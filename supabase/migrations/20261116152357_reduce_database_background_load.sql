-- Bound background database work without changing paid-work eligibility.
set constraints all immediate;
create index transcript_requested_recovery_due on public.transcript_jobs(next_attempt_at,reel_id)
  include(priority,priority_requested_at)
  where status='awaiting_media' and priority_requested_at is not null and attempt_count<3 and completed_at is null;

do $$ begin
  -- Materialization prevents the expensive owner/media eligibility function
  -- from running once for every historical transcript job. The final authority
  -- remains unchanged, including requested-only recovery and owner checks.
  perform collection_intents_private.patch('public.worker_transcription_media_candidates(integer)',
    $old$      select c.id creator_id,c.username,max(t.priority) priority,min(t.priority_requested_at) requested_at
      from public.creators c join public.reels r on r.creator_id=c.id join public.transcript_jobs t on t.reel_id=r.id$old$,
    $new$      with eligible_requests as materialized (
        select reel_id,priority,priority_requested_at from public.transcript_jobs
        where status='awaiting_media' and priority_requested_at is not null and attempt_count<3
          and next_attempt_at<=now() and completed_at is null
      )
      select c.id creator_id,c.username,max(t.priority) priority,min(t.priority_requested_at) requested_at
      from public.creators c join public.reels r on r.creator_id=c.id join eligible_requests t on t.reel_id=r.id$new$);
  -- Preserve the five-minute interval, offset from transcription maintenance.
  perform collection_intents_private.patch('public.worker_install_competitor_schedules(uuid,text,text)',
    $old$('reelradar-competitor-maintenance','*/5 * * * *','maintenance')$old$,
    $new$('reelradar-competitor-maintenance','2-59/5 * * * *','maintenance')$new$);
end $$;

-- Only an existing, enabled, known schedule is adjusted. No schedules are
-- installed, enabled, renamed, or given different commands/credentials.
do $$ declare j record; begin
  for j in select jobid from cron.job where jobname='reelradar-competitor-maintenance'
    and active and schedule='*/5 * * * *' loop
    perform cron.alter_job(j.jobid,'2-59/5 * * * *');
  end loop;
end $$;
