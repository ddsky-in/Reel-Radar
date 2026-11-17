-- Separate durable 12-hour discovery and 24-hour metric workflows. Installation
-- is explicit; this migration does not enable Cron or submit provider work.
create schema if not exists competitor_refresh_private;
revoke all on schema competitor_refresh_private from public,anon,authenticated,service_role;

create table competitor_refresh_private.configuration (
  owner_user_id uuid primary key references public.app_settings(owner_user_id),
  edge_url text not null, secret_id uuid not null, enabled boolean not null default false
);
create table public.competitor_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.app_settings(owner_user_id),
  creator_id uuid not null references public.creators(id),
  kind text not null check(kind in ('discovery','metrics')),
  slot timestamptz not null, since_at timestamptz,
  status text not null default 'pending' check(status in ('pending','running','blocked','succeeded','partial','failed')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 3),
  last_job_id uuid references public.scrape_jobs(id),
  next_attempt_at timestamptz not null default now(),
  expected_reels integer not null default 0 check(expected_reels>=0),
  observed_reels integer not null default 0 check(observed_reels>=0),
  error_message text, created_at timestamptz not null default now(), completed_at timestamptz,
  unique(owner_user_id,creator_id,kind,slot)
);
create unique index competitor_refresh_one_open on public.competitor_refresh_runs(owner_user_id,creator_id,kind)
  where status in ('pending','running','blocked');
create index competitor_refresh_due on public.competitor_refresh_runs(owner_user_id,next_attempt_at)
  where status in ('pending','running','blocked');
create table public.competitor_refresh_targets (
  run_id uuid not null references public.competitor_refresh_runs(id),
  reel_id uuid not null references public.reels(id), shortcode text not null,
  observed_at timestamptz, primary key(run_id,reel_id), unique(run_id,shortcode)
);
create index competitor_refresh_target_reel on public.competitor_refresh_targets(reel_id);
alter table public.scrape_jobs
  add column competitor_run_id uuid references public.competitor_refresh_runs(id),
  add column workflow_attempt integer,
  add column collection_since timestamptz,
  add constraint competitor_attempt_unique unique(competitor_run_id,workflow_attempt),
  add constraint competitor_job_link check(
    (kind in ('discovery','metrics') and competitor_run_id is not null and workflow_attempt is not null and workflow_attempt between 1 and 3)
    or (kind not in ('discovery','metrics') and competitor_run_id is null and workflow_attempt is null));
alter table public.scrape_jobs drop constraint scrape_jobs_kind_check;
alter table public.scrape_jobs add constraint scrape_jobs_kind_check
  check(kind in ('daily','weekly','backfill','profile','manual','retry','discovery','metrics'));
alter table public.scrape_jobs drop constraint scrape_jobs_results_limit_check;
alter table public.scrape_jobs add constraint scrape_jobs_results_limit_check check(
  (kind='backfill' and results_limit=100 and requested_profiles_count=1)
  or (kind='manual' and results_limit=100 and requested_profiles_count=1)
  or (kind in ('discovery','metrics') and results_limit=10000 and requested_profiles_count=1)
  or (kind not in ('backfill','discovery','metrics') and results_limit between 1 and 30)) not valid;

alter table competitor_refresh_private.configuration enable row level security;
revoke all on competitor_refresh_private.configuration from public,anon,authenticated,service_role;
alter table public.competitor_refresh_runs enable row level security;
alter table public.competitor_refresh_targets enable row level security;
revoke all on public.competitor_refresh_runs,public.competitor_refresh_targets from public,anon,authenticated,service_role;
grant select on public.competitor_refresh_runs,public.competitor_refresh_targets to service_role;
grant select on public.competitor_refresh_runs to authenticated;
create policy competitor_refresh_owner_read on public.competitor_refresh_runs for select to authenticated
  using(owner_user_id=(select auth.uid()) and (select public.is_allowed_owner()) and public.can_read_creator(creator_id));
create trigger owner_revision_changed after insert or update or delete on public.competitor_refresh_runs
  for each row execute function public.signal_owner_revision();

