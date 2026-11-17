-- A terminal run's usage can arrive after its first terminal callback. Preserve
-- exact provider observations; never silently lower budget protection.
alter table public.scrape_jobs add column billing_last_checked_at timestamptz,
  add column billing_review_required boolean not null default false;
create table collection_intents_private.charge_observations (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.app_settings(owner_user_id),
  job_id uuid not null references public.scrape_jobs(id), run_id text not null,
  previous_cost_usd numeric, reported_cost_usd numeric not null check(reported_cost_usd between 0 and 999999),
  decision text not null check(decision in ('observed','decrease_review')),
  observed_at timestamptz not null default clock_timestamp(),
  unique(job_id,reported_cost_usd,decision)
);
alter table collection_intents_private.charge_observations enable row level security;
revoke all on collection_intents_private.charge_observations from public,anon,authenticated,service_role;
create trigger charge_observation_append_only before update or delete on collection_intents_private.charge_observations
  for each row execute function collection_intents_private.append_only();

create function public.worker_observe_run_charge(p_owner_user_id uuid,p_job_id uuid,p_run_id text,p_actor_id text,p_provider_user_id text,
  p_status text,p_dataset_id text,p_usage_total_usd numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; amount numeric; decision text;
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
  if not found or nullif(p_run_id,'') is null or j.actor_run_id is distinct from p_run_id
    or j.expected_actor_id is distinct from p_actor_id or j.expected_provider_user_id is distinct from p_provider_user_id
    or j.dataset_id is not null and j.dataset_id is distinct from p_dataset_id
    or j.live and not apify_accounts_private.job_account_matches(j.owner_user_id,j.apify_account_slot,p_provider_user_id) then
    raise exception 'run_identity_mismatch' using errcode='42501'; end if;
  if p_status is null or p_status not in ('READY','RUNNING','SUCCEEDED','FAILED','ABORTED','TIMED-OUT')
    or p_usage_total_usd is not null and not(p_usage_total_usd between 0 and 999999) then
    raise exception 'invalid_run_metadata' using errcode='22023'; end if;
  if p_status not in ('SUCCEEDED','FAILED','ABORTED','TIMED-OUT') then return to_jsonb(j); end if;
  update public.scrape_jobs set billing_last_checked_at=clock_timestamp() where id=j.id returning * into j;
  if p_usage_total_usd is null then return to_jsonb(j); end if;
  amount:=round(p_usage_total_usd,6); -- Existing ledger precision; audit retains the exact reported numeric.
  decision:=case when j.actual_cost_usd is not null and amount<j.actual_cost_usd then 'decrease_review' else 'observed' end;
  if j.live then
    insert into collection_intents_private.charge_observations(owner_id,job_id,run_id,previous_cost_usd,reported_cost_usd,decision)
      values(j.owner_user_id,j.id,p_run_id,j.actual_cost_usd,p_usage_total_usd,decision) on conflict do nothing;
  end if;
  if decision='decrease_review' then
    update public.scrape_jobs set billing_review_required=true where id=j.id returning * into j;
    return to_jsonb(j);
  end if;
  insert into collection_intents_private.billing_mode values(txid_current(),j.id) on conflict do nothing;
  update public.scrape_jobs set actual_cost_usd=amount,reserved_usd=0,billing_review_required=false,
    billing_reconciled_at=case when actual_cost_usd is distinct from amount or billing_reconciled_at is null then clock_timestamp() else billing_reconciled_at end
    where id=j.id returning * into j;
  delete from collection_intents_private.billing_mode where transaction_id=txid_current() and job_id=j.id;
  return to_jsonb(j);
end $$;
revoke all on function public.worker_observe_run_charge(uuid,uuid,text,text,text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.worker_observe_run_charge(uuid,uuid,text,text,text,text,text,numeric) to service_role;

create or replace function public.worker_reconcile_run_billing_only(p_job_id uuid,p_run_id text,p_actor_id text,p_provider_user_id text,p_status text,p_dataset_id text,p_usage_total_usd numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_owner uuid;
begin
  perform public.require_service(); select owner_user_id into v_owner from public.scrape_jobs where id=p_job_id;
  if not found then raise exception 'unknown_job' using errcode='22023'; end if;
  return public.worker_observe_run_charge(v_owner,p_job_id,p_run_id,p_actor_id,p_provider_user_id,p_status,p_dataset_id,p_usage_total_usd);
end $$;
do $$ begin
  perform collection_intents_private.patch('public.worker_allow_reel_validation(uuid,uuid,uuid,uuid,text)',
    'or prior.actual_cost_usd is null or prior.billing_reconciled_at is null',
    'or prior.actual_cost_usd is null or prior.billing_reconciled_at is null or prior.billing_review_required');
  perform collection_intents_private.patch('public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)',
    'actual_cost_usd=coalesce(p_usage_total_usd,actual_cost_usd),','');
  perform collection_intents_private.patch('public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)',
    'return to_jsonb(j);',
    'return public.worker_observe_run_charge(j.owner_user_id,j.id,p_run_id,p_actor_id,p_provider_user_id,p_status,p_dataset_id,p_usage_total_usd);');
  perform collection_intents_private.patch('public.worker_claim_billing_reconciliation(uuid,uuid,integer)',
    $o$and q.actual_cost_usd is null and q.provider_terminal_status in$o$,
    $n$and (q.actual_cost_usd is null or coalesce(q.completed_at,q.billing_reconciled_at)>=clock_timestamp()-interval '3 days')
      and (p_job_id is not null or q.billing_last_checked_at is null or q.billing_last_checked_at<=clock_timestamp()-interval '3 minutes')
      and q.provider_terminal_status in$n$);
end $$;

-- Re-evaluate only an already ingested, identity-pinned profile whose sole
-- failure was the previously unsupported OUTPUT contract. Never resubmit it.
create table collection_intents_private.profile_reprocess_requests (
  job_id uuid primary key references public.scrape_jobs(id), owner_id uuid not null references public.app_settings(owner_user_id),
  run_id text not null, request_key uuid not null, created_at timestamptz not null default clock_timestamp()
);
alter table collection_intents_private.profile_reprocess_requests enable row level security;
revoke all on collection_intents_private.profile_reprocess_requests from public,anon,authenticated,service_role;
create trigger profile_reprocess_append_only before update or delete on collection_intents_private.profile_reprocess_requests
  for each row execute function collection_intents_private.append_only();
create function public.worker_reprocess_profile_output(p_owner_user_id uuid,p_job_id uuid,p_run_id text,p_request_key uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; request collection_intents_private.profile_reprocess_requests;
begin
  perform public.require_service();
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and id=p_job_id for update;
  if not found or not collection_intents_private.job_visible(p_owner_user_id,j.id) then raise exception 'forbidden' using errcode='42501'; end if;
  select * into request from collection_intents_private.profile_reprocess_requests where job_id=j.id;
  if found then
    if request.run_id is distinct from p_run_id or request.request_key is distinct from p_request_key then raise exception 'profile_reprocess_conflict' using errcode='22023'; end if;
    return to_jsonb(j);
  end if;
  if p_request_key is null or j.actor_run_id is distinct from p_run_id or j.kind<>'profile' or j.status<>'partial'
    or j.dispatch_phase<>'attached' or j.provider_terminal_status<>'SUCCEEDED' or j.actual_cost_usd is null
    or not j.dataset_finished or j.output_summary_reason is distinct from 'profile_output_contract_unverified'
    or j.lease_token is not null and j.lease_expires_at>clock_timestamp()
    or not exists(select 1 from public.scrape_job_creators where job_id=j.id)
    or exists(select 1 from public.scrape_job_creators where job_id=j.id and (status<>'active'
      or error_message is not null and error_message<>'profile_output_contract_unverified' or result_count<>1 or received_count<>1)) then
    raise exception 'profile_reprocess_scope_invalid' using errcode='22023'; end if;
  insert into collection_intents_private.profile_reprocess_requests(job_id,owner_id,run_id,request_key) values(j.id,p_owner_user_id,p_run_id,p_request_key);
  update public.scrape_job_creators set error_message=null,completion_status='unknown',summary_authoritative=false,
    summary_delivered_count=null,summary_recorded_at=null where job_id=j.id;
  update public.scrape_jobs set status='processing',completed_at=null,output_summary_verified=false,output_summary_reason=null,
    output_summary_recorded_at=null,error_message=null,lease_token=null,lease_expires_at=null,processing_attempts=0
    where id=j.id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.worker_reprocess_profile_output(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.worker_reprocess_profile_output(uuid,uuid,text,uuid) to service_role;
