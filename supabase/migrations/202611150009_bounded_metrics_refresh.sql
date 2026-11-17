-- Bound only metrics refresh to its frozen tracked set plus 50. No provider call,
-- schedule enablement, billing settlement or historical accepted-run rewrite.
set constraints all immediate;
alter table public.scrape_jobs add column metrics_tracked_count integer;
alter table public.scrape_jobs add constraint scrape_jobs_metrics_window_check check(
  metrics_tracked_count is null or (kind='metrics' and metrics_tracked_count>0
    and requested_profiles_count=1 and results_limit=least(metrics_tracked_count::bigint+50,10000)));
alter table public.scrape_jobs drop constraint scrape_jobs_results_limit_check;
alter table public.scrape_jobs add constraint scrape_jobs_results_limit_check check(
  (kind='backfill' and results_limit=100 and requested_profiles_count=1)
  or (kind='manual' and results_limit=100 and requested_profiles_count=1)
  or (kind='discovery' and results_limit=10000 and requested_profiles_count=1)
  or (kind='metrics' and requested_profiles_count=1 and (
    metrics_tracked_count is null and results_limit=10000
    or metrics_tracked_count is not null and metrics_tracked_count>0 and results_limit=least(metrics_tracked_count::bigint+50,10000)))
  or (kind not in ('backfill','discovery','metrics') and results_limit between 1 and 30)
  or (kind='carousel' and carousel_initial and results_limit=50 and requested_profiles_count=1)) not valid;

create function competitor_refresh_private.metrics_never_started(j public.scrape_jobs) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
  select j.status in ('pending','budget_paused') and not j.live and j.attempt_count=0
    and j.apify_account_slot is null and j.started_at is null and j.completed_at is null
    and j.dispatch_nonce is null and j.actor_run_id is null and j.expected_actor_id is null
    and j.expected_provider_user_id is null and j.dataset_id is null and j.dataset_cursor=0
    and not j.dataset_finished and j.processing_attempts=0 and j.provider_terminal_status is null
    and j.result_fetched_at is null and j.returned_records_count=0 and j.reserved_usd=0
    and j.actual_cost_usd is null and j.billing_reconciled_at is null and j.billing_month is null
    and j.lease_token is null and j.lease_expires_at is null
    and not j.output_summary_verified and j.output_summary_recorded_at is null
$$;

create function competitor_refresh_private.protect_metrics_window() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.competitor_refresh_runs; tracked integer;
begin
  if tg_op='UPDATE' then
    if old.metrics_tracked_count is not null then
      if new.metrics_tracked_count is distinct from old.metrics_tracked_count
        or new.results_limit is distinct from old.results_limit or new.kind is distinct from old.kind
        or new.owner_user_id is distinct from old.owner_user_id or new.competitor_run_id is distinct from old.competitor_run_id
        or new.id is distinct from old.id or new.workflow_attempt is distinct from old.workflow_attempt then
        raise exception 'metrics_window_is_durable' using errcode='23514';
      end if;
      return new;
    end if;
    if new.metrics_tracked_count is null then return new; end if;
    if not competitor_refresh_private.metrics_never_started(old) then
      raise exception 'metrics_window_already_started' using errcode='23514';
    end if;
  end if;
  if new.kind<>'metrics' then return new; end if;
  if not competitor_refresh_private.metrics_never_started(new) then
    raise exception 'metrics_window_requires_unstarted_job' using errcode='23514';
  end if;
  select * into r from public.competitor_refresh_runs where id=new.competitor_run_id
    and owner_user_id=new.owner_user_id and kind='metrics';
  if not found then raise exception 'metrics_run_identity_invalid' using errcode='42501'; end if;
  select count(*)::integer into tracked from public.competitor_refresh_targets t join public.reels reel on reel.id=t.reel_id
    where t.run_id=r.id and reel.creator_id=r.creator_id;
  if tracked<=0 or tracked<>r.expected_reels or tracked<>(select count(*) from public.competitor_refresh_targets where run_id=r.id) then
    raise exception 'metrics_targets_invalid' using errcode='23514';
  end if;
  if new.metrics_tracked_count is not null and new.metrics_tracked_count<>tracked then
    raise exception 'metrics_target_count_mismatch' using errcode='23514';
  end if;
  new.metrics_tracked_count:=tracked;
  new.results_limit:=least(tracked::bigint+50,10000);
  return new;
end $$;
create trigger metrics_window_durable before insert or update on public.scrape_jobs
  for each row execute function competitor_refresh_private.protect_metrics_window();