-- Extend the established transactionally reserved collection dispatcher. All
-- account, global switch, concurrency and unknown-charge checks remain in place.
do $$ declare definition text; begin
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into definition;
  if definition not like '%headroom/slots%' or definition not like '%unreconciled_charges%'
    or definition not like '%j.kind<>''profile'' and j.kind<>''backfill''%'
    or definition not like '%public.require_service()%' then raise exception 'competitor_dispatch_contract_drift'; end if;
  definition:=replace(definition,'''daily'',''weekly'',''backfill'',''profile'',''manual'',''retry''',
    '''daily'',''weekly'',''backfill'',''profile'',''manual'',''retry'',''discovery'',''metrics''');
  definition:=replace(definition,'s.paused and p_kind in (''daily'',''weekly'',''retry'')',
    's.paused and p_kind in (''daily'',''weekly'',''retry'',''discovery'',''metrics'')');
  definition:=replace(definition,'j.kind<>''profile'' and j.kind<>''backfill''',
    'j.kind not in (''profile'',''backfill'',''discovery'',''metrics'')');
  execute definition;
end $$;

create function competitor_refresh_private.schedule_owner(p_owner uuid,p_kind text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare period interval; window_start timestamptz; c record; rid uuid; since_date timestamptz; ids uuid[]:='{}';
begin
  if p_kind is null or p_kind not in ('discovery','metrics') then raise exception 'invalid_workflow' using errcode='22023'; end if;
  if not exists(select 1 from public.app_settings where owner_user_id=p_owner and not paused and scraping_enabled) then
    return jsonb_build_object('run_ids',ids,'reason','paused_or_disabled'); end if;
  perform pg_advisory_xact_lock(hashtextextended('competitor-workflow:'||p_owner::text,0));
  period:=case when p_kind='discovery' then interval '12 hours' else interval '24 hours' end;
  window_start:=date_bin(period,now(),case when p_kind='discovery' then '2000-01-01 00:00Z'::timestamptz else '2000-01-01 00:30Z'::timestamptz end);
  for c in select cc.* from public.creators cc where cc.status not in ('private','unavailable','paused')
    and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
      where wc.creator_id=cc.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner)
    and not exists(select 1 from public.competitor_refresh_runs r where r.owner_user_id=p_owner and r.creator_id=cc.id
      and r.kind=p_kind and (r.slot=window_start or r.status in ('pending','running','blocked')))
    order by cc.id loop
    if p_kind='metrics' then
      -- No date cutoff when a stored publication date is unknown. Frozen targets
      -- determine completeness, even when the provider truncates a history.
      select case when count(*) filter(where published_at is null)=0 then min(published_at)-interval '1 second' end
        into since_date from public.reels where creator_id=c.id;
      if not exists(select 1 from public.reels where creator_id=c.id) then continue; end if;
    else
      select max(created_at) into since_date from public.competitor_refresh_runs
        where owner_user_id=p_owner and creator_id=c.id and kind='discovery' and status='succeeded';
      since_date:=coalesce(since_date,c.last_reels_fetch_at,now()-interval '12 hours')-interval '24 hours';
    end if;
    insert into public.competitor_refresh_runs(owner_user_id,creator_id,kind,slot,since_at)
      values(p_owner,c.id,p_kind,window_start,since_date) returning id into rid;
    if p_kind='metrics' then
      insert into public.competitor_refresh_targets(run_id,reel_id,shortcode)
        select rid,id,shortcode from public.reels where creator_id=c.id;
      update public.competitor_refresh_runs set expected_reels=(select count(*) from public.competitor_refresh_targets where run_id=rid) where id=rid;
    end if;
    ids:=array_append(ids,rid);
  end loop;
  return jsonb_build_object('run_ids',ids,'reason',null);
end $$;
revoke all on function competitor_refresh_private.schedule_owner(uuid,text) from public,anon,authenticated,service_role;

