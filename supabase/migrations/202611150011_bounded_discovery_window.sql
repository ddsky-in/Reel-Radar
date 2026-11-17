-- Discovery requests are capped at 50, independently of tracked-count metrics.
-- No paid starts, schedule enablement, historical pin changes or hold releases.
set constraints all immediate;
alter table public.scrape_jobs add column discovery_bounded boolean not null default false;
alter table public.scrape_jobs add constraint scrape_jobs_discovery_window_check check(
  not discovery_bounded or (kind='discovery' and results_limit=50 and requested_profiles_count=1));
alter table public.scrape_jobs drop constraint scrape_jobs_results_limit_check;
alter table public.scrape_jobs add constraint scrape_jobs_results_limit_check check(
  (kind='backfill' and results_limit=100 and requested_profiles_count=1)
  or (kind='manual' and results_limit=100 and requested_profiles_count=1)
  or (kind='discovery' and requested_profiles_count=1 and ((discovery_bounded and results_limit=50) or (not discovery_bounded and results_limit=10000)))
  or (kind='metrics' and requested_profiles_count=1 and (
    metrics_tracked_count is null and results_limit=10000
    or metrics_tracked_count is not null and metrics_tracked_count>0 and results_limit=least(metrics_tracked_count::bigint+50,10000)))
  or (kind not in ('backfill','discovery','metrics') and results_limit between 1 and 30)
  or (kind='carousel' and carousel_initial and results_limit=50 and requested_profiles_count=1)) not valid;

create function competitor_refresh_private.protect_discovery_window() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' then
    if old.discovery_bounded then
      if new.discovery_bounded is distinct from old.discovery_bounded or new.results_limit is distinct from old.results_limit
        or new.kind is distinct from old.kind or new.owner_user_id is distinct from old.owner_user_id
        or new.competitor_run_id is distinct from old.competitor_run_id or new.workflow_attempt is distinct from old.workflow_attempt
        or new.collection_since is distinct from old.collection_since or new.id is distinct from old.id then
        raise exception 'discovery_window_is_durable' using errcode='23514';
      end if;
      return new;
    end if;
    if not new.discovery_bounded then return new; end if;
    if not competitor_refresh_private.metrics_never_started(old) then raise exception 'discovery_window_already_started' using errcode='23514'; end if;
  end if;
  if new.kind<>'discovery' then return new; end if;
  if not competitor_refresh_private.metrics_never_started(new) or not exists(select 1 from public.competitor_refresh_runs r
    where r.id=new.competitor_run_id and r.owner_user_id=new.owner_user_id and r.kind='discovery') then
    raise exception 'discovery_window_identity_invalid' using errcode='23514';
  end if;
  new.discovery_bounded:=true; new.results_limit:=50;
  return new;
end $$;
create trigger discovery_window_durable before insert or update on public.scrape_jobs
  for each row execute function competitor_refresh_private.protect_discovery_window();

update public.scrape_jobs j set discovery_bounded=true,results_limit=50
from public.competitor_refresh_runs r where j.kind='discovery' and not j.discovery_bounded
  and r.id=j.competitor_run_id and r.kind='discovery' and r.owner_user_id=j.owner_user_id
  and competitor_refresh_private.metrics_never_started(j)
  and (select count(*) from public.scrape_job_creators where job_id=j.id)=1
  and exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=r.creator_id);

