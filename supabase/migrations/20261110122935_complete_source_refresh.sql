-- Complete, explicitly requested source refreshes for any owned competitor.
-- Every accepted Reel has durable field coverage; no provider calls run in SQL.
alter table public.scrape_jobs add column source_refresh boolean not null default false;
create table public.reel_fetch_observations (
  job_id uuid not null references public.scrape_jobs(id) on delete cascade,
  reel_id uuid not null references public.reels(id) on delete cascade,
  fetched_at timestamptz not null,
  caption_received boolean not null,
  media_received boolean not null,
  primary key(job_id,reel_id)
);
alter table public.reel_fetch_observations enable row level security;
revoke all on public.reel_fetch_observations from public,anon,authenticated,service_role;
grant select on public.reel_fetch_observations to service_role;
create index reel_fetch_observations_reel_idx on public.reel_fetch_observations(reel_id);

-- Omitted provider fields must not erase previously captured metadata. Snapshot
-- rows still record exactly which metrics the new response did or did not fetch.
do $$
declare def text; old text; patched text; start_at integer; end_at integer; field text;
begin
  select pg_get_functiondef('public.worker_ingest_page_pre_transcription(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure) into def;
  start_at:=strpos(def,'on conflict(shortcode) do update set');
  end_at:=strpos(substr(def,start_at),'returning id into rid;');
  if start_at=0 or end_at=0 then raise exception 'source_upsert_contract_drift'; end if;
  old:=substr(def,start_at,end_at+length('returning id into rid;')-1);
  patched:=replace(old,'thumbnail_url=excluded.thumbnail_url','thumbnail_url=coalesce(excluded.thumbnail_url,public.reels.thumbnail_url)');
  patched:=replace(patched,'duration_seconds=excluded.duration_seconds','duration_seconds=coalesce(excluded.duration_seconds,public.reels.duration_seconds)');
  patched:=replace(patched,'caption_preview=excluded.caption_preview','caption_preview=case when rec->>''caption_full'' is null and excluded.caption_preview='''' then public.reels.caption_preview else excluded.caption_preview end');
  foreach field in array array['views','likes','comments'] loop
    if strpos(old,'latest_'||field||'=excluded.latest_'||field)=0 then raise exception 'source_metric_contract_drift'; end if;
    patched:=replace(patched,'latest_'||field||'=excluded.latest_'||field,
      format('latest_%1$s=case when excluded.%1$s_state=''not_fetched'' then public.reels.latest_%1$s else excluded.latest_%1$s end',field));
    patched:=replace(patched,field||'_state=excluded.'||field||'_state',
      format('%1$s_state=case when excluded.%1$s_state=''not_fetched'' then public.reels.%1$s_state else excluded.%1$s_state end',field));
  end loop;
  execute replace(def,old,patched);
end $$;

create function reel_detail_private.enqueue_source_refresh(p_owner_id uuid,p_creator_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; m public.transcription_media_refreshes; jid uuid; targets uuid[]; reason text;
begin
  if coalesce(auth.jwt()->>'role','')='service_role' then perform public.require_service();
  elsif auth.uid() is distinct from p_owner_id or not public.is_allowed_owner() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  select * into s from public.transcription_settings where singleton for update;
  if not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
    join public.creators c on c.id=wc.creator_id join public.app_settings ap on ap.owner_user_id=w.owner_user_id
    where wc.creator_id=p_creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_id
    and c.status not in ('private','unavailable','paused')) then
    raise exception 'creator_not_authorized' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_id for update;
  select mr.* into m from public.transcription_media_refreshes mr
    where mr.owner_user_id=p_owner_id and mr.creator_id=p_creator_id and mr.status='active';
  if found then
    if exists(select 1 from public.scrape_jobs where id=m.job_id and source_refresh) then
      return jsonb_build_object('job_id',m.job_id,'refresh_id',m.id,'target_count',m.target_count,'reason','already_queued');
    end if;
    return jsonb_build_object('job_id',null,'target_count',0,'reason','creator_busy');
  end if;
  if exists(select 1 from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
    where j.owner_user_id=p_owner_id and jc.creator_id=p_creator_id
      and j.status in ('pending','dispatching','running','processing','uncertain','budget_paused')) then
    return jsonb_build_object('job_id',null,'target_count',0,'reason','creator_busy');
  end if;
  reason:=public.transcription_paid_gate();
  if reason is null and (not s.media_recovery_enabled or s.phase<>'automatic') then reason:='source_refresh_disabled'; end if;
  select array_agg(r.id order by r.published_at desc nulls last,r.id) into targets from public.reels r where r.creator_id=p_creator_id;
  if coalesce(cardinality(targets),0)=0 then reason:=coalesce(reason,'initial_import_required');
  elsif cardinality(targets)>100 then reason:=coalesce(reason,'source_coverage_limit');
  elsif not public.transcription_combined_budget(.01) then reason:=coalesce(reason,'budget_paused'); end if;
  if reason is not null then return jsonb_build_object('job_id',null,'target_count',coalesce(cardinality(targets),0),'reason',reason); end if;
  insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,manual_authorized_by,priority,source_refresh)
    values(p_owner_id,'manual',1,100,.01,p_owner_id,100,true) returning id into jid;
  insert into public.scrape_job_creators(job_id,creator_id) values(jid,p_creator_id);
  insert into public.transcription_media_refreshes(job_id,owner_user_id,creator_id,phase,billing_month,target_count)
    values(jid,p_owner_id,p_creator_id,s.phase,date_trunc('month',now() at time zone 'UTC')::date,cardinality(targets)) returning * into m;
  insert into public.transcription_media_targets(refresh_id,creator_id,reel_id,shortcode)
    select m.id,p_creator_id,r.id,r.shortcode from public.reels r where r.id=any(targets);
  return jsonb_build_object('job_id',jid,'refresh_id',m.id,'target_count',m.target_count,'reason',null);
end $$;
revoke all on function reel_detail_private.enqueue_source_refresh(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.worker_transcription_source_refresh_enqueue(p_creator_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare owner_id uuid;
begin
  perform public.require_service();
  select owner_user_id into owner_id from public.app_settings where singleton;
  return reel_detail_private.enqueue_source_refresh(owner_id,p_creator_id);
end $$;
revoke all on function public.worker_transcription_source_refresh_enqueue(uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_source_refresh_enqueue(uuid) to service_role;

create function reel_detail_private.request_source_refresh(p_workspace_id uuid,p_creator_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_workspace(p_workspace_id);
  if auth.uid() is null or not public.is_allowed_owner() or not exists(select 1 from public.workspaces w
    join public.workspace_creators wc on wc.workspace_id=w.id where w.id=p_workspace_id
    and w.owner_user_id=auth.uid() and w.archived_at is null and wc.creator_id=p_creator_id and wc.active) then
    raise exception 'creator_not_authorized' using errcode='42501';
  end if;
  -- A completely missed initial import still has no known targets. Reuse the
  -- existing authorized backfill queue, including its configured charge cap.
  if not exists(select 1 from public.reels where creator_id=p_creator_id) then
    return public.enqueue_refresh(p_workspace_id,array[p_creator_id],'backfill');
  end if;
  return reel_detail_private.enqueue_source_refresh(auth.uid(),p_creator_id);
end $$;
revoke all on function reel_detail_private.request_source_refresh(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.request_source_refresh(uuid,uuid) to authenticated;
create function public.request_creator_source_refresh(p_workspace_id uuid,p_creator_id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog,public as $$
  select reel_detail_private.request_source_refresh(p_workspace_id,p_creator_id);
$$;
revoke all on function public.request_creator_source_refresh(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_creator_source_refresh(uuid,uuid) to authenticated;

-- A full source refresh uses canonical ingestion: newly returned Reels that an
-- earlier run missed must be inserted, not silently dropped as unknown targets.
-- Media-only recovery retains its original frozen-target behavior.
alter function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) rename to worker_ingest_page_pre_source_coverage;
revoke all on function public.worker_ingest_page_pre_source_coverage(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,
  p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; m public.transcription_media_refreshes; result jsonb; rec jsonb; rid uuid; fetched timestamptz; caption_ok boolean; media_ok boolean;
begin
  perform public.require_service();
  -- Follow worker lock order before source ingestion can request a transcript retry.
  perform 1 from public.transcription_settings where singleton for update;
  select * into j from public.scrape_jobs where id=p_job_id;
  select * into m from public.transcription_media_refreshes where job_id=p_job_id;
  if j.source_refresh then
    result:=public.transcription_ingest_page_pre_media(p_job_id,p_lease_token,p_expected_cursor,p_records,p_errors,p_next_cursor,p_finished,p_received_counts);
  else
    result:=public.worker_ingest_page_pre_source_coverage(p_job_id,p_lease_token,p_expected_cursor,p_records,p_errors,p_next_cursor,p_finished,p_received_counts);
  end if;
  if coalesce((result->>'duplicate')::boolean,false) or j.kind='profile' then return result; end if;
  for rec in select value from jsonb_array_elements(p_records) loop
    select r.id into rid from public.reels r join public.creators c on c.id=r.creator_id
      where r.creator_id=(rec->>'creator_id')::uuid and r.shortcode=rec->>'shortcode' and c.username=rec->>'username'
      and exists(select 1 from public.scrape_job_creators jc where jc.job_id=j.id and jc.creator_id=r.creator_id)
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        where wc.creator_id=r.creator_id and wc.active and w.archived_at is null and w.owner_user_id=j.owner_user_id)
      and (m.id is null or j.source_refresh or exists(select 1 from public.transcription_media_targets mt
        where mt.refresh_id=m.id and mt.reel_id=r.id and mt.shortcode=r.shortcode));
    if rid is null then continue; end if;
    fetched:=(rec->>'fetched_at')::timestamptz;
    if fetched is null or fetched>now()+interval '5 minutes' then raise exception 'invalid_fetch_timestamp' using errcode='22023'; end if;
    caption_ok:=coalesce(jsonb_typeof(rec->'caption_full')='string',false);
    media_ok:=public.transcription_valid_media_url(rec->>'media_source_url') or exists(
      select 1 from jsonb_array_elements_text(coalesce(nullif(rec->'media_candidates','null'::jsonb),'[]')) u(url)
      where public.transcription_valid_media_url(url));
    if j.source_refresh and rec ? 'caption_full' and rec->'caption_full'<>'null'::jsonb then
      if not caption_ok or char_length(rec->>'caption_full')>20000 then raise exception 'invalid_full_caption' using errcode='22023'; end if;
      update public.reels set caption_full=rec->>'caption_full',caption_observed_at=fetched
        where id=rid and (caption_observed_at is null or caption_observed_at<=fetched);
    end if;
    insert into public.reel_fetch_observations(job_id,reel_id,fetched_at,caption_received,media_received)
      values(j.id,rid,fetched,caption_ok,media_ok)
      on conflict(job_id,reel_id) do update set fetched_at=greatest(public.reel_fetch_observations.fetched_at,excluded.fetched_at),
        caption_received=public.reel_fetch_observations.caption_received or excluded.caption_received,
        media_received=public.reel_fetch_observations.media_received or excluded.media_received;
    if j.source_refresh then
      update public.transcription_media_targets set observed_at=greatest(observed_at,fetched),observation_count=observation_count+1
        where refresh_id=m.id and reel_id=rid;
      -- This retry belongs to the explicit full-refresh request. A passive/new
      -- observation never restarts a terminal or possibly billed transcription.
      if media_ok and reel_detail_private.media_retry_allowed(rid) then
        update public.transcript_jobs set status='queued',next_attempt_at=now(),completed_at=null,error_message=null
          where reel_id=rid and reel_detail_private.media_retry_allowed(rid);
      end if;
    end if;
  end loop;
  return result;
end $$;
revoke all on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) to service_role;

alter function public.worker_finish_processing(uuid,uuid) rename to worker_finish_processing_pre_source_coverage;
revoke all on function public.worker_finish_processing_pre_source_coverage(uuid,uuid) from public,anon,authenticated,service_role;
create function public.worker_finish_processing(p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; j public.scrape_jobs; missing_rows integer; missing_captions integer; missing_media integer;
begin
  perform public.require_service();
  result:=public.worker_finish_processing_pre_source_coverage(p_job_id,p_lease_token);
  select * into j from public.scrape_jobs where id=p_job_id;
  if j.kind='profile' or j.status not in ('succeeded','partial') then return result; end if;
  select count(*) filter(where not caption_received),count(*) filter(where not media_received)
    into missing_captions,missing_media from public.reel_fetch_observations where job_id=j.id;
  select count(*) into missing_rows from public.transcription_media_targets mt join public.transcription_media_refreshes mr on mr.id=mt.refresh_id
    where mr.job_id=j.id and mt.observation_count=0 and j.source_refresh;
  if missing_rows+missing_captions+missing_media>0 then
    update public.scrape_jobs set status='partial',error_message=format('Source details incomplete: %s known Reels not returned, %s captions missing, %s media links missing.',missing_rows,missing_captions,missing_media) where id=j.id;
    update public.creators c set last_error='Some Reel details were not returned. Refresh all details to recover missing data.'
      where exists(select 1 from public.scrape_job_creators jc where jc.job_id=j.id and jc.creator_id=c.id)
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=j.owner_user_id);
    result:=result||jsonb_build_object('status','partial');
  end if;
  return result;
end $$;
revoke all on function public.worker_finish_processing(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_finish_processing(uuid,uuid) to service_role;

create function reel_detail_private.source_refresh_status(p_workspace_id uuid,p_creator_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; m public.transcription_media_refreshes; details jsonb; missing jsonb;
begin
  perform public.require_workspace(p_workspace_id);
  if auth.uid() is null or not public.is_allowed_owner() or not exists(select 1 from public.workspaces w
    join public.workspace_creators wc on wc.workspace_id=w.id where w.id=p_workspace_id and w.owner_user_id=auth.uid()
      and wc.creator_id=p_creator_id and wc.active) then raise exception 'creator_not_authorized' using errcode='42501'; end if;
  select sj.* into j from public.scrape_jobs sj join public.scrape_job_creators jc on jc.job_id=sj.id
    where sj.owner_user_id=auth.uid() and jc.creator_id=p_creator_id and sj.kind<>'profile'
    order by sj.created_at desc,sj.id desc limit 1;
  if j.id is null then return null; end if;
  select * into m from public.transcription_media_refreshes where job_id=j.id and owner_user_id=auth.uid();
  select jsonb_build_object('returned_reels',count(*),'missing_captions',count(*) filter(where not o.caption_received),
    'missing_media',count(*) filter(where not o.media_received)) into details
    from public.reel_fetch_observations o join public.reels r on r.id=o.reel_id where o.job_id=j.id and r.creator_id=p_creator_id;
  select coalesce(jsonb_agg(jsonb_build_object('reel_id',r.id,'shortcode',r.shortcode,
    'not_returned',o.reel_id is null,'caption_missing',coalesce(not o.caption_received,true),
    'media_missing',coalesce(not o.media_received,true)) order by r.shortcode),'[]') into missing
    from public.reels r left join public.reel_fetch_observations o on o.reel_id=r.id and o.job_id=j.id
    where r.creator_id=p_creator_id and (o.reel_id is not null or j.source_refresh and exists(
      select 1 from public.transcription_media_targets mt where mt.refresh_id=m.id and mt.reel_id=r.id))
      and (o.reel_id is null or not o.caption_received or not o.media_received);
  return details||jsonb_build_object('job_id',j.id,'status',j.status,'source_refresh',j.source_refresh,'results_limit',j.results_limit,
    'coverage_recorded',exists(select 1 from public.reel_fetch_observations where job_id=j.id),
    'expected_reels',case when j.source_refresh then m.target_count else null end,
    'missing_reels',case when j.source_refresh then (select count(*) from public.transcription_media_targets where refresh_id=m.id and observation_count=0) else 0 end,
    'missing',missing,'completed_at',j.completed_at);
end $$;
revoke all on function reel_detail_private.source_refresh_status(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.source_refresh_status(uuid,uuid) to authenticated;
create function public.get_creator_source_refresh(p_workspace_id uuid,p_creator_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
  select reel_detail_private.source_refresh_status(p_workspace_id,p_creator_id);
$$;
revoke all on function public.get_creator_source_refresh(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_creator_source_refresh(uuid,uuid) to authenticated;

-- Select only a currently captured candidate proven by the worker to contain
-- audio. This never reserves budget, submits speech or changes transcript state.
create function public.worker_transcription_select_media(p_attempt_id uuid,p_lease_token uuid,p_source_url text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; rid uuid; m public.reel_media_sources; urls text[];
begin
  perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
  a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
  if a.status<>'submitting' or a.submit_authorized or not public.transcription_valid_media_url(p_source_url) then
    raise exception 'invalid_verified_media' using errcode='22023';
  end if;
  select j.reel_id into rid from public.transcript_jobs j join public.reels r on r.id=j.reel_id
    where j.id=a.job_id and j.current_attempt_id=a.id and exists(select 1 from public.workspace_creators wc
      join public.workspaces w on w.id=wc.workspace_id join public.app_settings s on s.owner_user_id=w.owner_user_id
      where wc.creator_id=r.creator_id and wc.active and w.archived_at is null);
  if rid is null then raise exception 'reel_not_authorized' using errcode='42501'; end if;
  select * into m from public.reel_media_sources where reel_id=rid for update;
  if p_source_url is distinct from m.source_url and not coalesce(p_source_url=any(m.candidates),false) then
    return jsonb_build_object('selected',false,'reason','newer_source_observed');
  end if;
  urls:=array[p_source_url]||array_remove(coalesce(m.candidates,'{}'),p_source_url);
  update public.reel_media_sources set source_url=p_source_url,candidates=urls[1:16],has_audio=true where reel_id=rid;
  return jsonb_build_object('selected',true);
end $$;
revoke all on function public.worker_transcription_select_media(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_select_media(uuid,uuid,text) to service_role;