create function public.worker_competitor_maintain(p_owner_user_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.competitor_refresh_runs; j public.scrape_jobs; jid uuid; jobs uuid[]:='{}';
begin
  perform public.require_service();
  if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id) then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('competitor-workflow:'||p_owner_user_id::text,0));
  -- The fallback also catches up a missed scheduler HTTP request. The same slot
  -- and open-run unique keys make repeated wakes harmless.
  if exists(select 1 from competitor_refresh_private.configuration where owner_user_id=p_owner_user_id and enabled) then
    perform competitor_refresh_private.schedule_owner(p_owner_user_id,'discovery');
    perform competitor_refresh_private.schedule_owner(p_owner_user_id,'metrics');
  end if;
  for r in select * from public.competitor_refresh_runs where owner_user_id=p_owner_user_id
    and status in ('pending','running','blocked') order by next_attempt_at,id for update loop
    if r.last_job_id is not null then
      select * into j from public.scrape_jobs where id=r.last_job_id;
      if j.status in ('pending','budget_paused','dispatching','running','processing') then continue; end if;
      if j.status='uncertain' or j.live and j.actual_cost_usd is null then
        update public.competitor_refresh_runs set status='blocked',error_message='Provider outcome or billing needs reconciliation.'
          where id=r.id and status<>'blocked'; continue;
      end if;
      if j.status='succeeded' then
        update public.competitor_refresh_runs set status='succeeded',completed_at=coalesce(completed_at,now()),error_message=null where id=r.id; continue;
      end if;
      if r.attempt_count>=3 then
        update public.competitor_refresh_runs set status=case when observed_reels>0 then 'partial' else 'failed' end,
          completed_at=coalesce(completed_at,now()),error_message='Refresh incomplete after three reconciled attempts; see job coverage.' where id=r.id; continue;
      end if;
      -- Processing can exhaust its own retries without calling the finish hook.
      -- Enforce workflow backoff from the terminal job in that path as well.
      r.next_attempt_at:=greatest(r.next_attempt_at,coalesce(j.completed_at,j.scheduled_for)+
        case when r.attempt_count=1 then interval '5 minutes' else interval '15 minutes' end);
      update public.competitor_refresh_runs set status='pending',next_attempt_at=r.next_attempt_at,
        error_message=coalesce(j.error_message,error_message) where id=r.id;
    end if;
    if r.next_attempt_at>now() then continue; end if;
    if not exists(select 1 from public.creators c join public.workspace_creators wc on wc.creator_id=c.id
      join public.workspaces w on w.id=wc.workspace_id where c.id=r.creator_id and c.status not in ('private','unavailable','paused')
      and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id) then
      update public.competitor_refresh_runs set status='failed',completed_at=now(),error_message='Creator is no longer eligible.' where id=r.id; continue;
    end if;
    if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id and not paused and scraping_enabled) then continue; end if;
    insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,priority,
      competitor_run_id,workflow_attempt,collection_since,scheduled_for)
      values(p_owner_user_id,r.kind,1,10000,case when r.kind='discovery' then 20 else 10 end,
        r.id,r.attempt_count+1,r.since_at,now()) returning id into jid;
    insert into public.scrape_job_creators(job_id,creator_id) values(jid,r.creator_id);
    update public.competitor_refresh_runs set last_job_id=jid,attempt_count=attempt_count+1,status='running' where id=r.id;
    jobs:=array_append(jobs,jid);
  end loop;
  return jsonb_build_object('job_ids',jobs);
