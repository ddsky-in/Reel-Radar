-- Owner recovery controls are decisions about risk, never billing verification.
create table collection_intents_private.release_audit (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.app_settings(owner_user_id),
  job_id uuid not null unique references public.scrape_jobs(id) on delete restrict,
  outcome text not null check(outcome='risk_release'),
  reason text not null check(length(btrim(reason)) between 1 and 1000),
  evidence_reference text not null check(length(btrim(evidence_reference)) between 1 and 500),
  idempotency_key text not null check(length(idempotency_key) between 1 and 128),
  expected_version bigint not null,
  released_usd numeric not null check(released_usd>=0),
  original_snapshot jsonb not null,
  decided_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_user_id,idempotency_key,job_id)
);
create table collection_intents_private.release_requests (
  owner_user_id uuid not null references public.app_settings(owner_user_id),
  request_key text not null,
  job_ids uuid[] not null,
  expected jsonb not null,
  reason text not null,
  evidence_reference text not null,
  primary key(owner_user_id,request_key)
);
alter table collection_intents_private.release_audit enable row level security;
alter table collection_intents_private.release_requests enable row level security;
revoke all on collection_intents_private.release_audit,collection_intents_private.release_requests from public,anon,authenticated,service_role;
create function collection_intents_private.append_only() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin raise exception 'immutable_collection_release_audit' using errcode='23514'; end $$;
create trigger append_only_collection_release_audit before update or delete on collection_intents_private.release_audit
for each row execute function collection_intents_private.append_only();
create trigger append_only_collection_release_request before update or delete on collection_intents_private.release_requests
for each row execute function collection_intents_private.append_only();
create function collection_intents_private.job_visible(p_owner uuid,p_job uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.scrape_jobs j where j.id=p_job and j.owner_user_id=p_owner
    and exists(select 1 from public.scrape_job_creators jc join public.workspace_creators wc on wc.creator_id=jc.creator_id
      join public.workspaces w on w.id=wc.workspace_id where jc.job_id=j.id and w.owner_user_id=p_owner))
$$;
create function collection_intents_private.hold(j public.scrape_jobs) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'account_slot',j.apify_account_slot,
    'reserved_usd',j.reserved_usd,'claimed_cap_usd',j.claimed_cap_usd,'reservation_started_at',j.started_at,
    'uncertain_since',j.uncertain_since,
    'dispatch_phase',j.dispatch_phase,'operational_disposition',j.operational_disposition,'actual_cost_usd',j.actual_cost_usd,
    'recovery_reason',j.missing_run_recovery_reason,'recovery_attempts',j.missing_run_recovery_attempts,
    'recovery_exhausted',j.missing_run_recovery_exhausted,'actor_run_id',j.actor_run_id,'billing_reconciled_at',j.billing_reconciled_at,
    'created_at',j.created_at,'expected_version',j.recovery_version,
    'creators',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'username',c.username) order by c.username),'[]')
      from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and w.owner_user_id=j.owner_user_id)),
    'allowed_actions',case when j.operational_disposition='protected' and j.live and j.status='uncertain' and j.actor_run_id is null and j.actual_cost_usd is null
      and j.dispatch_phase in ('legacy','submission_authorized','request_unknown') then jsonb_build_array('risk_release') else '[]'::jsonb end)
