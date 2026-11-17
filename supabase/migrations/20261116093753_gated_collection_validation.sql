-- Inert until an explicit service-only permit is approved. The general gate
-- stays TRUE; existing workers may claim only the exact permitted fresh job.
create table collection_intents_private.validation_permits (
  owner_id uuid not null references public.app_settings(owner_user_id),
  job_id uuid primary key references public.scrape_jobs(id),
  creator_id uuid not null references public.creators(id),
  request_key uuid not null,
  reason text not null check(length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  unique(owner_id,request_key)
);
create unique index one_open_collection_validation on collection_intents_private.validation_permits(owner_id) where closed_at is null;
alter table collection_intents_private.validation_permits enable row level security;
revoke all on collection_intents_private.validation_permits from public,anon,authenticated,service_role;

create function collection_intents_private.validation_allowed(j public.scrape_jobs) returns boolean
language sql volatile security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from collection_intents_private.validation_permits p
    where p.owner_id=j.owner_user_id and p.job_id=j.id and p.closed_at is null and p.expires_at>clock_timestamp()
      and j.kind in ('profile','daily','metrics') and j.results_limit between 1 and 30 and j.requested_profiles_count=1
      and ((j.status in ('pending','budget_paused') and j.attempt_count=0 and j.dispatch_nonce is null)
        or j.status='dispatching' and j.attempt_count=1) and j.collection_source in ('legacy','ordinary') and j.competitor_run_id is null
      and (j.claimed_cap_usd is null or j.claimed_cap_usd<=.10)
      and (select count(*) from public.scrape_job_creators jc where jc.job_id=j.id)=1
      and exists(select 1 from public.scrape_job_creators jc join public.workspace_creators wc on wc.creator_id=jc.creator_id
        join public.workspaces w on w.id=wc.workspace_id join public.workspace_members m on m.workspace_id=w.id
        where jc.job_id=j.id and jc.creator_id=p.creator_id and wc.active and w.archived_at is null
          and w.owner_user_id=p.owner_id and m.user_id=p.owner_id and m.role='owner'))
$$;
revoke all on function collection_intents_private.validation_allowed(public.scrape_jobs) from public,anon,authenticated,service_role;