end $$;
revoke all on function public.worker_competitor_maintain(uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_competitor_maintain(uuid) to service_role;

alter function public.worker_schedule(uuid,text) rename to worker_schedule_pre_competitors;
revoke all on function public.worker_schedule_pre_competitors(uuid,text) from public,anon,authenticated,service_role;
create function public.worker_schedule(p_owner_user_id uuid,p_kind text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.require_service();
  if p_kind not in ('discovery','metrics') or p_kind is null then return public.worker_schedule_pre_competitors(p_owner_user_id,p_kind); end if;
  result:=competitor_refresh_private.schedule_owner(p_owner_user_id,p_kind);
  return result||public.worker_competitor_maintain(p_owner_user_id);
end $$;
revoke all on function public.worker_schedule(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_schedule(uuid,text) to service_role;

-- Metrics jobs pass only frozen, authorized targets to the proven canonical
-- upsert/media/snapshot pipeline. Discovery jobs retain its global deduplication.
alter function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) rename to worker_ingest_page_pre_competitors;
revoke all on function public.worker_ingest_page_pre_competitors(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,
  p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; result jsonb; accepted jsonb; rec jsonb;
begin
  perform public.require_service();
  select * into j from public.scrape_jobs where id=p_job_id;
  accepted:=p_records;
  if j.kind='metrics' then
    if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records)>100 then raise exception 'invalid_page' using errcode='22023'; end if;
    -- Do not silently swallow a mismatched identity just because it isn't a target.
    for rec in select value from jsonb_array_elements(p_records) loop
      if not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id
        where jc.job_id=j.id and c.id=(rec->>'creator_id')::uuid and c.username=rec->>'username') then
        raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
    end loop;
    select coalesce(jsonb_agg(value),'[]') into accepted from jsonb_array_elements(p_records)
      where exists(select 1 from public.competitor_refresh_targets t join public.reels r on r.id=t.reel_id
        where t.run_id=j.competitor_run_id and t.shortcode=value->>'shortcode' and r.creator_id=(value->>'creator_id')::uuid);
  end if;
  result:=public.worker_ingest_page_pre_competitors(p_job_id,p_lease_token,p_expected_cursor,accepted,p_errors,p_next_cursor,p_finished,p_received_counts);
  if j.competitor_run_id is not null and not coalesce((result->>'duplicate')::boolean,false) then
    if j.kind='metrics' then
      update public.competitor_refresh_targets t set observed_at=greatest(t.observed_at,(rec.value->>'fetched_at')::timestamptz)
        from jsonb_array_elements(accepted) rec(value) where t.run_id=j.competitor_run_id and t.shortcode=rec.value->>'shortcode';
      update public.competitor_refresh_runs set observed_reels=(select count(*) from public.competitor_refresh_targets
        where run_id=j.competitor_run_id and observed_at is not null) where id=j.competitor_run_id;
    else
      update public.competitor_refresh_runs set observed_reels=observed_reels+coalesce((result->>'accepted')::integer,0) where id=j.competitor_run_id;
    end if;
  end if;
  return result;
end $$;
revoke all on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) to service_role;

