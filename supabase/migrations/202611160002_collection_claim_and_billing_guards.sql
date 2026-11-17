-- Surgical forward patches preserve the latest bounded-window/lock-order bodies.
create function collection_intents_private.patch(p_signature text,p_old text,p_new text) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare definition text;
begin
  select pg_get_functiondef(p_signature::regprocedure) into definition;
  if position(p_old in definition)=0 or length(definition)-length(replace(definition,p_old,''))<>length(p_old)
    or position('SECURITY DEFINER' in definition)=0 then raise exception 'collection_intents_contract_drift: %',p_signature; end if;
  execute replace(definition,p_old,p_new);
end $$;
do $$
declare core text:='public.transcription_claim_dispatch_core(uuid,boolean,text,text)'; definition text; signature text;
  old_busy text:=$o$busy.status in ('dispatching','running','processing','uncertain')$o$;
begin
  perform collection_intents_private.patch(core,
    $o$  if p_live and not s.scraping_enabled then$o$,
    $n$  if p_live and coalesce((select paid_starts_gated from public.collection_worker_settings where owner_user_id=p_owner_user_id),true) then return jsonb_build_object('reason','paid_starts_gated'); end if;
  if p_live and s.collection_job_cap_usd<=0 then return jsonb_build_object('reason','job_cap_disabled'); end if;
  if p_live and not s.scraping_enabled then$n$);
  perform collection_intents_private.patch(core,
    $o$select count(*) into active_count from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('dispatching','running','processing','uncertain');$o$,
    $n$select count(*) into active_count from public.scrape_jobs active_job where owner_user_id=p_owner_user_id and status in ('dispatching','running','processing','uncertain') and collection_intents_private.blocks_dispatch(active_job);$n$);
  perform collection_intents_private.patch(core,
    $o$cap:=case when p_live then trunc(headroom/slots,6) else 0 end;$o$,
    $n$cap:=case when p_live then least(s.collection_job_cap_usd,trunc(headroom/slots,6)) else 0 end;$n$);
  perform collection_intents_private.patch(core,
    $o$update public.scrape_jobs set collection_source=case$o$,
    $n$update public.scrape_jobs set dispatch_phase='prepared',claimed_cap_usd=cap,input_digest=null,dispatch_authorized_at=null,collection_source=case$n$);
  -- Shared overlap gates use a conjunct around existing predicates, never remove
  -- old uncertainty or processing-exhaustion predicates.
  foreach signature in array array[
    'collection_worker_private.claim_next(uuid,boolean,jsonb,text[])',
    'profile_automation_private.dispatch_previous(uuid,boolean,text,text)',
    'carousel_automation_private.maintain_pre_initial(uuid,integer)'] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if position(old_busy in definition)=0 then raise exception 'collection_overlap_contract_drift: %',signature; end if;
    definition:=replace(definition,old_busy,old_busy||' and collection_intents_private.blocks_dispatch(busy)');
    definition:=replace(definition,'or busy.processing_attempts>=10','or collection_intents_private.blocks_dispatch(busy) and busy.processing_attempts>=10');
    definition:=replace(definition,'or busy.live and busy.actual_cost_usd is null','or collection_intents_private.blocks_dispatch(busy) and busy.live and busy.actual_cost_usd is null');
    execute definition;
  end loop;
  perform collection_intents_private.patch('profile_automation_private.blocked(uuid,uuid,uuid)',
    'and j.id is distinct from p_exclude_job and','and j.id is distinct from p_exclude_job and collection_intents_private.blocks_dispatch(j) and');
  -- Unmapped released no-run jobs no longer operationally quarantine every slot;
  -- authoritative actual charges and their unobserved usage remain unchanged.
  perform collection_intents_private.patch('apify_accounts_private.status(uuid)',
    E'where j.owner_user_id=p_owner and j.live\n    and (j.attempt_count>0',
    E'where j.owner_user_id=p_owner and j.live and collection_intents_private.blocks_dispatch(j)\n    and (j.attempt_count>0');
  perform collection_intents_private.patch('apify_accounts_private.status(uuid)',
    $o$count(*) filter(where j.status='uncertain' or j.status in ('succeeded','partial','failed') and j.actual_cost_usd is null
        or j.provider_terminal_status is not null and j.actual_cost_usd is null)$o$,
    $n$count(*) filter(where collection_intents_private.blocks_dispatch(j) and (j.status='uncertain' or j.status in ('succeeded','partial','failed') and j.actual_cost_usd is null
        or j.provider_terminal_status is not null and j.actual_cost_usd is null))$n$);
  perform collection_intents_private.patch('apify_accounts_private.status(uuid)',
    $o$and busy.apify_account_slot=a.slot and busy.status in ('dispatching','running','processing','uncertain')$o$,
    $n$and busy.apify_account_slot=a.slot and busy.status in ('dispatching','running','processing','uncertain') and collection_intents_private.blocks_dispatch(busy)$n$);
  foreach signature in array array['public.get_creator_collection_state(uuid,uuid[])','public.get_creator_collection_summary(uuid)'] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if position('j.owner_user_id=owner_id and j.live and' in definition)=0 then raise exception 'collection_read_blocker_drift: %',signature; end if;
    definition:=replace(definition,'j.owner_user_id=owner_id and j.live and','j.owner_user_id=owner_id and j.live and collection_intents_private.blocks_dispatch(j) and');
    definition:=replace(definition,$o$filter(where j.status in ('dispatching','running','processing','uncertain'))$o$,
      $n$filter(where j.status in ('dispatching','running','processing','uncertain') and collection_intents_private.blocks_dispatch(j))$n$);
    execute definition;
  end loop;
  perform collection_intents_private.patch('public.worker_competitor_maintain(uuid)',
    $o$      if j.status in ('pending','budget_paused','dispatching','running','processing') then continue; end if;$o$,
    $n$      if j.operational_disposition='risk_released' then
        update public.competitor_refresh_runs set status='outcome_unknown',completed_at=coalesce(completed_at,now()),
          error_message='Operator accepted unknown provider liability; no automatic retry.' where id=r.id;
        continue;
      end if;
      if j.status in ('pending','budget_paused','dispatching','running','processing') then continue; end if;$n$);
  -- Set executor context only around the already-fenced claim body. No client can
  -- turn a fake GUC into a nonce: capture reads the locked owner settings row.
  perform collection_intents_private.patch('public.worker_claim_next(uuid,boolean,jsonb,text[],uuid,bigint)',
    'result:=collection_worker_private.claim_next(p_owner_user_id,p_live,p_actor_ids,p_eligible_kinds);',
    $n$  perform set_config('reelradar.collection_executor_nonce',p_executor_nonce::text,true);
  result:=collection_worker_private.claim_next(p_owner_user_id,p_live,p_actor_ids,p_eligible_kinds);
  perform set_config('reelradar.collection_executor_nonce','',true);$n$);
  -- Every reconcile entrypoint must have a nonempty bound exact run. NULL=NULL
  -- cannot be authoritative evidence of a completed paid start.
  perform collection_intents_private.patch('public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)',
    'if j.actor_run_id is distinct from p_run_id',
    $n$if nullif(btrim(p_run_id),'') is null or nullif(btrim(j.actor_run_id),'') is null or j.actor_run_id is distinct from p_run_id$n$);
  -- Cancelled proofs cannot later acquire a run; other late receipts retain all
  -- inherited unique-run, exact actor, account and dispatch-nonce checks.
  perform collection_intents_private.patch('public.worker_attach_run(uuid,uuid,text,text,text,text)',
    'if j.dispatch_nonce is distinct from p_dispatch_nonce',
    $n$if j.dispatch_phase='cancelled_before_submit' or j.dispatch_nonce is distinct from p_dispatch_nonce$n$);
  -- Protect actual collection completion hooks with a private transactional
  -- marker: an authenticated user cannot set a custom GUC to suppress a wake.
  perform collection_intents_private.patch('collection_worker_private.completion_trigger()',
    '  if new.collection_source=''ordinary''',
    $n$  if exists(select 1 from collection_intents_private.billing_mode where transaction_id=txid_current() and job_id=new.id) then return new; end if;
  if new.collection_source='ordinary'$n$);
