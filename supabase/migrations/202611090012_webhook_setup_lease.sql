-- Do not poison an active webhook creation lease when another setup request arrives.
create or replace function public.worker_transcription_webhook_begin() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.transcription_webhook_setup; token uuid;
begin
 perform public.require_service();
 select * into strict s from public.transcription_webhook_setup where singleton for update;
 if s.lease_token is not null and s.lease_expires_at>clock_timestamp() then
  return jsonb_build_object('status','busy');
 end if;
 if s.status in ('create_pending','uncertain') then
  update public.transcription_webhook_setup set status='uncertain',updated_at=clock_timestamp()
   where singleton and status is distinct from 'uncertain';
  return jsonb_build_object('status','uncertain');
 end if;
 if s.status='recovery_required' then return jsonb_build_object('status','recovery_required'); end if;
 token:=gen_random_uuid();
 update public.transcription_webhook_setup set status='checking',lease_token=token,
  lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() where singleton;
 return jsonb_build_object('status','acquired','lease_token',token,'webhook_id',s.webhook_id);
end $$;
revoke all on function public.worker_transcription_webhook_begin() from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_webhook_begin() to service_role;
