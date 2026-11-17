-- Phase-specific collection intent protocol. No network, schedules or hosted rollout.
set constraints all immediate;
alter table public.app_settings add column collection_job_cap_usd numeric not null default .10
  check(collection_job_cap_usd>=0 and collection_job_cap_usd<='10000'::numeric and collection_job_cap_usd=round(collection_job_cap_usd,6));
alter table public.collection_worker_settings add column paid_starts_gated boolean not null default false;
alter table public.scrape_jobs
  add column dispatch_phase text not null default 'legacy' check(dispatch_phase in ('legacy','prepared','submission_authorized','request_unknown','accepted_save_pending','attached','cancelled_before_submit')),
  add column dispatch_authorized_at timestamptz,
  add column uncertain_since timestamptz,
  add column claimed_cap_usd numeric check(claimed_cap_usd>=0),
  add column input_digest text check(input_digest ~ '^[0-9a-f]{64}$'),
  add column operational_disposition text not null default 'protected' check(operational_disposition in ('protected','risk_released')),
  add column recovery_version bigint not null default 1 check(recovery_version>0),
  add column missing_run_recovery_attempts integer not null default 0 check(missing_run_recovery_attempts between 0 and 8),
  add column missing_run_recovery_pages integer not null default 0 check(missing_run_recovery_pages between 0 and 8),
  add column missing_run_recovery_cursor text check(length(missing_run_recovery_cursor)<=1024),
  add column missing_run_recovery_token uuid,
  add column missing_run_recovery_expires_at timestamptz,
  add column missing_run_recovery_next_at timestamptz not null default now(),
  add column missing_run_recovery_exhausted boolean not null default false,
  add column missing_run_recovery_reason text;