-- The trigger also bounds inserts from an older scheduler. Explicit new enqueue
-- fields keep retries at the same frozen run count rather than today's live count.
do $$ declare definition text; old_insert text; begin
  select pg_get_functiondef('public.worker_competitor_maintain(uuid)'::regprocedure) into definition;
  old_insert:=$old$competitor_run_id,workflow_attempt,collection_since,scheduled_for)
      values(p_owner_user_id,r.kind,1,10000,case when r.kind='discovery' then 20 else 10 end,
        r.id,r.attempt_count+1,r.since_at,now())$old$;
  if position(old_insert in definition)=0 then raise exception 'bounded_metrics_maintenance_contract_drift'; end if;
  execute replace(definition,old_insert,$new$competitor_run_id,workflow_attempt,collection_since,scheduled_for,metrics_tracked_count)
      values(p_owner_user_id,r.kind,1,case when r.kind='metrics' then least(r.expected_reels::bigint+50,10000) else 10000 end,
        case when r.kind='discovery' then 20 else 10 end,
        r.id,r.attempt_count+1,r.since_at,now(),case when r.kind='metrics' then r.expected_reels end)$new$);
end $$;

-- Only demonstrably never-started queue entries are upgraded. All accepted or
-- uncertain jobs retain their input, identity, hold and reconciliation contract.
update public.scrape_jobs j set metrics_tracked_count=r.expected_reels,
  results_limit=least(r.expected_reels::bigint+50,10000)
from public.competitor_refresh_runs r
where j.kind='metrics' and j.metrics_tracked_count is null and j.competitor_run_id=r.id
  and r.kind='metrics' and r.owner_user_id=j.owner_user_id and r.expected_reels>0
  and competitor_refresh_private.metrics_never_started(j)
  and r.expected_reels=(select count(*) from public.competitor_refresh_targets t join public.reels reel on reel.id=t.reel_id
    where t.run_id=r.id and reel.creator_id=r.creator_id)
  and r.expected_reels=(select count(*) from public.competitor_refresh_targets where run_id=r.id)
  and (select count(*) from public.scrape_job_creators where job_id=j.id)=1
  and exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=r.creator_id);

create function competitor_refresh_private.prepare_metrics_window(p_job uuid,p_owner uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; r public.competitor_refresh_runs; tracked integer;
begin
  select * into j from public.scrape_jobs where id=p_job and owner_user_id=p_owner for update;
  if not found then return false; end if;
  if j.kind<>'metrics' then return true; end if;
  if not competitor_refresh_private.metrics_never_started(j) then return false; end if;
  select * into r from public.competitor_refresh_runs where id=j.competitor_run_id and owner_user_id=p_owner and kind='metrics';
  if not found or (select count(*) from public.scrape_job_creators where job_id=j.id)<>1
    or not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=r.creator_id) then return false; end if;
  select count(*)::integer into tracked from public.competitor_refresh_targets t join public.reels reel on reel.id=t.reel_id
    where t.run_id=r.id and reel.creator_id=r.creator_id;
  if tracked<=0 or tracked<>r.expected_reels or tracked<>(select count(*) from public.competitor_refresh_targets where run_id=r.id) then return false; end if;
  if j.metrics_tracked_count is null then
    update public.scrape_jobs set metrics_tracked_count=tracked,results_limit=least(tracked::bigint+50,10000) where id=j.id;
  elsif j.metrics_tracked_count<>tracked or j.results_limit<>least(tracked::bigint+50,10000) or j.requested_profiles_count<>1 then
    return false;
  end if;
  return true;
end $$;

-- Guard the current core BEFORE monetary reservation. Preserve checkpoint usage,
-- account rotation, executor fencing, carousel provenance and existing lock order.
do $$ declare definition text; anchor text:=$old$  if j.apify_account_slot is not null$old$; begin
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into definition;
  if position(anchor in definition)=0 or position('headroom/slots' in definition)=0
    or position('unreconciled_charges' in definition)=0 then raise exception 'bounded_metrics_dispatch_contract_drift'; end if;
  execute replace(definition,anchor,$new$  if j.kind='metrics' then
    if not competitor_refresh_private.prepare_metrics_window(j.id,p_owner_user_id) then
      return jsonb_build_object('reason','provider_input_invalid');
    end if;
    select * into j from public.scrape_jobs where id=j.id;
  end if;
$new$||anchor);
  select pg_get_functiondef('public.get_bootstrap()'::regprocedure) into definition;
  anchor:='requested_profiles_count,results_limit,returned_records_count';
  if position(anchor in definition)=0 then raise exception 'bounded_metrics_bootstrap_contract_drift'; end if;
  execute replace(definition,anchor,'requested_profiles_count,results_limit,metrics_tracked_count,returned_records_count');
end $$;
revoke all on function competitor_refresh_private.metrics_never_started(public.scrape_jobs),
  competitor_refresh_private.protect_metrics_window(),competitor_refresh_private.prepare_metrics_window(uuid,uuid)
  from public,anon,authenticated,service_role;
