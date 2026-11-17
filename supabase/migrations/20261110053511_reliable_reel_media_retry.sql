-- Media metadata is not proof of no speech. Only a completed STT result can say
-- no_speech. Do not queue or spend on historical metadata-only outcomes here.
with metadata_only as (
  delete from public.reel_transcripts t using public.transcript_jobs j
  where t.reel_id=j.reel_id and t.model=j.model and t.options_version=j.options_version
    and t.status='no_speech' and t.text='' and t.language is null and t.segments='[]'::jsonb
    and j.status='no_speech' and j.attempt_count=0 and j.current_attempt_id is null
    and not exists(select 1 from public.transcript_attempts a where a.job_id=j.id)
  returning t.reel_id
)
update public.transcript_jobs set status='media_unavailable',
  error_message='Audio has not been verified from the stored video. Retry checks downloadable media.'
where reel_id in (select reel_id from metadata_only);

-- Preserve owner eligibility, atomic reservations, pilot starts, uncertain holds,
-- two automatic claims and the existing pre-submit fence. Ignore has_audio hints.
create or replace function public.worker_transcription_claim(p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; j public.transcript_jobs; a public.transcript_attempts; r public.reels; m public.reel_media_sources;
  jobs jsonb:='[]'; reason text; outstanding integer; pilot_starts integer; owner_id uuid;
begin
  perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
  if p_limit is null or p_limit not between 1 and 2 then raise exception 'invalid_claim_limit' using errcode='22023'; end if;
  update public.transcript_jobs set status='uncertain',error_message='Acceptance unknown; manual reconciliation required.'
    where status in ('submitting','processing') and current_attempt_id in (select id from public.transcript_attempts where lease_expires_at<now());
  update public.transcript_attempts set status='uncertain' where status in ('submitting','processing') and lease_expires_at<now();
  reason:=public.transcription_paid_gate();
  if reason is not null then return jsonb_build_object('reason',reason,'jobs',jobs); end if;
  select count(*) into outstanding from public.transcript_attempts where status in ('submitting','processing','uncertain');
  for j in select jj.* from public.transcript_jobs jj join public.reels rr on rr.id=jj.reel_id join public.creators c on c.id=rr.creator_id
    where jj.status in ('queued','budget_paused','awaiting_media') and jj.attempt_count<3 and jj.next_attempt_at<=now()
      and c.status not in ('private','unavailable','paused')
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        join public.app_settings ap on ap.owner_user_id=w.owner_user_id where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null)
      and not exists(select 1 from public.reel_transcripts t where t.reel_id=jj.reel_id)
    order by jj.created_at,jj.id for update of jj loop
    exit when jsonb_array_length(jobs)>=least(p_limit,s.concurrency,case when s.phase='pilot' then 1 else 2 end);
    select * into r from public.reels where id=j.reel_id;
    select * into m from public.reel_media_sources where reel_id=j.reel_id;
    if r.duration_seconds is null or r.duration_seconds<.1 then
      update public.transcript_jobs set status=case when (j.media_recovery_eligible or s.phase='automatic') and s.media_recovery_enabled then 'awaiting_media' else 'media_unavailable' end,error_message=null
        where id=j.id and (status is distinct from case when (j.media_recovery_eligible or s.phase='automatic') and s.media_recovery_enabled then 'awaiting_media' else 'media_unavailable' end or error_message is not null); continue;
    elsif r.duration_seconds>s.max_duration_seconds then
      update public.transcript_jobs set status='media_unavailable',error_message='Media exceeds the duration limit.' where id=j.id; continue;
    end if;
    if m.source_url is null and coalesce(cardinality(m.candidates),0)=0 then
      update public.transcript_jobs set status='awaiting_media',error_message=null where id=j.id and (status is distinct from 'awaiting_media' or error_message is not null); continue;
    end if;
    if outstanding>=s.concurrency then reason:='concurrency'; exit; end if;
    select w.owner_user_id into owner_id from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
      join public.app_settings ap on ap.owner_user_id=w.owner_user_id
      where wc.creator_id=r.creator_id and wc.active and w.archived_at is null order by w.created_at,w.id limit 1;
    perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
    perform 1 from public.app_settings where owner_user_id=owner_id for update;
    select count(*) into pilot_starts from public.transcript_attempts where phase='pilot';
    if not public.transcription_combined_budget(s.reservation_usd) or s.phase='pilot' and pilot_starts>=s.max_starts then
      update public.transcript_jobs set status='budget_paused',error_message='Transcription budget or pilot start limit reached.'
        where id=j.id and (status is distinct from 'budget_paused' or error_message is distinct from 'Transcription budget or pilot start limit reached.');
      reason:='budget_paused'; continue;
    end if;
    insert into public.transcript_attempts(job_id,attempt_number,lease_expires_at,phase,billing_month,reserved_usd)
      values(j.id,j.attempt_count+1,now()+interval '15 minutes',s.phase,date_trunc('month',now() at time zone 'UTC')::date,s.reservation_usd) returning * into a;
    update public.transcript_jobs set status='submitting',attempt_count=attempt_count+1,current_attempt_id=a.id,error_message=null,completed_at=null where id=j.id;
    outstanding:=outstanding+1;
    jobs:=jobs||jsonb_build_array(jsonb_build_object('id',j.id,'reel_id',j.reel_id,'attempt_id',a.id,'lease_token',a.lease_token,'lease_expires_at',a.lease_expires_at,
      'source_url',m.source_url,'candidates',m.candidates,'has_audio',m.has_audio,'duration_seconds',r.duration_seconds,'model',j.model,'options_version',j.options_version,
      'reservation_usd',s.reservation_usd,'max_duration_seconds',s.max_duration_seconds,'max_media_bytes',s.max_media_bytes));
  end loop;
  return jsonb_build_object('reason',case when jsonb_array_length(jobs)>0 then null else coalesce(reason,'empty') end,'jobs',jobs);
