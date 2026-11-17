-- Fixed owner-scoped Apify slots. Local forward migration only: no requests, schedules,
-- credential storage, budget changes, hold releases, or automatic starts.
create table public.apify_accounts (
  owner_id uuid not null references public.app_settings(owner_user_id) on delete restrict,
  slot smallint not null check(slot in (1,2,3)),
  provider_user_id text check(provider_user_id is null or (length(provider_user_id) between 1 and 256 and provider_user_id=btrim(provider_user_id))),
  enabled boolean not null default false,
  authorization_confirmed boolean not null default false,
  usage_checked_at timestamptz,
  cycle_start_at timestamptz,
  cycle_end_at timestamptz,
  usage_usd numeric(12,6) check(usage_usd between 0 and 999999),
  limit_usd numeric(12,6) check(limit_usd between 0 and 999999),
  primary key(owner_id,slot),
  unique(owner_id,provider_user_id)
);
alter table public.apify_accounts enable row level security;
revoke all on public.apify_accounts from public,anon,authenticated,service_role;
grant select on public.apify_accounts to service_role;

insert into public.apify_accounts(owner_id,slot,provider_user_id,enabled,authorization_confirmed,usage_checked_at,cycle_start_at,cycle_end_at,usage_usd,limit_usd)
select owner_user_id,1,nullif(btrim(provider_account_id),''),true,provider_account_id is not null,
  provider_usage_checked_at,provider_cycle_start_at,provider_cycle_end_at,provider_cycle_usage_usd,provider_cycle_limit_usd
from public.app_settings;
insert into public.apify_accounts(owner_id,slot)
select owner_user_id,slot from public.app_settings cross join (values(2),(3)) slots(slot);

alter table public.scrape_jobs add column apify_account_slot smallint check(apify_account_slot in (1,2,3));
alter table public.scrape_jobs add constraint scrape_jobs_apify_account_fk
  foreign key(owner_user_id,apify_account_slot) references public.apify_accounts(owner_id,slot) on delete restrict;
-- Only exact pre-existing provider identity proves the legacy primary account.
-- Unmapped attempts keep their holds and are globally fail-closed, never guessed.
update public.scrape_jobs j set apify_account_slot=1
from public.apify_accounts a where a.owner_id=j.owner_user_id and a.slot=1
  and j.live and (j.attempt_count>0 or j.dispatch_nonce is not null or j.actor_run_id is not null
    or j.status in ('dispatching','running','processing','uncertain') or j.provider_terminal_status is not null)
  and j.expected_provider_user_id=a.provider_user_id and a.provider_user_id is not null;
-- Flush existing deferred revision/FK events before further table DDL in an atomic rollout.
set constraints all immediate;
create index scrape_jobs_apify_ledger_idx on public.scrape_jobs(owner_user_id,apify_account_slot) where live;

create schema apify_accounts_private;
revoke all on schema apify_accounts_private from public,anon,authenticated,service_role;
create function apify_accounts_private.provision_slots() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  insert into public.apify_accounts(owner_id,slot,enabled)
  values(new.owner_user_id,1,true),(new.owner_user_id,2,false),(new.owner_user_id,3,false);
  return new;
end $$;
create trigger app_settings_apify_slots after insert on public.app_settings
for each row execute function apify_accounts_private.provision_slots();

create function apify_accounts_private.enforce_pin() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.apify_account_slot is not null and (new.apify_account_slot is distinct from old.apify_account_slot
    or new.owner_user_id is distinct from old.owner_user_id or new.expected_provider_user_id is distinct from old.expected_provider_user_id) then
    raise exception 'apify_account_pin_immutable' using errcode='42501';
  end if;
  if old.apify_account_slot is null and new.apify_account_slot is not null then
    if not new.live or new.status<>'dispatching' or new.dispatch_nonce is null or new.attempt_count<>old.attempt_count+1
      or old.live and (old.attempt_count>0 or old.dispatch_nonce is not null or old.actor_run_id is not null)
      or not exists(select 1 from public.apify_accounts a where a.owner_id=new.owner_user_id and a.slot=new.apify_account_slot
        and a.provider_user_id=new.expected_provider_user_id and a.enabled and a.authorization_confirmed) then
      raise exception 'apify_account_pin_invalid' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger scrape_jobs_apify_pin before update on public.scrape_jobs
for each row execute function apify_accounts_private.enforce_pin();

