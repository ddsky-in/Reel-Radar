-- Forward-only daily COMBINED profile metadata refresh. No provider calls,
-- enabled schedule, backfill changes, accepted-attempt rewrites or hold releases.
set constraints all immediate;
do $$ begin
  if to_regprocedure('competitor_refresh_private.prepare_metrics_window(uuid,uuid)') is null
    or position('prepare_metrics_window' in pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure))=0 then
    raise exception 'daily_profile_requires_bounded_metrics_009';
  end if;
end $$;
create schema profile_automation_private;
revoke all on schema profile_automation_private from public,anon,authenticated,service_role;
create table profile_automation_private.settings (
  owner_user_id uuid primary key references public.app_settings(owner_user_id) on delete restrict,
  enabled boolean not null default false,
  provider_validated boolean not null default false,
  configured_at timestamptz,
  last_maintenance_at timestamptz,
  check(not enabled or provider_validated)
);
alter table profile_automation_private.settings enable row level security;
revoke all on profile_automation_private.settings from public,anon,authenticated,service_role;
insert into profile_automation_private.settings(owner_user_id) select owner_user_id from public.app_settings;
create function profile_automation_private.provision() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  insert into profile_automation_private.settings(owner_user_id) values(new.owner_user_id);
  return new;
end $$;
create trigger app_settings_profile_automation after insert on public.app_settings
for each row execute function profile_automation_private.provision();
-- Follow 003's deferred owner-before-family feed. Throttle bookkeeping is not
-- user configuration and must not acquire revision locks during queue work.
create constraint trigger owner_revision_changed after insert or delete on profile_automation_private.settings
  deferrable initially deferred for each row execute function public.signal_owner_revision();
create constraint trigger owner_revision_configuration_changed after update on profile_automation_private.settings
  deferrable initially deferred for each row when (old.enabled is distinct from new.enabled
    or old.provider_validated is distinct from new.provider_validated or old.configured_at is distinct from new.configured_at)
  execute function public.signal_owner_revision();
create constraint trigger owner_resource_revision_changed after insert or delete on profile_automation_private.settings
  deferrable initially deferred for each row execute function public.signal_owner_resource_revision('settings','jobs');
create constraint trigger owner_resource_revision_configuration_changed after update on profile_automation_private.settings
  deferrable initially deferred for each row when (old.enabled is distinct from new.enabled
    or old.provider_validated is distinct from new.provider_validated or old.configured_at is distinct from new.configured_at)
  execute function public.signal_owner_resource_revision('settings','jobs');

alter table public.scrape_jobs
  add column profile_automatic boolean not null default false,
  add column profile_automation_scheduled_at timestamptz,
  add constraint scrape_jobs_profile_automatic_check check(
    (profile_automatic and kind='profile' and results_limit=1 and requested_profiles_count between 1 and 20
      and manual_authorized_by is not null and manual_authorized_by=owner_user_id and profile_automation_scheduled_at is not null)
    or (not profile_automatic and profile_automation_scheduled_at is null));
create index scrape_jobs_profile_cadence_idx on public.scrape_jobs(owner_user_id,scheduled_for) where kind='profile';

-- A transient, private authorization for ONLY IDs returned by this invocation of
-- the existing queue helper. No JWT/GUC impersonation and no legacy-job adoption.
-- The marking trigger consumes the scope in the same transaction; normal service
-- callers can enqueue unauthorized profiles but cannot grant them manual consent.
create table profile_automation_private.queue_scope (
  job_id uuid primary key references public.scrape_jobs(id) on delete cascade,
  owner_user_id uuid not null,
  scheduled_at timestamptz not null
);
alter table profile_automation_private.queue_scope enable row level security;
revoke all on profile_automation_private.queue_scope from public,anon,authenticated,service_role;
create function profile_automation_private.never_started(j public.scrape_jobs) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
  select j.status in ('pending','budget_paused') and not j.live and j.attempt_count=0
    and j.started_at is null and j.completed_at is null and j.apify_account_slot is null
    and j.dispatch_nonce is null and j.actor_run_id is null and j.expected_actor_id is null
    and j.expected_provider_user_id is null and j.dataset_id is null and j.dataset_cursor=0
    and not j.dataset_finished and j.processing_attempts=0 and j.provider_terminal_status is null
    and j.result_fetched_at is null and j.returned_records_count=0 and j.reserved_usd=0
    and j.actual_cost_usd is null and j.billing_reconciled_at is null and j.billing_month is null
    and j.lease_token is null and j.lease_expires_at is null
    and not j.output_summary_verified and j.output_summary_recorded_at is null
