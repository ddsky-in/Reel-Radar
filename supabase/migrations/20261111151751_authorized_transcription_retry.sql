-- Explicit owner retries retire an expired submission from dispatch capacity,
-- not from billing. The old reservation and unknown actual cost stay intact.
alter table public.transcript_attempts
  add column retry_authorized_at timestamptz,
  add column retry_authorized_by uuid references auth.users(id),
  add constraint transcript_retry_authorization_pair check
    ((retry_authorized_at is null) = (retry_authorized_by is null));

create function reel_detail_private.uncertain_retry_allowed(p_reel_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.transcript_jobs j
    join public.transcript_attempts a on a.id=j.current_attempt_id and a.job_id=j.id
    join public.transcription_settings s on s.singleton
    where j.reel_id=p_reel_id and j.status='uncertain' and j.attempt_count<3
      and a.status='uncertain' and a.lease_expires_at<=now() and a.retry_authorized_at is null
      and a.submit_authorized and not a.submit_denied and a.submit_checked_at is not null
      and a.phase='automatic' and s.phase='automatic'
      and a.reserved_usd=s.reservation_usd and a.accounted_usd=0
      and a.actual_cost_usd is null and a.reconciled_at is null
      and not exists(select 1 from public.reel_transcripts t where t.reel_id=j.reel_id));
$$;
revoke all on function reel_detail_private.uncertain_retry_allowed(uuid) from public,anon,authenticated,service_role;

-- Preserve every existing gate, queue order and budget calculation. Only an
-- explicitly superseded attempt stops occupying a worker/review slot.
do $$ declare definition text; begin
  select pg_get_functiondef('public.transcription_paid_gate()'::regprocedure) into definition;
  if definition not like '%a.status=''uncertain'' and%'
    or definition not like '%where status=''uncertain'')>=s.concurrency%' then
    raise exception 'retry_gate_contract_drift'; end if;
  definition:=replace(definition,'a.status=''uncertain'' and','a.status=''uncertain'' and a.retry_authorized_at is null and');
  definition:=replace(definition,'where status=''uncertain'')>=s.concurrency',
    'where status=''uncertain'' and retry_authorized_at is null)>=s.concurrency');
  execute definition;
  select pg_get_functiondef('public.worker_transcription_claim(integer)'::regprocedure) into definition;
  if definition not like '%where status in (''submitting'',''processing'',''uncertain'');%'
    or definition not like '%public.transcription_combined_budget(s.reservation_usd)%' then
    raise exception 'retry_claim_contract_drift'; end if;
  execute replace(definition,'where status in (''submitting'',''processing'',''uncertain'');',
    'where status in (''submitting'',''processing'',''uncertain'') and retry_authorized_at is null;');
  select pg_get_functiondef('reel_detail_private.read_detail_pre_completion(uuid,uuid)'::regprocedure) into definition;
  execute replace(definition,'where status=''uncertain''','where status=''uncertain'' and retry_authorized_at is null');
  select pg_get_functiondef('reel_detail_private.failed_retry_allowed(uuid)'::regprocedure) into definition;
  execute replace(definition,'x.status in (''submitting'',''processing'',''uncertain'')',
    'x.status in (''submitting'',''processing'',''uncertain'') and x.retry_authorized_at is null');
  -- A returned POST failure has ended its transport. Permit explicit recovery
  -- immediately, while runtime disappearance still waits for lease expiration.
  select pg_get_functiondef('public.worker_transcription_fail(uuid,uuid,text,text,numeric)'::regprocedure) into definition;
  if definition not like '%set status=p_status,completed_at=%' then raise exception 'retry_failure_contract_drift'; end if;
  execute replace(definition,'set status=p_status,completed_at=',
    'set status=p_status,lease_expires_at=case when p_status=''uncertain'' then least(lease_expires_at,now()) else lease_expires_at end,completed_at=');
end $$;

alter function reel_detail_private.read_detail(uuid,uuid) rename to read_detail_pre_retry;
create function reel_detail_private.read_detail(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare detail jsonb; attempt_id uuid;
begin
  detail:=reel_detail_private.read_detail_pre_retry(p_workspace_id,p_reel_id);
  if detail->'reel'->>'creator_status' not in ('private','unavailable','paused')
    and reel_detail_private.uncertain_retry_allowed(p_reel_id) then
    select current_attempt_id into attempt_id from public.transcript_jobs where reel_id=p_reel_id;
  end if;
  return jsonb_set(detail,'{processing,retry_attempt_id}',coalesce(to_jsonb(attempt_id),'null'::jsonb));
end $$;

create function reel_detail_private.retry_transcript(p_workspace_id uuid,p_reel_id uuid,p_attempt_id uuid,p_accept_duplicate_charge boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare detail jsonb; j public.transcript_jobs; a public.transcript_attempts;
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform public.require_workspace(p_workspace_id);
  if p_attempt_id is null or p_accept_duplicate_charge is distinct from true then
    raise exception 'retry_confirmation_required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('reel-transcript:'||p_reel_id::text,0));
  perform 1 from public.transcription_settings where singleton for update;
  select * into j from public.transcript_jobs where reel_id=p_reel_id for update;
  detail:=reel_detail_private.read_detail(p_workspace_id,p_reel_id);
  select * into a from public.transcript_attempts where id=p_attempt_id and job_id=j.id for update;
  -- Replayed clicks or a lost API response cannot authorize another generation.
  if a.retry_authorized_at is not null and a.retry_authorized_by=auth.uid() then return detail; end if;
  if j.current_attempt_id is distinct from p_attempt_id
    or detail->'processing'->>'retry_attempt_id' is distinct from p_attempt_id::text then
    raise exception 'retry_state_changed' using errcode='40001'; end if;
  update public.transcript_attempts set retry_authorized_at=now(),retry_authorized_by=auth.uid() where id=a.id;
  -- Detach before the next claim so late responses/callbacks cannot replace it.
  update public.transcript_jobs set current_attempt_id=null,status='queued',next_attempt_at=now(),
    priority=100,priority_requested_at=now(),completed_at=null,error_message=null where id=j.id;
  perform public.transcription_request_wake('dispatch');
  return reel_detail_private.read_detail(p_workspace_id,p_reel_id);
end $$;

create function public.retry_reel_transcript(p_workspace_id uuid,p_reel_id uuid,p_attempt_id uuid,p_accept_duplicate_charge boolean) returns jsonb
language sql security invoker set search_path=pg_catalog,public as $$
  select reel_detail_private.retry_transcript(p_workspace_id,p_reel_id,p_attempt_id,p_accept_duplicate_charge);
$$;
revoke all on function public.retry_reel_transcript(uuid,uuid,uuid,boolean),
  reel_detail_private.retry_transcript(uuid,uuid,uuid,boolean),reel_detail_private.read_detail(uuid,uuid),
  reel_detail_private.read_detail_pre_retry(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.retry_reel_transcript(uuid,uuid,uuid,boolean),
  reel_detail_private.retry_transcript(uuid,uuid,uuid,boolean),reel_detail_private.read_detail(uuid,uuid),
  reel_detail_private.read_detail_pre_retry(uuid,uuid) to authenticated;
-- ALTER/CREATE OR REPLACE preserves existing ACLs on the internal gate/worker
-- helpers. No queue entries, schedules, ceilings or billing rows change in DDL.
