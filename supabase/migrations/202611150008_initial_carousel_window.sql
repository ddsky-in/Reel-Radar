-- Local forward-only rollout. No historical enrollment, cleanup, provider call,
-- schedule, configuration enablement, reservation or billing reconciliation.
set constraints all immediate;
create table carousel_automation_private.initial_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.app_settings(owner_user_id) on delete restrict,
  creator_id uuid not null references public.creators(id) on delete restrict,
  state text not null default 'pending' check(state in ('pending','bound','reused')),
  initial_job_id uuid unique references public.scrape_jobs(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(owner_user_id,creator_id),
  check((state='bound')=(initial_job_id is not null))
);
alter table carousel_automation_private.initial_requests enable row level security;
revoke all on carousel_automation_private.initial_requests from public,anon,authenticated,service_role;
create index initial_carousel_pending_owner on carousel_automation_private.initial_requests(owner_user_id,created_at,id)
  where state='pending';
-- Even concurrent owner adds cannot purchase two initial windows for one shared
-- canonical creator. Reused owner decisions remain individually durable.
create unique index initial_carousel_once_per_canonical on carousel_automation_private.initial_requests(creator_id)
  where state in ('pending','bound');

alter table public.scrape_jobs
  add column carousel_initial boolean not null default false,
  add column carousel_initial_request_id uuid unique references carousel_automation_private.initial_requests(id) on delete restrict,
  add constraint scrape_jobs_carousel_initial_check check(
    (not carousel_initial and carousel_initial_request_id is null) or
    (carousel_initial and carousel_initial_request_id is not null and kind='carousel' and carousel_automatic
      and results_limit=50 and requested_profiles_count=1 and manual_authorized_by is not null
      and manual_authorized_by=owner_user_id and carousel_automation_scheduled_at is not null
      and dataset_cursor<=50 and returned_records_count<=50));
-- Preserve the inherited NOT VALID constraint: old holdings are not rescanned or
-- changed. The sole new allowance is a provenance-checked initial carousel50.
alter table public.scrape_jobs drop constraint scrape_jobs_results_limit_check;
alter table public.scrape_jobs add constraint scrape_jobs_results_limit_check check(
  (kind='backfill' and results_limit=100 and requested_profiles_count=1)
  or (kind='manual' and results_limit=100 and requested_profiles_count=1)
  or (kind in ('discovery','metrics') and results_limit=10000 and requested_profiles_count=1)
  or (kind not in ('backfill','discovery','metrics') and results_limit between 1 and 30)
  or (kind='carousel' and carousel_initial and results_limit=50 and requested_profiles_count=1)) not valid;

-- A request is a one-way durable decision, not another retry queue. Removing a
-- workspace, a failed/empty result, or re-adding the handle cannot reset it.
create function carousel_automation_private.protect_initial_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then raise exception 'initial_carousel_request_is_durable' using errcode='23514'; end if;
  if new.id is distinct from old.id or new.owner_user_id is distinct from old.owner_user_id
    or new.creator_id is distinct from old.creator_id or new.created_at is distinct from old.created_at
    or old.state<>'pending' and (new.state is distinct from old.state or new.initial_job_id is distinct from old.initial_job_id) then
    raise exception 'initial_carousel_request_is_durable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger initial_carousel_request_durable before update or delete on carousel_automation_private.initial_requests
  for each row execute function carousel_automation_private.protect_initial_request();

create function carousel_automation_private.protect_initial_job() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- Never upgrade existing manual30 jobs or strip a bound job's provenance.
  if new.carousel_initial is distinct from old.carousel_initial
    or new.carousel_initial_request_id is distinct from old.carousel_initial_request_id
    or old.carousel_initial and (new.id is distinct from old.id or new.owner_user_id is distinct from old.owner_user_id) then
    raise exception 'initial_carousel_job_is_durable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger initial_carousel_job_durable before update on public.scrape_jobs
  for each row when (old.carousel_initial or new.carousel_initial)
  execute function carousel_automation_private.protect_initial_job();

-- Deferred checks allow the request, job and creator link to be inserted in one
-- transaction, but forbid a bare flag, wrong owner, extra link or forged pointer.
create function carousel_automation_private.assert_initial_job(p_job uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; r carousel_automation_private.initial_requests;
begin
  select * into j from public.scrape_jobs where id=p_job;
  if not found or not j.carousel_initial then return; end if;
  select * into r from carousel_automation_private.initial_requests where id=j.carousel_initial_request_id;
  if not found or r.state<>'bound' or r.initial_job_id is distinct from j.id
    or r.owner_user_id is distinct from j.owner_user_id
    or (select count(*) from public.scrape_job_creators where job_id=j.id)<>1
    or not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=r.creator_id) then
    raise exception 'invalid_initial_carousel_provenance' using errcode='23514';
  end if;
