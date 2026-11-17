-- Only an explicit, owner-authorized transcript request may consume allowance.
-- Existing request timestamps were written only by request/retry RPCs. Preserve
-- them and every result, attempt, reservation, configured budget and schedule.
-- The existing maintenance worker may finish requested work, never the backlog.
do $$
declare definition text; anchor text;
begin
  select pg_get_functiondef('public.worker_transcription_claim(integer)'::regprocedure) into definition;
  anchor:='where jj.status in (''queued'',''budget_paused'',''awaiting_media'')';
  if position(anchor in definition)=0 or definition not like '%public.transcription_combined_budget(s.reservation_usd)%'
    or definition not like '%outstanding>=s.concurrency%' then raise exception 'on_demand_claim_contract_drift'; end if;
  execute replace(definition,anchor,'where jj.priority_requested_at is not null and jj.status in (''queued'',''budget_paused'',''awaiting_media'')');

  -- Also fence a dispatcher that claimed automatic work before this migration.
  select pg_get_functiondef('public.worker_transcription_before_submit(uuid,uuid)'::regprocedure) into definition;
  anchor:='where j.id=a.job_id and';
  if position(anchor in definition)=0 or definition not like '%transcription_locked_attempt%'
    or definition not like '%submit_authorized=reason is null%' then raise exception 'on_demand_submit_contract_drift'; end if;
  execute replace(definition,anchor,'where j.id=a.job_id and j.priority_requested_at is not null and');

  select pg_get_functiondef('public.transcription_recovery_target(uuid,uuid)'::regprocedure) into definition;
  anchor:='where s.singleton and r.id=p_reel_id';
  if position(anchor in definition)=0 or definition not like '%w.owner_user_id=p_owner_user_id%' then
    raise exception 'on_demand_recovery_contract_drift'; end if;
  execute replace(definition,anchor,'where t.priority_requested_at is not null and s.singleton and r.id=p_reel_id');

  select pg_get_functiondef('public.transcription_request_wake(text)'::regprocedure) into definition;
  anchor:='where j.attempt_count < 3';
  if position(anchor in definition)=0 then raise exception 'on_demand_wake_contract_drift'; end if;
  execute replace(definition,anchor,'where j.priority_requested_at is not null and j.attempt_count < 3');

  -- Queue positions count only requested work, including retained manual retries.
  select pg_get_functiondef('reel_detail_private.read_detail_pre_completion(uuid,uuid)'::regprocedure) into definition;
  anchor:='where q.id<>j.id and';
  if position(anchor in definition)=0 then raise exception 'on_demand_position_contract_drift'; end if;
  execute replace(definition,anchor,'where q.priority_requested_at is not null and q.id<>j.id and');

  -- Unrequested imported metadata is not waiting work. History stays visible.
  select pg_get_functiondef('public.get_transcription_overview()'::regprocedure) into definition;
  anchor:='where exists(select 1 from public.workspace_creators wc';
  if position(anchor in definition)=0 then raise exception 'on_demand_overview_contract_drift'; end if;
  execute replace(definition,anchor,'where (j.priority_requested_at is not null or j.attempt_count>0 or j.status in (''ready'',''no_speech'',''failed'',''media_unavailable''))
 and exists(select 1 from public.workspace_creators wc');
end $$;

create or replace function public.get_reel_transcript(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare t public.reel_transcripts; j public.transcript_jobs; st text;
begin
 perform public.require_workspace(p_workspace_id);
 if not exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id
   join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.workspace_id=p_workspace_id
   and wc.active and w.archived_at is null) then raise exception 'reel_not_in_workspace' using errcode='42501'; end if;
 select * into t from public.reel_transcripts where reel_id=p_reel_id and model='scribe_v2' and options_version=1;
 select * into j from public.transcript_jobs where reel_id=p_reel_id and model='scribe_v2' and options_version=1;
 st:=coalesce(t.status,case when j.priority_requested_at is null and j.attempt_count=0
   and j.status in ('queued','budget_paused','awaiting_media') then 'not_requested' else j.status end,'not_requested');
 return jsonb_build_object('reel_id',p_reel_id,'status',st,'text',t.text,'language',t.language,
   'segments',coalesce(t.segments,'[]'::jsonb),'model',coalesce(t.model,j.model),
   'completed_at',coalesce(t.completed_at,j.completed_at),
   'error_message',case when t.reel_id is null and st<>'not_requested' then j.error_message end);
end $$;

-- No new grants, spending limits, paid starts, or schedule changes.
revoke all on function public.worker_transcription_claim(integer),public.worker_transcription_before_submit(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_claim(integer),public.worker_transcription_before_submit(uuid,uuid) to service_role;
revoke all on function public.transcription_recovery_target(uuid,uuid),public.transcription_request_wake(text),
 reel_detail_private.read_detail_pre_completion(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_reel_transcript(uuid,uuid),public.get_transcription_overview() from public,anon,authenticated,service_role;
grant execute on function public.get_reel_transcript(uuid,uuid),public.get_transcription_overview() to authenticated;