-- Authorization is explicit and service-only. Never replace the account identity
-- behind a historical accepted claim, even after that claim's billing settles.
create function public.worker_configure_apify_account(p_owner_user_id uuid,p_account_slot integer,p_provider_user_id text,p_enabled boolean,p_authorization_confirmed boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.apify_accounts;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_account_slot is null or p_account_slot not in (1,2,3) or p_enabled is null or p_authorization_confirmed is null
    or p_provider_user_id is not null and (length(p_provider_user_id) not between 1 and 256 or p_provider_user_id<>btrim(p_provider_user_id))
    or p_enabled and p_provider_user_id is null then raise exception 'invalid_apify_account' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  select * into a from public.apify_accounts where owner_id=p_owner_user_id and slot=p_account_slot for update;
  if a.provider_user_id is distinct from p_provider_user_id and exists(select 1 from public.scrape_jobs j
    where j.owner_user_id=p_owner_user_id and j.live and (j.apify_account_slot=p_account_slot
      or j.apify_account_slot is null and (j.attempt_count>0 or j.dispatch_nonce is not null or j.actor_run_id is not null
        or j.status in ('dispatching','running','processing','uncertain') or j.provider_terminal_status is not null))) then
    raise exception 'apify_account_has_pinned_jobs' using errcode='42501';
  end if;
  update public.apify_accounts set provider_user_id=p_provider_user_id,enabled=p_enabled,authorization_confirmed=p_authorization_confirmed,
    usage_checked_at=case when a.provider_user_id is not distinct from p_provider_user_id then usage_checked_at end,
    cycle_start_at=case when a.provider_user_id is not distinct from p_provider_user_id then cycle_start_at end,
    cycle_end_at=case when a.provider_user_id is not distinct from p_provider_user_id then cycle_end_at end,
    usage_usd=case when a.provider_user_id is not distinct from p_provider_user_id then usage_usd end,
    limit_usd=case when a.provider_user_id is not distinct from p_provider_user_id then limit_usd end
    where owner_id=p_owner_user_id and slot=p_account_slot;
  if p_account_slot=1 then
    update public.app_settings set provider_account_id=p_provider_user_id,
      provider_usage_checked_at=case when a.provider_user_id is not distinct from p_provider_user_id then provider_usage_checked_at end,
      provider_cycle_start_at=case when a.provider_user_id is not distinct from p_provider_user_id then provider_cycle_start_at end,
      provider_cycle_end_at=case when a.provider_user_id is not distinct from p_provider_user_id then provider_cycle_end_at end,
      provider_cycle_usage_usd=case when a.provider_user_id is not distinct from p_provider_user_id then provider_cycle_usage_usd end,
      provider_cycle_limit_usd=case when a.provider_user_id is not distinct from p_provider_user_id then provider_cycle_limit_usd end,
      provider_balance_usd=null,provider_balance_checked_at=null where owner_user_id=p_owner_user_id;
  end if;
end $$;

create function public.worker_record_account_usage(p_owner_user_id uuid,p_account_slot integer,p_provider_user_id text,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,p_usage_usd numeric,p_limit_usd numeric)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_account_slot is null or p_account_slot not in (1,2,3) or p_cycle_start_at is null or p_cycle_end_at is null
    or p_cycle_start_at>now() or p_cycle_end_at<=now() or p_cycle_start_at>=p_cycle_end_at
    or p_cycle_end_at-p_cycle_start_at>interval '62 days' or p_usage_usd is null or p_limit_usd is null
    or not (p_usage_usd between 0 and 999999 and p_limit_usd between 0 and 999999) then
    raise exception 'invalid_provider_usage' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  update public.apify_accounts set usage_checked_at=now(),cycle_start_at=p_cycle_start_at,cycle_end_at=p_cycle_end_at,
    usage_usd=p_usage_usd,limit_usd=p_limit_usd
    where owner_id=p_owner_user_id and slot=p_account_slot and provider_user_id=p_provider_user_id and nullif(p_provider_user_id,'') is not null;
  if not found then raise exception 'provider_account_mismatch' using errcode='42501'; end if;
  if p_account_slot=1 then
    update public.app_settings set provider_account_id=p_provider_user_id,provider_usage_checked_at=now(),
      provider_cycle_start_at=p_cycle_start_at,provider_cycle_end_at=p_cycle_end_at,provider_cycle_usage_usd=p_usage_usd,
      provider_cycle_limit_usd=p_limit_usd,provider_balance_usd=null,provider_balance_checked_at=null where owner_user_id=p_owner_user_id;
  end if;
end $$;

create function public.worker_invalidate_account_usage(p_owner_user_id uuid,p_account_slot integer)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_account_slot is null or p_account_slot not in (1,2,3) then raise exception 'invalid_apify_account' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  update public.apify_accounts set usage_checked_at=null where owner_id=p_owner_user_id and slot=p_account_slot;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  if p_account_slot=1 then update public.app_settings set provider_usage_checked_at=null,provider_cycle_start_at=null,
    provider_cycle_end_at=null,provider_cycle_usage_usd=null,provider_cycle_limit_usd=null where owner_user_id=p_owner_user_id; end if;
end $$;

create or replace function public.worker_record_usage(p_owner_user_id uuid,p_provider_user_id text,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,p_usage_usd numeric,p_limit_usd numeric)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  -- Legacy setup may establish an unconfigured primary, never replace a pin.
  if exists(select 1 from public.apify_accounts where owner_id=p_owner_user_id and slot=1 and provider_user_id is null) then
    perform public.worker_configure_apify_account(p_owner_user_id,1,p_provider_user_id,true,true);
  end if;
  perform public.worker_record_account_usage(p_owner_user_id,1,p_provider_user_id,p_cycle_start_at,p_cycle_end_at,p_usage_usd,p_limit_usd);
end $$;

create function public.worker_accounts(p_owner_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  return (select coalesce(jsonb_agg(jsonb_build_object('owner_user_id',owner_id,'account_slot',slot,'provider_user_id',provider_user_id,
    'enabled',enabled,'authorization_confirmed',authorization_confirmed,'usage_cycle_start_at',cycle_start_at,'usage_cycle_end_at',cycle_end_at,
    'usage_usd',usage_usd,'limit_usd',limit_usd,'usage_reconciled_at',usage_checked_at) order by slot),'[]'::jsonb)
    from public.apify_accounts where owner_id=p_owner_user_id);
end $$;

-- Identity checks intentionally do not require enabled/fresh usage: disabled
-- accounts must still be able to reconcile their already accepted pinned runs.
create function apify_accounts_private.job_account_matches(p_owner uuid,p_slot smallint,p_provider text) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.apify_accounts a join public.app_settings s on s.owner_user_id=a.owner_id
    where a.owner_id=p_owner and a.slot=p_slot and a.provider_user_id=p_provider and p_provider is not null
      and (a.slot<>1 or s.provider_account_id=a.provider_user_id));
$$;

create function apify_accounts_private.status(p_owner uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare a public.apify_accounts; reason text; hold numeric; unobserved numeric; unknown_count integer;
  gate boolean:=false; unmapped boolean; rows jsonb:='[]'::jsonb; ready integer:=0;
begin
  select exists(select 1 from public.scrape_jobs j where j.owner_user_id=p_owner and j.live
    and (j.attempt_count>0 or j.dispatch_nonce is not null or j.actor_run_id is not null
      or j.status in ('dispatching','running','processing','uncertain') or j.provider_terminal_status is not null)
    and not apify_accounts_private.job_account_matches(j.owner_user_id,j.apify_account_slot,j.expected_provider_user_id)) into unmapped;
  for a in select * from public.apify_accounts where owner_id=p_owner order by slot loop
    select coalesce(sum(j.reserved_usd),0),
      coalesce(sum(j.actual_cost_usd) filter(where j.billing_reconciled_at>a.usage_checked_at),0),
      count(*) filter(where j.status='uncertain' or j.status in ('succeeded','partial','failed') and j.actual_cost_usd is null
        or j.provider_terminal_status is not null and j.actual_cost_usd is null)
      into hold,unobserved,unknown_count from public.scrape_jobs j
      where j.owner_user_id=p_owner and j.live and j.apify_account_slot=a.slot;
    reason:=null;
    if not a.enabled then reason:='disabled';
    elsif unmapped then reason:='unreconciled_charges';
    elsif unknown_count>0 then reason:='unreconciled_charges';
    elsif a.provider_user_id is null or not a.authorization_confirmed then reason:='setup_required'; gate:=true;
    elsif gate or not apify_accounts_private.job_account_matches(p_owner,a.slot,a.provider_user_id)
      or a.usage_checked_at is null or a.usage_checked_at<now()-interval '15 minutes' or a.usage_checked_at>now()+interval '1 minute'
      or a.cycle_start_at is null or a.cycle_end_at is null or a.cycle_start_at>now() or a.cycle_end_at<=now()
      or a.usage_usd is null or a.limit_usd is null then reason:='usage_unverified'; gate:=true;
    elsif a.limit_usd-a.usage_usd-unobserved-hold<=0 then reason:='allowance_exhausted';
    else ready:=ready+1;
    end if;
    rows:=rows||jsonb_build_array(jsonb_build_object('slot',a.slot,'label','Account '||a.slot,'enabled',a.enabled,
      'configured',a.provider_user_id is not null and a.authorization_confirmed,'reason',reason,'usage_usd',a.usage_usd,
      'limit_usd',a.limit_usd,'usage_checked_at',a.usage_checked_at,'cycle_end_at',a.cycle_end_at,
      'reserved_usd',hold,'unreconciled_jobs',unknown_count));
  end loop;
  return jsonb_build_object('accounts',rows,'ready_accounts',ready);
end $$;

create function public.get_apify_account_status() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  return apify_accounts_private.status(auth.uid());
end $$;

-- Replace only the underlying allocator. The outer transcription/media wrapper,
-- carousel authorization extensions, and exact-target pilot remain untouched.
create or replace function public.transcription_claim_dispatch_core(p_owner_user_id uuid,p_live boolean,p_actor_id text,p_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; j public.scrape_jobs; a public.apify_accounts; chosen public.apify_accounts;
  month_start date:=date_trunc('month',now() at time zone 'UTC')::date;
  committed numeric; reserved numeric; cap numeric; cycle_unobserved numeric; account_reserved numeric;
  headroom numeric; owner_headroom numeric; slots integer; active_count integer; registry jsonb; entry jsonb; fallback_reason text;
begin
  perform public.require_service();
  if p_live is null or nullif(p_actor_id,'') is null or p_kind is null
    or p_kind not in ('daily','weekly','backfill','profile','manual','retry','carousel','discovery','metrics') then
    raise exception 'invalid_claim' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into s from public.app_settings where owner_user_id=p_owner_user_id for update;
  if not found then return jsonb_build_object('reason','owner_not_provisioned'); end if;
  if p_live and not s.scraping_enabled then return jsonb_build_object('reason','globalscraping_disabled'); end if;
  if p_live and p_kind='backfill' and not s.initial_backfill_enabled then return jsonb_build_object('reason','initial_backfill_disabled'); end if;
  if s.paused and p_kind in ('daily','weekly','retry','discovery','metrics') then return jsonb_build_object('reason','paused'); end if;
  select count(*) into active_count from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('dispatching','running','processing','uncertain');
  if active_count>=2 then return jsonb_build_object('reason','concurrency_limit'); end if;
  select coalesce(sum(actual_cost_usd) filter(where live and billing_month=month_start),0),coalesce(sum(reserved_usd) filter(where live),0)
    into committed,reserved from public.scrape_jobs where owner_user_id=p_owner_user_id;
  owner_headroom:=greatest(0,s.monthly_budget_usd-committed-reserved);
  -- All account rotation occurs AFTER the owner ceiling/concurrency checks and
  -- under the same owner lock. Every historical uncertain hold stays counted.
  if p_live and owner_headroom<=0 then
    if exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id and live and
      (status='uncertain' or status in ('succeeded','partial','failed') and actual_cost_usd is null
       or provider_terminal_status is not null and actual_cost_usd is null)) then return jsonb_build_object('reason','unreconciled_charges'); end if;
    return jsonb_build_object('reason','budget_paused');
  end if;
  if p_live then
    perform 1 from public.apify_accounts where owner_id=p_owner_user_id order by slot for update;
    registry:=apify_accounts_private.status(p_owner_user_id);
    for entry in select value from jsonb_array_elements(registry->'accounts') loop
      if entry->>'reason' is null then
        select * into chosen from public.apify_accounts where owner_id=p_owner_user_id and slot=(entry->>'slot')::integer;
        exit;
      elsif entry->>'reason'='unreconciled_charges' then fallback_reason:=coalesce(fallback_reason,'unreconciled_charges');
      elsif entry->>'reason' in ('setup_required','usage_unverified') then
        return jsonb_build_object('reason','live_setup_or_usage_unverified');
      elsif entry->>'reason'='allowance_exhausted' then fallback_reason:=coalesce(fallback_reason,'budget_paused');
      end if;
    end loop;
    if chosen.slot is null then return jsonb_build_object('reason',coalesce(fallback_reason,'live_setup_or_usage_unverified')); end if;
  end if;
  select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()
    and (not p_live or kind not in ('profile','manual','carousel') or manual_authorized_by=p_owner_user_id)
    and (nullif(current_setting('reelradar.media_job_id',true),'') is null or id=nullif(current_setting('reelradar.media_job_id',true),'')::uuid)
    order by priority desc,scheduled_for,created_at,id for update skip locked limit 1;
  if not found then
    if p_live and p_kind in ('profile','manual','carousel') and exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id
      and kind=p_kind and status in ('pending','budget_paused') and manual_authorized_by is distinct from p_owner_user_id) then
      return jsonb_build_object('reason','manual_authorization_required');
    end if;
    return jsonb_build_object('reason','no_pending_jobs');
  end if;
  if j.apify_account_slot is not null or p_live and j.live and (j.attempt_count>0 or j.dispatch_nonce is not null or j.actor_run_id is not null) then
    return jsonb_build_object('reason','unreconciled_charges');
  end if;
  if p_live and (j.kind='backfill' and (j.results_limit<>100 or j.requested_profiles_count<>1)
    or j.kind not in ('profile','backfill','discovery','metrics') and j.results_limit not between 10 and 30
    and not (j.kind='manual' and j.results_limit=100 and j.requested_profiles_count=1 and exists(select 1 from public.transcription_media_refreshes m
      where m.job_id=j.id and m.owner_user_id=p_owner_user_id and m.status='active'))) then return jsonb_build_object('reason','provider_input_invalid'); end if;
  if not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id
    and c.status not in ('private','unavailable','paused') and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
      where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)) then
    update public.scrape_jobs set status='failed',completed_at=now(),actual_cost_usd=0,billing_reconciled_at=now(),error_message='No eligible associated public creators' where id=j.id;
    return jsonb_build_object('reason','empty_job');
  end if;
  if j.kind<>'backfill' then
    delete from public.scrape_job_creators jc where jc.job_id=j.id and not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
      join public.creators c on c.id=wc.creator_id where wc.creator_id=jc.creator_id and wc.active and w.archived_at is null
        and w.owner_user_id=p_owner_user_id and c.status not in ('private','unavailable','paused'));
  end if;
  if p_live then
    select coalesce(sum(reserved_usd),0),coalesce(sum(actual_cost_usd) filter(where billing_reconciled_at>chosen.usage_checked_at),0)
      into account_reserved,cycle_unobserved from public.scrape_jobs where owner_user_id=p_owner_user_id and live and apify_account_slot=chosen.slot;
    headroom:=greatest(0,least(owner_headroom,chosen.limit_usd-chosen.usage_usd-cycle_unobserved-account_reserved));
  end if;
  select greatest(1,least(2-active_count,(select count(*) from public.scrape_jobs where owner_user_id=p_owner_user_id
    and status in ('pending','budget_paused') and scheduled_for<=now() and (kind not in ('profile','manual','carousel') or manual_authorized_by=p_owner_user_id)))) into slots;
  cap:=case when p_live then trunc(headroom/slots,6) else 0 end;
  if p_live and cap=0 and headroom>=.000001 then cap:=.000001; end if;
  if p_live and cap<=0 then
    update public.scrape_jobs set status='budget_paused',error_message='Monthly collection budget or verified provider account allowance exhausted.' where id=j.id;
    return jsonb_build_object('reason','budget_paused');
  end if;
  update public.scrape_jobs set status='dispatching',live=p_live,reserved_usd=cap,billing_month=month_start,dispatch_nonce=gen_random_uuid(),
    apify_account_slot=case when p_live then chosen.slot end,expected_actor_id=p_actor_id,expected_provider_user_id=case when p_live then chosen.provider_user_id else 'mock' end,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',started_at=now(),attempt_count=attempt_count+1,
    requested_profiles_count=(select count(*) from public.scrape_job_creators where job_id=j.id),error_message=null where id=j.id returning * into j;
  return jsonb_build_object('job',to_jsonb(j),'creators',(select jsonb_agg(jsonb_build_object('id',c.id,'username',c.username) order by c.username)
    from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id),'max_total_charge_usd',cap);