end $$;
create function carousel_automation_private.check_initial_provenance() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r carousel_automation_private.initial_requests;
begin
  if tg_table_name='initial_requests' then
    select * into r from carousel_automation_private.initial_requests where id=new.id;
    if r.state='bound' then
      if not exists(select 1 from public.scrape_jobs where id=r.initial_job_id and carousel_initial
        and carousel_initial_request_id=r.id and owner_user_id=r.owner_user_id) then
        raise exception 'invalid_initial_carousel_provenance' using errcode='23514';
      end if;
      perform carousel_automation_private.assert_initial_job(r.initial_job_id);
    end if;
  elsif tg_table_name='scrape_jobs' then
    perform carousel_automation_private.assert_initial_job(new.id);
  else
    if tg_op<>'INSERT' then perform carousel_automation_private.assert_initial_job(old.job_id); end if;
    if tg_op<>'DELETE' then perform carousel_automation_private.assert_initial_job(new.job_id); end if;
  end if;
  return null;
end $$;
create constraint trigger initial_carousel_request_provenance after insert or update on carousel_automation_private.initial_requests
  deferrable initially deferred for each row execute function carousel_automation_private.check_initial_provenance();
create constraint trigger initial_carousel_job_provenance after insert or update on public.scrape_jobs
  deferrable initially deferred for each row when (new.carousel_initial)
  execute function carousel_automation_private.check_initial_provenance();
create constraint trigger initial_carousel_creator_provenance after insert or update or delete on public.scrape_job_creators
  deferrable initially deferred for each row execute function carousel_automation_private.check_initial_provenance();

-- Extend only the inherited provider input allowlist. The allocator, account
-- choice, reservation, paid pin, manual100 and automatic claim wrappers remain.
do $$ declare definition text; old_guard text:=$old$j.kind not in ('profile','backfill','discovery','metrics') and j.results_limit not between 10 and 30$old$;
begin
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into definition;
  if position(old_guard in definition)=0 or position('headroom/slots' in definition)=0
    or position('unreconciled_charges' in definition)=0 then
    raise exception 'initial_carousel_dispatch_contract_drift';
  end if;
  definition:=replace(definition,old_guard,old_guard||$new$
    and not (j.kind='carousel' and j.carousel_initial and j.carousel_automatic and j.results_limit=50
      and j.requested_profiles_count=1 and j.manual_authorized_by=p_owner_user_id
      and j.carousel_automation_scheduled_at is not null and exists(
        select 1 from carousel_automation_private.initial_requests r join public.scrape_job_creators jc
          on jc.job_id=r.initial_job_id and jc.creator_id=r.creator_id
        where r.id=j.carousel_initial_request_id and r.state='bound' and r.initial_job_id=j.id
          and r.owner_user_id=p_owner_user_id and (select count(*) from public.scrape_job_creators where job_id=j.id)=1))$new$);
  execute definition;
end $$;

-- The single, bulk and CSV import paths all resolve this private signature.
-- Revoke the inherited helper BEFORE replacement; it is never a browser bypass.
alter function creator_profile_private.add_creator(uuid,text,boolean) rename to add_creator_pre_initial_carousel;
revoke all on function creator_profile_private.add_creator_pre_initial_carousel(uuid,text,boolean) from public,anon,authenticated,service_role;
create function creator_profile_private.add_creator(p_workspace_id uuid,p_username text,p_queue_profile boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid(); existing_id uuid; previously_linked boolean; result jsonb; cid uuid;
begin
  perform public.require_workspace(p_workspace_id);
  if owner_id is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||owner_id::text,0));
  select id into existing_id from public.creators where username=public.normalize_username(p_username);
  previously_linked:=exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
    where wc.creator_id=existing_id and w.owner_user_id=owner_id);
  result:=creator_profile_private.add_creator_pre_initial_carousel(p_workspace_id,p_username,p_queue_profile);
  cid:=(result->>'id')::uuid;
  -- Serialize shared canonical decisions after the inherited insert (without
  -- taking handle locks that would invert bulk-import/queue lock ordering).
  perform 1 from public.creators where id=cid for update;
  -- No backfill of the old owner cohort, even on repeated add/reactivation. A
  -- newly linked shared canonical creator is reused, not a second paid import.
  if existing_id is null or not previously_linked then
    insert into carousel_automation_private.initial_requests(owner_user_id,creator_id,state)
      values(owner_id,cid,case when existing_id is null and not exists(
        select 1 from carousel_automation_private.initial_requests where creator_id=cid and state in ('pending','bound'))
        then 'pending' else 'reused' end)
      on conflict(owner_user_id,creator_id) do nothing;
  end if;
  return result;
