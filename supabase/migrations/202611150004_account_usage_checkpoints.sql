-- Forward-only, local rollout. No provider calls, schedules, credentials or hold releases.
-- Request-start time is an ordering boundary, NOT proof of provider billing reflection.
-- Provider allowance is conservatively additive: authoritative monthly usage +
-- known local costs potentially attributable to this cycle + all outstanding holds.
-- This CAN DOUBLE COUNT already reflected local costs and pause paid work early.
-- No exact authoritative run-to-monthly-usage reconciliation exists here, so a
-- newer usage observation must NEVER release local costs based on its timestamp.
set constraints all immediate;
create table apify_accounts_private.usage_checkpoints (
  owner_id uuid not null,
  slot smallint not null,
  observation_id uuid,
  observed_at timestamptz,
  accounting_through_at timestamptz not null default '-infinity',
  accepted_id uuid,
  primary key(owner_id,slot),
  foreign key(owner_id,slot) references public.apify_accounts(owner_id,slot) on delete cascade
);
create table apify_accounts_private.usage_observations (
  id uuid primary key,
  owner_id uuid not null,
  slot smallint not null,
  provider_user_id text,
  observed_at timestamptz not null,
  foreign key(owner_id,slot) references public.apify_accounts(owner_id,slot) on delete cascade
);
alter table apify_accounts_private.usage_checkpoints enable row level security;
alter table apify_accounts_private.usage_observations enable row level security;
revoke all on apify_accounts_private.usage_checkpoints,apify_accounts_private.usage_observations from public,anon,authenticated,service_role;

