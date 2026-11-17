-- Durable, service-only callback hints and fair bounded reconciliation. No schedules or starts.
alter table public.scrape_jobs
 add column reconciliation_selected_at timestamptz,
 add column reconciliation_next_at timestamptz not null default now(),
 add column reconciliation_attempts integer not null default 0 check(reconciliation_attempts between 0 and 8),
 add column reconciliation_token uuid,
 add column reconciliation_expires_at timestamptz;
create index jobs_reconciliation_due_idx on public.scrape_jobs(owner_user_id,reconciliation_next_at,reconciliation_selected_at,id);

create table public.scrape_callback_receipts (
 job_id uuid not null references public.scrape_jobs on delete cascade,
 dispatch_nonce uuid not null,
 run_id text not null check(run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 owner_user_id uuid not null references public.app_settings(owner_user_id),
 expected_actor_id text not null check(length(expected_actor_id) between 1 and 256),
 expected_provider_user_id text not null check(length(expected_provider_user_id) between 1 and 256),
 state text not null default 'pending' check(state in ('pending','verified','rejected')),
 received_at timestamptz not null default now(),
 selected_at timestamptz,
 checked_at timestamptz,
 primary key(job_id,dispatch_nonce,run_id)
);
alter table public.scrape_callback_receipts enable row level security;
revoke all on public.scrape_callback_receipts from public,anon,authenticated,service_role;
grant all on public.scrape_callback_receipts to service_role;
create index callback_receipts_pending_idx on public.scrape_callback_receipts(owner_user_id,job_id,received_at) where state='pending';

create function public.worker_record_callback_receipt(p_owner_user_id uuid,p_job_id uuid,p_dispatch_nonce uuid,p_run_id text,p_actor_id text,p_provider_user_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
 perform public.require_service();
 select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
 if not found or not j.live or p_dispatch_nonce is null or j.dispatch_nonce is distinct from p_dispatch_nonce
  or nullif(p_actor_id,'') is null or length(p_actor_id)>256 or j.expected_actor_id is distinct from p_actor_id
  or nullif(p_provider_user_id,'') is null or length(p_provider_user_id)>256 or j.expected_provider_user_id is distinct from p_provider_user_id
  or not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id and provider_account_id=p_provider_user_id)
  or p_run_id is null or p_run_id !~ '^[A-Za-z0-9_-]{1,128}$'
  or j.actor_run_id is not null and j.actor_run_id is distinct from p_run_id
  or j.actor_run_id is null and j.status not in ('dispatching','uncertain') then
  return jsonb_build_object('accepted',false,'reason','unknown_callback');
 end if;
 -- A verified replay remains an eligible exact re-read, even after authoritative billing settles.
 -- It cannot reset the due throttle or acquire/release a processing lease; rejected hints stay quarantined.
 if exists(select 1 from public.scrape_callback_receipts where job_id=j.id and dispatch_nonce=p_dispatch_nonce and run_id=p_run_id) then
  update public.scrape_callback_receipts set state='pending' where job_id=j.id and dispatch_nonce=p_dispatch_nonce and run_id=p_run_id and state='verified';
  return jsonb_build_object('accepted',true);
 end if;
 -- Quarantined mismatches are removable; a fake hint must not permanently poison a true callback.
 delete from public.scrape_callback_receipts where job_id=j.id and (state='rejected' or dispatch_nonce is distinct from j.dispatch_nonce);
 if (select count(*) from public.scrape_callback_receipts where job_id=j.id and state='pending')>=3 then
  return jsonb_build_object('accepted',false,'reason','callback_capacity_retry');
 end if;
 insert into public.scrape_callback_receipts(job_id,dispatch_nonce,run_id,owner_user_id,expected_actor_id,expected_provider_user_id)
 values(j.id,p_dispatch_nonce,p_run_id,p_owner_user_id,p_actor_id,p_provider_user_id);
 update public.scrape_jobs set reconciliation_next_at=least(reconciliation_next_at,now()) where id=j.id;
 return jsonb_build_object('accepted',true);
end; $$;

create function public.worker_claim_reconciliation(p_owner_user_id uuid,p_job_id uuid default null,p_kind text default null,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; hint jsonb; result jsonb:='[]'::jsonb;
begin
 perform public.require_service();
 if p_owner_user_id is null or p_limit is null or p_limit<1 or p_limit>10 or p_kind is not null and p_kind<>'carousel' then
  raise exception 'invalid_reconciliation_scope' using errcode='22023';
 end if;
 if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id) then return result; end if;
 for j in
  select q.* from public.scrape_jobs q
  where q.owner_user_id=p_owner_user_id and (p_job_id is null or q.id=p_job_id) and (p_kind is null or q.kind=p_kind)
   -- Exact authorized settlement ignores the due throttle, but never an in-flight claim.
   and (p_job_id is not null or q.reconciliation_next_at<=now())
   and (q.reconciliation_token is null or q.reconciliation_expires_at<=now())
   and (not q.live or exists(select 1 from public.app_settings s where s.owner_user_id=q.owner_user_id and s.provider_account_id=q.expected_provider_user_id and nullif(q.expected_actor_id,'') is not null))
   and (
    q.actor_run_id is not null and (
     q.status='running' or q.status='processing' and q.processing_attempts<10
     or q.live and q.actual_cost_usd is null and q.status in ('succeeded','partial','failed','uncertain','processing')
    )
    or exists(select 1 from public.scrape_callback_receipts r where r.job_id=q.id and r.owner_user_id=q.owner_user_id
      and r.dispatch_nonce=q.dispatch_nonce and r.expected_actor_id=q.expected_actor_id and r.expected_provider_user_id=q.expected_provider_user_id
      and r.state='pending' and (q.actor_run_id is not null or q.status in ('dispatching','uncertain')))
   )
  -- Round-robin by last selection, not scheduled_for alone: the oldest ten cannot starve the rest.
  order by q.reconciliation_selected_at asc nulls first,q.scheduled_for,q.created_at,q.id
  limit p_limit for update of q skip locked
 loop
  hint:=null;
  select jsonb_build_object('run_id',r.run_id,'dispatch_nonce',r.dispatch_nonce) into hint
   from public.scrape_callback_receipts r where r.job_id=j.id and r.owner_user_id=j.owner_user_id and r.dispatch_nonce=j.dispatch_nonce
    and r.expected_actor_id=j.expected_actor_id and r.expected_provider_user_id=j.expected_provider_user_id and r.state='pending'
   order by r.selected_at asc nulls first,(r.run_id is distinct from j.actor_run_id),r.received_at,r.run_id limit 1;
  if hint is not null then
   update public.scrape_callback_receipts set selected_at=now() where job_id=j.id and dispatch_nonce=j.dispatch_nonce and run_id=hint->>'run_id';
  end if;
  -- Stamp before any provider read. This lease is separate from dispatch/processing leases.
  update public.scrape_jobs set reconciliation_selected_at=now(),reconciliation_next_at=now()+interval '3 minutes',
   reconciliation_attempts=least(reconciliation_attempts+1,8),reconciliation_token=gen_random_uuid(),reconciliation_expires_at=now()+interval '3 minutes'
   where id=j.id returning * into j;
  result:=result||jsonb_build_array(jsonb_build_object('job',to_jsonb(j),'callback_hint',hint,'reconciliation_token',j.reconciliation_token));
 end loop;
 return result;
end; $$;

create function public.worker_complete_reconciliation(p_owner_user_id uuid,p_job_id uuid,p_reconciliation_token uuid,p_callback_run_id text default null,p_callback_state text default 'pending')
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs;
begin
 perform public.require_service();
 if p_callback_state is null or p_callback_state not in ('pending','verified','rejected') then raise exception 'invalid_callback_state' using errcode='22023'; end if;
 select * into j from public.scrape_jobs where id=p_job_id and owner_user_id=p_owner_user_id for update;
 if not found or p_reconciliation_token is null or j.reconciliation_token is distinct from p_reconciliation_token
  or j.reconciliation_expires_at<=now() then return; end if;
 if p_callback_state='verified' and (j.actor_run_id is distinct from p_callback_run_id or p_callback_run_id is null) then
  raise exception 'callback_not_attached' using errcode='42501';
 end if;
 if p_callback_run_id is not null then
  update public.scrape_callback_receipts set state=p_callback_state,checked_at=now()
   where job_id=j.id and owner_user_id=p_owner_user_id and dispatch_nonce=j.dispatch_nonce and run_id=p_callback_run_id
    and expected_actor_id=j.expected_actor_id and expected_provider_user_id=j.expected_provider_user_id and state='pending';
 end if;
 -- Unknown final charges and retryable errors remain eligible indefinitely, with bounded backoff.
 update public.scrape_jobs set reconciliation_token=null,reconciliation_expires_at=null,
  reconciliation_next_at=now()+make_interval(secs=>case when j.status='processing' and j.processing_attempts<10 then 3 else least(300,3*power(2,greatest(j.reconciliation_attempts-1,0))::integer) end)
  where id=j.id;
end; $$;

revoke execute on function public.worker_record_callback_receipt(uuid,uuid,uuid,text,text,text),
 public.worker_claim_reconciliation(uuid,uuid,text,integer),public.worker_complete_reconciliation(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_record_callback_receipt(uuid,uuid,uuid,text,text,text),
 public.worker_claim_reconciliation(uuid,uuid,text,integer),public.worker_complete_reconciliation(uuid,uuid,uuid,text,text) to service_role;