end $$;

-- Fail loudly on drift rather than silently patching a different wrapper.
do $$ declare def text; old_check text; new_check text; begin
  select pg_get_functiondef('public.worker_record_callback_receipt(uuid,uuid,uuid,text,text,text)'::regprocedure) into def;
  old_check:='exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id and provider_account_id=p_provider_user_id)';
  new_check:='apify_accounts_private.job_account_matches(p_owner_user_id,j.apify_account_slot,p_provider_user_id)';
  if position(old_check in def)=0 then raise exception 'apify_callback_contract_drift'; end if;
  execute replace(def,old_check,new_check);
  select pg_get_functiondef('public.worker_claim_reconciliation(uuid,uuid,text,integer)'::regprocedure) into def;
  old_check:='exists(select 1 from public.app_settings s where s.owner_user_id=q.owner_user_id and s.provider_account_id=q.expected_provider_user_id and nullif(q.expected_actor_id,'''') is not null)';
  new_check:='(apify_accounts_private.job_account_matches(q.owner_user_id,q.apify_account_slot,q.expected_provider_user_id) and nullif(q.expected_actor_id,'''') is not null)';
  if position(old_check in def)=0 then raise exception 'apify_reconciliation_contract_drift'; end if;
  execute replace(def,old_check,new_check);
  foreach def in array array[pg_get_functiondef('public.worker_attach_run(uuid,uuid,text,text,text,text)'::regprocedure),
    pg_get_functiondef('public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)'::regprocedure)] loop
    old_check:='j.expected_provider_user_id is distinct from p_provider_user_id';
    if position(old_check in def)=0 then raise exception 'apify_run_identity_contract_drift'; end if;
    execute replace(def,old_check,old_check||' or j.live and not apify_accounts_private.job_account_matches(j.owner_user_id,j.apify_account_slot,p_provider_user_id)');
  end loop;
