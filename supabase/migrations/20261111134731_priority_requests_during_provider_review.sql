-- Priority promotion is free. A different acceptance-unknown submission must not
-- hide the queued Reel's action, bypass paid gates, or retry the unknown attempt.
do $$
declare definition text;
  anchor text := '  -- Promotion itself is free and allowed while paused or budget limited. Only';
  allowed_before text := 'allowed:=(reason is null or reason in (''paused'',''budget_paused''))';
begin
  select pg_get_functiondef('reel_detail_private.read_detail_pre_completion(uuid,uuid)'::regprocedure) into definition;
  if position(anchor in definition)=0 or position(allowed_before in definition)=0
    or definition not like '%read_detail_pre_priority%'
    or definition not like '%request_allowed%' then
    raise exception 'provider_review_priority_reader_contract_drift';
  end if;
  definition:=replace(definition,anchor,$reader$
  if reason='review_required' and public.transcription_paid_gate()='uncertain'
    and st in ('not_requested','awaiting_media','queued','budget_paused')
    and coalesce(j.attempt_count,0)<3
    and detail->'reel'->>'creator_status' not in ('private','unavailable','paused')
    and (st<>'awaiting_media' or s.media_recovery_enabled)
    and not exists(select 1 from public.reel_transcripts where reel_id=p_reel_id)
    and not exists(select 1 from public.transcript_attempts where job_id=j.id
      and status in ('submitting','processing','uncertain')) then
    reason:='provider_review_required';
  end if;
  -- Promotion itself is free and allowed while paused or budget limited. Only
$reader$);
  definition:=replace(definition,allowed_before,
    'allowed:=(reason is null or reason in (''paused'',''budget_paused'',''provider_review_required''))');
  execute definition;
end $$;

-- Save priority during provider review, without waking a paid dispatcher that
-- is known to be blocked. Normal ready-gate requests retain immediate wakeups.
do $$
declare definition text;
  original text := $wake$    if st='awaiting_media' then perform public.transcription_request_wake('maintenance');
    elsif st in ('queued','budget_paused') then perform public.transcription_request_wake('dispatch'); end if;$wake$;
begin
  select pg_get_functiondef('reel_detail_private.request_transcript(uuid,uuid)'::regprocedure) into definition;
  if position(original in definition)=0 or definition not like '%public.require_workspace(p_workspace_id)%'
    or definition not like '%priority=100%' then
    raise exception 'provider_review_priority_request_contract_drift';
  end if;
  execute replace(definition,original,$wake$
    if detail#>>'{processing,reason}' is distinct from 'provider_review_required' then
      if st='awaiting_media' then perform public.transcription_request_wake('maintenance');
      elsif st in ('queued','budget_paused') then perform public.transcription_request_wake('dispatch'); end if;
    end if;
$wake$);
end $$;

revoke all on function reel_detail_private.read_detail_pre_completion(uuid,uuid)
  from public,anon,authenticated,service_role;
revoke all on function reel_detail_private.request_transcript(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.request_transcript(uuid,uuid) to authenticated;

