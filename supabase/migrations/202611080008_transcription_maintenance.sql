-- Native transcript-only maintenance. Provider and database gates stay disabled until validated.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create function public.worker_transcription_maintenance() returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_secret text;
  v_config jsonb;
begin
  select jsonb_build_object('enabled', enabled, 'paused', paused) into v_config
    from public.transcription_settings where singleton;
  if not coalesce((v_config->>'enabled')::boolean, false)
     or coalesce((v_config->>'paused')::boolean, true) then
    return null;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets
    where name = 'reelradar_transcription_maintenance_v1';
  if v_secret is null then return null; end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'reelradar_edge_url' and decrypted_secret ~ '^https://[a-z0-9.-]+(:[0-9]+)?/?$') then return null; end if;
  return net.http_post(
    url := (select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'reelradar_edge_url') || '/functions/v1/transcript-reconcile',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := '{"action":"maintenance"}'::jsonb,
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function public.worker_transcription_maintenance() from public, anon, authenticated, service_role;

create function public.worker_transcription_install_schedule(p_secret text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_id bigint;
  v_count integer;
  v_command text;
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid maintenance authentication' using errcode = '22023';
  end if;
  select count(*) into v_count from vault.secrets where name = 'reelradar_transcription_maintenance_v1';
  if v_count > 1 then raise exception 'Ambiguous maintenance configuration'; end if;
  if v_count = 0 then
    perform vault.create_secret(p_secret, 'reelradar_transcription_maintenance_v1', 'Transcript-only maintenance authentication');
  elsif not exists(select 1 from vault.decrypted_secrets where name = 'reelradar_transcription_maintenance_v1' and decrypted_secret = p_secret) then
    raise exception 'Existing maintenance authentication differs';
  end if;
  select jobid, command into v_id, v_command from cron.job where jobname = 'reelradar-transcription-maintenance';
  if v_id is not null then
    if v_command <> 'select public.worker_transcription_maintenance();' then
      raise exception 'Existing schedule is unrelated';
    end if;
    if not exists(select 1 from cron.job where jobid = v_id and schedule = '*/5 * * * *' and active) then
      raise exception 'Existing maintenance schedule differs';
    end if;
  else
    v_id := cron.schedule('reelradar-transcription-maintenance', '*/5 * * * *', 'select public.worker_transcription_maintenance();');
  end if;
  return jsonb_build_object('installed', true, 'job_id', v_id, 'schedule', '*/5 * * * *', 'provider_gates_required', true);
end;
$$;
revoke all on function public.worker_transcription_install_schedule(text) from public, anon, authenticated, service_role;
grant execute on function public.worker_transcription_install_schedule(text) to service_role;
