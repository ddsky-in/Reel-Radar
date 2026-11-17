-- Local forward migration only. Existing five-minute maintenance may invoke the
-- service RPC; this migration creates no schedule, request, run or enabled switch.
set constraints all immediate;
create table public.carousel_automation_settings (
  owner_user_id uuid primary key references public.app_settings(owner_user_id) on delete restrict,
  enabled boolean not null default false,
  provider_validated boolean not null default false,
  configured_at timestamptz,
  check(not enabled or provider_validated)
);
alter table public.carousel_automation_settings enable row level security;
revoke all on public.carousel_automation_settings from public,anon,authenticated,service_role;
grant select on public.carousel_automation_settings to service_role;
insert into public.carousel_automation_settings(owner_user_id)
select owner_user_id from public.app_settings;

create schema carousel_automation_private;
revoke all on schema carousel_automation_private from public,anon,authenticated,service_role;
create function carousel_automation_private.provision() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  insert into public.carousel_automation_settings(owner_user_id) values(new.owner_user_id);
  return new;
end $$;
create trigger app_settings_carousel_automation after insert on public.app_settings
for each row execute function carousel_automation_private.provision();
create trigger owner_revision_changed after insert or update or delete on public.carousel_automation_settings
for each row execute function public.signal_owner_revision();

set constraints all immediate;
alter table public.scrape_jobs
  add column carousel_automatic boolean not null default false,
  add column carousel_automation_scheduled_at timestamptz,
  add constraint scrape_jobs_carousel_automatic_check check(not carousel_automatic or
    (kind='carousel' and manual_authorized_by=owner_user_id and manual_authorized_by is not null
      and carousel_automation_scheduled_at is not null));
create index scrape_jobs_carousel_cadence_idx on public.scrape_jobs(owner_user_id,carousel_automation_scheduled_at)
where kind='carousel';

-- A stable service stamp survives repeated maintenance and empty successful feeds.
-- A later real start/fetch extends the rolling 24-hour cooldown, never shortens it.
-- Billing is intentionally independent: verified output does not imply a known cost.
create function carousel_automation_private.cadence(p_owner uuid,p_creator uuid)
returns table(last_attempt_at timestamptz,last_fetch_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  with history as (
    select greatest(j.carousel_automation_scheduled_at,j.started_at) attempted_at,
      case when j.live and j.status='succeeded' and j.provider_terminal_status='SUCCEEDED'
        and j.output_summary_verified and jc.summary_authoritative and jc.completion_status='completed'
        and jc.error_message is null then coalesce(j.result_fetched_at,j.completed_at) end fetched_at
    from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
    where j.owner_user_id=p_owner and j.kind='carousel' and jc.creator_id=p_creator
  ), successful as (
    select fetched_at from history
    union all
    select latest_fetched_at from public.carousel_posts where creator_id=p_creator and provider not in ('mock','demo')
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        where wc.creator_id=p_creator and wc.active and w.owner_user_id=p_owner)
  )
  select greatest((select max(attempted_at) from history),(select max(fetched_at) from successful)),
    (select max(fetched_at) from successful);
$$;