$$;
create function profile_automation_private.protect_provenance() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare scope profile_automation_private.queue_scope;
begin
  if tg_op='UPDATE' and old.profile_automatic then
    if new.profile_automatic is distinct from old.profile_automatic
      or new.profile_automation_scheduled_at is distinct from old.profile_automation_scheduled_at
      or new.id is distinct from old.id or new.owner_user_id is distinct from old.owner_user_id
      or new.kind is distinct from old.kind or new.results_limit is distinct from old.results_limit
      or new.requested_profiles_count is distinct from old.requested_profiles_count
      or new.manual_authorized_by is distinct from old.manual_authorized_by then
      raise exception 'profile_automation_provenance_is_durable' using errcode='23514';
    end if;
    return new;
  end if;
  if new.profile_automatic then
    if tg_op<>'UPDATE' then raise exception 'profile_automation_queue_scope_required' using errcode='42501'; end if;
    delete from profile_automation_private.queue_scope where job_id=new.id and owner_user_id=new.owner_user_id
      and scheduled_at=new.profile_automation_scheduled_at returning * into scope;
    if not found or not profile_automation_private.never_started(old)
      or not profile_automation_private.never_started(new) or old.manual_authorized_by is not null
      or new.kind<>'profile' or old.kind<>'profile' or new.id<>old.id or new.owner_user_id<>old.owner_user_id
      or not exists(select 1 from profile_automation_private.settings a join public.app_settings s using(owner_user_id)
        where a.owner_user_id=new.owner_user_id and a.enabled and a.provider_validated and s.scraping_enabled and not s.paused) then
      raise exception 'profile_automation_queue_scope_required' using errcode='42501';
    end if;
  elsif new.kind='profile' and auth.role()='service_role' and new.manual_authorized_by is not null
    and (tg_op='INSERT' or new.manual_authorized_by is distinct from old.manual_authorized_by
      or new.kind is distinct from old.kind or new.owner_user_id is distinct from old.owner_user_id) then
    raise exception 'profile_manual_authorization_requires_owner' using errcode='42501';
  end if;
  return new;
end $$;
create trigger profile_automation_provenance before insert or update on public.scrape_jobs
for each row execute function profile_automation_private.protect_provenance();

-- Persisted profile captures are valid cadence evidence even when only some
-- fields were returned or OUTPUT summary verification was unavailable. Billing
-- remains unknown until independently reconciled by the existing allocator.
create function profile_automation_private.cadence(p_owner uuid,p_creator uuid,p_exclude_job uuid default null)
returns table(last_attempt_at timestamptz,last_fetch_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  select greatest(c.last_profile_fetch_at,(select max(greatest(j.profile_automation_scheduled_at,j.scheduled_for,j.started_at))
    from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
    where j.owner_user_id=p_owner and j.kind='profile' and jc.creator_id=c.id and j.id is distinct from p_exclude_job)),
    c.last_profile_fetch_at
  from public.creators c where c.id=p_creator
$$;
create function profile_automation_private.eligible(p_owner uuid,p_creator uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.creators c where c.id=p_creator and c.status not in ('private','unavailable','paused')
    and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
      where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner))
$$;
create function profile_automation_private.blocked(p_owner uuid,p_creator uuid,p_exclude_job uuid default null) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
    where j.owner_user_id=p_owner and jc.creator_id=p_creator and j.id is distinct from p_exclude_job and (
      j.status in ('dispatching','running','processing','uncertain')
      or j.kind='profile' and j.status in ('pending','budget_paused')
      or j.processing_attempts>=10 and j.status<>'succeeded'
      or j.live and j.actual_cost_usd is null and (j.attempt_count>0 or j.started_at is not null or j.dispatch_nonce is not null
        or j.actor_run_id is not null or j.apify_account_slot is not null or j.provider_terminal_status is not null)))
