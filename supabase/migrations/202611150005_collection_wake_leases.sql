-- Durable ownership for ordinary completion executors only. No schedules,
-- networking, monetary changes, or accepted-start replay/release.
set constraints all immediate;
alter table public.collection_worker_settings
  add column executor_nonce uuid,
  add column executor_revision bigint,
  add column executor_expires_at timestamptz,
  add column executor_starts integer not null default 0,
  add column executor_start_limit integer not null default 2,
  add column wake_retry_after timestamptz,
  add constraint collection_executor_state check (
    (executor_nonce is null) = (executor_expires_at is null)
    and (executor_nonce is null or executor_revision is not null)
    and (executor_revision is null or executor_revision between 0 and wake_revision)
    and executor_start_limit between 1 and 4
    and executor_starts between 0 and executor_start_limit
  );

create function public.worker_claim_collection_executor(p_owner_user_id uuid,p_completion_only boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.collection_worker_settings; revision bigint; used integer; cap integer;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_completion_only is null then
    raise exception 'invalid_collection_executor' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into c from public.collection_worker_settings where owner_user_id=p_owner_user_id for update;
  if not found then return jsonb_build_object('reason','owner_not_provisioned'); end if;
  if c.executor_nonce is not null and c.executor_expires_at>clock_timestamp() then
    return jsonb_build_object('reason','executor_busy');
  end if;
  if p_completion_only and c.wake_revision<=c.drained_revision then
    return jsonb_build_object('reason','wake_not_pending');
  end if;
  if c.executor_revision=c.wake_revision and c.wake_retry_after>clock_timestamp() then
    return jsonb_build_object('reason','wake_retry_deferred');
  end if;
  revision:=c.wake_revision;
  used:=case when c.executor_revision=revision then c.executor_starts else 0 end;
  cap:=case when c.executor_revision=revision then c.executor_start_limit else c.max_starts_per_wake end;
  if p_completion_only and used>=cap then
    return jsonb_build_object('reason','wake_start_limit');
  end if;
  -- Maintenance/manual dispatch remains legitimate without a completion wake.
  -- Give that invocation a durable revision too: a crash must not erase its work.
  -- Only an explicit invocation can obtain a fresh budget after an exhausted wake.
  if not p_completion_only and (revision<=c.drained_revision or used>=cap) then
    revision:=revision+1; used:=0; cap:=c.max_starts_per_wake;
  end if;
  update public.collection_worker_settings set wake_revision=revision,
    executor_nonce=gen_random_uuid(),executor_revision=revision,
    executor_expires_at=clock_timestamp()+interval '5 minutes',
    executor_starts=used,executor_start_limit=cap,wake_retry_after=null
    where owner_user_id=p_owner_user_id returning * into c;
  return public.worker_collection_runtime(p_owner_user_id)||jsonb_build_object(
    'claimed_revision',revision,'starts_remaining',cap-used);
end $$;

create function public.worker_renew_collection_executor(p_owner_user_id uuid,p_executor_nonce uuid,p_revision bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.collection_worker_settings set executor_expires_at=clock_timestamp()+interval '5 minutes'
    where owner_user_id=p_owner_user_id and executor_nonce=p_executor_nonce
      and executor_revision=p_revision and executor_expires_at>clock_timestamp();
  return found;
end $$;

-- Preserve the existing fair selector and its budget/account/wrapper locks.
-- Its unfenced body is private, so service callers cannot bypass lease checks.
alter function public.worker_claim_next(uuid,boolean,jsonb,text[]) set schema collection_worker_private;
alter function collection_worker_private.worker_claim_next(uuid,boolean,jsonb,text[]) rename to claim_next;
revoke all on function collection_worker_private.claim_next(uuid,boolean,jsonb,text[]) from public,anon,authenticated,service_role;

create function public.worker_claim_next(p_owner_user_id uuid,p_live boolean,p_actor_ids jsonb,p_eligible_kinds text[])
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  -- An expired nonce must be explicitly reclaimed, never bypassed by an old client.
  if exists(select 1 from public.collection_worker_settings where owner_user_id=p_owner_user_id and executor_nonce is not null) then
    return jsonb_build_object('reason','executor_busy');
  end if;
  return collection_worker_private.claim_next(p_owner_user_id,p_live,p_actor_ids,p_eligible_kinds);
end $$;

create function public.worker_claim_next(p_owner_user_id uuid,p_live boolean,p_actor_ids jsonb,p_eligible_kinds text[],
  p_executor_nonce uuid,p_claimed_revision bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.collection_worker_settings; result jsonb;
begin
  perform public.require_service();
  -- Match the selector's established lock order. Do not lock the wake row before
  -- a job: finishing transactions acquire job -> wake row, independently of us.
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into c from public.collection_worker_settings where owner_user_id=p_owner_user_id;
  if c.executor_nonce is distinct from p_executor_nonce or p_executor_nonce is null
    or c.executor_revision is distinct from p_claimed_revision or c.executor_expires_at<=clock_timestamp() then
    return jsonb_build_object('reason','executor_lease_lost');
  end if;
  if c.executor_starts>=c.executor_start_limit then return jsonb_build_object('reason','wake_start_limit'); end if;
  result:=collection_worker_private.claim_next(p_owner_user_id,p_live,p_actor_ids,p_eligible_kinds);
  if result ? 'job' then
    -- Count a reservation even if the response is lost or the provider start is
    -- ambiguous. Recovery can only claim other untouched jobs within this cap.
    update public.collection_worker_settings set executor_starts=executor_starts+1,
      executor_expires_at=clock_timestamp()+interval '5 minutes'
      where owner_user_id=p_owner_user_id and executor_nonce=p_executor_nonce and executor_revision=p_claimed_revision;
    if not found then raise exception 'collection_executor_changed' using errcode='40001'; end if;
  end if;
  return result;
end $$;

-- Disable the old unowned drain, including calls by privileged stale workers.
create or replace function public.worker_drain_completion_wake(p_owner_user_id uuid,p_revision bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  raise exception 'executor_nonce_required' using errcode='42501';
end $$;
revoke all on function public.worker_drain_completion_wake(uuid,bigint) from public,anon,authenticated,service_role;

create function public.worker_drain_completion_wake(p_owner_user_id uuid,p_revision bigint,p_executor_nonce uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.collection_worker_settings set drained_revision=greatest(drained_revision,p_revision),
    executor_nonce=null,executor_expires_at=null,wake_retry_after=null
    where owner_user_id=p_owner_user_id and executor_nonce=p_executor_nonce
      and executor_revision=p_revision and executor_expires_at>clock_timestamp();
  -- Never drain a later completion revision or a replacement executor's work.
  return found;
end $$;

create function public.worker_release_collection_executor(p_owner_user_id uuid,p_executor_nonce uuid,p_revision bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.collection_worker_settings set executor_nonce=null,executor_expires_at=null,
    wake_retry_after=clock_timestamp()+interval '1 minute'
    where owner_user_id=p_owner_user_id and executor_nonce=p_executor_nonce and executor_revision=p_revision;
  -- Failure retains the claimed revision and attempt count. No callback spin.
  return found;
end $$;

revoke all on function public.worker_claim_collection_executor(uuid,boolean),
  public.worker_renew_collection_executor(uuid,uuid,bigint),public.worker_claim_next(uuid,boolean,jsonb,text[]),
  public.worker_claim_next(uuid,boolean,jsonb,text[],uuid,bigint),public.worker_drain_completion_wake(uuid,bigint,uuid),
  public.worker_release_collection_executor(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.worker_claim_collection_executor(uuid,boolean),
  public.worker_renew_collection_executor(uuid,uuid,bigint),public.worker_claim_next(uuid,boolean,jsonb,text[]),
  public.worker_claim_next(uuid,boolean,jsonb,text[],uuid,bigint),public.worker_drain_completion_wake(uuid,bigint,uuid),
  public.worker_release_collection_executor(uuid,uuid,bigint) to service_role;
