-- Provider reports are observations, not invoices, prepaid balances, or proof
-- that a particular run is included. Never change reservation accounting here.
create table apify_accounts_private.monthly_reports (
  owner_id uuid not null,
  slot smallint not null,
  provider_user_id text not null,
  cycle_start_at timestamptz not null,
  cycle_end_at timestamptz not null,
  observed_at timestamptz not null,
  checked_at timestamptz not null default clock_timestamp(),
  before_discount_usd numeric not null check(before_discount_usd between 0 and 999999),
  after_discount_usd numeric not null check(after_discount_usd between 0 and 999999),
  service_amounts jsonb not null check(jsonb_typeof(service_amounts)='object' and octet_length(service_amounts::text)<=32000),
  primary key(owner_id,slot,cycle_start_at),
  foreign key(owner_id,slot) references public.apify_accounts(owner_id,slot) on delete restrict,
  check(cycle_start_at<cycle_end_at)
);
alter table apify_accounts_private.monthly_reports enable row level security;
revoke all on apify_accounts_private.monthly_reports from public,anon,authenticated,service_role;

create function public.worker_record_monthly_billing_report(p_owner_user_id uuid,p_account_slot integer,p_provider_user_id text,
  p_observation_id uuid,p_observed_at timestamptz,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,
  p_before_discount_usd numeric,p_after_discount_usd numeric,p_service_amounts jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.apify_accounts; c apify_accounts_private.usage_checkpoints;
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into a from public.apify_accounts where owner_id=p_owner_user_id and slot=p_account_slot for update;
  if not found or not a.enabled or not a.authorization_confirmed or a.provider_user_id is distinct from p_provider_user_id then
    raise exception 'provider_account_mismatch' using errcode='42501'; end if;
  select * into c from apify_accounts_private.usage_checkpoints where owner_id=p_owner_user_id and slot=p_account_slot;
  if p_observation_id is null or c.accepted_id is distinct from p_observation_id or c.observed_at is distinct from p_observed_at
    or p_observed_at is null or p_observed_at>clock_timestamp() or p_observed_at<clock_timestamp()-interval '15 minutes' then
    return false; end if;
  if p_cycle_start_at is distinct from a.cycle_start_at or p_cycle_end_at is distinct from a.cycle_end_at
    or p_cycle_start_at is null or p_cycle_end_at<=clock_timestamp() or p_cycle_start_at>clock_timestamp()
    or p_before_discount_usd is null or not(p_before_discount_usd between 0 and 999999)
    or p_after_discount_usd is null or not(p_after_discount_usd between 0 and 999999)
    or p_service_amounts is null or jsonb_typeof(p_service_amounts)<>'object' or octet_length(p_service_amounts::text)>32000 then
    raise exception 'invalid_monthly_report' using errcode='22023'; end if;
  if (select count(*) from jsonb_each(p_service_amounts))>100 or exists(select 1 from jsonb_each(p_service_amounts) x
    where x.key!~'^[A-Z][A-Z0-9_]{0,99}$' or jsonb_typeof(x.value) not in ('number','null')
      or case when jsonb_typeof(x.value)='number' then not((x.value::text)::numeric between 0 and 999999) else false end) then
    raise exception 'invalid_monthly_services' using errcode='22023'; end if;
  insert into apify_accounts_private.monthly_reports values(p_owner_user_id,p_account_slot,p_provider_user_id,
    p_cycle_start_at,p_cycle_end_at,p_observed_at,clock_timestamp(),p_before_discount_usd,p_after_discount_usd,p_service_amounts)
  on conflict(owner_id,slot,cycle_start_at) do update set provider_user_id=excluded.provider_user_id,
    cycle_end_at=excluded.cycle_end_at,observed_at=excluded.observed_at,checked_at=excluded.checked_at,
    before_discount_usd=excluded.before_discount_usd,after_discount_usd=excluded.after_discount_usd,service_amounts=excluded.service_amounts
  where monthly_reports.observed_at<=excluded.observed_at;
  return found;
end $$;
revoke all on function public.worker_record_monthly_billing_report(uuid,integer,text,uuid,timestamptz,timestamptz,timestamptz,numeric,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.worker_record_monthly_billing_report(uuid,integer,text,uuid,timestamptz,timestamptz,timestamptz,numeric,numeric,jsonb) to service_role;

create or replace function public.get_apify_account_status() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_owner uuid:=auth.uid(); result jsonb;
begin
  if v_owner is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  result:=apify_accounts_private.status(v_owner)||jsonb_build_object('capacity',collection_intents_private.capacity(v_owner));
  return jsonb_set(result,'{accounts}',(select jsonb_agg(item||jsonb_build_object('monthly_report',(
    select jsonb_build_object('source','apify_monthly_usage','cycle_start_at',r.cycle_start_at,'cycle_end_at',r.cycle_end_at,
      'checked_at',r.checked_at,'before_discount_usd',r.before_discount_usd,'after_discount_usd',r.after_discount_usd,'service_amounts',r.service_amounts)
    from apify_accounts_private.monthly_reports r join public.apify_accounts a on a.owner_id=r.owner_id and a.slot=r.slot
    where r.owner_id=v_owner and r.slot=(item->>'slot')::smallint and r.provider_user_id=a.provider_user_id
      and r.cycle_start_at=a.cycle_start_at and r.cycle_end_at=a.cycle_end_at
    limit 1)) order by (item->>'slot')::integer) from jsonb_array_elements(result->'accounts') item));
end $$;
