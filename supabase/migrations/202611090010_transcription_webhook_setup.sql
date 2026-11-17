-- API-only webhook configuration. No paid gates, queue changes, schedules or secret literals.
-- Metadata is private; no table access is granted, even to service_role.
create table public.transcription_webhook_setup (
 singleton boolean primary key default true check(singleton),
 status text not null default 'idle' check(status in ('idle','checking','create_pending','uncertain','recovery_required','configured')),
 lease_token uuid, lease_expires_at timestamptz,
 webhook_id text check(webhook_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 secret_id uuid references vault.secrets(id),
 updated_at timestamptz not null default clock_timestamp(),
 check((webhook_id is null) = (secret_id is null))
);
insert into public.transcription_webhook_setup(singleton) values(true);
alter table public.transcription_webhook_setup enable row level security;
revoke all on public.transcription_webhook_setup from public, anon, authenticated, service_role;

-- null or {id,secret}; only a trusted Edge service caller may read decrypted configuration.
create function public.worker_transcription_webhook_get_credentials() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare result jsonb;
begin
 perform public.require_service();
 select jsonb_build_object('id',s.webhook_id,'secret',v.decrypted_secret) into result
 from public.transcription_webhook_setup s join vault.decrypted_secrets v on v.id=s.secret_id
 where s.singleton and s.webhook_id is not null and v.name='reelradar_transcription_webhook_hmac_v1';
 return result;
end $$;
revoke all on function public.worker_transcription_webhook_get_credentials() from public, anon, authenticated, service_role;
grant execute on function public.worker_transcription_webhook_get_credentials() to service_role;

-- The lease is durable BEFORE the first provider request. Expired pending creates never restart.
create function public.worker_transcription_webhook_begin() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.transcription_webhook_setup; token uuid;
begin
 perform public.require_service();
 select * into strict s from public.transcription_webhook_setup where singleton for update;
 if s.status in ('create_pending','uncertain') then
  update public.transcription_webhook_setup set status='uncertain',updated_at=clock_timestamp() where singleton;
  return jsonb_build_object('status','uncertain');
 end if;
 if s.status='recovery_required' then return jsonb_build_object('status','recovery_required'); end if;
 if s.lease_token is not null and s.lease_expires_at>clock_timestamp() then return jsonb_build_object('status','busy'); end if;
 token:=gen_random_uuid();
 update public.transcription_webhook_setup set status='checking',lease_token=token,
  lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() where singleton;
 return jsonb_build_object('status','acquired','lease_token',token,'webhook_id',s.webhook_id);
end $$;
revoke all on function public.worker_transcription_webhook_begin() from public, anon, authenticated, service_role;
grant execute on function public.worker_transcription_webhook_begin() to service_role;

create function public.worker_transcription_webhook_mark_create(p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_service();
 update public.transcription_webhook_setup set status='create_pending',updated_at=clock_timestamp()
 where singleton and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
  and status='checking' and webhook_id is null and secret_id is null;
 if not found then raise exception 'webhook_setup_fenced' using errcode='42501'; end if;
 return jsonb_build_object('pending',true);
end $$;
revoke all on function public.worker_transcription_webhook_mark_create(uuid) from public, anon, authenticated, service_role;
grant execute on function public.worker_transcription_webhook_mark_create(uuid) to service_role;

-- One transaction stores the one-time secret in Vault and binds its immutable provider ID.
create function public.worker_transcription_webhook_store(p_lease_token uuid,p_webhook_id text,p_webhook_secret text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.transcription_webhook_setup; sid uuid;
begin
 perform public.require_service();
 if p_webhook_id is null or p_webhook_id !~ '^[A-Za-z0-9_-]{1,200}$' or p_webhook_secret is null
  or char_length(p_webhook_secret) not between 1 and 4096 or p_webhook_secret ~ '[^!-~]' then
  raise exception 'invalid_webhook_credentials' using errcode='22023';
 end if;
 select * into strict s from public.transcription_webhook_setup where singleton for update;
 if p_lease_token is null or s.lease_token is distinct from p_lease_token or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp()
  or s.status not in ('checking','create_pending') then raise exception 'webhook_setup_fenced' using errcode='42501'; end if;
 if s.webhook_id is not null then
  if s.webhook_id<>p_webhook_id or not exists(select 1 from vault.decrypted_secrets
    where id=s.secret_id and name='reelradar_transcription_webhook_hmac_v1' and decrypted_secret=p_webhook_secret) then
   raise exception 'webhook_recovery_required' using errcode='42501';
  end if;
  sid:=s.secret_id;
 else
  if exists(select 1 from vault.secrets where name='reelradar_transcription_webhook_hmac_v1') then
   raise exception 'webhook_recovery_required' using errcode='42501';
  end if;
  sid:=vault.create_secret(p_webhook_secret,'reelradar_transcription_webhook_hmac_v1','Transcription callback HMAC authentication');
 end if;
 update public.transcription_webhook_setup set webhook_id=p_webhook_id,secret_id=sid,status='checking',updated_at=clock_timestamp() where singleton;
 return jsonb_build_object('stored',true);
end $$;
revoke all on function public.worker_transcription_webhook_store(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.worker_transcription_webhook_store(uuid,text,text) to service_role;

create function public.worker_transcription_webhook_finish(p_lease_token uuid,p_status text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.transcription_webhook_setup;
begin
 perform public.require_service();
 select * into strict s from public.transcription_webhook_setup where singleton for update;
 if s.lease_token is distinct from p_lease_token or p_lease_token is null
  or s.status not in ('checking','create_pending','uncertain') then raise exception 'webhook_setup_fenced' using errcode='42501'; end if;
 if p_status not in ('idle','uncertain','recovery_required','configured') or p_status is null
  or s.status in ('create_pending','uncertain') and p_status<>'uncertain'
  or p_status='configured' and (s.webhook_id is null or s.secret_id is null or s.lease_expires_at<=clock_timestamp()) then
  raise exception 'invalid_webhook_setup_transition' using errcode='22023';
 end if;
 update public.transcription_webhook_setup set status=p_status,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where singleton;
 return jsonb_build_object('status',p_status);
end $$;
revoke all on function public.worker_transcription_webhook_finish(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.worker_transcription_webhook_finish(uuid,text) to service_role;
