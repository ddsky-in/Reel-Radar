-- Honor the requested bounded automatic batch without changing any reservation,
-- owner eligibility, uncertain-payment, or immediately-before-submit checks.
do $$
declare definition text; old_limit text := 'exit when jsonb_array_length(jobs)>=1;';
begin
  select pg_get_functiondef('public.worker_transcription_claim(integer)'::regprocedure) into definition;
  if (select count(*) from regexp_matches(definition, 'exit when jsonb_array_length\(jobs\)>=1;', 'g')) <> 1
     or definition not like '%public.require_service()%'
     or definition not like '%public.transcription_paid_gate()%'
     or definition not like '%outstanding>=s.concurrency%'
     or definition not like '%public.transcription_combined_budget(s.reservation_usd)%' then
    raise exception 'transcription_claim_contract_drift';
  end if;
  execute replace(definition, old_limit,
    'exit when jsonb_array_length(jobs)>=least(p_limit,s.concurrency,case when s.phase=''pilot'' then 1 else 2 end);');
end $$;

-- Requests are asynchronous and become visible to pg_net only after commit.
-- One wake per action per transaction coalesces bulk ingestion without a new
-- contended row lock. Workers remain the authority for transactional paid gates.
create function public.transcription_request_wake(p_action text default 'dispatch') returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.transcription_settings; secret text; request_id bigint; marker text;
begin
  if p_action not in ('dispatch', 'maintenance') or p_action is null then return null; end if;
  marker := 'reelradar.transcription_wake_' || p_action;
  if current_setting(marker, true) = 'sent' then return null; end if;
  select * into s from public.transcription_settings where singleton;
  if not found or not s.enabled or s.paused or s.phase <> 'automatic'
     or not s.key_validated or not s.contract_validated or not s.account_pricing_validated
     or public.transcription_paid_gate() is not null then return null; end if;
  if p_action = 'dispatch' and
     (select count(*) from public.transcript_attempts where status in ('submitting','processing','uncertain')) >= s.concurrency then
    return null;
  end if;
  if not exists (
    select 1 from public.transcript_jobs j
    join public.reels r on r.id = j.reel_id
    join public.creators c on c.id = r.creator_id
    where j.attempt_count < 3 and j.next_attempt_at <= now()
      and (j.status in ('queued','budget_paused') or p_action = 'maintenance' and s.media_recovery_enabled and j.status = 'awaiting_media')
      and c.status not in ('private','unavailable','paused')
      and exists (select 1 from public.workspace_creators wc join public.workspaces w on w.id = wc.workspace_id
        where wc.creator_id = r.creator_id and wc.active and w.archived_at is null)
      and not exists (select 1 from public.reel_transcripts t where t.reel_id = j.reel_id)
  ) then return null; end if;
  select decrypted_secret into secret from vault.decrypted_secrets
    where name = 'reelradar_transcription_maintenance_v1';
  if secret is null or secret !~ '^[0-9a-f]{64}$'
     or (select count(*) from vault.secrets where name = 'reelradar_transcription_maintenance_v1') <> 1 then
    return null;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'reelradar_edge_url' and decrypted_secret ~ '^https://[a-z0-9.-]+(:[0-9]+)?/?$') then return null; end if;
  request_id := net.http_post(
    url := (select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'reelradar_edge_url') || '/functions/v1/transcript-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', secret),
    body := jsonb_build_object('action', p_action), timeout_milliseconds := 10000
  );
  perform set_config(marker, 'sent', true);
  return request_id;
exception when others then
  -- A wake transport failure must never undo ingestion or a completed transcript.
  -- The existing five-minute maintenance remains the durable recovery path.
  raise warning 'Transcription wake unavailable; scheduled maintenance will recover';
  return null;
end $$;
revoke all on function public.transcription_request_wake(text) from public, anon, authenticated, service_role;

create function public.transcription_job_wake() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status = 'awaiting_media' then
    perform public.transcription_request_wake('maintenance');
  elsif new.status = 'queued' or tg_op = 'UPDATE' and new.status in ('ready','no_speech','media_unavailable','failed') then
    perform public.transcription_request_wake('dispatch');
  end if;
  return new;
end $$;
revoke all on function public.transcription_job_wake() from public, anon, authenticated, service_role;
create trigger transcription_job_wake after insert or update of status on public.transcript_jobs
for each row execute function public.transcription_job_wake();

-- Media may be observed before its recovery run's billing is reconciled.
-- Settlement opens the paid gate and wakes the already populated queue.
create function public.transcription_media_settled_wake() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.status = 'settled' and old.status is distinct from new.status then
    perform public.transcription_request_wake('maintenance');
  end if;
  return new;
end $$;
revoke all on function public.transcription_media_settled_wake() from public, anon, authenticated, service_role;
create trigger transcription_media_settled_wake after update of status on public.transcription_media_refreshes
for each row execute function public.transcription_media_settled_wake();

create function public.transcription_settings_wake() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.enabled and not new.paused and new.phase = 'automatic' and
     (old.enabled is distinct from new.enabled or old.paused is distinct from new.paused
      or old.phase is distinct from new.phase or old.monthly_budget_usd < new.monthly_budget_usd) then
    perform public.transcription_request_wake('maintenance');
  end if;
  return new;
end $$;
revoke all on function public.transcription_settings_wake() from public, anon, authenticated, service_role;
create trigger transcription_settings_wake after update of enabled, paused, phase, monthly_budget_usd on public.transcription_settings
for each row execute function public.transcription_settings_wake();