$$;
create function profile_automation_private.claim_reason(p_job uuid,p_owner uuid) returns text
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; cfg profile_automation_private.settings; s public.app_settings;
begin
  select * into j from public.scrape_jobs where id=p_job and owner_user_id=p_owner;
  if not found then return 'profile_scope_invalid'; end if;
  if not j.profile_automatic then return null; end if;
  select * into cfg from profile_automation_private.settings where owner_user_id=p_owner;
  select * into s from public.app_settings where owner_user_id=p_owner;
  if not coalesce(cfg.enabled,false) then return 'disabled'; end if;
  if not coalesce(cfg.provider_validated,false) then return 'setup_required'; end if;
  if not coalesce(s.scraping_enabled,false) then return 'globalscraping_disabled'; end if;
  if s.paused then return 'paused'; end if;
  if not profile_automation_private.never_started(j) or j.kind<>'profile' or j.results_limit<>1
    or j.requested_profiles_count not between 1 and 20 or j.manual_authorized_by is distinct from p_owner
    or j.profile_automation_scheduled_at is null
    or (select count(*) from public.scrape_job_creators where job_id=j.id)<>j.requested_profiles_count
    or exists(select 1 from public.scrape_job_creators jc
      cross join lateral profile_automation_private.cadence(p_owner,jc.creator_id,j.id) h where jc.job_id=j.id
      and (not profile_automation_private.eligible(p_owner,jc.creator_id)
        or profile_automation_private.blocked(p_owner,jc.creator_id,j.id)
        or h.last_attempt_at>now()-interval '24 hours')) then
    return 'profile_overlap_or_ineligible_attempt';
  end if;
  return null;
end $$;