alter function public.worker_finish_processing(uuid,uuid) rename to worker_finish_processing_pre_competitors;
revoke all on function public.worker_finish_processing_pre_competitors(uuid,uuid) from public,anon,authenticated,service_role;
create function public.worker_finish_processing(p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; r public.competitor_refresh_runs; missing integer; success boolean; message text;
begin
  perform public.require_service();
  select * into j from public.scrape_jobs where id=p_job_id for update;
  if j.competitor_run_id is null then return public.worker_finish_processing_pre_competitors(p_job_id,p_lease_token); end if;
  if j.status in ('succeeded','partial','failed') then return to_jsonb(j); end if;
  if j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() or not j.dataset_finished then
    raise exception 'not_finished_or_lease_expired' using errcode='40001'; end if;
  select * into r from public.competitor_refresh_runs where id=j.competitor_run_id for update;
  missing:=case when j.kind='metrics' then r.expected_reels-r.observed_reels else 0 end;
  success:=missing=0 and j.provider_terminal_status='SUCCEEDED' and j.output_summary_verified
    and not exists(select 1 from public.scrape_job_creators where job_id=j.id and error_message is not null);
  message:=case when missing>0 then format('%s of %s stored Reels were not returned; existing values preserved.',missing,r.expected_reels)
    when not success then 'Provider output incomplete or unverified; collected records preserved.' end;
  update public.scrape_jobs set status=case when success then 'succeeded' when returned_records_count>0 then 'partial' else 'failed' end,
    completed_at=now(),lease_token=null,lease_expires_at=null,error_message=message where id=j.id returning * into j;
  update public.competitor_refresh_runs set status=case when success then 'succeeded' when attempt_count>=3 then
      case when observed_reels>0 then 'partial' else 'failed' end else 'pending' end,
    next_attempt_at=now()+case when attempt_count=1 then interval '5 minutes' else interval '15 minutes' end,
    completed_at=case when success or attempt_count>=3 then now() end,error_message=message where id=r.id;
  if success then
    update public.creators set status='active',last_error=null,last_reels_fetch_at=greatest(last_reels_fetch_at,j.result_fetched_at)
      where id=r.creator_id and status not in ('private','unavailable','paused');
    update public.scrape_job_creators set status='active',completion_status='completed' where job_id=j.id;
  end if;
  return to_jsonb(j);
end $$;
revoke all on function public.worker_finish_processing(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_finish_processing(uuid,uuid) to service_role;

-- Only native Cron/operator execution can read the stored authentication secret.
-- Network failures don't destroy the durable schedules or queued work.
create function competitor_refresh_private.wake(p_kind text) returns bigint
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cfg competitor_refresh_private.configuration; secret text; request_id bigint;
begin
  if p_kind is null or p_kind not in ('discovery','metrics','maintenance') then return null; end if;
  select * into cfg from competitor_refresh_private.configuration where enabled limit 1;
  if not found then return null; end if;
  if p_kind<>'maintenance' then perform competitor_refresh_private.schedule_owner(cfg.owner_user_id,p_kind); end if;
  select decrypted_secret into secret from vault.decrypted_secrets where id=cfg.secret_id;
  if secret is null then raise warning 'Competitor scheduler authentication unavailable'; return null; end if;
  begin
    request_id:=net.http_post(url:=cfg.edge_url||'/functions/v1/'||case when p_kind='maintenance' then 'reconcile-jobs' else 'refresh-dispatch' end,
      headers:=jsonb_build_object('Content-Type','application/json','x-internal-secret',secret),
      body:=case when p_kind='maintenance' then '{}'::jsonb else jsonb_build_object('kind',p_kind) end,timeout_milliseconds:=10000);
  exception when others then raise warning 'Competitor scheduler wake failed; durable work will retry'; end;
  return request_id;
end $$;
revoke all on function competitor_refresh_private.wake(text) from public,anon,authenticated,service_role;

create function public.worker_install_competitor_schedules(p_owner_user_id uuid,p_edge_url text,p_secret text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare secret_id uuid; existing_secret text; command_text text; entry record;
begin
  perform public.require_service();
  if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id) then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  if p_edge_url is null or p_edge_url !~ '^https://[a-z0-9]+\.supabase\.co$' or p_secret is null or length(p_secret)<32 or length(p_secret)>512 then
    raise exception 'invalid_schedule_config' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('competitor-schedule-install',0));
  select id,decrypted_secret into secret_id,existing_secret from vault.decrypted_secrets where name='reelradar_competitor_maintenance_v1';
  if secret_id is null then secret_id:=vault.create_secret(p_secret,'reelradar_competitor_maintenance_v1','ReelRadar competitor schedules');
  elsif existing_secret is distinct from p_secret then raise exception 'schedule_secret_rotation_required'; end if;
  insert into competitor_refresh_private.configuration(owner_user_id,edge_url,secret_id,enabled)
    values(p_owner_user_id,p_edge_url,secret_id,true) on conflict(owner_user_id) do update set edge_url=excluded.edge_url,secret_id=excluded.secret_id,enabled=true;
  for entry in select * from (values
    ('reelradar-competitor-discovery','0 0,12 * * *','discovery'),
    ('reelradar-competitor-metrics','30 0 * * *','metrics'),
    ('reelradar-competitor-maintenance','*/5 * * * *','maintenance')) v(name,schedule,kind) loop
    command_text:=format('select competitor_refresh_private.wake(%L);',entry.kind);
    if exists(select 1 from cron.job where jobname=entry.name and command<>command_text) then raise exception 'schedule_name_conflict'; end if;
    perform cron.schedule(entry.name,entry.schedule,command_text);
  end loop;
  return jsonb_build_object('installed',true,'discovery_hours',12,'metrics_hours',24,'maintenance_minutes',5);
end $$;
revoke all on function public.worker_install_competitor_schedules(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_install_competitor_schedules(uuid,text,text) to service_role;