end $$;
revoke all on function creator_profile_private.add_creator(uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function creator_profile_private.add_creator(uuid,text,boolean) to authenticated;

-- Only new initial requests alter candidate selection. Keep the ordinary daily30
-- body, legacy adoption, disabled reasons and budget/claim stack otherwise intact.
alter function public.worker_carousel_maintain(uuid,integer) set schema carousel_automation_private;
alter function carousel_automation_private.worker_carousel_maintain(uuid,integer) rename to maintain_pre_initial;
revoke all on function carousel_automation_private.maintain_pre_initial(uuid,integer) from public,anon,authenticated,service_role;
do $$ declare definition text; old_filter text:=$old$where c.status not in ('private','unavailable','paused') and exists($old$;
begin
  select pg_get_functiondef('carousel_automation_private.maintain_pre_initial(uuid,integer)'::regprocedure) into definition;
  if position(old_filter in definition)=0 or position('results_limit<>30' in definition)=0 then
    raise exception 'initial_carousel_maintenance_contract_drift';
  end if;
  definition:=replace(definition,old_filter,$new$where c.status not in ('private','unavailable','paused')
      and not exists(select 1 from carousel_automation_private.initial_requests initial
        left join public.scrape_jobs initial_job on initial_job.id=initial.initial_job_id
        where initial.owner_user_id=p_owner_user_id and initial.creator_id=c.id and (
          initial.state='pending' or initial.state='bound' and initial_job.status<>'succeeded'
          or initial.state='reused' and exists(select 1 from public.scrape_jobs backlog
            join public.scrape_job_creators links on links.job_id=backlog.id
            where backlog.owner_user_id=p_owner_user_id and backlog.kind='carousel' and links.creator_id=c.id
              and backlog.status in ('pending','budget_paused'))))
      and exists($new$);
  execute definition;
end $$;

create function public.worker_carousel_maintain(p_owner_user_id uuid,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; cfg public.carousel_automation_settings; candidate record;
  jid uuid; jobs uuid[]:='{}'; created integer:=0; reason text; ordinary jsonb;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_limit is null or p_limit not between 1 and 10 then
    raise exception 'invalid_carousel_maintenance_scope' using errcode='22023';
  end if;
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

  for candidate in
    select r.id,r.creator_id,history.last_attempt_at from carousel_automation_private.initial_requests r
    join public.creators c on c.id=r.creator_id
    cross join lateral carousel_automation_private.cadence(p_owner_user_id,c.id) history
    where r.owner_user_id=p_owner_user_id and r.state='pending' and c.status not in ('private','unavailable','paused')
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)
    order by r.created_at,r.id for update of r skip locked
  loop
    exit when cardinality(jobs)>=p_limit;
    -- Any stored shared carousel history or existing carousel attempt wins. In
    -- particular, await manual30 without upgrading, adopting or duplicating it.
    if exists(select 1 from public.carousel_posts where creator_id=candidate.creator_id)
      or exists(select 1 from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id
        where jc.creator_id=candidate.creator_id and j.kind='carousel') then
      update carousel_automation_private.initial_requests set state='reused' where id=candidate.id;
      continue;
    end if;
    if candidate.last_attempt_at is not null and candidate.last_attempt_at>now()-interval '24 hours' then continue; end if;
    -- The pointer, exact single creator and stable scheduled stamp commit with
    -- the job. Repeated maintenance never allocates a second initial attempt.
    insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,estimated_cost_usd,
      manual_authorized_by,priority,carousel_automatic,carousel_automation_scheduled_at,carousel_initial,carousel_initial_request_id)
    values(p_owner_user_id,'carousel',50,1,0,p_owner_user_id,5,true,now(),true,candidate.id) returning id into jid;
    insert into public.scrape_job_creators(job_id,creator_id) values(jid,candidate.creator_id);
    update carousel_automation_private.initial_requests set state='bound',initial_job_id=jid where id=candidate.id;
    jobs:=array_append(jobs,jid); created:=created+1;
  end loop;
  if cardinality(jobs)=p_limit then return jsonb_build_object('job_ids',jobs,'created',created,'adopted',0); end if;
  ordinary:=carousel_automation_private.maintain_pre_initial(p_owner_user_id,p_limit-cardinality(jobs));
  return jsonb_build_object('job_ids',to_jsonb(jobs)||(ordinary->'job_ids'),
    'created',created+(ordinary->>'created')::integer,'adopted',(ordinary->>'adopted')::integer);
end $$;
revoke all on function public.worker_carousel_maintain(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.worker_carousel_maintain(uuid,integer) to service_role;
revoke all on all functions in schema carousel_automation_private from public,anon,authenticated,service_role;
comment on column public.scrape_jobs.carousel_initial is 'Future-only single-creator bounded initial carousel window; not a full-history backfill or retry policy.';
comment on column public.scrape_jobs.carousel_initial_request_id is 'Private durable owner/creator request provenance; checked against its permanent initial job and canonical creator link.';
comment on table carousel_automation_private.initial_requests is 'Future add-only initial carousel decisions. Pending, permanently bound, or reused shared history; no historical enrollment or browser/realtime payload.';
