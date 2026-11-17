-- Authorization is the durable boundary before the one permitted provider POST.
-- An immutable, matching intent with no authorization proves that this claim
-- never crossed that boundary; a failed/absent provider search does not.
create function collection_intents_private.never_authorized(j public.scrape_jobs) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select j.dispatch_phase in ('prepared','request_unknown')
    and j.status in ('dispatching','uncertain') and j.operational_disposition='protected'
    and j.dispatch_nonce is not null and j.dispatch_authorized_at is null and j.input_digest is null
    and j.actor_run_id is null and j.dataset_id is null and j.provider_terminal_status is null
    and j.actual_cost_usd is null and j.billing_reconciled_at is null
    and exists(select 1 from collection_intents_private.intents i where i.job_id=j.id
      and i.owner_user_id=j.owner_user_id and i.dispatch_nonce=j.dispatch_nonce
      and i.claimed_at=j.started_at and i.claimed_cap_usd=j.claimed_cap_usd
      and i.actor_id=j.expected_actor_id and i.provider_user_id=j.expected_provider_user_id
      and i.account_slot is not distinct from j.apify_account_slot
      and i.authorized_at is null and i.input_digest is null)
    and not exists(select 1 from collection_intents_private.accepted_evidence e where e.job_id=j.id)
    and not exists(select 1 from public.scrape_callback_receipts r where r.job_id=j.id and r.state<>'rejected')
$$;
revoke all on function collection_intents_private.never_authorized(public.scrape_jobs) from public,anon,authenticated,service_role;

do $$ begin
  perform collection_intents_private.patch('collection_intents_private.job_protocol()',
    $o$or old.dispatch_phase='request_unknown' and new.dispatch_phase in ('accepted_save_pending','attached')$o$,
    $n$or old.dispatch_phase='request_unknown' and (new.dispatch_phase in ('accepted_save_pending','attached')
      or new.dispatch_phase='cancelled_before_submit' and collection_intents_private.never_authorized(old))$n$);
  perform collection_intents_private.patch('public.worker_cancel_pre_submit(uuid,uuid,uuid,text)',
    $o$if j.dispatch_phase<>'prepared' or j.status<>'dispatching' or j.dispatch_authorized_at is not null or j.actor_run_id is not null$o$,
    $n$if not coalesce(collection_intents_private.never_authorized(j),false)$n$);
  -- Old and new worker versions receive the same transactional repair. This
  -- serializes against authorization and callbacks using the canonical job lock.
  perform collection_intents_private.patch('public.worker_dispatch_failure(uuid,uuid,uuid,text,text)',
    $o$  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;$o$,
    $n$  cancelled:=public.worker_cancel_pre_submit(p_owner_user_id,p_job_id,p_dispatch_nonce,'Submission authorization did not commit; no provider start was permitted.');
  if coalesce((cancelled->>'cancelled')::boolean,false) then
    return jsonb_build_object('recorded',true,'cancelled',true); end if;
  select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;$n$);
  -- Recover already-misclassified claims on normal settlement wakes, even when
  -- the unrelated provider-lookup budget has been exhausted. Bounded to ten.
  perform collection_intents_private.patch('public.worker_expire_dispatches(uuid)',
    $o$  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.status='dispatching'$o$,
    $n$  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id
    and q.status='uncertain' and collection_intents_private.never_authorized(q)
    order by q.id limit 10 for update of q loop
    result:=public.worker_cancel_pre_submit(p_owner_user_id,j.id,j.dispatch_nonce,'Recovered uncommitted submission authorization; no provider start was permitted.');
    if coalesce((result->>'cancelled')::boolean,false) then n:=n+1; end if;
  end loop;
  for j in select q.* from public.scrape_jobs q where q.owner_user_id=p_owner_user_id and q.status='dispatching'$n$);
end $$;