$$;
create function collection_intents_private.capacity(p_owner uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('occupied_slots',(select count(*) from public.scrape_jobs j where j.owner_user_id=p_owner
      and j.status in ('dispatching','running','processing','uncertain') and collection_intents_private.blocks_dispatch(j)),
    'uncertain_slots',(select count(*) from public.scrape_jobs j where j.owner_user_id=p_owner and j.status='uncertain' and collection_intents_private.blocks_dispatch(j)),
    'max_active',c.max_active,'paid_starts_gated',c.paid_starts_gated)
  from public.collection_worker_settings c where c.owner_user_id=p_owner
$$;
create function collection_intents_private.recovery_detail(p_owner uuid,p_job uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select collection_intents_private.hold(j)||jsonb_build_object('audit',
    (select coalesce(jsonb_agg(jsonb_build_object('outcome',a.outcome,'created_at',a.created_at,'released_usd',a.released_usd,
      'reason',a.reason,'evidence_reference',a.evidence_reference) order by a.created_at),'[]') from collection_intents_private.release_audit a
      where a.owner_user_id=p_owner and a.job_id=j.id))
  from public.scrape_jobs j where j.id=p_job and j.owner_user_id=p_owner
$$;
create function public.get_collection_holds(p_page integer default 1,p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid(); items jsonb; total integer; known numeric; exposure numeric;
begin
  if owner_id is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_page is null or p_page not between 1 and 1000000 or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_collection_page' using errcode='22023'; end if;
  select count(*) into total from public.scrape_jobs j where j.owner_user_id=owner_id and j.live
    and (j.status in ('dispatching','running','processing','uncertain') or j.actual_cost_usd is null and (j.attempt_count>0 or j.dispatch_nonce is not null))
    and collection_intents_private.job_visible(owner_id,j.id);
  select coalesce(jsonb_agg(collection_intents_private.hold(j) order by j.created_at,j.id),'[]') into items from (
    select q.* from public.scrape_jobs q where q.owner_user_id=owner_id and q.live
      and (q.status in ('dispatching','running','processing','uncertain') or q.actual_cost_usd is null and (q.attempt_count>0 or q.dispatch_nonce is not null))
      and collection_intents_private.job_visible(owner_id,q.id)
    order by q.created_at,q.id limit p_limit offset ((p_page::bigint-1)*p_limit)) j;
  select coalesce(sum(actual_cost_usd),0) into known from public.scrape_jobs where owner_user_id=owner_id and live
    and billing_month=date_trunc('month',now() at time zone 'UTC')::date;
  select coalesce(sum(a.released_usd),0) into exposure from collection_intents_private.release_audit a join public.scrape_jobs j on j.id=a.job_id
    where a.owner_user_id=owner_id and j.actual_cost_usd is null;
  return jsonb_build_object('items',items,'total',total,'page',p_page,'limit',p_limit,
    'capacity',collection_intents_private.capacity(owner_id),'usage',jsonb_build_object('reconciled_month_spend_usd',known,'risk_released_exposure_usd',exposure));
end $$;
create function public.get_collection_job_recovery(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid();
begin
  if owner_id is null or not public.is_allowed_owner() or not collection_intents_private.job_visible(owner_id,p_job_id) then raise exception 'forbidden' using errcode='42501'; end if;
  return collection_intents_private.recovery_detail(owner_id,p_job_id);
end $$;
create function collection_intents_private.risk_release(p_owner uuid,p_job uuid,p_reason text,p_evidence text,p_key text,p_version bigint,p_decided_by uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; a collection_intents_private.release_audit;
begin
  if nullif(btrim(p_reason),'') is null or length(p_reason)>1000 or nullif(btrim(p_evidence),'') is null or length(p_evidence)>500
    or nullif(btrim(p_key),'') is null or length(p_key)>128 or p_version is null or p_version<=0 then raise exception 'invalid_collection_settlement' using errcode='22023'; end if;
  if not collection_intents_private.job_visible(p_owner,p_job) then raise exception 'forbidden' using errcode='42501'; end if;
  select * into j from public.scrape_jobs where id=p_job and owner_user_id=p_owner for update;
  select * into a from collection_intents_private.release_audit where job_id=p_job and owner_user_id=p_owner;
  if found then
    if a.idempotency_key is distinct from p_key or a.reason is distinct from p_reason or a.evidence_reference is distinct from p_evidence
      or a.expected_version is distinct from p_version then raise exception 'collection_settlement_idempotency_conflict' using errcode='22023'; end if;
    return collection_intents_private.recovery_detail(p_owner,p_job);
  end if;
  if j.recovery_version is distinct from p_version then raise exception 'collection_state_changed' using errcode='40001'; end if;
  if not coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner),false) then
    raise exception 'paid_starts_gate_required' using errcode='42501'; end if;
  if j.lease_token is not null and j.lease_expires_at>clock_timestamp()
    or j.reconciliation_token is not null and j.reconciliation_expires_at>clock_timestamp()
    or j.missing_run_recovery_token is not null and j.missing_run_recovery_expires_at>clock_timestamp() then
    raise exception 'collection_recovery_in_flight' using errcode='40001'; end if;
  if not apify_accounts_private.job_account_matches(p_owner,j.apify_account_slot,j.expected_provider_user_id) then
    raise exception 'collection_account_identity_unverified' using errcode='42501'; end if;
  if j.operational_disposition<>'protected' or not j.live or j.status<>'uncertain' or j.actor_run_id is not null or j.actual_cost_usd is not null
    or j.billing_reconciled_at is not null or j.dispatch_nonce is null or j.dispatch_phase not in ('legacy','submission_authorized','request_unknown')
    or exists(select 1 from collection_intents_private.accepted_evidence e where e.job_id=j.id and (e.verified or e.source='start_response'))
    or exists(select 1 from public.scrape_callback_receipts r where r.job_id=j.id and r.dispatch_nonce=j.dispatch_nonce and r.state='verified') then
    raise exception 'collection_risk_release_not_eligible' using errcode='22023'; end if;
  insert into collection_intents_private.release_audit(owner_user_id,job_id,outcome,reason,evidence_reference,idempotency_key,expected_version,released_usd,original_snapshot,decided_by)
    values(p_owner,j.id,'risk_release',p_reason,p_evidence,p_key,p_version,j.reserved_usd,
      jsonb_build_object('dispatch_nonce',j.dispatch_nonce,'started_at',j.started_at,'expected_actor_id',j.expected_actor_id,
        'expected_provider_user_id',j.expected_provider_user_id,'apify_account_slot',j.apify_account_slot,'live',j.live,
        'billing_month',j.billing_month,'claimed_cap_usd',j.claimed_cap_usd,'reserved_usd',j.reserved_usd,'input_digest',j.input_digest,
        'dispatch_phase',j.dispatch_phase,'collection_source',j.collection_source,'competitor_run_id',j.competitor_run_id),p_decided_by);
  -- Provenance isolation precedes any operation that could trip completion hooks.
  update public.scrape_jobs set collection_source='operator_settle' where id=j.id;
  update public.scrape_jobs set operational_disposition='risk_released',reserved_usd=0,
    missing_run_recovery_reason='operator_risk_release_outcome_unknown' where id=j.id;
  update public.competitor_refresh_runs set status='outcome_unknown',completed_at=coalesce(completed_at,clock_timestamp()),
    error_message='Operator accepted unknown provider liability; no automatic retry.'
    where id=j.competitor_run_id and owner_user_id=p_owner;
  return collection_intents_private.recovery_detail(p_owner,p_job);
end $$;
create function public.collection_settle_job(p_job_id uuid,p_outcome text,p_reason text,p_evidence_reference text,p_idempotency_key text,p_expected_version bigint,p_acknowledge_unknown boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid();
begin
  if owner_id is null or not public.is_allowed_owner() or not collection_intents_private.job_visible(owner_id,p_job_id) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_outcome is distinct from 'risk_release' or p_acknowledge_unknown is distinct from true then raise exception 'unknown_liability_acknowledgement_required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('competitor-workflow:'||owner_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
  return collection_intents_private.risk_release(owner_id,p_job_id,p_reason,p_evidence_reference,p_idempotency_key,p_expected_version,owner_id);
end $$;
create function public.worker_risk_release_collection_jobs(p_owner_user_id uuid,p_job_ids uuid[],p_request_key text,p_reason text,p_evidence_reference text,p_expected jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; e jsonb; req collection_intents_private.release_requests; result jsonb:='[]'; replayed boolean:=false; ids uuid[];
begin
  perform public.require_service();
  if p_owner_user_id is null or cardinality(p_job_ids) not between 1 and 20 or p_job_ids is null or array_position(p_job_ids,null) is not null
    or cardinality(p_job_ids)<>(select count(distinct id) from unnest(p_job_ids) id) or jsonb_typeof(p_expected) is distinct from 'array'
    or jsonb_array_length(p_expected)<>cardinality(p_job_ids) or nullif(btrim(p_request_key),'') is null or length(p_request_key)>128 then
    raise exception 'invalid_collection_release_request' using errcode='22023'; end if;
  select array_agg(id order by id) into ids from unnest(p_job_ids) id;
  perform pg_advisory_xact_lock(hashtextextended('competitor-workflow:'||p_owner_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  if not coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),false) then raise exception 'paid_starts_gate_required' using errcode='42501'; end if;
  select * into req from collection_intents_private.release_requests where owner_user_id=p_owner_user_id and request_key=p_request_key;
  if found then
    if req.job_ids is distinct from ids or req.expected is distinct from p_expected or req.reason is distinct from p_reason or req.evidence_reference is distinct from p_evidence_reference then
      raise exception 'collection_settlement_idempotency_conflict' using errcode='22023'; end if;
    replayed:=true;
  else
    insert into collection_intents_private.release_requests values(p_owner_user_id,p_request_key,ids,p_expected,p_reason,p_evidence_reference);
  end if;
  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.id=any(ids) order by q.id for update of q loop
    if (select count(*) from jsonb_array_elements(p_expected) x where (x->>'job_id')::uuid=j.id)<>1 then raise exception 'invalid_release_expected_manifest' using errcode='22023'; end if;
    select x into e from jsonb_array_elements(p_expected) x where (x->>'job_id')::uuid=j.id;
    if not replayed and (j.dispatch_nonce is distinct from (e->>'dispatch_nonce')::uuid or j.started_at is distinct from (e->>'started_at')::timestamptz) then
      raise exception 'collection_state_changed' using errcode='40001'; end if;
    result:=result||jsonb_build_array(collection_intents_private.risk_release(p_owner_user_id,j.id,p_reason,p_evidence_reference,p_request_key,(e->>'expected_version')::bigint,null));
  end loop;
  if jsonb_array_length(result)<>cardinality(ids) then raise exception 'forbidden' using errcode='42501'; end if;
  return jsonb_build_object('items',result,'replayed',replayed);
end $$;
-- Immutable audit snapshots, not cleared reservations, quantify unknown risk.
do $$ begin
  perform collection_intents_private.patch('public.get_bootstrap()',
    $o$'usage',usage,$o$,
    $n$'collection_capacity',collection_intents_private.capacity(auth.uid()),'usage',usage||jsonb_build_object(
      'risk_released_exposure_usd',(select coalesce(sum(a.released_usd),0) from collection_intents_private.release_audit a
        join public.scrape_jobs exposure_job on exposure_job.id=a.job_id where a.owner_user_id=auth.uid() and exposure_job.actual_cost_usd is null)), $n$);
end $$;
revoke all on all functions in schema collection_intents_private from public,anon,authenticated,service_role;
revoke all on function public.get_collection_holds(integer,integer),public.get_collection_job_recovery(uuid),
 public.collection_settle_job(uuid,text,text,text,text,bigint,boolean),public.worker_risk_release_collection_jobs(uuid,uuid[],text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_collection_holds(integer,integer),public.get_collection_job_recovery(uuid),
 public.collection_settle_job(uuid,text,text,text,text,bigint,boolean) to authenticated;
grant execute on function public.worker_risk_release_collection_jobs(uuid,uuid[],text,text,text,jsonb) to service_role;
