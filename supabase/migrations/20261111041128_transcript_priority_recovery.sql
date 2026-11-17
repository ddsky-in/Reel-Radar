-- Recover abandoned work only when the database proves the paid submission
-- fence was never crossed. Authorized/ambiguous submissions retain their holds.
alter table public.transcript_jobs
  add column priority integer not null default 0 check(priority in (0,100)),
  add column priority_requested_at timestamptz;
create index transcript_jobs_priority_queue on public.transcript_jobs(priority desc,priority_requested_at,created_at,id)
  where status in ('queued','budget_paused','awaiting_media') and attempt_count<3;

create function public.worker_transcription_release_unsubmitted(p_attempt_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts;
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
  if a.status='not_started' then return jsonb_build_object('released',true,'duplicate',true); end if;
  if a.submit_authorized or a.provider_job_id is not null or a.provider_transcription_id is not null
    or a.status not in ('submitting','uncertain') then return jsonb_build_object('released',false,'reason','submission_may_have_started'); end if;
  -- This same settings/job/attempt lock also fences before_submit. A delayed
  -- worker cannot obtain paid permission after this terminal transition.
  update public.transcript_attempts set status='not_started',submit_denied=true,submit_checked_at=now(),
    reserved_usd=0,accounted_usd=0,actual_cost_usd=0,reconciled_at=now(),completed_at=now() where id=a.id;
  update public.transcript_jobs set status=case when attempt_count<3 then 'queued' else 'failed' end,
    next_attempt_at=case when a.lease_expires_at<now()-interval '1 minute' then now()
      else now()+make_interval(secs=>least(300,15*power(2,greatest(0,attempt_count-1)))::integer) end,
    completed_at=case when attempt_count>=3 then now() end,
    error_message='Worker stopped before paid submission; retry is bounded and budget checked.' where id=a.job_id;
  return jsonb_build_object('released',true,'duplicate',false);
end $$;
revoke all on function public.worker_transcription_release_unsubmitted(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_release_unsubmitted(uuid,uuid) to service_role;

create function public.worker_transcription_recover_stale() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a record; recovered integer:=0; result jsonb;
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  for a in select aa.id,aa.lease_token from public.transcript_attempts aa
    join public.transcript_jobs j on j.id=aa.job_id and j.current_attempt_id=aa.id
    where aa.status in ('submitting','uncertain') and aa.lease_expires_at<now()
      and not aa.submit_authorized and aa.provider_job_id is null and aa.provider_transcription_id is null
    order by aa.created_at,aa.id limit 100 loop
    result:=public.worker_transcription_release_unsubmitted(a.id,a.lease_token);
    if coalesce((result->>'released')::boolean,false) then recovered:=recovered+1; end if;
  end loop;
  return jsonb_build_object('recovered',recovered);
end $$;
revoke all on function public.worker_transcription_recover_stale() from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_recover_stale() to service_role;

-- Change queue ordering, not payment/concurrency policy. A bounded scan avoids
-- a large missing-media backlog holding the settings lock beyond RPC timeouts.
do $$ declare definition text; begin
  select pg_get_functiondef('public.worker_transcription_claim(integer)'::regprocedure) into definition;
  if definition not like '%order by jj.created_at,jj.id for update of jj loop%'
    or definition not like '%public.transcription_paid_gate()%'
    or definition not like '%public.transcription_combined_budget(s.reservation_usd)%'
    or definition not like '%outstanding>=s.concurrency%' then raise exception 'priority_claim_contract_drift'; end if;
  definition:=replace(definition,'update public.transcript_jobs set status=''uncertain'',error_message=',
    'perform public.worker_transcription_recover_stale();
  update public.transcript_jobs set status=''uncertain'',error_message=');
  definition:=replace(definition,'order by jj.created_at,jj.id for update of jj loop',
    'and (jj.status<>''awaiting_media'' or exists(select 1 from public.reel_media_sources mm
      where mm.reel_id=jj.reel_id and (mm.source_url is not null or cardinality(mm.candidates)>0)
      and rr.duration_seconds between .1 and s.max_duration_seconds))
    order by jj.priority desc,jj.priority_requested_at nulls last,jj.created_at,jj.id
    limit 100 for update of jj skip locked loop');
  execute definition;
end $$;

create function reel_detail_private.failed_retry_allowed(p_reel_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.transcript_jobs j join public.transcript_attempts a on a.id=j.current_attempt_id and a.job_id=j.id
    where j.reel_id=p_reel_id and j.status='failed' and j.attempt_count<3
      and a.status in ('failed','not_started') and a.completed_at is not null and a.reserved_usd=0
      and not exists(select 1 from public.reel_transcripts t where t.reel_id=j.reel_id)
      and not exists(select 1 from public.transcript_attempts x where x.job_id=j.id and x.status in ('submitting','processing','uncertain')));
$$;
revoke all on function reel_detail_private.failed_retry_allowed(uuid) from public,anon,authenticated,service_role;

alter function reel_detail_private.read_detail(uuid,uuid) rename to read_detail_pre_priority;
revoke all on function reel_detail_private.read_detail_pre_priority(uuid,uuid) from public,anon,authenticated,service_role;
create function reel_detail_private.read_detail(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare detail jsonb; j public.transcript_jobs; s public.transcription_settings; st text; reason text; allowed boolean:=false;
  estimate jsonb; samples integer; low_seconds numeric; high_seconds numeric; ahead integer:=0; active integer:=0;
  elapsed numeric:=0; wait_seconds numeric:=0; position integer;
begin
  -- The existing private reader checks both the allowed owner and active
  -- workspace association before returning any media, Reel, or queue data.
  detail:=reel_detail_private.read_detail_pre_priority(p_workspace_id,p_reel_id);
  select * into j from public.transcript_jobs where reel_id=p_reel_id and model='scribe_v2' and options_version=1;
  select * into s from public.transcription_settings where singleton;
  st:=detail->'transcript'->>'status'; reason:=detail->'processing'->>'reason';
  if st in ('failed','media_unavailable') and reason='review_required' and public.transcription_paid_gate() is null and
    (reel_detail_private.failed_retry_allowed(p_reel_id) or reel_detail_private.media_retry_allowed(p_reel_id)) then reason:=null; end if;
  if st not in ('ready','no_speech','processing','submitting') and j.attempt_count>=3 then reason:='retry_limit_reached'; end if;
  -- Promotion itself is free and allowed while paused or budget limited. Only
  -- the workers can claim paid work after all live gates become ready again.
  allowed:=(reason is null or reason in ('paused','budget_paused'))
    and detail->'reel'->>'creator_status' not in ('private','unavailable','paused') and coalesce(j.attempt_count,0)<3 and
    (st in ('not_requested','awaiting_media','queued','budget_paused')
      or st='failed' and reel_detail_private.failed_retry_allowed(p_reel_id)
      or st='media_unavailable' and reel_detail_private.media_retry_allowed(p_reel_id));
  if st in ('queued','budget_paused') then
    select count(*) into ahead from public.transcript_jobs q join public.reels rr on rr.id=q.reel_id
      join public.creators c on c.id=rr.creator_id join public.reel_media_sources m on m.reel_id=rr.id
      where q.id<>j.id and q.status in ('queued','budget_paused','awaiting_media') and q.attempt_count<3
        and q.next_attempt_at<=greatest(now(),j.next_attempt_at)
        and rr.duration_seconds between .1 and s.max_duration_seconds
        and (m.source_url is not null or cardinality(m.candidates)>0) and c.status not in ('private','unavailable','paused')
        and (-q.priority,coalesce(q.priority_requested_at,q.created_at),q.created_at,q.id)
          <(-j.priority,coalesce(j.priority_requested_at,j.created_at),j.created_at,j.id)
        and not exists(select 1 from public.reel_transcripts t where t.reel_id=rr.id)
        and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
          where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid());
    position:=ahead+1;
    wait_seconds:=greatest(0,extract(epoch from j.next_attempt_at-now()));
  end if;
  if reason is null and s.phase='automatic' and st in ('queued','submitting','processing') then
    select count(*),percentile_cont(.5) within group(order by seconds),percentile_cont(.9) within group(order by seconds)
      into samples,low_seconds,high_seconds from (
        select extract(epoch from a.completed_at-a.created_at) seconds from public.transcript_attempts a
        join public.transcript_jobs tj on tj.id=a.job_id join public.reels rr on rr.id=tj.reel_id
        where a.status='ready' and tj.model='scribe_v2' and tj.options_version=1 and a.completed_at>now()-interval '7 days'
          and a.completed_at>a.created_at and a.completed_at-a.created_at<=interval '1 hour'
          and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
            where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid())
        order by a.completed_at desc limit 50) recent;
    if samples>=5 then
      if st in ('submitting','processing') then
        select greatest(0,extract(epoch from now()-created_at)) into elapsed from public.transcript_attempts where id=j.current_attempt_id;
      else
        select count(*) into active from public.transcript_attempts where status in ('submitting','processing');
        low_seconds:=low_seconds*(1+floor((ahead+active)::numeric/greatest(1,s.concurrency)))+wait_seconds;
        high_seconds:=high_seconds*(1+ceil((ahead+active)::numeric/greatest(1,s.concurrency)))+wait_seconds;
      end if;
      if coalesce(elapsed,0)<high_seconds and high_seconds<=86400 then
        estimate:=jsonb_build_object('min_seconds',greatest(1,ceil(low_seconds-coalesce(elapsed,0))),
          'max_seconds',greatest(1,ceil(high_seconds-coalesce(elapsed,0))),'sample_count',samples,'estimated_at',now());
      end if;
    end if;
  end if;
  return jsonb_set(detail,'{processing}',jsonb_build_object('request_allowed',coalesce(allowed,false),'reason',reason,'estimate',estimate,
    'priority',case when j.priority=100 then 'high' else 'normal' end,'queue_position',position,
    'retry_after_seconds',ceil(wait_seconds)));
end $$;
revoke all on function reel_detail_private.read_detail(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.read_detail(uuid,uuid) to authenticated;

create or replace function reel_detail_private.request_transcript(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare detail jsonb; st text;
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform public.require_workspace(p_workspace_id);
  perform pg_advisory_xact_lock(hashtextextended('reel-transcript:'||p_reel_id::text,0));
  perform 1 from public.transcription_settings where singleton for update;
  perform 1 from public.transcript_jobs where reel_id=p_reel_id for update;
  detail:=reel_detail_private.read_detail(p_workspace_id,p_reel_id);
  if (detail->'processing'->>'request_allowed')::boolean then
    st:=detail->'transcript'->>'status';
    if st in ('failed','media_unavailable') then
      update public.transcript_jobs set status='queued',next_attempt_at=now(),completed_at=null,error_message=null where reel_id=p_reel_id;
      st:='queued';
    elsif st='not_requested' then st:=public.transcription_enqueue(p_reel_id); end if;
    update public.transcript_jobs set priority=100,priority_requested_at=coalesce(priority_requested_at,now())
      where reel_id=p_reel_id and status in ('queued','awaiting_media','budget_paused') and priority<>100;
    if st='awaiting_media' then perform public.transcription_request_wake('maintenance');
    elsif st in ('queued','budget_paused') then perform public.transcription_request_wake('dispatch'); end if;
  end if;
  return reel_detail_private.read_detail(p_workspace_id,p_reel_id);
end $$;
revoke all on function reel_detail_private.request_transcript(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.request_transcript(uuid,uuid) to authenticated;

-- Missing-media recovery uses the same priority, without changing its durable
-- target membership or creating additional paid recovery for a previous target.
create or replace function public.worker_transcription_media_candidates(p_limit integer default 1) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid;
begin
  perform public.require_service();
  if p_limit is null or p_limit not between 1 and 4 then raise exception 'invalid_candidate_limit' using errcode='22023'; end if;
  if public.transcription_paid_gate() is not null or not (select media_recovery_enabled from public.transcription_settings where singleton) then
    return jsonb_build_object('creators','[]'::jsonb); end if;
  select owner_user_id into owner_id from public.app_settings where singleton;
  return jsonb_build_object('creators',coalesce((select jsonb_agg(jsonb_build_object('creator_id',x.creator_id,'username',x.username)
    order by x.priority desc,x.requested_at nulls last,x.username,x.creator_id) from (
      select c.id creator_id,c.username,max(t.priority) priority,min(t.priority_requested_at) requested_at
      from public.creators c join public.reels r on r.creator_id=c.id join public.transcript_jobs t on t.reel_id=r.id
      where c.status not in ('private','unavailable','paused') and public.transcription_recovery_target(owner_id,t.reel_id)
        and not exists(select 1 from public.transcription_media_refreshes m where m.owner_user_id=owner_id and m.creator_id=c.id and m.status='active')
      group by c.id,c.username order by max(t.priority) desc,min(t.priority_requested_at) nulls last,c.username,c.id limit p_limit
    ) x),'[]'::jsonb));
end $$;
revoke all on function public.worker_transcription_media_candidates(integer) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_media_candidates(integer) to service_role;

-- No live queue is changed by DDL. Recovery runs with the next authorized worker
-- invocation, and every retried attempt still reserves budget transactionally.
