-- Forward-only expansion of the deployed owner-scoped registry from three to five.
-- No credential storage, paid work, schedule changes, budget changes or hold releases.
-- Flush pre-existing deferred revision/FK events before touching either table.
set constraints all immediate;

alter table public.apify_accounts
  drop constraint apify_accounts_slot_check,
  add constraint apify_accounts_slot_check check(slot in (1,2,3,4,5));

-- Defaults keep new accounts disabled, unauthorized and without identity/usage.
-- Do not update existing accounts, legacy settings, jobs or their immutable pins.
insert into public.apify_accounts(owner_id,slot)
select owner_user_id,slot from public.app_settings cross join (values(4),(5)) slots(slot)
on conflict(owner_id,slot) do nothing;

-- Backfill may enqueue FK events; flush them before subsequent table DDL too.
set constraints all immediate;
alter table public.scrape_jobs
  drop constraint scrape_jobs_apify_account_slot_check,
  add constraint scrape_jobs_apify_account_slot_check check(apify_account_slot in (1,2,3,4,5));

-- Patch only fixed bounds in the deployed functions. Fail loudly on source drift;
-- CREATE OR REPLACE from pg_get_functiondef retains owner, security and ACL scopes.
-- Dynamic registry/status/allocation loops and all historical identity checks stay intact.
do $$
declare def text; target regprocedure; old_check text; new_check text;
begin
  foreach target in array array[
    'public.worker_configure_apify_account(uuid,integer,text,boolean,boolean)'::regprocedure,
    'public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric)'::regprocedure,
    'public.worker_invalidate_account_usage(uuid,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(target) into def;
    old_check:='p_account_slot not in (1,2,3)';
    new_check:='p_account_slot not in (1,2,3,4,5)';
    if position(old_check in def)=0 or position(old_check in substring(def from position(old_check in def)+length(old_check)))>0 then
      raise exception 'apify_five_account_bounds_contract_drift: %',target;
    end if;
    execute replace(def,old_check,new_check);
  end loop;

  select pg_get_functiondef('apify_accounts_private.provision_slots()'::regprocedure) into def;
  old_check:='values(new.owner_user_id,1,true),(new.owner_user_id,2,false),(new.owner_user_id,3,false);';
  new_check:='values(new.owner_user_id,1,true),(new.owner_user_id,2,false),(new.owner_user_id,3,false),(new.owner_user_id,4,false),(new.owner_user_id,5,false);';
  if position(old_check in def)=0 or position(old_check in substring(def from position(old_check in def)+length(old_check)))>0 then
    raise exception 'apify_five_account_provision_contract_drift';
  end if;
  execute replace(def,old_check,new_check);
end $$;

comment on table public.apify_accounts is 'Fixed owner-authorized slots 1/2/3/4/5, authoritative usage metadata only; never stores tokens or secret references.';
