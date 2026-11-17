-- Immediate wakes must use the same capacity policy as transactional claims.
-- Superseded attempts retain their billing holds, but no longer occupy a slot.
do $$
declare definition text;
  anchor text := 'where status in (''submitting'',''processing'',''uncertain'')) >= s.concurrency';
begin
  select pg_get_functiondef('public.transcription_request_wake(text)'::regprocedure) into definition;
  if position(anchor in definition)=0 or definition not like '%public.transcription_paid_gate()%'
    or definition not like '%SET search_path TO ''pg_catalog'', ''public''%' then
    raise exception 'retry_wake_capacity_contract_drift'; end if;
  execute replace(definition,anchor,
    'where status in (''submitting'',''processing'',''uncertain'') and retry_authorized_at is null) >= s.concurrency');
end $$;
revoke all on function public.transcription_request_wake(text) from public,anon,authenticated,service_role;