create function public.worker_configure_carousel_automation(p_owner_user_id uuid,p_enabled boolean,p_provider_validated boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_owner_user_id is null or p_enabled is null or p_provider_validated is null
    or p_enabled and not p_provider_validated then
    raise exception 'invalid_carousel_automation_configuration' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  -- Explicit service configuration records the owner's consent only after the
  -- capped provider pilot was verified. It does not itself adopt, enqueue or start.
  update public.carousel_automation_settings set enabled=p_enabled,provider_validated=p_provider_validated,configured_at=now()
    where owner_user_id=p_owner_user_id;
  return jsonb_build_object('enabled',p_enabled,'provider_validated',p_provider_validated);
end $$;

create function public.worker_carousel_maintain(p_owner_user_id uuid,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; cfg public.carousel_automation_settings; candidate record;
  j public.scrape_jobs; jid uuid; jobs uuid[]:='{}'; created integer:=0; adopted integer:=0; reason text;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_limit is null or p_limit not between 1 and 10 then
    raise exception 'invalid_carousel_maintenance_scope' using errcode='22023';
  end if;
  -- Same owner locks as manual enqueue/unlink and the unchanged budget allocator.
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||p_owner_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into s from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then return jsonb_build_object('job_ids',jobs,'created',0,'adopted',0,'reason','owner_not_provisioned'); end if;
  select * into cfg from public.carousel_automation_settings where owner_user_id=p_owner_user_id for update;
  if not coalesce(cfg.provider_validated,false) then reason:='setup_required';
  elsif not coalesce(cfg.enabled,false) then reason:='disabled';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif s.paused then reason:='paused'; end if;
  if reason is not null then return jsonb_build_object('job_ids',jobs,'created',0,'adopted',0,'reason',reason); end if;

  -- Canonical creators across ALL owner workspaces, not a latest-120/first-workspace
  -- window. Null/oldest attempts first ensure bounded continuations reach all 125+.
  for candidate in
    select c.id,history.last_attempt_at from public.creators c
    cross join lateral carousel_automation_private.cadence(p_owner_user_id,c.id) history
    where c.status not in ('private','unavailable','paused') and exists(
      select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
      where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)
      and (history.last_attempt_at is null or history.last_attempt_at<=now()-interval '24 hours')
    order by history.last_attempt_at asc nulls first,c.id
  loop
    exit when cardinality(jobs)>=p_limit;
    -- Uncertain starts, exhausted processing and accepted unknown-cost attempts
    -- are NEVER relaunches, even after a day. Unrelated Reel work is not a carousel.
    if exists(select 1 from public.scrape_jobs busy join public.scrape_job_creators jc on jc.job_id=busy.id
      where busy.owner_user_id=p_owner_user_id and busy.kind='carousel' and jc.creator_id=candidate.id and (
        busy.status in ('dispatching','running','processing','uncertain')
        or busy.processing_attempts>=10 and busy.status<>'succeeded'
        or busy.live and busy.actual_cost_usd is null and (busy.attempt_count>0 or busy.actor_run_id is not null or busy.provider_terminal_status is not null))) then
      continue;
    end if;
    select q.* into j from public.scrape_jobs q join public.scrape_job_creators jc on jc.job_id=q.id
      where q.owner_user_id=p_owner_user_id and q.kind='carousel' and jc.creator_id=candidate.id
        and q.status in ('pending','budget_paused')
      order by q.priority desc,q.scheduled_for,q.created_at,q.id for update of q skip locked limit 1;
    if found then
      -- Adopt existing backlog conservatively: one creator / 30 photos, never
      -- started, no paid pin/hold/lease. IDs, links, counters and priority survive.
      if j.carousel_automatic or j.attempt_count<>0 or j.started_at is not null or j.dispatch_nonce is not null
        or j.actor_run_id is not null or j.provider_terminal_status is not null or j.apify_account_slot is not null
        or j.live or j.reserved_usd<>0 or j.lease_token is not null or j.processing_attempts<>0
        or j.requested_profiles_count<>1 or j.results_limit<>30
        or (select count(*) from public.scrape_job_creators where job_id=j.id)<>1 then continue; end if;
      update public.scrape_jobs set carousel_automatic=true,carousel_automation_scheduled_at=now(),manual_authorized_by=p_owner_user_id
        where id=j.id;
      jid:=j.id; adopted:=adopted+1;
    else
      -- A locked pending row is still busy: SKIP LOCKED is not permission to
      -- create a duplicate. Neither read RPC nor configuration calls this path.
      if exists(select 1 from public.scrape_jobs q join public.scrape_job_creators jc on jc.job_id=q.id
        where q.owner_user_id=p_owner_user_id and q.kind='carousel' and jc.creator_id=candidate.id
          and q.status in ('pending','budget_paused')) then continue; end if;
      insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,estimated_cost_usd,
        manual_authorized_by,priority,carousel_automatic,carousel_automation_scheduled_at)
      values(p_owner_user_id,'carousel',30,1,0,p_owner_user_id,5,true,now()) returning id into jid;
      insert into public.scrape_job_creators(job_id,creator_id) values(jid,candidate.id);
      created:=created+1;
    end if;
    jobs:=array_append(jobs,jid);
  end loop;
  -- Queuing is not budget readiness. Only the existing claim allocator may
  -- select an authoritative account, reserve money and enforce concurrency.
  return jsonb_build_object('job_ids',jobs,'created',created,'adopted',adopted);
end $$;

-- Keep the established transcription/media wrapper and allocator unchanged.
-- Pin an eligible carousel candidate through their existing exact-job mechanism
-- so a disabled automatic head cannot starve a manually authorized pilot/job.
do $$ declare def text; begin
  select pg_get_functiondef('public.worker_claim_dispatch(uuid,boolean,text,text)'::regprocedure) into def;
  if position('reelradar.media_job_id' in def)=0 or position('dispatch_candidate_changed' in def)=0
    or position('transcription_claim_dispatch_core' in def)=0 then
    raise exception 'carousel_automation_dispatch_contract_drift';
  end if;
end $$;
alter function public.worker_claim_dispatch(uuid,boolean,text,text) rename to worker_claim_dispatch_pre_carousel_automation;
revoke all on function public.worker_claim_dispatch_pre_carousel_automation(uuid,boolean,text,text) from public,anon,authenticated,service_role;
create function public.worker_claim_dispatch(p_owner_user_id uuid,p_live boolean,p_actor_id text,p_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; cfg public.carousel_automation_settings; j public.scrape_jobs;
  allowed boolean; prior_target text; result jsonb;
begin
  perform public.require_service();
  if p_kind is distinct from 'carousel' then
    return public.worker_claim_dispatch_pre_carousel_automation(p_owner_user_id,p_live,p_actor_id,p_kind);
  end if;
  if p_live is null or nullif(p_actor_id,'') is null then raise exception 'invalid_claim' using errcode='22023'; end if;
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into s from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then return jsonb_build_object('reason','owner_not_provisioned'); end if;
  if p_live and not s.scraping_enabled then return jsonb_build_object('reason','globalscraping_disabled'); end if;
  if s.paused then return jsonb_build_object('reason','paused'); end if;
  select * into cfg from public.carousel_automation_settings where owner_user_id=p_owner_user_id;
  allowed:=coalesce(cfg.enabled and cfg.provider_validated,false) and s.scraping_enabled;
  prior_target:=coalesce(current_setting('reelradar.media_job_id',true),'');
  select q.* into j from public.scrape_jobs q
    where q.owner_user_id=p_owner_user_id and q.kind='carousel' and q.status in ('pending','budget_paused') and q.scheduled_for<=now()
      and (not p_live or q.manual_authorized_by=p_owner_user_id)
      and (prior_target='' or q.id=prior_target::uuid)
      and (not q.carousel_automatic or allowed and q.attempt_count=0 and q.started_at is null and q.dispatch_nonce is null
        and q.actor_run_id is null and q.apify_account_slot is null and not q.live and q.processing_attempts=0
        and not exists(select 1 from public.scrape_job_creators target join public.scrape_job_creators other on other.creator_id=target.creator_id
          join public.scrape_jobs busy on busy.id=other.job_id where target.job_id=q.id and busy.id<>q.id
            and busy.owner_user_id=p_owner_user_id and busy.kind='carousel' and (
              busy.status in ('dispatching','running','processing','uncertain')
              or busy.processing_attempts>=10 and busy.status<>'succeeded'
              or busy.live and busy.actual_cost_usd is null and (busy.attempt_count>0 or busy.actor_run_id is not null or busy.provider_terminal_status is not null))))
    order by q.priority desc,q.scheduled_for,q.created_at,q.id for update of q skip locked limit 1;
  if not found then
    if exists(select 1 from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.kind='carousel'
      and q.carousel_automatic and q.status in ('pending','budget_paused') and (prior_target='' or q.id=prior_target::uuid)) then
      return jsonb_build_object('reason',case when not coalesce(cfg.provider_validated,false) then 'setup_required'
        when not allowed then 'disabled' else 'carousel_overlap_or_unresolved_attempt' end);
    end if;
    return public.worker_claim_dispatch_pre_carousel_automation(p_owner_user_id,p_live,p_actor_id,p_kind);
  end if;
  perform set_config('reelradar.media_job_id',j.id::text,true);
  result:=public.worker_claim_dispatch_pre_carousel_automation(p_owner_user_id,p_live,p_actor_id,p_kind);
  perform set_config('reelradar.media_job_id',prior_target,true);
  return result;
end $$;

create function public.get_carousel_collection_status(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid(); s public.app_settings; cfg public.carousel_automation_settings;
  reason text; pending integer; active integer; fetched timestamptz; due timestamptz;
begin
  perform public.require_workspace(p_workspace_id);
  select * into s from public.app_settings where owner_user_id=owner_id;
  select * into cfg from public.carousel_automation_settings where owner_user_id=owner_id;
  if not coalesce(cfg.provider_validated,false) then reason:='setup_required';
  elsif not coalesce(cfg.enabled,false) then reason:='disabled';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif s.paused or exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then reason:='paused'; end if;
  select count(*) filter(where j.status in ('pending','budget_paused'))::integer,
    count(*) filter(where j.status in ('dispatching','running','processing','uncertain'))::integer
    into pending,active from public.scrape_jobs j where j.owner_user_id=owner_id and j.kind='carousel' and exists(
      select 1 from public.scrape_job_creators jc join public.workspace_creators wc on wc.creator_id=jc.creator_id
      where jc.job_id=j.id and wc.workspace_id=p_workspace_id and wc.active);
  select max(history.last_fetch_at),min(case when c.status not in ('private','unavailable','paused') then
    coalesce(history.last_attempt_at+interval '24 hours',now()) end) into fetched,due
    from public.workspace_creators wc join public.creators c on c.id=wc.creator_id
    cross join lateral carousel_automation_private.cadence(owner_id,c.id) history
    where wc.workspace_id=p_workspace_id and wc.active;
  return jsonb_build_object('enabled',coalesce(cfg.enabled,false),'provider_validated',coalesce(cfg.provider_validated,false),
    'paused',s.paused or exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null),
    'reason',reason,'pending_jobs',pending,'active_jobs',active,'last_fetch_at',fetched,
    'next_due_at',case when reason is null then due end,'interval_hours',24,'window_limit',30);
end $$;

revoke all on all functions in schema carousel_automation_private from public,anon,authenticated,service_role;
revoke all on function public.worker_configure_carousel_automation(uuid,boolean,boolean),public.worker_carousel_maintain(uuid,integer),
  public.worker_claim_dispatch(uuid,boolean,text,text),public.get_carousel_collection_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_configure_carousel_automation(uuid,boolean,boolean),public.worker_carousel_maintain(uuid,integer),
  public.worker_claim_dispatch(uuid,boolean,text,text) to service_role;
grant execute on function public.get_carousel_collection_status(uuid) to authenticated;
comment on column public.scrape_jobs.carousel_automatic is 'Service-authorized daily carousel collection; rechecked against owner configuration before a first claim.';
comment on column public.scrape_jobs.carousel_automation_scheduled_at is 'Stable service timestamp for rolling 24-hour canonical creator deduplication, including adopted legacy jobs.';
comment on table public.carousel_automation_settings is 'Default-disabled owner consent and provider-pilot verification. No secrets, budget allocations or schedules.';