create function public.worker_configure_profile_automation(p_owner_user_id uuid,p_enabled boolean,p_provider_validated boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_owner_user_id is null or p_enabled is null or p_provider_validated is null or p_enabled and not p_provider_validated then
    raise exception 'invalid_profile_automation_configuration' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  update profile_automation_private.settings set enabled=p_enabled,provider_validated=p_provider_validated,configured_at=clock_timestamp()
    where owner_user_id=p_owner_user_id;
  return jsonb_build_object('enabled',p_enabled,'provider_validated',p_provider_validated);
end $$;
create function profile_automation_private.queue_new(p_owner uuid,p_ids uuid[],p_stamp timestamptz) returns uuid[]
language plpgsql security definer set search_path=pg_catalog,public as $$
declare jobs uuid[];
begin
  perform public.require_service();
  if cardinality(p_ids) not between 1 and 20 or array_position(p_ids,null) is not null
    or not exists(select 1 from profile_automation_private.settings a join public.app_settings s using(owner_user_id)
      where a.owner_user_id=p_owner and a.enabled and a.provider_validated and s.scraping_enabled and not s.paused) then
    raise exception 'profile_automation_not_authorized' using errcode='42501';
  end if;
  jobs:=public.queue_creator_jobs(p_owner,p_ids,'profile');
  if cardinality(jobs)>1 then raise exception 'profile_automation_batch_contract_drift'; end if;
  insert into profile_automation_private.queue_scope(job_id,owner_user_id,scheduled_at) select unnest(jobs),p_owner,p_stamp;
  update public.scrape_jobs set profile_automatic=true,profile_automation_scheduled_at=p_stamp,manual_authorized_by=p_owner
    where id=any(jobs) and owner_user_id=p_owner and kind='profile';
  return jobs;
end $$;
create function public.worker_profile_maintain(p_owner_user_id uuid,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; cfg profile_automation_private.settings; ids uuid[]; jobs uuid[]:='{}'; stamp timestamptz; reason text; created integer:=0;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_limit is null or p_limit not between 1 and 20 then
    raise exception 'invalid_profile_maintenance_scope' using errcode='22023';
  end if;
  -- Match add/import: capacity -> queue -> budget -> settings. Durable throttle is
  -- owner-global across ticks/restarts; toggling configuration never resets it.
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||p_owner_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('queue:'||p_owner_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into s from public.app_settings where owner_user_id=p_owner_user_id for update;
  select * into cfg from profile_automation_private.settings where owner_user_id=p_owner_user_id for update;
  stamp:=clock_timestamp();
  if s.owner_user_id is null then reason:='owner_not_provisioned';
  elsif not coalesce(cfg.enabled,false) then reason:='disabled';
  elsif not coalesce(cfg.provider_validated,false) then reason:='setup_required';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif s.paused then reason:='paused';
  elsif cfg.last_maintenance_at>stamp-interval '5 minutes' then reason:='maintenance_throttled'; end if;
  if reason is null then
    update profile_automation_private.settings set last_maintenance_at=stamp where owner_user_id=p_owner_user_id;
    select array_agg(candidate.id order by candidate.last_attempt_at asc nulls first,candidate.id) into ids from (
      select c.id,h.last_attempt_at from public.creators c
      cross join lateral profile_automation_private.cadence(p_owner_user_id,c.id) h
      where profile_automation_private.eligible(p_owner_user_id,c.id)
        and not profile_automation_private.blocked(p_owner_user_id,c.id)
        and (h.last_attempt_at is null or h.last_attempt_at<=now()-interval '24 hours')
      order by h.last_attempt_at asc nulls first,c.id limit p_limit
    ) candidate;
    if coalesce(cardinality(ids),0)>0 then jobs:=profile_automation_private.queue_new(p_owner_user_id,ids,stamp); end if;
    if cardinality(jobs)=0 then reason:='no_due_profiles';
    else created:=cardinality(jobs); end if;
  end if;
  return jsonb_build_object('job_ids',jobs,'created',created,'reason',reason);
end $$;

-- Read-only owner-global status. Account reasons reuse the authoritative registry,
-- including checkpoint-conservative costs; never expose provider identity/secrets.
create function public.get_profile_automation_status() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid(); s public.app_settings; cfg profile_automation_private.settings; registry jsonb;
  reason text; pending integer; active integer; due_count integer; fetched timestamptz; due timestamptz; committed numeric; reserved numeric;
begin
  if auth.role() is distinct from 'authenticated' or owner_id is null or not public.is_allowed_owner() then
    raise exception 'forbidden' using errcode='42501'; end if;
  select * into s from public.app_settings where owner_user_id=owner_id;
  select * into cfg from profile_automation_private.settings where owner_user_id=owner_id;
  select count(*) filter(where status in ('pending','budget_paused'))::integer,
    count(*) filter(where status in ('dispatching','running','processing','uncertain'))::integer into pending,active
    from public.scrape_jobs where owner_user_id=owner_id and kind='profile';
  select count(*) filter(where not x.blocked and (x.last_attempt_at is null or x.last_attempt_at<=now()-interval '24 hours'))::integer,
    max(x.last_fetch_at),min(case when not x.blocked then coalesce(x.last_attempt_at+interval '24 hours',now()) end)
    into due_count,fetched,due from (
      select h.*,profile_automation_private.blocked(owner_id,c.id) blocked from public.creators c
      cross join lateral profile_automation_private.cadence(owner_id,c.id) h
      where profile_automation_private.eligible(owner_id,c.id)
    ) x;
  if not coalesce(cfg.enabled,false) then reason:='disabled';
  elsif not coalesce(cfg.provider_validated,false) then reason:='setup_required';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif s.paused then reason:='paused';
  elsif (select count(*) from public.scrape_jobs where owner_user_id=owner_id and status in ('dispatching','running','processing','uncertain'))
    >=(select max_active from public.collection_worker_settings where owner_user_id=owner_id) then reason:='concurrency_limit';
  else
    select coalesce(sum(actual_cost_usd) filter(where live and billing_month=date_trunc('month',now() at time zone 'UTC')::date),0),
      coalesce(sum(reserved_usd) filter(where live),0) into committed,reserved from public.scrape_jobs where owner_user_id=owner_id;
    registry:=apify_accounts_private.status(owner_id);
    if s.monthly_budget_usd-committed-reserved<=0 then
      if exists(select 1 from public.scrape_jobs j where j.owner_user_id=owner_id and j.live and (
        j.status='uncertain' or j.status in ('succeeded','partial','failed') and j.actual_cost_usd is null
        or j.provider_terminal_status is not null and j.actual_cost_usd is null)) then reason:='unreconciled_charges';
      else reason:='budget_paused'; end if;
    elsif (registry->>'ready_accounts')::integer=0 then
      if exists(select 1 from jsonb_array_elements(registry->'accounts') a where a->>'reason'='unreconciled_charges') then reason:='unreconciled_charges';
      elsif exists(select 1 from jsonb_array_elements(registry->'accounts') a where a->>'reason'='account_capacity_full') then reason:='concurrency_limit';
      elsif exists(select 1 from jsonb_array_elements(registry->'accounts') a where a->>'reason'='allowance_exhausted') then reason:='budget_paused';
      else reason:='usage_unverified'; end if;
    end if;
  end if;
  return jsonb_build_object('enabled',coalesce(cfg.enabled,false),'provider_validated',coalesce(cfg.provider_validated,false),'paused',s.paused,
    'reason',reason,'interval_hours',24,'batch_limit',20,'due_creators',due_count,'pending_jobs',pending,'active_jobs',active,
    'last_fetch_at',fetched,'next_due_at',case when reason is null and due is not null then greatest(now(),due,cfg.last_maintenance_at+interval '5 minutes') end);
end $$;

-- Guard the actual latest paid core BEFORE any new monetary reservation or
-- membership pruning. Keep 009 metrics windows, account checkpoint comparisons,
-- executor fencing, carousel wrappers, and preexisting manual pause semantics.
do $$ declare definition text; anchor text:='  if j.apify_account_slot is not null'; begin
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into definition;
  if position(anchor in definition)=0 or position('prepare_metrics_window' in definition)=0
    or position('cost_overlaps_cycle' in definition)=0 or position('headroom/slots' in definition)=0 then
    raise exception 'daily_profile_dispatch_contract_drift'; end if;
  execute replace(definition,anchor,$patch$  if j.profile_automatic and profile_automation_private.claim_reason(j.id,p_owner_user_id) is not null then
    return jsonb_build_object('reason',profile_automation_private.claim_reason(j.id,p_owner_user_id));
  end if;
$patch$||anchor);
  select pg_get_functiondef('collection_worker_private.claim_next(uuid,boolean,jsonb,text[])'::regprocedure) into definition;
  anchor:='          and (not q.carousel_automatic or automatic_allowed';
  if position(anchor in definition)=0 or position('attempted_ids' in definition)=0 then
    raise exception 'daily_profile_fair_selector_contract_drift'; end if;
  execute replace(definition,anchor,$patch$          and (not q.profile_automatic or profile_automation_private.claim_reason(q.id,p_owner_user_id) is null)
$patch$||anchor);
end $$;

-- Exact-profile selection also protects older direct workers: disabled/unresolved
-- automatic heads do not hide later manual profiles. Delegate all other kinds to
-- the unchanged current wrapper; the private previous entry cannot be bypassed.
alter function public.worker_claim_dispatch(uuid,boolean,text,text) set schema profile_automation_private;
alter function profile_automation_private.worker_claim_dispatch(uuid,boolean,text,text) rename to dispatch_previous;
create function public.worker_claim_dispatch(p_owner_user_id uuid,p_live boolean,p_actor_id text,p_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; prior_target text; result jsonb; blocked_reason text;
begin
  perform public.require_service();
  if p_kind is distinct from 'profile' then
    return profile_automation_private.dispatch_previous(p_owner_user_id,p_live,p_actor_id,p_kind);
  end if;
  if p_live is null or nullif(p_actor_id,'') is null then raise exception 'invalid_claim' using errcode='22023'; end if;
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  prior_target:=coalesce(current_setting('reelradar.media_job_id',true),'');
  select q.* into j from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.kind='profile'
    and q.status in ('pending','budget_paused') and q.scheduled_for<=now()
    and (not p_live or q.manual_authorized_by=p_owner_user_id) and (prior_target='' or q.id=prior_target::uuid)
    and (not q.profile_automatic or profile_automation_private.claim_reason(q.id,p_owner_user_id) is null)
    order by q.priority desc,q.scheduled_for,q.created_at,q.id for update of q skip locked limit 1;
  if not found then
    select profile_automation_private.claim_reason(q.id,p_owner_user_id) into blocked_reason from public.scrape_jobs q
      where q.owner_user_id=p_owner_user_id and q.kind='profile' and q.profile_automatic
        and q.status in ('pending','budget_paused') and q.scheduled_for<=now() and (prior_target='' or q.id=prior_target::uuid)
      order by q.priority desc,q.scheduled_for,q.created_at,q.id limit 1;
    if blocked_reason is not null then return jsonb_build_object('reason',blocked_reason); end if;
    return profile_automation_private.dispatch_previous(p_owner_user_id,p_live,p_actor_id,p_kind);
  end if;
  perform set_config('reelradar.media_job_id',j.id::text,true);
  result:=profile_automation_private.dispatch_previous(p_owner_user_id,p_live,p_actor_id,p_kind);
  perform set_config('reelradar.media_job_id',prior_target,true);
  if result ? 'job' and (result->'job'->>'id')::uuid is distinct from j.id then raise exception 'dispatch_candidate_changed' using errcode='40001'; end if;
  return result;
end $$;
revoke all on all functions in schema profile_automation_private from public,anon,authenticated,service_role;
revoke all on function public.worker_configure_profile_automation(uuid,boolean,boolean),public.worker_profile_maintain(uuid,integer),
  public.get_profile_automation_status(),public.worker_claim_dispatch(uuid,boolean,text,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_configure_profile_automation(uuid,boolean,boolean),public.worker_profile_maintain(uuid,integer),
  public.worker_claim_dispatch(uuid,boolean,text,text) to service_role;
grant execute on function public.get_profile_automation_status() to authenticated;
comment on column public.scrape_jobs.profile_automatic is 'Explicit service-authorized daily combined followers/name/avatar job, using the existing profile provider response.';
comment on column public.scrape_jobs.profile_automation_scheduled_at is 'Immutable first automatic enqueue timestamp; manual scheduled/start and captured-profile timestamps also extend rolling 24-hour cadence.';