create schema collection_intents_private;
revoke all on schema collection_intents_private from public,anon,authenticated,service_role;
create table collection_intents_private.intents (
  job_id uuid primary key references public.scrape_jobs(id) on delete restrict,
  owner_user_id uuid not null references public.app_settings(owner_user_id),
  dispatch_nonce uuid not null unique,
  claimed_at timestamptz not null,
  claimed_cap_usd numeric not null check(claimed_cap_usd>=0),
  actor_id text not null, provider_user_id text not null, account_slot smallint,
  executor_nonce uuid, executor_revision bigint,
  direct_service_claim boolean not null default false,
  input_digest text check(input_digest ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz
);
create table collection_intents_private.accepted_evidence (
  job_id uuid not null references public.scrape_jobs(id) on delete restrict,
  owner_user_id uuid not null references public.app_settings(owner_user_id),
  dispatch_nonce uuid not null,
  run_id text not null check(run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  source text not null check(source in ('start_response','callback','provider_recovery')),
  verified boolean not null default false,
  received_at timestamptz not null default clock_timestamp(),
  primary key(job_id,dispatch_nonce,run_id,source)
);
create table collection_intents_private.billing_mode (
  transaction_id bigint not null, job_id uuid not null, primary key(transaction_id,job_id)
);
alter table collection_intents_private.intents enable row level security;
alter table collection_intents_private.accepted_evidence enable row level security;
alter table collection_intents_private.billing_mode enable row level security;
revoke all on all tables in schema collection_intents_private from public,anon,authenticated,service_role;

-- Only operational blocking is relaxed. This predicate never deletes unknown
-- liability, alters billing, or frees a discovered running/processing run.
create function collection_intents_private.blocks_dispatch(j public.scrape_jobs) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
  select not (j.operational_disposition='risk_released' and nullif(j.actor_run_id,'') is null
    and j.status not in ('running','processing'))
$$;
create function collection_intents_private.intent_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then raise exception 'immutable_collection_intent' using errcode='23514'; end if;
  if (to_jsonb(new)-'input_digest'-'authorized_at') is distinct from (to_jsonb(old)-'input_digest'-'authorized_at')
    or old.input_digest is not null or new.input_digest is null or old.authorized_at is not null or new.authorized_at is null then
    raise exception 'immutable_collection_intent' using errcode='23514';
  end if;
  return new;
end $$;
create trigger immutable_collection_intent before update or delete on collection_intents_private.intents
for each row execute function collection_intents_private.intent_guard();
create function collection_intents_private.job_protocol() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.dispatch_phase<>'legacy' then
    if new.dispatch_nonce is distinct from old.dispatch_nonce or new.started_at is distinct from old.started_at
      or new.expected_actor_id is distinct from old.expected_actor_id or new.expected_provider_user_id is distinct from old.expected_provider_user_id
      or new.claimed_cap_usd is distinct from old.claimed_cap_usd or old.input_digest is not null and new.input_digest is distinct from old.input_digest
      or old.dispatch_authorized_at is not null and new.dispatch_authorized_at is distinct from old.dispatch_authorized_at then
      raise exception 'immutable_collection_claim' using errcode='23514';
    end if;
    if new.dispatch_phase is distinct from old.dispatch_phase and not (
      old.dispatch_phase='prepared' and new.dispatch_phase in ('submission_authorized','cancelled_before_submit','request_unknown','accepted_save_pending','attached')
      or old.dispatch_phase='submission_authorized' and new.dispatch_phase in ('request_unknown','accepted_save_pending','attached')
      or old.dispatch_phase='request_unknown' and new.dispatch_phase in ('accepted_save_pending','attached')
      or old.dispatch_phase='accepted_save_pending' and new.dispatch_phase='attached') then
      raise exception 'collection_phase_regression' using errcode='23514';
    end if;
  end if;
  if new.actor_run_id is not null and old.actor_run_id is not null and new.actor_run_id is distinct from old.actor_run_id then
    raise exception 'immutable_collection_run' using errcode='23514';
  end if;
  if new.actor_run_id is not null and old.actor_run_id is null and new.dispatch_phase<>'cancelled_before_submit' then
    new.dispatch_phase:='attached';
  end if;
  if new.status='uncertain' and old.status is distinct from 'uncertain' then
    new.uncertain_since:=coalesce(old.uncertain_since,clock_timestamp());
    if new.dispatch_phase in ('prepared','submission_authorized') then new.dispatch_phase:='request_unknown'; end if;
  end if;
  if (to_jsonb(new)-'recovery_version') is distinct from (to_jsonb(old)-'recovery_version') then
    new.recovery_version:=old.recovery_version+1;
  else new.recovery_version:=old.recovery_version; end if;
  return new;
end $$;
create trigger collection_protocol_guard before update on public.scrape_jobs
for each row execute function collection_intents_private.job_protocol();
create function collection_intents_private.capture_intent() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.collection_worker_settings;
begin
  if old.dispatch_phase='legacy' and new.dispatch_phase='prepared' then
    if old.live and (old.attempt_count>0 or old.started_at is not null or old.dispatch_nonce is not null or old.actor_run_id is not null)
      or old.apify_account_slot is not null or old.dispatch_nonce is not null or new.dispatch_nonce is null then
      raise exception 'collection_intent_prior_submission' using errcode='23514';
    end if;
    select * into c from public.collection_worker_settings where owner_user_id=new.owner_user_id;
    insert into collection_intents_private.intents(job_id,owner_user_id,dispatch_nonce,claimed_at,claimed_cap_usd,actor_id,provider_user_id,account_slot,executor_nonce,executor_revision,direct_service_claim)
      values(new.id,new.owner_user_id,new.dispatch_nonce,new.started_at,new.claimed_cap_usd,new.expected_actor_id,new.expected_provider_user_id,new.apify_account_slot,
        case when nullif(current_setting('reelradar.collection_executor_nonce',true),'') is not null then c.executor_nonce end,
        case when nullif(current_setting('reelradar.collection_executor_nonce',true),'') is not null then c.executor_revision end,
        c.executor_nonce is null and auth.role()='service_role');
  end if;
  return new;
end $$;
create trigger collection_intent_capture after update of dispatch_phase on public.scrape_jobs
for each row execute function collection_intents_private.capture_intent();

create function public.worker_set_collection_start_gate(p_owner_user_id uuid,p_gated boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_owner_user_id is null or p_gated is null then raise exception 'invalid_collection_gate' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.collection_worker_settings set paid_starts_gated=p_gated where owner_user_id=p_owner_user_id;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  return jsonb_build_object('paid_starts_gated',p_gated);
end $$;
create function public.worker_authorize_collection_submit(p_owner_user_id uuid,p_job_id uuid,p_dispatch_nonce uuid,p_input_digest text,
  p_executor_nonce uuid default null,p_claimed_revision bigint default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; c public.collection_worker_settings; i collection_intents_private.intents;
begin
  perform public.require_service();
  if p_input_digest is null or p_input_digest !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input_digest' using errcode='22023'; end if;
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into c from public.collection_worker_settings where owner_user_id=p_owner_user_id;
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or p_dispatch_nonce is null or j.dispatch_nonce is distinct from p_dispatch_nonce then return jsonb_build_object('authorized',false,'reason','claim_identity_mismatch'); end if;
  if j.live and coalesce(c.paid_starts_gated,true) then return jsonb_build_object('authorized',false,'reason','paid_starts_gated'); end if;
  if j.dispatch_phase<>'prepared' or j.status<>'dispatching' or j.dispatch_authorized_at is not null or j.input_digest is not null
    or j.actor_run_id is not null or j.lease_expires_at<=clock_timestamp() or j.lease_token is null then
    return jsonb_build_object('authorized',false,'reason','intent_not_fresh');
  end if;
  select * into i from collection_intents_private.intents where job_id=j.id and owner_user_id=p_owner_user_id and dispatch_nonce=p_dispatch_nonce;
  if not found then return jsonb_build_object('authorized',false,'reason','intent_missing'); end if;
  if j.collection_source='ordinary' then
    if p_executor_nonce is null or i.executor_nonce is distinct from p_executor_nonce or i.executor_revision is distinct from p_claimed_revision
      or c.executor_nonce is distinct from p_executor_nonce or c.executor_revision is distinct from p_claimed_revision or c.executor_expires_at<=clock_timestamp() then
      return jsonb_build_object('authorized',false,'reason','executor_lease_lost');
    end if;
  elsif j.collection_source='carousel_pilot' then
    if p_executor_nonce is not null or p_claimed_revision is not null or j.kind<>'carousel' or j.results_limit<>30 or j.requested_profiles_count<>1
      or j.manual_authorized_by is distinct from p_owner_user_id or j.reserved_usd>.10
      or (select count(*) from public.scrape_job_creators where job_id=j.id)<>1 then return jsonb_build_object('authorized',false,'reason','pilot_scope_invalid'); end if;
  elsif j.collection_source='target_media' then
    if p_executor_nonce is not null or p_claimed_revision is not null or not exists(select 1 from public.transcription_media_refreshes m
      where m.job_id=j.id and m.owner_user_id=p_owner_user_id and m.status='active') then return jsonb_build_object('authorized',false,'reason','media_scope_invalid'); end if;
  else return jsonb_build_object('authorized',false,'reason','submission_source_invalid'); end if;
  if j.live and (j.reserved_usd<=0 or j.reserved_usd<>i.claimed_cap_usd
    or not apify_accounts_private.job_account_matches(j.owner_user_id,j.apify_account_slot,j.expected_provider_user_id)) then
    return jsonb_build_object('authorized',false,'reason','reservation_identity_invalid'); end if;
  if not exists(select 1 from public.scrape_job_creators jc join public.workspace_creators wc on wc.creator_id=jc.creator_id
    join public.workspaces w on w.id=wc.workspace_id where jc.job_id=j.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id) then
    return jsonb_build_object('authorized',false,'reason','workspace_scope_invalid'); end if;
  update collection_intents_private.intents set input_digest=p_input_digest,authorized_at=clock_timestamp() where job_id=j.id;
  update public.scrape_jobs set dispatch_phase='submission_authorized',input_digest=p_input_digest,dispatch_authorized_at=clock_timestamp() where id=j.id returning * into j;
  return jsonb_build_object('authorized',true,'job',to_jsonb(j));
end $$;
create function public.worker_cancel_pre_submit(p_owner_user_id uuid,p_job_id uuid,p_dispatch_nonce uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
  perform public.require_service();
  if nullif(btrim(p_reason),'') is null or length(p_reason)>500 then raise exception 'invalid_cancel_reason' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or p_dispatch_nonce is null or j.dispatch_nonce is distinct from p_dispatch_nonce then return jsonb_build_object('cancelled',false,'reason','claim_identity_mismatch'); end if;
  if j.dispatch_phase='cancelled_before_submit' then return jsonb_build_object('cancelled',true,'replayed',true); end if;
  if j.dispatch_phase<>'prepared' or j.status<>'dispatching' or j.dispatch_authorized_at is not null or j.actor_run_id is not null
    or exists(select 1 from collection_intents_private.accepted_evidence where job_id=j.id)
    or exists(select 1 from public.scrape_callback_receipts where job_id=j.id and state<>'rejected') then
    return jsonb_build_object('cancelled',false,'reason','submission_possible'); end if;
  -- A prepared-only service proof is different from operator acceptance of risk.
  update public.scrape_jobs set collection_source='operator_settle',dispatch_phase='cancelled_before_submit',status='failed',reserved_usd=0,
    actual_cost_usd=0,billing_reconciled_at=clock_timestamp(),completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,error_message=p_reason where id=j.id;
  return jsonb_build_object('cancelled',true,'replayed',false);
end $$;
create function public.worker_record_accepted_evidence(p_owner_user_id uuid,p_job_id uuid,p_dispatch_nonce uuid,p_run_id text,p_source text,p_verified boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
  perform public.require_service();
  if p_run_id is null or p_run_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_source is null or p_source not in ('start_response','callback','provider_recovery') or p_verified is null then
    raise exception 'invalid_accepted_evidence' using errcode='22023'; end if;
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or p_dispatch_nonce is null or j.dispatch_nonce is distinct from p_dispatch_nonce or j.dispatch_phase='cancelled_before_submit'
    or j.actor_run_id is not null and j.actor_run_id is distinct from p_run_id
    or exists(select 1 from collection_intents_private.accepted_evidence e where e.job_id=j.id and e.dispatch_nonce=p_dispatch_nonce
      and e.run_id<>p_run_id and (e.verified or e.source='start_response')) then return jsonb_build_object('recorded',false,'reason','evidence_identity_mismatch'); end if;
  insert into collection_intents_private.accepted_evidence(job_id,owner_user_id,dispatch_nonce,run_id,source,verified)
    values(j.id,p_owner_user_id,p_dispatch_nonce,p_run_id,p_source,p_verified)
    on conflict(job_id,dispatch_nonce,run_id,source) do update set verified=collection_intents_private.accepted_evidence.verified or excluded.verified;
  if (p_source='start_response' or p_verified) and j.actor_run_id is null and j.dispatch_phase in ('legacy','prepared','submission_authorized','request_unknown') then
    update public.scrape_jobs set dispatch_phase='accepted_save_pending',missing_run_recovery_reason='accepted_evidence_pending_attachment' where id=j.id;
  end if;
  return jsonb_build_object('recorded',true);
end $$;
create function public.worker_dispatch_failure(p_owner_user_id uuid,p_job_id uuid,p_dispatch_nonce uuid,p_classification text,p_error text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; cancelled jsonb;
begin
  perform public.require_service();
  if p_classification is null or p_classification not in ('request_unknown','definite_no_start') then raise exception 'invalid_dispatch_failure' using errcode='22023'; end if;
  if p_classification='definite_no_start' then
    cancelled:=public.worker_cancel_pre_submit(p_owner_user_id,p_job_id,p_dispatch_nonce,coalesce(nullif(p_error,''),'Provider submission was never authorized.'));
    return jsonb_build_object('recorded',coalesce((cancelled->>'cancelled')::boolean,false),'reason',cancelled->>'reason');
  end if;
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or p_dispatch_nonce is null or j.dispatch_nonce is distinct from p_dispatch_nonce then return jsonb_build_object('recorded',false,'reason','claim_identity_mismatch'); end if;
  if j.dispatch_phase in ('accepted_save_pending','attached','cancelled_before_submit') or j.actor_run_id is not null then
    return jsonb_build_object('recorded',false,'reason','stronger_evidence_preserved'); end if;
  update public.scrape_jobs set dispatch_phase='request_unknown',status='uncertain',uncertain_since=coalesce(uncertain_since,clock_timestamp()),
    lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'Provider request acceptance unknown; no automatic relaunch.'),500) where id=j.id;
  return jsonb_build_object('recorded',true);
end $$;
create function public.worker_claim_missing_run_recovery(p_owner_user_id uuid,p_job_id uuid default null,p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; result jsonb:='[]';
begin
  perform public.require_service();
  if p_owner_user_id is null or p_limit is null or p_limit not between 1 and 2 then raise exception 'invalid_missing_run_scope' using errcode='22023'; end if;
  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.live and q.actor_run_id is null
    and (p_job_id is null or q.id=p_job_id) and q.status in ('dispatching','uncertain') and q.dispatch_nonce is not null
    and q.dispatch_phase in ('legacy','submission_authorized','request_unknown','accepted_save_pending')
    and not q.missing_run_recovery_exhausted and q.missing_run_recovery_attempts<8 and q.missing_run_recovery_pages<8
    and q.missing_run_recovery_next_at<=clock_timestamp()
    and (q.missing_run_recovery_token is null or q.missing_run_recovery_expires_at<=clock_timestamp())
    and apify_accounts_private.job_account_matches(q.owner_user_id,q.apify_account_slot,q.expected_provider_user_id)
    order by q.missing_run_recovery_attempts,q.missing_run_recovery_next_at,q.created_at,q.id limit p_limit for update of q skip locked
  loop
    update public.scrape_jobs set missing_run_recovery_attempts=missing_run_recovery_attempts+1,missing_run_recovery_token=gen_random_uuid(),
      missing_run_recovery_expires_at=clock_timestamp()+interval '3 minutes',missing_run_recovery_next_at=clock_timestamp()+interval '3 minutes'
      where id=j.id returning * into j;
    result:=result||jsonb_build_array(jsonb_build_object('job',to_jsonb(j),'recovery_token',j.missing_run_recovery_token,
      'cursor',j.missing_run_recovery_cursor,'attempt',j.missing_run_recovery_attempts,'pages_remaining',8-j.missing_run_recovery_pages,
      'accepted_evidence',(select coalesce(jsonb_agg(jsonb_build_object('run_id',e.run_id,'source',e.source,'verified',e.verified) order by e.received_at),'[]')
        from collection_intents_private.accepted_evidence e where e.job_id=j.id and e.dispatch_nonce=j.dispatch_nonce)));
  end loop;
  return result;
end $$;
create function public.worker_complete_missing_run_recovery(p_owner_user_id uuid,p_job_id uuid,p_recovery_token uuid,p_outcome text,p_cursor text default null,p_pages_used integer default 1) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; exhausted boolean;
begin
  perform public.require_service();
  if p_outcome is null or p_outcome not in ('no_match','exhausted','matched') or p_pages_used is null or p_pages_used not between 0 and 8
    or length(p_cursor)>1024 then raise exception 'invalid_missing_run_result' using errcode='22023'; end if;
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or p_recovery_token is null or j.missing_run_recovery_token is distinct from p_recovery_token or j.missing_run_recovery_expires_at<=clock_timestamp() then
    return jsonb_build_object('recorded',false,'reason','recovery_lease_lost'); end if;
  if j.missing_run_recovery_pages+p_pages_used>8 then raise exception 'missing_run_page_budget_exceeded' using errcode='22023'; end if;
  if p_outcome='matched' and j.actor_run_id is null and not exists(select 1 from collection_intents_private.accepted_evidence e
    where e.job_id=j.id and e.dispatch_nonce=j.dispatch_nonce and e.verified) then raise exception 'missing_run_match_unverified' using errcode='42501'; end if;
  exhausted:=p_outcome='exhausted' or p_outcome<>'matched' and (j.missing_run_recovery_attempts>=8 or j.missing_run_recovery_pages+p_pages_used>=8);
  update public.scrape_jobs set missing_run_recovery_token=null,missing_run_recovery_expires_at=null,
    missing_run_recovery_pages=missing_run_recovery_pages+p_pages_used,missing_run_recovery_cursor=p_cursor,
    missing_run_recovery_exhausted=exhausted,missing_run_recovery_reason=case when exhausted then 'lookup_exhausted_not_no_start' when p_outcome='matched' then 'matched' else 'no_match_not_no_start' end,
    missing_run_recovery_next_at=clock_timestamp()+interval '3 minutes' where id=j.id;
  return jsonb_build_object('recorded',true,'exhausted',exhausted);
end $$;
revoke all on all functions in schema collection_intents_private from public,anon,authenticated,service_role;
revoke all on function public.worker_set_collection_start_gate(uuid,boolean),public.worker_authorize_collection_submit(uuid,uuid,uuid,text,uuid,bigint),
 public.worker_cancel_pre_submit(uuid,uuid,uuid,text),public.worker_record_accepted_evidence(uuid,uuid,uuid,text,text,boolean),
 public.worker_dispatch_failure(uuid,uuid,uuid,text,text),public.worker_claim_missing_run_recovery(uuid,uuid,integer),
 public.worker_complete_missing_run_recovery(uuid,uuid,uuid,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.worker_set_collection_start_gate(uuid,boolean),public.worker_authorize_collection_submit(uuid,uuid,uuid,text,uuid,bigint),
 public.worker_cancel_pre_submit(uuid,uuid,uuid,text),public.worker_record_accepted_evidence(uuid,uuid,uuid,text,text,boolean),
 public.worker_dispatch_failure(uuid,uuid,uuid,text,text),public.worker_claim_missing_run_recovery(uuid,uuid,integer),
 public.worker_complete_missing_run_recovery(uuid,uuid,uuid,text,text,integer) to service_role;