create function public.worker_allow_collection_validation(p_owner_user_id uuid,p_job_id uuid,p_creator_id uuid,p_request_key uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; permit collection_intents_private.validation_permits;
begin
  perform public.require_service();
  if p_request_key is null or p_reason is null or length(btrim(p_reason)) not between 8 and 500 then
    raise exception 'invalid_validation_request' using errcode='22023'; end if;
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  if (select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id) is distinct from true then
    raise exception 'paid_starts_gate_required' using errcode='42501'; end if;
  select * into permit from collection_intents_private.validation_permits where owner_id=p_owner_user_id and request_key=p_request_key;
  if found then
    if permit.job_id is distinct from p_job_id or permit.creator_id is distinct from p_creator_id or permit.reason is distinct from p_reason then
      raise exception 'validation_request_conflict' using errcode='22023'; end if;
    return to_jsonb(permit); -- Replays never extend the deadline or authorize a replacement.
  end if;
  select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and id=p_job_id for update;
  if not found or j.kind not in ('profile','daily','metrics') or j.status not in ('pending','budget_paused')
    or j.results_limit not between 1 and 30 or j.requested_profiles_count<>1 or j.attempt_count<>0
    or j.actor_run_id is not null or j.dispatch_nonce is not null or j.started_at is not null or j.actual_cost_usd is not null
    or j.collection_source not in ('legacy','ordinary') or j.competitor_run_id is not null or not collection_intents_private.job_visible(p_owner_user_id,p_job_id)
    or (select count(*) from public.scrape_job_creators where job_id=p_job_id)<>1
    or not exists(select 1 from public.scrape_job_creators jc join public.workspace_creators wc on wc.creator_id=jc.creator_id
      join public.workspaces w on w.id=wc.workspace_id join public.workspace_members m on m.workspace_id=w.id
      where jc.job_id=p_job_id and jc.creator_id=p_creator_id and wc.active and w.archived_at is null
        and w.owner_user_id=p_owner_user_id and m.user_id=p_owner_user_id and m.role='owner') then
    raise exception 'validation_scope_invalid' using errcode='42501'; end if;
  update collection_intents_private.validation_permits p set closed_at=clock_timestamp() where p.owner_id=p_owner_user_id and p.closed_at is null
    and (p.expires_at<=clock_timestamp() or exists(select 1 from public.scrape_jobs q where q.id=p.job_id
      and q.status in ('succeeded','partial','failed','uncertain','cancelled')));
  if exists(select 1 from collection_intents_private.validation_permits where owner_id=p_owner_user_id and closed_at is null) then
    raise exception 'validation_already_active' using errcode='22023'; end if;
  insert into collection_intents_private.validation_permits(owner_id,job_id,creator_id,request_key,reason,expires_at)
    values(p_owner_user_id,p_job_id,p_creator_id,p_request_key,p_reason,clock_timestamp()+interval '15 minutes') returning * into permit;
  return to_jsonb(permit);
end $$;
revoke all on function public.worker_allow_collection_validation(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.worker_allow_collection_validation(uuid,uuid,uuid,uuid,text) to service_role;

create function public.worker_close_collection_validation(p_owner_user_id uuid,p_job_id uuid,p_request_key uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare permit collection_intents_private.validation_permits;
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update collection_intents_private.validation_permits set closed_at=coalesce(closed_at,clock_timestamp())
    where owner_id=p_owner_user_id and job_id=p_job_id and request_key=p_request_key returning * into permit;
  if not found then raise exception 'validation_scope_invalid' using errcode='42501'; end if;
  -- Closing permission cannot undo an already authorized provider request.
  return to_jsonb(permit);
end $$;
revoke all on function public.worker_close_collection_validation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.worker_close_collection_validation(uuid,uuid,uuid) to service_role;

-- The second stage is a fresh 30-Reel request for the same creator, permitted
-- only after the exact first profile job succeeded and its cost was reconciled.
create function public.worker_allow_reel_validation(p_owner_user_id uuid,p_profile_job_id uuid,p_creator_id uuid,p_request_key uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare prior public.scrape_jobs; permit collection_intents_private.validation_permits; v_job_id uuid;
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into prior from public.scrape_jobs where id=p_profile_job_id and owner_user_id=p_owner_user_id;
  if not found or prior.kind<>'profile' or prior.status<>'succeeded' or prior.actor_run_id is null
    or prior.actual_cost_usd is null or prior.billing_reconciled_at is null
    or not exists(select 1 from collection_intents_private.validation_permits p where p.job_id=prior.id and p.owner_id=p_owner_user_id and p.creator_id=p_creator_id)
    or not exists(select 1 from public.scrape_job_creators where job_id=prior.id and creator_id=p_creator_id) then
    raise exception 'profile_validation_not_reconciled' using errcode='42501'; end if;
  select * into permit from collection_intents_private.validation_permits where owner_id=p_owner_user_id and request_key=p_request_key;
  if found then
    if permit.creator_id is distinct from p_creator_id or permit.reason is distinct from p_reason
      or not exists(select 1 from public.scrape_jobs where id=permit.job_id and kind='daily' and results_limit=30) then
      raise exception 'validation_request_conflict' using errcode='22023'; end if;
    return to_jsonb(permit);
  end if;
  insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by,priority,collection_source)
    values(p_owner_user_id,'daily',1,30,p_owner_user_id,100,'ordinary') returning id into v_job_id;
  insert into public.scrape_job_creators(job_id,creator_id) values(v_job_id,p_creator_id);
  return public.worker_allow_collection_validation(p_owner_user_id,v_job_id,p_creator_id,p_request_key,p_reason);
end $$;
revoke all on function public.worker_allow_reel_validation(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.worker_allow_reel_validation(uuid,uuid,uuid,uuid,text) to service_role;

do $$ begin
  perform collection_intents_private.patch('collection_worker_private.claim_next(uuid,boolean,jsonb,text[])',
    $o$  automatic_allowed:=exists($o$,
    $n$  if p_live and coalesce(cfg.paid_starts_gated,true) and not exists(
      select 1 from collection_intents_private.validation_permits p join public.scrape_jobs q on q.id=p.job_id
      where p.owner_id=p_owner_user_id and collection_intents_private.validation_allowed(q)) then
      return jsonb_build_object('reason','paid_starts_gated'); end if;
  automatic_allowed:=exists($n$);
  perform collection_intents_private.patch('collection_worker_private.claim_next(uuid,boolean,jsonb,text[])',
    $o$where q.owner_user_id=p_owner_user_id and q.status in ('pending','budget_paused') and q.scheduled_for<=now()$o$,
    $n$where q.owner_user_id=p_owner_user_id and q.status in ('pending','budget_paused') and q.scheduled_for<=now()
      and (not p_live or not coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true)
        or collection_intents_private.validation_allowed(q))$n$);
  perform collection_intents_private.patch('public.worker_claim_dispatch(uuid,boolean,text,text)',
    $o$select q.* into j from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.kind='profile'$o$,
    $n$select q.* into j from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.kind='profile'
      and (not p_live or not coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true)
        or collection_intents_private.validation_allowed(q))$n$);
  perform collection_intents_private.patch('public.transcription_claim_dispatch_core(uuid,boolean,text,text)',
    $o$if p_live and coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true) then$o$,
    $n$if p_live and coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true)
      and not exists(select 1 from collection_intents_private.validation_permits p join public.scrape_jobs q on q.id=p.job_id
        where p.owner_id=p_owner_user_id and collection_intents_private.validation_allowed(q)) then$n$);
  perform collection_intents_private.patch('public.transcription_claim_dispatch_core(uuid,boolean,text,text)',
    $o$select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()$o$,
    $n$select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()
      and (not p_live or not coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true)
        or collection_intents_private.validation_allowed(scrape_jobs))$n$);
  perform collection_intents_private.patch('public.transcription_claim_dispatch_core(uuid,boolean,text,text)',
    $o$  if p_live and cap<=0 then$o$,
    $n$  if p_live and coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true) then cap:=least(cap,.10); end if;
  if p_live and cap<=0 then$n$);
  perform collection_intents_private.patch('public.worker_authorize_collection_submit(uuid,uuid,uuid,text,uuid,bigint)',
    $o$if j.live and coalesce(c.paid_starts_gated,true) then$o$,
    $n$if j.live and coalesce(c.paid_starts_gated,true) and not collection_intents_private.validation_allowed(j) then$n$);
end $$;
