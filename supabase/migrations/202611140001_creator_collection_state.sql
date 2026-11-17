-- Read-only owner collection diagnostics. No queue maintenance, reservations,
-- settings changes, schedules, or provider requests are performed by this RPC.
create function public.get_creator_collection_state(p_workspace_id uuid,p_creator_ids uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  owner_id uuid:=auth.uid();
  s public.app_settings;
  selected_ids uuid[];
  reason text;
  blocking_job_id uuid;
  pending_ids uuid[];
  active_ids uuid[];
  profiles jsonb;
  month_start date:=date_trunc('month',now() at time zone 'UTC')::date;
  committed numeric;
  reserved numeric;
  cycle_unobserved numeric;
  active_count integer;
begin
  if owner_id is null or not public.is_allowed_owner() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  perform public.require_workspace(p_workspace_id);
  if p_creator_ids is not null and (cardinality(p_creator_ids)>120 or exists(select 1 from unnest(p_creator_ids) cid where cid is null or not exists(
    select 1 from public.workspace_creators wc
    where wc.workspace_id=p_workspace_id and wc.creator_id=cid and wc.active))) then
    raise exception 'creator_not_in_workspace' using errcode='42501';
  end if;
  -- Active means the workspace association, not canonical creator status:
  -- newly imported creators can still be pending while their profile is fetched.
  select coalesce(array_agg(wc.creator_id order by wc.creator_id),'{}'::uuid[]) into selected_ids
    from public.workspace_creators wc
    where wc.workspace_id=p_workspace_id and wc.active
      and (p_creator_ids is null or wc.creator_id=any(p_creator_ids));
  select * into s from public.app_settings where owner_user_id=owner_id;

  -- The full owner ledger is deliberately independent of selected creators,
  -- workspace, job kind, billing month, and any bootstrap/latest-50 window.
  -- This is the dispatcher's unknown accepted-start/final-charge predicate.
  select j.id into blocking_job_id from public.scrape_jobs j
    where j.owner_user_id=owner_id and j.live and
      (j.status='uncertain' or j.status in ('succeeded','partial','failed') and j.actual_cost_usd is null
        or j.provider_terminal_status is not null and j.actual_cost_usd is null)
    order by j.created_at,j.id limit 1;
  select coalesce(sum(j.actual_cost_usd) filter(where j.live and j.billing_month=month_start),0),
    coalesce(sum(j.reserved_usd) filter(where j.live),0),
    coalesce(sum(j.actual_cost_usd) filter(where j.live and j.billing_reconciled_at>s.provider_usage_checked_at),0),
    count(*) filter(where j.status in ('dispatching','running','processing','uncertain'))
    into committed,reserved,cycle_unobserved,active_count
    from public.scrape_jobs j where j.owner_user_id=owner_id;
  if blocking_job_id is not null then reason:='unreconciled_charges';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif not s.initial_backfill_enabled then reason:='initial_import_disabled';
  elsif s.provider_account_id is null or s.provider_usage_checked_at is null
    or s.provider_usage_checked_at<now()-interval '15 minutes'
    or s.provider_usage_checked_at>now()+interval '1 minute'
    or s.provider_cycle_start_at is null or s.provider_cycle_end_at is null
    or s.provider_cycle_start_at>now() or s.provider_cycle_end_at<=now()
    or s.provider_cycle_usage_usd is null or s.provider_cycle_limit_usd is null then reason:='usage_unverified';
  elsif least(s.monthly_budget_usd-committed-reserved,
    s.provider_cycle_limit_usd-s.provider_cycle_usage_usd-cycle_unobserved-reserved)<=0 then reason:='budget_paused';
  elsif active_count>=2 then reason:='concurrency_limit';
  end if;
  -- s.paused controls scheduled collection only; manual imports remain allowed.

  -- EXISTS deduplicates batched/shared creator links. Return only owner jobs
  -- relevant to active selected associations; carousel work is a separate UI.
  select coalesce(array_agg(j.id order by j.priority desc,j.scheduled_for,j.created_at,j.id)
      filter(where j.status in ('pending','budget_paused')),'{}'::uuid[]),
    coalesce(array_agg(j.id order by j.priority desc,j.scheduled_for,j.created_at,j.id)
      filter(where j.status in ('dispatching','running','processing','uncertain')),'{}'::uuid[])
    into pending_ids,active_ids
    from public.scrape_jobs j
    where j.owner_user_id=owner_id and j.kind<>'carousel'
      and exists(select 1 from public.scrape_job_creators jc where jc.job_id=j.id and jc.creator_id=any(selected_ids));
  -- No fabricated entries when a creator has never had a profile job. Terminal
  -- statuses remain visible, and a newer backfill cannot replace profile state.
  select coalesce(jsonb_agg(jsonb_build_object('creator_id',latest.creator_id,'job_id',latest.job_id,'status',latest.status)
    order by latest.creator_id),'[]'::jsonb) into profiles from (
      select distinct on (jc.creator_id) jc.creator_id,j.id job_id,j.status
      from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
      where j.owner_user_id=owner_id and j.kind='profile' and jc.creator_id=any(selected_ids)
      order by jc.creator_id,j.created_at desc,j.id desc
    ) latest;
  return jsonb_build_object('reason',reason,'blocking_job_id',blocking_job_id,
    'pending_job_ids',pending_ids,'active_job_ids',active_ids,'profiles',profiles);
end $$;
revoke all on function public.get_creator_collection_state(uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.get_creator_collection_state(uuid,uuid[]) to authenticated;