end $$;
alter table public.competitor_refresh_runs drop constraint competitor_refresh_runs_status_check;
alter table public.competitor_refresh_runs add constraint competitor_refresh_runs_status_check
  check(status in ('pending','running','blocked','succeeded','partial','failed','outcome_unknown'));
-- Cap updates keep all existing field validation and lock ordering.
do $$ begin
  perform collection_intents_private.patch('public.update_settings(jsonb)',
    $o$'daily_limit','weekly_limit','monthly_budget_usd','budget_warning_pct','capacity'$o$,
    $n$'daily_limit','weekly_limit','monthly_budget_usd','budget_warning_pct','capacity','collection_job_cap_usd'$n$);
  perform collection_intents_private.patch('public.update_settings(jsonb)',
    $o$if item.key='monthly_budget_usd' then$o$,
    $n$if item.key in ('monthly_budget_usd','collection_job_cap_usd') then$n$);
  perform collection_intents_private.patch('public.update_settings(jsonb)',
    $o$monthly_budget_usd=coalesce((p_settings->>'monthly_budget_usd')::numeric,monthly_budget_usd),$o$,
    $n$monthly_budget_usd=coalesce((p_settings->>'monthly_budget_usd')::numeric,monthly_budget_usd),
 collection_job_cap_usd=coalesce((p_settings->>'collection_job_cap_usd')::numeric,collection_job_cap_usd),$n$);
  perform collection_intents_private.patch('public.update_settings(jsonb)',
    $o$'daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,$o$,
    $n$'collection_job_cap_usd',s.collection_job_cap_usd,'daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,$n$);
  perform collection_intents_private.patch('public.get_bootstrap()',
    $o$'settings',jsonb_build_object('daily_limit',s.daily_limit$o$,
    $n$'settings',jsonb_build_object('collection_job_cap_usd',s.collection_job_cap_usd,'daily_limit',s.daily_limit$n$);
end $$;
create function public.worker_get_collection_recovery_state(p_owner_user_id uuid,p_job_id uuid,p_dispatch_nonce uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
  perform public.require_service();
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id and dispatch_nonce=p_dispatch_nonce;
  if not found or p_dispatch_nonce is null then return null; end if;
  return jsonb_build_object('input_digest',j.input_digest,'accepted_evidence',
    (select coalesce(jsonb_agg(jsonb_build_object('run_id',e.run_id,'source',e.source,'verified',e.verified) order by e.received_at),'[]')
      from collection_intents_private.accepted_evidence e where e.job_id=j.id and e.dispatch_nonce=j.dispatch_nonce),
    'callback_hints',(select coalesce(jsonb_agg(jsonb_build_object('run_id',r.run_id,'dispatch_nonce',r.dispatch_nonce) order by r.received_at),'[]')
      from public.scrape_callback_receipts r where r.job_id=j.id and r.owner_user_id=p_owner_user_id and r.dispatch_nonce=j.dispatch_nonce and r.state='pending'));
end $$;
create function public.worker_claim_billing_reconciliation(p_owner_user_id uuid,p_job_id uuid default null,p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; result jsonb:='[]';
begin
  perform public.require_service();
  if p_owner_user_id is null or p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_billing_scope' using errcode='22023'; end if;
  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.live and nullif(q.actor_run_id,'') is not null
    and q.actual_cost_usd is null and q.provider_terminal_status in ('SUCCEEDED','FAILED','ABORTED','TIMED-OUT')
    and (p_job_id is null or q.id=p_job_id) and (p_job_id is not null or q.reconciliation_next_at<=clock_timestamp())
    and (q.reconciliation_token is null or q.reconciliation_expires_at<=clock_timestamp())
    and apify_accounts_private.job_account_matches(q.owner_user_id,q.apify_account_slot,q.expected_provider_user_id)
    order by q.reconciliation_selected_at nulls first,q.created_at,q.id limit p_limit for update of q skip locked
  loop
    update public.scrape_jobs set reconciliation_selected_at=clock_timestamp(),reconciliation_next_at=clock_timestamp()+interval '3 minutes',
      reconciliation_attempts=least(reconciliation_attempts+1,8),reconciliation_token=gen_random_uuid(),reconciliation_expires_at=clock_timestamp()+interval '3 minutes'
      where id=j.id returning * into j;
    result:=result||jsonb_build_array(jsonb_build_object('job',to_jsonb(j),'callback_hint',null,'reconciliation_token',j.reconciliation_token));
  end loop;
  return result;
end $$;
create function public.worker_reconcile_run_billing_only(p_job_id uuid,p_run_id text,p_actor_id text,p_provider_user_id text,p_status text,p_dataset_id text,p_usage_total_usd numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
  perform public.require_service();
  select * into j from public.scrape_jobs where id=p_job_id;
  if not found then raise exception 'unknown_job' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||j.owner_user_id::text,0));
  select * into j from public.scrape_jobs where id=p_job_id for update;
  if nullif(btrim(p_run_id),'') is null or nullif(btrim(j.actor_run_id),'') is null or j.actor_run_id is distinct from p_run_id
    or j.expected_actor_id is distinct from p_actor_id or j.expected_provider_user_id is distinct from p_provider_user_id
    or j.live and not apify_accounts_private.job_account_matches(j.owner_user_id,j.apify_account_slot,p_provider_user_id) then
    raise exception 'run_identity_mismatch' using errcode='42501'; end if;
  if p_status is null or p_status not in ('READY','RUNNING','SUCCEEDED','FAILED','ABORTED','TIMED-OUT') or p_usage_total_usd<0
    or p_usage_total_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'invalid_run_metadata' using errcode='22023'; end if;
  if p_status in ('SUCCEEDED','FAILED','ABORTED','TIMED-OUT') and p_usage_total_usd is not null then
    insert into collection_intents_private.billing_mode values(txid_current(),j.id);
    update public.scrape_jobs set actual_cost_usd=p_usage_total_usd,reserved_usd=0,billing_reconciled_at=clock_timestamp() where id=j.id returning * into j;
    delete from collection_intents_private.billing_mode where transaction_id=txid_current() and job_id=j.id;
  end if;
  return to_jsonb(j);
end $$;
revoke all on all functions in schema collection_intents_private from public,anon,authenticated,service_role;
revoke all on function public.worker_get_collection_recovery_state(uuid,uuid,uuid),public.worker_claim_billing_reconciliation(uuid,uuid,integer),
 public.worker_reconcile_run_billing_only(uuid,text,text,text,text,text,numeric) from public,anon,authenticated,service_role;
grant execute on function public.worker_get_collection_recovery_state(uuid,uuid,uuid),public.worker_claim_billing_reconciliation(uuid,uuid,integer),
 public.worker_reconcile_run_billing_only(uuid,text,text,text,text,text,numeric) to service_role;
