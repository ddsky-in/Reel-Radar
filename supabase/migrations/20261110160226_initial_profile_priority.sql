-- Initial profile metadata must not wait behind every Reel backfill in a bulk
-- import. This changes ordering and narrows profile run caps, not total budgets.
alter table public.scrape_jobs drop constraint scrape_jobs_priority_check,
  add constraint scrape_jobs_priority_check check (priority between 0 and 110);

create or replace function creator_profile_private.queue_missing_profiles(p_creator_ids uuid[],p_initial_only boolean)
returns uuid[] language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids uuid[]; jobs uuid[]; owner_id uuid:=auth.uid();
begin
  if owner_id is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_creator_ids is null or cardinality(p_creator_ids)=0 then return '{}'::uuid[]; end if;
  if cardinality(p_creator_ids)>1000 or array_position(p_creator_ids,null) is not null then
    raise exception 'invalid_creator_ids' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('queue:'||owner_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
  if exists(select 1 from unnest(p_creator_ids) x where not exists(
    select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
    where wc.creator_id=x and wc.active and w.archived_at is null and w.owner_user_id=owner_id)) then
    raise exception 'creator_not_authorized' using errcode='42501';
  end if;
  select array_agg(c.id order by c.username) into ids from public.creators c
    where c.id=any(p_creator_ids)
      and (nullif(trim(c.avatar_url),'') is null or c.followers_count is null or nullif(trim(c.display_name),'') is null)
      and (not p_initial_only or not exists(select 1 from public.scrape_jobs j
        join public.scrape_job_creators jc on jc.job_id=j.id
        where jc.creator_id=c.id and j.owner_user_id=owner_id and j.kind='profile'));
  jobs:=public.queue_creator_jobs(owner_id,coalesce(ids,'{}'),'profile');
  update public.scrape_jobs set priority=greatest(priority,110)
    where id=any(jobs) and owner_user_id=owner_id and kind='profile' and status='pending';
  return jobs;
end $$;
revoke all on function creator_profile_private.queue_missing_profiles(uuid[],boolean) from public,anon,authenticated,service_role;

-- The provider enforces the returned cap via maxTotalChargeUsd. A batch has at
-- most 20 minimal profiles; $0.025 is a hard ceiling, never an inferred charge.
-- Keep any stricter operator cap and all existing concurrency, identity,
-- uncertainty, owner, account-cycle, monthly-budget and envelope checks.
do $$ declare def text; old text:='when p_live then s.max_run_charge_usd else 0 end;'; begin
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into def;
  if (select count(*) from regexp_matches(def,'when p_live then s\.max_run_charge_usd else 0 end;','g'))<>1
    or def not like '%SET search_path TO ''pg_catalog'', ''public''%'
    or def not like '%manual_authorized_by=p_owner_user_id%'
    or def not like '%provider_cycle_usage_usd+cycle_unobserved+reserved+cap>s.provider_cycle_limit_usd%'
    or def not like '%envelope_committed+cap>envelope_limit%'
    or def not like '%reelradar.media_job_id%'
    or def not like '%max_total_charge_usd%' then
    raise exception 'profile_dispatch_contract_drift';
  end if;
  execute replace(def,old,'when p_live and j.kind=''profile'' then least(.025,s.max_run_charge_usd) when p_live then s.max_run_charge_usd else 0 end;');
end $$;

-- Promote existing authorized, unstarted metadata jobs too. Preserve run/job
-- identities, reservations, terminal results and uncertain starts. No new jobs
-- or external calls are created by this repair.
update public.scrape_jobs j set priority=greatest(j.priority,110)
where j.kind='profile' and j.status in ('pending','budget_paused')
  and j.actor_run_id is null and j.attempt_count=0 and j.reserved_usd=0
  and j.manual_authorized_by=j.owner_user_id
  and exists(select 1 from public.scrape_job_creators jc
    join public.creators c on c.id=jc.creator_id
    join public.workspace_creators wc on wc.creator_id=c.id
    join public.workspaces w on w.id=wc.workspace_id
    where jc.job_id=j.id and wc.active and w.archived_at is null and w.owner_user_id=j.owner_user_id
      and (nullif(trim(c.avatar_url),'') is null or c.followers_count is null or nullif(trim(c.display_name),'') is null));