end $$;
revoke all on function public.worker_transcription_claim(integer) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_claim(integer) to service_role;

-- A false provider audio hint cannot exclude an awaiting-media Reel from the
-- existing bounded recovery policy. Durable paid-refresh exclusions still apply.
create or replace function public.transcription_recovery_target(p_owner_user_id uuid,p_reel_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.transcript_jobs t join public.reels r on r.id=t.reel_id
    join public.creators c on c.id=r.creator_id cross join public.transcription_settings s
    where s.singleton and r.id=p_reel_id and t.status='awaiting_media' and t.attempt_count<3
      and t.next_attempt_at<=now() and t.completed_at is null
      and (t.media_recovery_eligible or s.phase='automatic')
      and c.status not in ('private','unavailable','paused')
      and (r.duration_seconds is null or r.duration_seconds<=s.max_duration_seconds)
      and not exists(select 1 from public.reel_transcripts where reel_id=r.id)
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        join public.app_settings ap on ap.owner_user_id=w.owner_user_id
        where wc.creator_id=r.creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)
      and not exists(select 1 from public.transcription_media_targets mt join public.transcription_media_refreshes mr on mr.id=mt.refresh_id
        where mt.reel_id=r.id and mr.owner_user_id=p_owner_user_id));
$$;
revoke all on function public.transcription_recovery_target(uuid,uuid) from public,anon,authenticated,service_role;

-- A terminal media retry must be an explicit owner request, with proof that no
-- prior attempt crossed the paid fence. Media observation alone never requeues it.
create function reel_detail_private.media_retry_allowed(p_reel_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.transcript_jobs j join public.reels r on r.id=j.reel_id
    join public.reel_media_sources m on m.reel_id=r.id join public.transcription_settings s on s.singleton
    where r.id=p_reel_id and j.status='media_unavailable' and j.attempt_count<3
      and r.duration_seconds between .1 and s.max_duration_seconds
      and (public.transcription_valid_media_url(m.source_url) or exists(select 1 from unnest(m.candidates) u(url) where public.transcription_valid_media_url(url)))
      and not exists(select 1 from public.reel_transcripts t where t.reel_id=r.id)
      and not exists(select 1 from public.transcript_attempts a where a.job_id=j.id and
        (a.submit_authorized or a.provider_job_id is not null or a.provider_transcription_id is not null or a.status not in ('media_unavailable','not_started')))
      and (j.current_attempt_id is null and j.attempt_count=0 or exists(select 1 from public.transcript_attempts a
        where a.id=j.current_attempt_id and a.job_id=j.id and a.status in ('media_unavailable','not_started') and not a.submit_authorized)));
$$;
revoke all on function reel_detail_private.media_retry_allowed(uuid) from public,anon,authenticated,service_role;

