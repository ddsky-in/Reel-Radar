-- Narrow owner-facing contracts over private media/transcription tables.
-- No new schedules, provider calls, credentials, activation, or paid-cap changes.
create schema if not exists reel_detail_private;
revoke all on schema reel_detail_private from public, anon, authenticated, service_role;
grant usage on schema reel_detail_private to authenticated;

-- Privileged private lookup is intentional: media tables stay inaccessible to
-- browser roles. Every invocation independently checks the verified owner and
-- active Reel/workspace association, including direct calls to this helper.
create function reel_detail_private.read_detail(p_workspace_id uuid, p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare r jsonb; t jsonb; j public.transcript_jobs; s public.transcription_settings;
  reason text; gate text; urls text[]; observed timestamptz;
  estimate jsonb; samples integer; low_seconds numeric; high_seconds numeric;
  ahead integer; elapsed numeric := 0; wait_seconds numeric := 0;
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform public.require_workspace(p_workspace_id);
  if not exists (select 1 from public.reels rr join public.workspace_creators wc on wc.creator_id=rr.creator_id
    join public.workspaces w on w.id=wc.workspace_id where rr.id=p_reel_id and wc.workspace_id=p_workspace_id
    and wc.active and w.archived_at is null and w.owner_user_id=auth.uid()) then
    raise exception 'reel_not_in_workspace' using errcode='42501';
  end if;
  select to_jsonb(rs) || jsonb_build_object('saved',sr.reel_id is not null,'note',coalesce(sr.note,''),
    'tags',coalesce((select array_agg(tag order by tag) from public.reel_tags where workspace_id=p_workspace_id and reel_id=p_reel_id),'{}'::text[]))
    into r from public.reels_summary rs left join public.saved_reels sr on sr.reel_id=rs.id and sr.workspace_id=p_workspace_id where rs.id=p_reel_id;
  t := public.get_reel_transcript(p_workspace_id,p_reel_id);
  select * into j from public.transcript_jobs where reel_id=p_reel_id and model='scribe_v2' and options_version=1;
  select * into s from public.transcription_settings where singleton;
  select array_prepend(source_url,candidates),observed_at into urls,observed from public.reel_media_sources where reel_id=p_reel_id;
  -- SQL and the web boundary both validate playback URLs. No proxy, redirect,
  -- arbitrary provider payload, or thumbnail-as-video fallback.
  select coalesce(array_agg(url order by position),'{}'::text[]) into urls from
    (select url,min(position) position from unnest(urls) with ordinality u(url,position)
      where public.transcription_valid_media_url(url) group by url order by min(position) limit 4) safe;
  if t->>'status' not in ('ready','no_speech','submitting','processing') then
    gate := public.transcription_paid_gate();
    reason := case when gate='paused' then 'paused' when gate='uncertain' then 'review_required'
      when gate is not null or s.singleton is null then 'setup_required'
      when r->>'creator_status' in ('private','unavailable','paused') then 'creator_unavailable'
      when not public.transcription_combined_budget(s.reservation_usd) then 'budget_paused'
      when t->>'status'='awaiting_media' and not s.media_recovery_enabled then 'media_recovery_disabled'
      when t->>'status' in ('failed','uncertain','media_unavailable') then 'review_required' end;
  end if;
  -- Estimate remaining time only from >=5 recent successful *attempts* for
  -- this owner. Retries, delayed callbacks and another owner's jobs cannot
  -- invent a countdown. Read-only, and no costs/billing identifiers returned.
  if reason is null and s.phase='automatic' and t->>'status' in ('queued','submitting','processing') then
    select count(*),percentile_cont(.5) within group(order by seconds),percentile_cont(.9) within group(order by seconds)
      into samples,low_seconds,high_seconds from (
        select extract(epoch from a.completed_at-a.created_at) seconds from public.transcript_attempts a
        join public.transcript_jobs tj on tj.id=a.job_id join public.reels rr on rr.id=tj.reel_id
        where a.status='ready' and a.completed_at>now()-interval '7 days'
          and a.completed_at>a.created_at and a.completed_at-a.created_at<=interval '1 hour'
          and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
            where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid())
        order by a.completed_at desc limit 50
      ) recent;
    if samples>=5 then
      if t->>'status' in ('submitting','processing') then
        select greatest(0,extract(epoch from now()-created_at)) into elapsed from public.transcript_attempts where id=j.current_attempt_id;
      else
        select count(*) into ahead from public.transcript_jobs q join public.reels rr on rr.id=q.reel_id
          where q.id<>j.id and q.attempt_count<3 and (q.status in ('submitting','processing') or
            q.status in ('queued','budget_paused') and q.next_attempt_at<=now() and (q.created_at,q.id)<(j.created_at,j.id))
          and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
            where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid());
        wait_seconds := greatest(0,extract(epoch from j.next_attempt_at-now()));
        low_seconds := low_seconds*(1+floor(ahead::numeric/greatest(1,s.concurrency)))+wait_seconds;
        high_seconds := high_seconds*(1+ceil(ahead::numeric/greatest(1,s.concurrency)))+wait_seconds;
      end if;
      if coalesce(elapsed,0)<high_seconds then
        estimate := jsonb_build_object('min_seconds',greatest(5,ceil(low_seconds-coalesce(elapsed,0))),
          'max_seconds',greatest(5,ceil(high_seconds-coalesce(elapsed,0))),'sample_count',samples,'estimated_at',now());
      end if;
    end if;
  end if;
  return jsonb_build_object('reel',r,'media',jsonb_build_object('urls',urls,'observed_at',observed),'transcript',t,
    'processing',jsonb_build_object('request_allowed',reason is null and t->>'status' in ('not_requested','awaiting_media'),
      'reason',reason,'estimate',estimate));
end $$;
revoke all on function reel_detail_private.read_detail(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function reel_detail_private.read_detail(uuid,uuid) to authenticated;

create function reel_detail_private.request_transcript(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare detail jsonb; st text;
begin
  -- Serialize concurrent clicks, without creating a second attempt or clearing
  -- a failed/uncertain outcome. Queue insertion is covered by its unique key.
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('reel-transcript:'||p_reel_id::text,0));
  detail := reel_detail_private.read_detail(p_workspace_id,p_reel_id);
  if (detail->'processing'->>'request_allowed')::boolean then
    st := public.transcription_enqueue(p_reel_id);
    -- Existing wake and workers retain all activation/media/budget checks.
    if st='awaiting_media' then perform public.transcription_request_wake('maintenance');
    elsif st='queued' then perform public.transcription_request_wake('dispatch'); end if;
  end if;
  return reel_detail_private.read_detail(p_workspace_id,p_reel_id);
end $$;
revoke all on function reel_detail_private.request_transcript(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function reel_detail_private.request_transcript(uuid,uuid) to authenticated;

create function public.get_reel_detail(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select reel_detail_private.read_detail(p_workspace_id,p_reel_id);
$$;
create function public.request_reel_transcript(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$
  select reel_detail_private.request_transcript(p_workspace_id,p_reel_id);
$$;
revoke all on function public.get_reel_detail(uuid,uuid),public.request_reel_transcript(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_reel_detail(uuid,uuid),public.request_reel_transcript(uuid,uuid) to authenticated;
