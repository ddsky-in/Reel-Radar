-- A service-only, explicitly selected trial reuses the normal spending gate.
-- Reducing its hold before this transaction commits also reduces the provider cap.
-- The ordinary monthly allocator, provider validation and schedules stay intact.
-- The worker cannot directly lock private settings tables. Put that privilege
-- behind a non-exposed helper with service and owner checks, never broad grants.
create schema carousel_pilot_private;
revoke all on schema carousel_pilot_private from public,anon,authenticated;
grant usage on schema carousel_pilot_private to service_role;
create function carousel_pilot_private.claim(p_owner_user_id uuid,p_job_id uuid,p_actor_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; result jsonb; cap numeric; prior_target text;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_job_id is null or nullif(p_actor_id,'') is null then
    raise exception 'invalid_pilot' using errcode='22023';
  end if;
  -- Match the normal claim's lock order, including the shared transcription lock.
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  if exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id and paused) then
    return jsonb_build_object('reason','paused');
  end if;
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or j.kind<>'carousel' or j.results_limit<>30 or j.requested_profiles_count<>1
    or j.manual_authorized_by is distinct from p_owner_user_id
    or (select count(*) from public.scrape_job_creators where job_id=j.id)<>1
    or not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id
      join public.workspace_creators wc on wc.creator_id=c.id join public.workspaces w on w.id=wc.workspace_id
      where jc.job_id=j.id and c.status not in ('private','unavailable','paused') and wc.active
        and w.archived_at is null and w.owner_user_id=p_owner_user_id) then
    return jsonb_build_object('reason','pilot_job_not_authorized');
  end if;
  if j.status not in ('pending','budget_paused') or j.scheduled_for>now() then
    return jsonb_build_object('reason','pilot_job_not_pending');
  end if;
  prior_target:=coalesce(current_setting('reelradar.media_job_id',true),'');
  perform set_config('reelradar.media_job_id',p_job_id::text,true);
  result:=public.worker_claim_dispatch(p_owner_user_id,true,p_actor_id,'carousel');
  perform set_config('reelradar.media_job_id',prior_target,true);
  if not (result ? 'job') then return result; end if;
  if (result->'job'->>'id')::uuid is distinct from p_job_id then
    raise exception 'pilot_candidate_changed' using errcode='40001';
  end if;
  cap:=least(.10,(result->>'max_total_charge_usd')::numeric);
  if cap is null or cap<=0 then raise exception 'invalid_pilot_reservation'; end if;
  update public.scrape_jobs set reserved_usd=cap where id=p_job_id returning * into j;
  return result||jsonb_build_object('job',to_jsonb(j),'max_total_charge_usd',cap);
end $$;
revoke all on function carousel_pilot_private.claim(uuid,uuid,text) from public,anon,authenticated;
grant execute on function carousel_pilot_private.claim(uuid,uuid,text) to service_role;
create function public.worker_claim_carousel_pilot(p_owner_user_id uuid,p_job_id uuid,p_actor_id text)
returns jsonb language sql security invoker set search_path=pg_catalog,public as $$
  select carousel_pilot_private.claim(p_owner_user_id,p_job_id,p_actor_id);
$$;
revoke all on function public.worker_claim_carousel_pilot(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.worker_claim_carousel_pilot(uuid,uuid,text) to service_role;
comment on function public.worker_claim_carousel_pilot(uuid,uuid,text) is
  'Explicit one-job carousel validation trial; transactional provider cap at most USD 0.10.';
