-- Final protocol hardening: expiry is a phase decision, not evidence of a start.
create or replace function public.worker_expire_dispatches(p_owner_user_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; result jsonb; n integer:=0;
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.status='dispatching'
    and q.lease_expires_at<clock_timestamp() order by q.id for update of q loop
    if j.dispatch_phase='prepared' then
      result:=public.worker_cancel_pre_submit(p_owner_user_id,j.id,j.dispatch_nonce,'Prepared intent expired before submission authorization.');
      if (result->>'cancelled')::boolean then n:=n+1; continue; end if;
    end if;
    -- Journal evidence is strictly stronger than an expired dispatch lease.
    if j.dispatch_phase='accepted_save_pending' or j.actor_run_id is not null then
      update public.scrape_jobs set lease_token=null,lease_expires_at=null where id=j.id;
    else
      update public.scrape_jobs set status='uncertain',lease_token=null,lease_expires_at=null,
        error_message='Dispatch lease expired; acceptance remains unknown. No automatic relaunch.' where id=j.id;
    end if;
    n:=n+1;
  end loop;
  return n;
end $$;
-- Released legacy rows must keep their immutable original paid identity too.
create function collection_intents_private.released_identity_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if old.operational_disposition='risk_released' and (
    new.id is distinct from old.id or new.owner_user_id is distinct from old.owner_user_id
    or new.dispatch_nonce is distinct from old.dispatch_nonce or new.started_at is distinct from old.started_at
    or new.expected_actor_id is distinct from old.expected_actor_id or new.expected_provider_user_id is distinct from old.expected_provider_user_id
    or new.apify_account_slot is distinct from old.apify_account_slot or new.live is distinct from old.live or new.billing_month is distinct from old.billing_month
    or new.claimed_cap_usd is distinct from old.claimed_cap_usd or new.operational_disposition<>'risk_released'
    or new.actual_cost_usd is distinct from old.actual_cost_usd and new.actor_run_id is null
    or new.billing_reconciled_at is distinct from old.billing_reconciled_at and new.actor_run_id is null) then
    raise exception 'immutable_released_collection_identity' using errcode='23514'; end if;
  return new;
end $$;
create trigger collection_released_identity before update on public.scrape_jobs for each row execute function collection_intents_private.released_identity_guard();
do $$ begin
  -- Trial cap is selected before immutable intent capture, not after reservation.
  perform collection_intents_private.patch('carousel_pilot_private.claim(uuid,uuid,text)',
    '  result:=public.worker_claim_dispatch(p_owner_user_id,true,p_actor_id,''carousel'');',
    E'  perform set_config(''reelradar.collection_pilot_job_id'',p_job_id::text,true);\n  result:=public.worker_claim_dispatch(p_owner_user_id,true,p_actor_id,''carousel'');\n  perform set_config(''reelradar.collection_pilot_job_id'','''',true);');
  perform collection_intents_private.patch('public.transcription_claim_dispatch_core(uuid,boolean,text,text)',
    'least(s.collection_job_cap_usd,trunc(headroom/slots,6))',
    'least(s.collection_job_cap_usd,trunc(headroom/slots,6),case when nullif(current_setting(''reelradar.collection_pilot_job_id'',true),'''')=j.id::text then .10 else s.collection_job_cap_usd end)');
  perform collection_intents_private.patch('public.worker_attach_run(uuid,uuid,text,text,text,text)',
    $o$if j.dispatch_phase='cancelled_before_submit' or j.dispatch_nonce is distinct from p_dispatch_nonce$o$,
    $n$if exists(select 1 from collection_intents_private.accepted_evidence evidence where evidence.job_id=j.id and evidence.dispatch_nonce=j.dispatch_nonce
      and evidence.run_id<>p_run_id and (evidence.verified or evidence.source='start_response'))
      or j.dispatch_phase='cancelled_before_submit' or j.dispatch_nonce is distinct from p_dispatch_nonce$n$);
  perform collection_intents_private.patch('public.worker_authorize_collection_submit(uuid,uuid,uuid,text,uuid,bigint)',
    $o$  select * into i from collection_intents_private.intents$o$,
    $n$  if exists(select 1 from public.scrape_callback_receipts where job_id=j.id and state<>'rejected')
    or exists(select 1 from collection_intents_private.accepted_evidence where job_id=j.id) then
    return jsonb_build_object('authorized',false,'reason','accepted_evidence_conflict'); end if;
  select * into i from collection_intents_private.intents$n$);
  perform collection_intents_private.patch('public.worker_reconcile_run_billing_only(uuid,text,text,text,text,text,numeric)',
    $o$  if p_status in ('SUCCEEDED','FAILED','ABORTED','TIMED-OUT') and p_usage_total_usd is not null then$o$,
    $n$  if j.actual_cost_usd is not null then
    if p_usage_total_usd is not null and j.actual_cost_usd is distinct from p_usage_total_usd then raise exception 'authoritative_billing_conflict' using errcode='22023'; end if;
    return to_jsonb(j);
  end if;
  if p_status in ('SUCCEEDED','FAILED','ABORTED','TIMED-OUT') and p_usage_total_usd is not null then$n$);
  perform collection_intents_private.patch('public.worker_claim_missing_run_recovery(uuid,uuid,integer)',
    $o$  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.live$o$,
    $n$  update public.scrape_jobs set missing_run_recovery_token=null,missing_run_recovery_expires_at=null,
    missing_run_recovery_exhausted=true,missing_run_recovery_reason='lookup_exhausted_not_no_start'
    where owner_user_id=p_owner_user_id and actor_run_id is null and not missing_run_recovery_exhausted
      and (missing_run_recovery_attempts>=8 or missing_run_recovery_pages>=8)
      and (missing_run_recovery_token is null or missing_run_recovery_expires_at<=clock_timestamp());
  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.live$n$);
  -- New exact receipt evidence is a bounded re-read opportunity even after the
  -- discovery page budget is exhausted. It is not another search/start attempt.
  perform collection_intents_private.patch('public.worker_claim_missing_run_recovery(uuid,uuid,integer)',
    'and not q.missing_run_recovery_exhausted and q.missing_run_recovery_attempts<8 and q.missing_run_recovery_pages<8',
    $n$and (not q.missing_run_recovery_exhausted and q.missing_run_recovery_attempts<8 and q.missing_run_recovery_pages<8
      or q.dispatch_phase='accepted_save_pending' and exists(select 1 from collection_intents_private.accepted_evidence evidence
        where evidence.job_id=q.id and evidence.dispatch_nonce=q.dispatch_nonce and (evidence.verified or evidence.source='start_response')))$n$);
  perform collection_intents_private.patch('public.worker_claim_missing_run_recovery(uuid,uuid,integer)',
    'missing_run_recovery_attempts=missing_run_recovery_attempts+1',
    'missing_run_recovery_attempts=least(missing_run_recovery_attempts+1,8)');
  perform collection_intents_private.patch('public.worker_record_accepted_evidence(uuid,uuid,uuid,text,text,boolean)',
    $o$missing_run_recovery_reason='accepted_evidence_pending_attachment'$o$,
    $n$missing_run_recovery_reason='accepted_evidence_pending_attachment',missing_run_recovery_next_at=clock_timestamp()$n$);
  perform collection_intents_private.patch('public.get_bootstrap()',
    $o$'risk_released_exposure_usd',(select coalesce(sum(a.released_usd),0)$o$,
    $n$'reconciled_month_spend_usd',(select coalesce(sum(actual_cost_usd),0) from public.scrape_jobs known_job where known_job.owner_user_id=auth.uid()
        and known_job.live and known_job.billing_month=date_trunc('month',now() at time zone 'UTC')::date),
      'risk_released_exposure_usd',(select coalesce(sum(a.released_usd),0)$n$);
  perform collection_intents_private.patch('public.get_bootstrap()',
    'results_limit,metrics_tracked_count,discovery_bounded,returned_records_count',
    'results_limit,metrics_tracked_count,discovery_bounded,returned_records_count,apify_account_slot,reserved_usd,claimed_cap_usd,dispatch_phase,operational_disposition');
  perform collection_intents_private.patch('public.get_apify_account_status()',
    'return apify_accounts_private.status(auth.uid());',
    'return apify_accounts_private.status(auth.uid())||jsonb_build_object(''capacity'',collection_intents_private.capacity(auth.uid()));');
end $$;
revoke all on all functions in schema collection_intents_private from public,anon,authenticated,service_role;