create function competitor_refresh_private.prepare_discovery_window(p_job uuid,p_owner uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
  select * into j from public.scrape_jobs where id=p_job and owner_user_id=p_owner for update;
  if not found or j.kind<>'discovery' or not competitor_refresh_private.metrics_never_started(j) then return false; end if;
  if (select count(*) from public.scrape_job_creators where job_id=j.id)<>1 or not exists(
    select 1 from public.competitor_refresh_runs r join public.scrape_job_creators jc on jc.job_id=j.id and jc.creator_id=r.creator_id
    where r.id=j.competitor_run_id and r.owner_user_id=p_owner and r.kind='discovery') then return false; end if;
  if not j.discovery_bounded then update public.scrape_jobs set discovery_bounded=true,results_limit=50 where id=j.id;
  elsif j.results_limit<>50 or j.requested_profiles_count<>1 then return false; end if;
  return true;
end $$;

-- A fully reconciled 50-row OUTPUT can prove delivery of the bounded request,
-- but cannot prove exhaustion of the recent discovery window. Finish partial,
-- without a full-coverage watermark or an identical paid workflow retry.
create function competitor_refresh_private.discovery_cap_reached(j public.scrape_jobs) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select j.kind='discovery' and j.discovery_bounded and j.results_limit=50 and j.dataset_finished
    and j.dataset_cursor=50 and j.returned_records_count=50 and j.provider_terminal_status='SUCCEEDED'
    and j.output_summary_recorded_at is not null and not j.output_summary_verified
    and j.output_summary_reason='discovery_window_capped'
    and (select count(*) from public.scrape_job_creators where job_id=j.id)=1
    and exists(select 1 from public.scrape_job_creators where job_id=j.id and result_count=50 and received_count=50
      and summary_delivered_count=50 and error_message is null)
$$;

do $$ declare definition text; anchor text; begin
  select pg_get_functiondef('public.worker_competitor_maintain(uuid)'::regprocedure) into definition;
  anchor:='then least(r.expected_reels::bigint+50,10000) else 10000 end';
  if position(anchor in definition)=0 then raise exception 'discovery_enqueue_contract_drift'; end if;
  definition:=replace(definition,anchor,'then least(r.expected_reels::bigint+50,10000) else 50 end');
  anchor:=$old$      if j.status='uncertain' or j.live and j.actual_cost_usd is null then$old$;
  if position(anchor in definition)=0 then raise exception 'discovery_retry_contract_drift'; end if;
  execute replace(definition,anchor,$new$      if j.status='partial' and competitor_refresh_private.discovery_cap_reached(j) then
        update public.competitor_refresh_runs set status='partial',completed_at=coalesce(completed_at,now()),
          error_message='Discovery capped at 50 Reels; older results in the window may be missing. No automatic cap retry.' where id=r.id;
        continue;
      end if;
$new$||anchor);
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into definition;
  anchor:=$old$  if j.kind='metrics' then$old$;
  if position(anchor in definition)=0 or position('headroom/slots' in definition)=0 then raise exception 'discovery_dispatch_contract_drift'; end if;
  execute replace(definition,anchor,$new$  if j.kind='discovery' then
    if not competitor_refresh_private.prepare_discovery_window(j.id,p_owner_user_id) then return jsonb_build_object('reason','provider_input_invalid'); end if;
    select * into j from public.scrape_jobs where id=j.id;
  end if;
$new$||anchor);
  select pg_get_functiondef('public.get_bootstrap()'::regprocedure) into definition;
  anchor:='results_limit,metrics_tracked_count,returned_records_count';
  if position(anchor in definition)=0 then raise exception 'discovery_bootstrap_contract_drift'; end if;
  execute replace(definition,anchor,'results_limit,metrics_tracked_count,discovery_bounded,returned_records_count');
end $$;

alter function public.worker_finish_processing(uuid,uuid) rename to worker_finish_processing_pre_discovery_window;
revoke all on function public.worker_finish_processing_pre_discovery_window(uuid,uuid) from public,anon,authenticated,service_role;
create function public.worker_finish_processing(p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; j public.scrape_jobs;
begin
  perform public.require_service();
  result:=public.worker_finish_processing_pre_discovery_window(p_job_id,p_lease_token);
  select * into j from public.scrape_jobs where id=p_job_id;
  if j.status='partial' and competitor_refresh_private.discovery_cap_reached(j) then
    update public.scrape_jobs set error_message='Discovery capped at 50 Reels; older results in the window may be missing. No automatic cap retry.'
      where id=j.id returning * into j;
    update public.competitor_refresh_runs set status='partial',completed_at=coalesce(completed_at,now()),error_message=j.error_message
      where id=j.competitor_run_id and owner_user_id=j.owner_user_id;
    return to_jsonb(j);
  end if;
  return result;
end $$;
revoke all on function competitor_refresh_private.protect_discovery_window(),competitor_refresh_private.prepare_discovery_window(uuid,uuid),
  competitor_refresh_private.discovery_cap_reached(public.scrape_jobs),public.worker_finish_processing(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_finish_processing(uuid,uuid) to service_role;