end $$;

-- Preserve the profile/job response contract. A primary blocker remains a
-- warning ID, not an owner-wide pause when an authorized alternate is ready.
do $$ declare def text; start_pos integer; end_pos integer; replacement text; begin
  select pg_get_functiondef('public.get_creator_collection_state(uuid,uuid[])'::regprocedure) into def;
  start_pos:=position('  if blocking_job_id is not null then reason:=' in def);
  end_pos:=position('  select coalesce(array_agg(j.id order by' in def);
  if start_pos=0 or end_pos<=start_pos then raise exception 'apify_collection_state_contract_drift'; end if;
  replacement:=$patch$  if blocking_job_id is not null and (apify_accounts_private.status(owner_id)->>'ready_accounts')::integer=0 then reason:='unreconciled_charges';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif not s.initial_backfill_enabled then reason:='initial_import_disabled';
  elsif s.monthly_budget_usd-committed-reserved<=0 then reason:='budget_paused';
  elsif active_count>=2 then reason:='concurrency_limit';
  elsif (apify_accounts_private.status(owner_id)->>'ready_accounts')::integer=0 then
    if blocking_job_id is not null then reason:='unreconciled_charges';
    elsif exists(select 1 from jsonb_array_elements(apify_accounts_private.status(owner_id)->'accounts') a
      where a->>'reason'='allowance_exhausted') then reason:='budget_paused';
    else reason:='usage_unverified'; end if;
  end if;
$patch$;
  execute substring(def from 1 for start_pos-1)||replacement||substring(def from end_pos);
end $$;

revoke all on all functions in schema apify_accounts_private from public,anon,authenticated,service_role;
revoke all on function public.worker_configure_apify_account(uuid,integer,text,boolean,boolean),
  public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric),
  public.worker_invalidate_account_usage(uuid,integer),public.worker_accounts(uuid),
  public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric),public.get_apify_account_status()
  from public,anon,authenticated,service_role;
grant execute on function public.worker_configure_apify_account(uuid,integer,text,boolean,boolean),
  public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric),
  public.worker_invalidate_account_usage(uuid,integer),public.worker_accounts(uuid),
  public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric) to service_role;
grant execute on function public.get_apify_account_status() to authenticated;
comment on column public.scrape_jobs.apify_account_slot is 'Immutable owner-scoped Apify slot pinned transactionally at live dispatch claim; null means unclaimed or unverified legacy identity.';
comment on table public.apify_accounts is 'Fixed owner-authorized slots 1/2/3, authoritative usage metadata only; never stores tokens or secret references.';
