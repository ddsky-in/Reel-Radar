-- A single expired automatic submission can remain under review without
-- disabling the other worker slot. Its full reservation still counts against
-- the monthly budget, its slot remains occupied, and it is never resubmitted.
-- Missing/partial reservations, pilot work, active leases and two uncertain
-- attempts continue to stop paid dispatch. No ledger rows or limits change.
do $$
declare definition text;
  original text := 'when exists(select 1 from public.transcript_attempts where status=''uncertain'')';
begin
  select pg_get_functiondef('public.transcription_paid_gate()'::regprocedure) into definition;
  if position(original in definition)=0
    or definition not like '%s.pilot_verified%'
    or definition not like '%public.transcription_media_refreshes%'
    or definition not like '%SET search_path TO ''pg_catalog'', ''public''%' then
    raise exception 'transcription_review_gate_contract_drift';
  end if;
  execute replace(definition,original,$gate$
when exists(select 1 from public.transcript_attempts a where a.status='uncertain' and
  (s.phase<>'automatic' or a.phase<>'automatic' or not a.submit_authorized or a.submit_denied
    or a.submit_checked_at is null or a.lease_expires_at>=now()
    or a.reserved_usd<>s.reservation_usd or a.accounted_usd<>0 or a.actual_cost_usd is not null
    or a.billing_month<>date_trunc('month',now() at time zone 'UTC')::date))
or (select count(*) from public.transcript_attempts where status='uncertain')>=s.concurrency
$gate$);
end $$;

-- The original priority reader is wrapped by the completion-status reader.
-- Reflect the slot retained by an uncertain attempt in measured queue estimates.
do $$
declare definition text;
begin
  select pg_get_functiondef('reel_detail_private.read_detail_pre_completion(uuid,uuid)'::regprocedure) into definition;
  if definition not like '%read_detail_pre_priority%'
    or (select count(*) from regexp_matches(definition,'greatest\(1,s.concurrency\)','g'))<>2 then
    raise exception 'transcription_review_estimate_contract_drift';
  end if;
  execute replace(definition,'greatest(1,s.concurrency)',
    'greatest(1,s.concurrency-(select count(*) from public.transcript_attempts where status=''uncertain''))');
end $$;

-- These are internal helpers; replacing definitions must not widen access.
revoke all on function public.transcription_paid_gate(),reel_detail_private.read_detail_pre_completion(uuid,uuid)
  from public,anon,authenticated,service_role;