create function public.worker_begin_account_usage(p_owner_user_id uuid,p_account_slot integer,p_provider_user_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.apify_accounts; c apify_accounts_private.usage_checkpoints; stamp timestamptz; token uuid:=gen_random_uuid();
begin
  perform public.require_service();
  if p_owner_user_id is null or p_account_slot is null or p_account_slot not in (1,2,3,4,5) then
    raise exception 'invalid_apify_account' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  select * into a from public.apify_accounts where owner_id=p_owner_user_id and slot=p_account_slot for update;
  if not found or a.provider_user_id is distinct from p_provider_user_id then
    raise exception 'provider_account_mismatch' using errcode='42501'; end if;
  insert into apify_accounts_private.usage_checkpoints(owner_id,slot) values(p_owner_user_id,p_account_slot) on conflict do nothing;
  select * into c from apify_accounts_private.usage_checkpoints where owner_id=p_owner_user_id and slot=p_account_slot for update;
  stamp:=greatest(clock_timestamp(),c.observed_at+interval '1 microsecond');
  delete from apify_accounts_private.usage_observations where owner_id=p_owner_user_id and slot=p_account_slot and observed_at<clock_timestamp()-interval '15 minutes';
  insert into apify_accounts_private.usage_observations(id,owner_id,slot,provider_user_id,observed_at)
    values(token,p_owner_user_id,p_account_slot,p_provider_user_id,stamp);
  update apify_accounts_private.usage_checkpoints set observation_id=token,observed_at=stamp where owner_id=p_owner_user_id and slot=p_account_slot;
  return jsonb_build_object('observation_id',token,'observed_at',stamp);
end $$;

create function public.worker_record_account_usage(p_owner_user_id uuid,p_account_slot integer,p_provider_user_id text,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,p_usage_usd numeric,p_limit_usd numeric,p_observation_id uuid,p_observed_at timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.apify_accounts; c apify_accounts_private.usage_checkpoints; observation apify_accounts_private.usage_observations; stamp timestamptz;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_account_slot is null or p_account_slot not in (1,2,3,4,5) then
    raise exception 'invalid_provider_usage' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  select * into a from public.apify_accounts where owner_id=p_owner_user_id and slot=p_account_slot for update;
  if not found or a.provider_user_id is distinct from p_provider_user_id or nullif(p_provider_user_id,'') is null then
    raise exception 'provider_account_mismatch' using errcode='42501'; end if;
  stamp:=clock_timestamp();
  if p_cycle_start_at is null or p_cycle_end_at is null or p_cycle_start_at>stamp or p_cycle_end_at<=stamp or p_cycle_start_at>=p_cycle_end_at
    or p_cycle_end_at-p_cycle_start_at>interval '62 days' or p_usage_usd is null or p_limit_usd is null
    or not (p_usage_usd between 0 and 999999 and p_limit_usd between 0 and 999999) then
    raise exception 'invalid_provider_usage' using errcode='22023'; end if;
  select * into c from apify_accounts_private.usage_checkpoints where owner_id=p_owner_user_id and slot=p_account_slot for update;
  if p_observation_id is null and p_observed_at is null then
    -- Legacy callers lack a trusted start boundary. Never let them replace a
    -- checkpointed observation or discard known local accounting.
    if c.observed_at is not null then return; end if;
  else
    select * into observation from apify_accounts_private.usage_observations where id=p_observation_id;
    if not found or observation.owner_id<>p_owner_user_id or observation.slot<>p_account_slot
      or observation.provider_user_id is not null and observation.provider_user_id is distinct from p_provider_user_id
      or p_observed_at is null or observation.observed_at is distinct from p_observed_at
      or p_observed_at>stamp or p_observed_at<stamp-interval '15 minutes' then
      raise exception 'invalid_usage_checkpoint' using errcode='42501'; end if;
    if not a.authorization_confirmed then raise exception 'provider_account_mismatch' using errcode='42501'; end if;
    -- A newer request or invalidation is a barrier, even when its read failed.
    -- Equal-token replay cannot mutate usage or move the accounting boundary.
    if c.observation_id is distinct from p_observation_id or c.accepted_id=p_observation_id then return; end if;
    if p_observed_at<c.accounting_through_at then return; end if;
    update apify_accounts_private.usage_checkpoints set accounting_through_at=p_observed_at,accepted_id=p_observation_id
      where owner_id=p_owner_user_id and slot=p_account_slot;
  end if;
  update public.apify_accounts set usage_checked_at=coalesce(p_observed_at,stamp),cycle_start_at=p_cycle_start_at,cycle_end_at=p_cycle_end_at,
    usage_usd=p_usage_usd,limit_usd=p_limit_usd where owner_id=p_owner_user_id and slot=p_account_slot;
  if p_account_slot=1 then
    update public.app_settings set provider_account_id=p_provider_user_id,provider_usage_checked_at=coalesce(p_observed_at,stamp),
      provider_cycle_start_at=p_cycle_start_at,provider_cycle_end_at=p_cycle_end_at,provider_cycle_usage_usd=p_usage_usd,
      provider_cycle_limit_usd=p_limit_usd,provider_balance_usd=null,provider_balance_checked_at=null where owner_user_id=p_owner_user_id;
  end if;
end $$;

create or replace function public.worker_record_account_usage(p_owner_user_id uuid,p_account_slot integer,p_provider_user_id text,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,p_usage_usd numeric,p_limit_usd numeric)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform public.worker_record_account_usage(p_owner_user_id,p_account_slot,p_provider_user_id,p_cycle_start_at,p_cycle_end_at,p_usage_usd,p_limit_usd,null,null);
end $$;
create function public.worker_record_usage(p_owner_user_id uuid,p_provider_user_id text,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,p_usage_usd numeric,p_limit_usd numeric,p_observation_id uuid,p_observed_at timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if exists(select 1 from public.apify_accounts where owner_id=p_owner_user_id and slot=1 and provider_user_id is null) then
    perform public.worker_configure_apify_account(p_owner_user_id,1,p_provider_user_id,true,true);
  end if;
  perform public.worker_record_account_usage(p_owner_user_id,1,p_provider_user_id,p_cycle_start_at,p_cycle_end_at,p_usage_usd,p_limit_usd,p_observation_id,p_observed_at);
end $$;

comment on column apify_accounts_private.usage_checkpoints.accounting_through_at is 'Accepted request-start ordering high-water mark only. Not provider billing reflection and never a local-cost exclusion boundary.';
-- Without exact provider attribution, retain a known cost for every cycle it
-- could overlap: unknown/recent settlement, recent run start, or (if start is
-- missing) recent creation. Fully historical known costs may age out at a real
-- cycle boundary only when all available start/settlement evidence predates it.
-- Holds are deliberately NOT cycle filtered. Settlement may lag actual billing;
-- retaining such ambiguous costs is conservative, not proof of cycle membership.
create function apify_accounts_private.cost_overlaps_cycle(p_settled_at timestamptz,p_started_at timestamptz,p_created_at timestamptz,p_cycle_start_at timestamptz) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
  select p_cycle_start_at is null or p_settled_at is null or p_settled_at>=p_cycle_start_at
    or p_started_at>=p_cycle_start_at or p_started_at is null and p_created_at>=p_cycle_start_at
$$;
-- Read failures can invalidate only their own latest observation. A late failure
-- must not clear a newer successful read. The two-argument operator RPC remains
-- deliberately unconditional and also cancels the current observation token.
create function public.worker_invalidate_account_usage(p_owner_user_id uuid,p_account_slot integer,p_observation_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_owner_user_id is null or p_account_slot is null or p_account_slot not in (1,2,3,4,5) or p_observation_id is null then
    raise exception 'invalid_usage_checkpoint' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  perform 1 from public.apify_accounts where owner_id=p_owner_user_id and slot=p_account_slot for update;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  perform 1 from apify_accounts_private.usage_checkpoints where owner_id=p_owner_user_id and slot=p_account_slot
    and observation_id=p_observation_id for update;
  if not found then return; end if;
  perform public.worker_invalidate_account_usage(p_owner_user_id,p_account_slot);
end $$;
-- Serialize invalidation/identity changes with the same account row and retain
-- the last start-time high-water mark so delayed reads cannot resurrect usage.
create function apify_accounts_private.invalidate_usage_checkpoint() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.provider_user_id is distinct from old.provider_user_id and old.provider_user_id is not null then
    delete from apify_accounts_private.usage_observations where owner_id=new.owner_id and slot=new.slot;
    delete from apify_accounts_private.usage_checkpoints where owner_id=new.owner_id and slot=new.slot;
  elsif old.usage_checked_at is not null and new.usage_checked_at is null then
    update apify_accounts_private.usage_checkpoints set observation_id=null where owner_id=new.owner_id and slot=new.slot;
  end if;
  return new;
end $$;
create trigger apify_account_usage_checkpoint before update on public.apify_accounts
for each row execute function apify_accounts_private.invalidate_usage_checkpoint();

-- Patch only the two active account allowance comparisons and the existing
-- budget-serialized settlement timestamp. Fail loudly on inherited drift.
do $$ declare def text; old_check text; new_check text; begin
  select pg_get_functiondef('public.worker_invalidate_account_usage(uuid,integer)'::regprocedure) into def;
  old_check:='update public.apify_accounts set usage_checked_at=null where owner_id=p_owner_user_id and slot=p_account_slot;';
  new_check:='update apify_accounts_private.usage_checkpoints set observation_id=null where owner_id=p_owner_user_id and slot=p_account_slot; '||old_check;
  if position(old_check in def)=0 then raise exception 'account_usage_invalidation_contract_drift'; end if;
  execute replace(def,old_check,new_check);
  select pg_get_functiondef('apify_accounts_private.status(uuid)'::regprocedure) into def;
  old_check:='j.billing_reconciled_at>a.usage_checked_at';
  new_check:='apify_accounts_private.cost_overlaps_cycle(j.billing_reconciled_at,j.started_at,j.created_at,a.cycle_start_at)';
  if position(old_check in def)=0 then raise exception 'account_usage_status_contract_drift'; end if;
  execute replace(def,old_check,new_check);
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into def;
  old_check:='billing_reconciled_at>chosen.usage_checked_at';
  new_check:='apify_accounts_private.cost_overlaps_cycle(billing_reconciled_at,started_at,created_at,chosen.cycle_start_at)';
  if position(old_check in def)=0 then raise exception 'account_usage_claim_contract_drift'; end if;
  execute replace(def,old_check,new_check);
  select pg_get_functiondef('public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)'::regprocedure) into def;
  old_check:='billing_reconciled_at=case when p_usage_total_usd is not null then now() else billing_reconciled_at end';
  new_check:='billing_reconciled_at=case when p_usage_total_usd is not null then clock_timestamp() else billing_reconciled_at end';
  if position(old_check in def)=0 or position('pg_advisory_xact_lock' in def)=0 then raise exception 'account_usage_settlement_contract_drift'; end if;
  execute replace(def,old_check,new_check);
end $$;
revoke all on all functions in schema apify_accounts_private from public,anon,authenticated,service_role;
revoke all on function public.worker_begin_account_usage(uuid,integer,text),
  public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric,uuid,timestamptz),
  public.worker_invalidate_account_usage(uuid,integer,uuid),
  public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric,uuid,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.worker_begin_account_usage(uuid,integer,text),
  public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric,uuid,timestamptz),
  public.worker_invalidate_account_usage(uuid,integer,uuid),
  public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric,uuid,timestamptz) to service_role;