create or replace function reel_detail_private.read_detail(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare detail jsonb; caption text;
begin
  detail:=reel_detail_private.read_detail_pre_caption(p_workspace_id,p_reel_id);
  select caption_full into caption from public.reels where id=p_reel_id;
  if detail->'transcript'->>'status'='media_unavailable' and detail->'processing'->>'reason'='review_required'
    and public.transcription_paid_gate() is null and reel_detail_private.media_retry_allowed(p_reel_id) then
    detail:=jsonb_set(detail,'{processing}',jsonb_build_object('request_allowed',true,'reason',null,'estimate',null));
  end if;
  return detail||jsonb_build_object('caption_full',caption);
end $$;
revoke all on function reel_detail_private.read_detail(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.read_detail(uuid,uuid) to authenticated;

create or replace function reel_detail_private.request_transcript(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare detail jsonb; st text;
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('reel-transcript:'||p_reel_id::text,0));
  -- Same settings lock order as workers, plus a locked job. Concurrent requests
  -- and callbacks cannot create two attempts or change an uncertain outcome.
  perform 1 from public.transcription_settings where singleton for update;
  perform 1 from public.transcript_jobs where reel_id=p_reel_id for update;
  detail:=reel_detail_private.read_detail(p_workspace_id,p_reel_id);
  if (detail->'processing'->>'request_allowed')::boolean then
    if detail->'transcript'->>'status'='media_unavailable' then
      update public.transcript_jobs set status='queued',next_attempt_at=now(),completed_at=null,error_message=null
        where reel_id=p_reel_id and reel_detail_private.media_retry_allowed(p_reel_id);
      st:='queued';
    else st:=public.transcription_enqueue(p_reel_id); end if;
    if st='awaiting_media' then perform public.transcription_request_wake('maintenance');
    elsif st='queued' then perform public.transcription_request_wake('dispatch'); end if;
  end if;
  return reel_detail_private.read_detail(p_workspace_id,p_reel_id);
end $$;
revoke all on function reel_detail_private.request_transcript(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.request_transcript(uuid,uuid) to authenticated;

-- Explicit operator-only source repair. Automatic maintenance cannot invoke this
-- endpoint. A single latest-100 harvest only updates frozen existing Reel IDs,
-- including captions and media; it never requeues terminal transcription jobs.
create function public.worker_transcription_source_refresh_enqueue(p_creator_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; owner_id uuid; m public.transcription_media_refreshes; jid uuid; targets uuid[]; reason text;
begin
  perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
  reason:=public.transcription_paid_gate();
  if reason is not null or not s.media_recovery_enabled or s.phase<>'automatic' then
    return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason',coalesce(reason,'source_refresh_disabled')); end if;
  select w.owner_user_id into owner_id from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
    join public.app_settings ap on ap.owner_user_id=w.owner_user_id join public.creators c on c.id=wc.creator_id
    where c.id=p_creator_id and c.status not in ('private','unavailable','paused') and wc.active and w.archived_at is null
    order by w.created_at,w.id limit 1;
  if owner_id is null then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason','creator_not_eligible'); end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
  perform 1 from public.app_settings where owner_user_id=owner_id for update;
  select * into m from public.transcription_media_refreshes where owner_user_id=owner_id and creator_id=p_creator_id and status='active';
  if found then return jsonb_build_object('job_id',m.job_id,'refresh_id',m.id,'target_count',m.target_count,'reason','already_queued'); end if;
  select array_agg(x.id order by x.published_at desc nulls last,x.id) into targets from
    (select r.id,r.published_at from public.reels r where r.creator_id=p_creator_id and
      (r.caption_full is null or reel_detail_private.media_retry_allowed(r.id)) order by r.published_at desc nulls last,r.id limit 100) x;
  if coalesce(cardinality(targets),0)=0 then reason:='no_source_repairs';
  elsif not public.transcription_combined_budget(.01) then reason:='budget_paused'; end if;
  if reason is not null then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason',reason); end if;
  insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,manual_authorized_by,priority)
    values(owner_id,'manual',1,100,.01,owner_id,100) returning id into jid;
  insert into public.scrape_job_creators(job_id,creator_id) values(jid,p_creator_id);
  insert into public.transcription_media_refreshes(job_id,owner_user_id,creator_id,phase,billing_month,target_count)
    values(jid,owner_id,p_creator_id,s.phase,date_trunc('month',now() at time zone 'UTC')::date,cardinality(targets)) returning * into m;
  insert into public.transcription_media_targets(refresh_id,creator_id,reel_id,shortcode)
    select m.id,p_creator_id,r.id,r.shortcode from public.reels r where r.id=any(targets);
  return jsonb_build_object('job_id',jid,'refresh_id',m.id,'target_count',m.target_count,'reason',null);
end $$;
revoke all on function public.worker_transcription_source_refresh_enqueue(uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_source_refresh_enqueue(uuid) to service_role;
