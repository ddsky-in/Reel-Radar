-- Media preparation happens before the paid submission fence. A definitive
-- failure there costs $0; submitted/ambiguous attempts remain conservatively held.
create or replace function public.worker_transcription_fail(p_attempt_id uuid,p_lease_token uuid,p_status text,p_error_message text default null,p_estimated_cost_usd numeric default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; j public.transcript_jobs; st text; msg text; unsubmitted boolean;
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
  if a.status in ('ready','no_speech','failed','media_unavailable','not_started') then
    return jsonb_build_object('status',a.status,'duplicate',true); end if;
  if p_status is null or p_status not in ('uncertain','media_unavailable','failed')
    or (p_estimated_cost_usd is not null and p_estimated_cost_usd not between 0 and 10000) then
    raise exception 'invalid_failure' using errcode='22023'; end if;
  if a.status='uncertain' and p_status<>'uncertain' then
    raise exception 'reconciliation_required' using errcode='40001'; end if;
  select * into j from public.transcript_jobs where id=a.job_id;
  unsubmitted:=p_status='media_unavailable' and a.status='submitting'
    and not a.submit_authorized and a.provider_job_id is null and a.provider_transcription_id is null
    and a.actual_cost_usd is null and a.reconciled_at is null
    and coalesce(p_estimated_cost_usd,0)=0 and coalesce(a.estimated_cost_usd,0)=0;
  -- Browser-visible errors never include caller detail (signed URLs/secrets).
  msg:=case p_status when 'uncertain' then 'Acceptance unknown; manual reconciliation required.'
    when 'media_unavailable' then 'Media unavailable or exceeds download limits; automatic recovery disabled.'
    else 'Transcription failed.' end;
  update public.transcript_attempts set status=p_status,
    lease_expires_at=case when p_status='uncertain' then least(lease_expires_at,now()) else lease_expires_at end,
    completed_at=case when p_status<>'uncertain' then now() end,estimated_cost_usd=p_estimated_cost_usd,
    accounted_usd=case when unsubmitted then 0 when p_status='uncertain' then accounted_usd
      else greatest(accounted_usd,reserved_usd,coalesce(p_estimated_cost_usd,0)) end,
    reserved_usd=case when p_status='uncertain' then reserved_usd else 0 end,
    actual_cost_usd=case when unsubmitted then 0 else actual_cost_usd end,
    reconciled_at=case when unsubmitted then now() else reconciled_at end,
    submit_denied=case when unsubmitted then true else submit_denied end,
    submit_checked_at=case when unsubmitted then now() else submit_checked_at end where id=a.id;
  st:=case when p_status='failed' and j.attempt_count<3 then 'queued' else p_status end;
  update public.transcript_jobs set status=st,error_message=msg,next_attempt_at=now()+interval '5 minutes',
    completed_at=case when st in ('failed','media_unavailable') then now() end where id=j.id;
  return jsonb_build_object('status',st,'duplicate',a.status=p_status);
end $$;
revoke all on function public.worker_transcription_fail(uuid,uuid,text,text,numeric) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_fail(uuid,uuid,text,text,numeric) to service_role;

-- A delayed response/callback cannot attach identity to a proven unpaid terminal
-- attempt. before_submit and complete already reject these terminal states.
do $$
declare definition text; anchor text := 'if p_provider_job_id is null';
begin
  select pg_get_functiondef('public.worker_transcription_attach(uuid,uuid,text,text)'::regprocedure) into definition;
  if position(anchor in definition)=0 or definition not like '%transcription_locked_attempt%'
    or definition not like '%SET search_path TO ''pg_catalog'', ''public''%' then
    raise exception 'unsubmitted_attach_contract_drift'; end if;
  execute replace(definition,anchor,
    'if a.status in (''media_unavailable'',''not_started'') and not a.submit_authorized
      and a.provider_job_id is null and a.provider_transcription_id is null
      and a.actual_cost_usd=0 and a.reconciled_at is not null then
      return jsonb_build_object(''status'',a.status,''duplicate'',true);
    end if;
    if p_provider_job_id is null');
end $$;
revoke all on function public.worker_transcription_attach(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_attach(uuid,uuid,text,text) to service_role;

-- Authoritative reconciliation replaces the provisional allocation. Calling
-- this existing service-only RPC still requires verified provider USD metadata.
do $$
declare definition text; anchor text := 'accounted_usd=greatest(accounted_usd,reserved_usd,p_actual_cost_usd)';
begin
  select pg_get_functiondef('public.worker_transcription_reconcile(uuid,text,numeric)'::regprocedure) into definition;
  if position(anchor in definition)=0 or definition not like '%reconciliation_mismatch%'
    or definition not like '%require_service()%' then raise exception 'verified_cost_contract_drift'; end if;
  execute replace(definition,anchor,'accounted_usd=p_actual_cost_usd');
end $$;
revoke all on function public.worker_transcription_reconcile(uuid,text,numeric) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_reconcile(uuid,text,numeric) to service_role;

-- Historical repair is explicit, service-only, owner/workspace scoped and
-- idempotent. It never guesses USD costs or releases paid/ambiguous submissions.
create function public.worker_transcription_correct_unsubmitted(p_workspace_id uuid,p_owner_user_id uuid,p_attempt_ids uuid[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; entry record; corrected integer:=0; released numeric:=0;
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  if p_attempt_ids is null or cardinality(p_attempt_ids) not between 1 and 500
    or array_position(p_attempt_ids,null) is not null then
    raise exception 'invalid_correction_attempts' using errcode='22023'; end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id
    and owner_user_id=p_owner_user_id and archived_at is null) then
    raise exception 'forbidden' using errcode='42501'; end if;
  if exists(select 1 from unnest(p_attempt_ids) requested(id) where not exists(
    select 1 from public.transcript_attempts aa join public.transcript_jobs j on j.id=aa.job_id
    join public.reels r on r.id=j.reel_id join public.workspace_creators wc on wc.creator_id=r.creator_id
    where aa.id=requested.id and wc.workspace_id=p_workspace_id and wc.active)) then
    raise exception 'forbidden' using errcode='42501'; end if;
  for entry in select aa.id,aa.job_id from public.transcript_attempts aa
    where aa.id=any(p_attempt_ids) order by aa.job_id,aa.id loop
    perform 1 from public.transcript_jobs where id=entry.job_id for update;
    select * into a from public.transcript_attempts where id=entry.id for update;
    if a.status<>'media_unavailable' or a.submit_authorized or a.provider_job_id is not null
      or a.provider_transcription_id is not null or a.actual_cost_usd is not null
      or a.reconciled_at is not null or coalesce(a.estimated_cost_usd,0)<>0 then continue; end if;
    released:=released+a.accounted_usd+a.reserved_usd;
    update public.transcript_attempts set accounted_usd=0,reserved_usd=0,actual_cost_usd=0,
      reconciled_at=now(),submit_denied=true,submit_checked_at=now() where id=a.id;
    corrected:=corrected+1;
  end loop;
  return jsonb_build_object('corrected',corrected,'released_usd',released);
end $$;
revoke all on function public.worker_transcription_correct_unsubmitted(uuid,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_correct_unsubmitted(uuid,uuid,uuid[]) to service_role;
