-- Incremental after 001/002 (also matches their equivalent hosted migration chunks).
-- No external requests, owner seeds, live switches or Cron installation.

alter table public.app_settings
 add column initial_backfill_limit integer not null default 100 check (initial_backfill_limit = 100),
 add column initial_backfill_enabled boolean not null default false,
  add column provider_usage_checked_at timestamptz,
 add column provider_cycle_start_at timestamptz,
 add column provider_cycle_end_at timestamptz,
 add column provider_cycle_usage_usd numeric(12,6) check (provider_cycle_usage_usd >= 0),
 add column provider_cycle_limit_usd numeric(12,6) check (provider_cycle_limit_usd >= 0),
 add constraint provider_usage_cycle_valid check (
  (provider_cycle_start_at is null and provider_cycle_end_at is null and provider_cycle_usage_usd is null and provider_cycle_limit_usd is null and provider_usage_checked_at is null)
  or (provider_cycle_start_at is not null and provider_cycle_end_at is not null and provider_cycle_start_at < provider_cycle_end_at
      and provider_cycle_usage_usd is not null and provider_cycle_limit_usd is not null and provider_usage_checked_at is not null));
comment on column public.app_settings.provider_cycle_limit_usd is
 'Authoritative account hard monthly usage limit, e.g. official limits.maxMonthlyUsageUsd; not plan credits, balance, remaining cash or an estimated budget.';
comment on column public.app_settings.scraping_enabled is 'Service-controlled global kill switch: false blocks every live dispatch regardless of job kind or manual authorization.';
comment on column public.app_settings.initial_backfill_enabled is 'Service-controlled permission to dispatch initial/backfill jobs. Enqueue is automatic even while dispatch is disabled.';
-- Official account APIs do not establish remaining balance. Retire cached legacy claims.
update public.app_settings set provider_balance_usd=null,provider_balance_checked_at=null;

create table public.budget_envelopes (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references public.app_settings(owner_user_id) on delete restrict,
 limit_usd numeric(12,6) not null check (limit_usd > 0 and limit_usd <= 4),
 active boolean not null default true,
 created_at timestamptz not null default now(), deactivated_at timestamptz,
 check ((active and deactivated_at is null) or (not active and deactivated_at is not null)),
 unique(id,owner_user_id)
);
create unique index budget_envelopes_one_active_owner_idx on public.budget_envelopes(owner_user_id) where active;
alter table public.scrape_jobs
 add column envelope_id uuid,
 add column manual_authorized_by uuid references auth.users(id) on delete restrict,
 add column priority integer not null default 0 check (priority between 0 and 100),
 add constraint jobs_envelope_owner_fk foreign key(envelope_id,owner_user_id) references public.budget_envelopes(id,owner_user_id) on delete restrict;
create index jobs_envelope_idx on public.scrape_jobs(envelope_id) where envelope_id is not null;
create index jobs_dispatch_priority_idx on public.scrape_jobs(owner_user_id,kind,priority desc,scheduled_for,created_at,id) where status in ('pending','budget_paused');
-- NOT VALID avoids rejecting old backfill jobs created under 002's 1..30 rule.
-- The new rule is enforced for every subsequent INSERT/UPDATE; those legacy jobs
-- cannot be dispatched as live initial-100 work without an explicit replacement.
alter table public.scrape_jobs drop constraint scrape_jobs_results_limit_check;
alter table public.scrape_jobs add constraint scrape_jobs_results_limit_check check (
 (kind='backfill' and results_limit=100 and requested_profiles_count=1)
 or (kind<>'backfill' and results_limit between 1 and 30)) not valid;

create table public.creator_initializations (
 creator_id uuid primary key references public.creators(id) on delete restrict,
 initial_job_id uuid not null unique references public.scrape_jobs(id) on delete restrict,
 job_id uuid not null unique references public.scrape_jobs(id) on delete restrict,
 results_limit integer not null default 100 check (results_limit=100),
 version integer not null default 1 check (version >= 1),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
comment on table public.creator_initializations is 'Persistent globally unique first-backfill identity. Linking/unlinking/shared workspaces never resets it; only an explicit reconciled service retry changes the current job link.';
alter table public.scrape_job_creators
 add column completion_status text not null default 'unknown' check (completion_status in ('unknown','completed','fewer_available','partial','failed')),
 add column summary_delivered_count integer check (summary_delivered_count >= 0),
 add column summary_authoritative boolean not null default false,
 add column summary_recorded_at timestamptz,
 add column received_count integer not null default 0 check (received_count>=0);
alter table public.scrape_jobs
 add column output_summary_verified boolean not null default false,
 add column output_summary_recorded_at timestamptz,
 add column output_summary_reason text check (char_length(output_summary_reason)<=500);

alter table public.budget_envelopes enable row level security;
alter table public.creator_initializations enable row level security;
create policy budget_envelope_owner_read on public.budget_envelopes for select to authenticated
 using (owner_user_id=auth.uid() and public.is_allowed_owner());
create policy creator_initialization_read on public.creator_initializations for select to authenticated
 using (public.can_read_creator(creator_id));
revoke all on public.budget_envelopes,public.creator_initializations from public,anon,authenticated,service_role;
grant select on public.budget_envelopes,public.creator_initializations to authenticated;
grant all on public.budget_envelopes,public.creator_initializations to service_role;

-- Every new job, including service/direct-SQL fixtures, joins its owner's active
-- envelope. The lock is identical to claim/reconciliation/configuration locks.
create function public.assign_job_budget_envelope() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare active_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('budget:'||new.owner_user_id::text,0));
 select id into active_id from public.budget_envelopes where owner_user_id=new.owner_user_id and active;
 if active_id is not null then
  if new.envelope_id is not null and new.envelope_id<>active_id then raise exception 'active_envelope_required' using errcode='22023'; end if;
  new.envelope_id:=active_id;
 elsif new.envelope_id is not null then
  raise exception 'inactive_envelope' using errcode='22023';
 end if;
 return new;
end; $$;
create trigger scrape_jobs_assign_envelope before insert on public.scrape_jobs for each row execute function public.assign_job_budget_envelope();

create function public.worker_configure_budget_envelope(p_owner_user_id uuid,p_limit_usd numeric) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare eid uuid; previous_limit numeric; committed numeric;
begin
 perform public.require_service();
 if p_limit_usd is null or not (p_limit_usd>0 and p_limit_usd<=4) then raise exception 'invalid_envelope_limit' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id) then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
 select id,limit_usd into eid,previous_limit from public.budget_envelopes where owner_user_id=p_owner_user_id and active for update;
 if eid is not null then
  if previous_limit is distinct from p_limit_usd then raise exception 'active_envelope_limit_immutable' using errcode='22023'; end if;
  return eid;
 end if;
 -- A fresh test boundary cannot exclude a run which was already accepted.
 if exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id and
  (reserved_usd>0 or live and (status in ('dispatching','running','processing','uncertain') or actual_cost_usd is null and status not in ('pending','budget_paused')))) then
  raise exception 'outstanding_jobs_before_envelope' using errcode='22023';
 end if;
 insert into public.budget_envelopes(owner_user_id,limit_usd) values(p_owner_user_id,p_limit_usd) returning id into eid;
 -- Also scope pre-existing, undispatched jobs: adding creators before configuring
 -- the acceptance envelope must not allow their pending initial jobs to bypass it.
 update public.scrape_jobs set envelope_id=eid where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and not live;
 return eid;
end; $$;
create function public.worker_deactivate_budget_envelope(p_owner_user_id uuid,p_envelope_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 if not exists(select 1 from public.budget_envelopes where id=p_envelope_id and owner_user_id=p_owner_user_id) then raise exception 'envelope_not_found' using errcode='42501'; end if;
 if exists(select 1 from public.scrape_jobs where envelope_id=p_envelope_id and
  (reserved_usd>0 or live and (status in ('dispatching','running','processing','uncertain') or actual_cost_usd is null and status not in ('pending','budget_paused')))) then
  raise exception 'envelope_unreconciled_jobs' using errcode='22023';
 end if;
 update public.budget_envelopes set active=false,deactivated_at=coalesce(deactivated_at,now()) where id=p_envelope_id and owner_user_id=p_owner_user_id;
 -- Old jobs retain their envelope forever. Only jobs created after deactivation
 -- are outside that test cap; the permanent monthly cap still applies.
end; $$;

create or replace function public.queue_creator_jobs(p_owner_user_id uuid,p_creator_ids uuid[],p_kind text) returns uuid[] language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids uuid[]; batch uuid[]; job uuid; jobs uuid[]:='{}'; lim integer; i integer; cid uuid; batch_size integer; day_ist date:=(now() at time zone 'Asia/Kolkata')::date; manual_uid uuid;
begin
 if p_kind is null or p_kind not in ('daily','weekly','backfill','profile','manual','retry') then raise exception 'invalid_job_kind' using errcode='22023'; end if;
 -- Common lock order: capacity -> queue -> budget. add/import already hold capacity.
 perform pg_advisory_xact_lock(hashtextextended('queue:'||p_owner_user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 select case when p_kind='backfill' then 100 when p_kind='weekly' then greatest(10,weekly_limit) when p_kind='profile' then 1 else greatest(10,daily_limit) end into lim
 from public.app_settings where owner_user_id=p_owner_user_id;
 if lim is null then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
 manual_uid:=case when auth.role()='authenticated' and auth.uid()=p_owner_user_id and p_kind in ('manual','profile','backfill') then auth.uid() else null end;
 select array_agg(c.id order by case when p_kind='profile' then c.last_profile_fetch_at else c.last_reels_fetch_at end nulls first,c.username) into ids
 from public.creators c where c.id=any(p_creator_ids)
 and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)
 and (p_kind in ('manual','backfill') or c.status not in ('private','unavailable','paused'))
 and (p_kind<>'backfill' or not exists(select 1 from public.creator_initializations ci where ci.creator_id=c.id))
 and not exists(select 1 from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id
  where jc.creator_id=c.id and j.owner_user_id=p_owner_user_id and
   ((j.status in ('pending','dispatching','running','processing','uncertain','budget_paused') and
      -- A manually authorized follower job can coexist with the pending Reels
      -- backfill; it still shares the same aggregate acceptance envelope.
      (p_kind<>'profile' or j.kind='profile' or j.status in ('dispatching','running','processing','uncertain')))
    or p_kind in ('daily','weekly','profile') and j.kind=p_kind and (j.scheduled_for at time zone 'Asia/Kolkata')::date=day_ist));
 if p_kind='retry' then
  select array_agg(cid2) into ids from unnest(ids) cid2 where
   not exists(select 1 from public.creator_retry_days d where d.owner_user_id=p_owner_user_id and d.creator_id=cid2 and d.retry_date=day_ist)
   and exists(select 1 from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id where jc.creator_id=cid2 and j.owner_user_id=p_owner_user_id and j.kind='daily' and jc.status='failed' and (j.scheduled_for at time zone 'Asia/Kolkata')::date=day_ist);
 end if;
 if ids is null then return jobs; end if;
 batch_size:=case when p_kind='backfill' then 1 else 20 end;
 for i in 1..cardinality(ids) by batch_size loop
  batch:=ids[i:least(i+batch_size-1,cardinality(ids))];
  insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,manual_authorized_by,priority)
  values(p_owner_user_id,p_kind,cardinality(batch),lim,case when p_kind='profile' then cardinality(batch)*0.00109 else cardinality(batch)*lim*0.00005 end,
   manual_uid,case when p_kind='backfill' then 100 when p_kind='manual' then 50 when p_kind='profile' then 40 else 0 end) returning id into job;
  insert into public.scrape_job_creators(job_id,creator_id) select job,unnest(batch);
  if p_kind='backfill' then
   insert into public.creator_initializations(creator_id,initial_job_id,job_id) values(batch[1],job,job);
  end if;
  if p_kind='retry' then insert into public.creator_retry_days(owner_user_id,creator_id,retry_date,job_id) select p_owner_user_id,unnest(batch),day_ist,job; end if;
  jobs:=array_append(jobs,job);
 end loop;
 return jobs;
end; $$;

create or replace function public.add_creator(p_workspace_id uuid,p_username text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.creators; n integer; cap integer; inserted boolean; un text; jobs uuid[]; init_job uuid; init_status text;
begin
 perform public.require_workspace(p_workspace_id);
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
 un:=public.normalize_username(p_username);
 -- Explicit inserted detection, not xmax and not a no-op canonical UPDATE.
 insert into public.creators(username) values(un) on conflict(username) do nothing returning * into c;
 inserted:=found;
 if not inserted then select * into c from public.creators where username=un; end if;
 if not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.owner_user_id=auth.uid() and w.archived_at is null) then
  select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=auth.uid();
  select capacity into cap from public.app_settings where owner_user_id=auth.uid();
  if n>=cap then raise exception 'capacity_exceeded' using errcode='P0001'; end if;
 end if;
 insert into public.workspace_creators(workspace_id,creator_id) values(p_workspace_id,c.id) on conflict(workspace_id,creator_id) do update set active=true;
 if inserted then jobs:=public.queue_creator_jobs(auth.uid(),array[c.id],'backfill'); end if;
 select ci.job_id,j.status into init_job,init_status from public.creator_initializations ci join public.scrape_jobs j on j.id=ci.job_id where ci.creator_id=c.id;
 return (to_jsonb(c)-'instagram_user_id'-'created_at')||jsonb_build_object('initial_backfill_job_id',case when inserted then init_job else null end,'initial_backfill_status',init_status);
end; $$;

create or replace function public.import_creators(p_workspace_id uuid,p_rows jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare row_data jsonb; wid uuid; un text; wn text; added integer:=0; duplicates integer:=0; created integer:=0; cjson jsonb; seen text[]:='{}'; key text; job_ids uuid[]:='{}'; jid uuid;
begin
 perform public.require_workspace(p_workspace_id);
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'invalid_import' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 for row_data in select value from jsonb_array_elements(p_rows) loop
  un:=public.normalize_username(row_data->>'username'); wn:=trim(coalesce(row_data->>'workspace','')); wid:=p_workspace_id;
  if wn<>'' then
   select id into wid from public.workspaces where owner_user_id=auth.uid() and lower(name)=lower(wn) and archived_at is null order by created_at limit 1;
   if wid is null then cjson:=public.create_workspace(wn,null); wid:=(cjson->>'id')::uuid; created:=created+1; end if;
  end if;
  key:=wid::text||':'||un;
  if key=any(seen) or exists(select 1 from public.workspace_creators wc join public.creators c on c.id=wc.creator_id where wc.workspace_id=wid and wc.active and c.username=un) then duplicates:=duplicates+1;
  else
   cjson:=public.add_creator(wid,un); added:=added+1;
   jid:=(cjson->>'initial_backfill_job_id')::uuid;
   if jid is not null and not jid=any(job_ids) then job_ids:=array_append(job_ids,jid); end if;
  end if;
  seen:=array_append(seen,key);
 end loop;
 return jsonb_build_object('added',added,'duplicates',duplicates,'workspaces_created',created,'job_ids',to_jsonb(job_ids));
end; $$;

create or replace function public.worker_schedule(p_owner_user_id uuid,p_kind text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids uuid[];
begin
 perform public.require_service();
 -- Follower/profile refresh is explicitly user-authorized only, never scheduled.
 if p_kind='profile' then return jsonb_build_object('job_ids','[]'::jsonb,'reason','profile_requires_manual_authorization'); end if;
 if p_kind is null or p_kind not in ('daily','weekly','retry') then raise exception 'invalid_schedule_kind' using errcode='22023'; end if;
 if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id and not paused) then return jsonb_build_object('job_ids','[]'::jsonb,'reason','paused'); end if;
 select array_agg(distinct wc.creator_id) into ids from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id;
 return jsonb_build_object('job_ids',public.queue_creator_jobs(p_owner_user_id,coalesce(ids,'{}'),p_kind));
end; $$;

create function public.worker_record_usage(p_owner_user_id uuid,p_provider_user_id text,p_cycle_start_at timestamptz,p_cycle_end_at timestamptz,p_usage_usd numeric,p_limit_usd numeric) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 if p_cycle_start_at is null or p_cycle_end_at is null or p_cycle_start_at>now() or p_cycle_end_at<=now() or p_cycle_start_at>=p_cycle_end_at
  or p_cycle_end_at-p_cycle_start_at>interval '62 days' or p_usage_usd is null or p_limit_usd is null
  or not (p_usage_usd between 0 and 999999 and p_limit_usd between 0 and 999999) then raise exception 'invalid_provider_usage' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 update public.app_settings set provider_usage_checked_at=now(),provider_cycle_start_at=p_cycle_start_at,provider_cycle_end_at=p_cycle_end_at,
  provider_cycle_usage_usd=p_usage_usd,provider_cycle_limit_usd=p_limit_usd,provider_balance_usd=null,provider_balance_checked_at=null,
  provider_account_id=coalesce(provider_account_id,p_provider_user_id)
 where owner_user_id=p_owner_user_id and (provider_account_id is null or provider_account_id=p_provider_user_id) and nullif(p_provider_user_id,'') is not null;
 if not found then raise exception 'provider_account_mismatch' using errcode='42501'; end if;
end; $$;

create or replace function public.worker_claim_dispatch(p_owner_user_id uuid,p_live boolean,p_actor_id text,p_kind text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; j public.scrape_jobs; month_start date:=date_trunc('month',now() at time zone 'UTC')::date; committed numeric; reserved numeric; cap numeric; cycle_unobserved numeric; envelope_committed numeric; envelope_limit numeric; active_envelope uuid;
begin
 perform public.require_service();
 if p_live is null or nullif(p_actor_id,'') is null or p_kind is null or p_kind not in ('daily','weekly','backfill','profile','manual','retry') then raise exception 'invalid_claim' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 select * into s from public.app_settings where owner_user_id=p_owner_user_id for update;
 if not found then return jsonb_build_object('reason','owner_not_provisioned'); end if;
 -- Dry service fixtures deliberately do not require verified external account
 -- metadata or live switches. They never receive a monetary reservation.
 if p_live and not s.scraping_enabled then return jsonb_build_object('reason','globalscraping_disabled'); end if;
 if p_live and p_kind='backfill' and not s.initial_backfill_enabled then return jsonb_build_object('reason','initial_backfill_disabled'); end if;
 if s.paused and p_kind in ('daily','weekly','retry') then return jsonb_build_object('reason','paused'); end if;
 if p_live and (s.provider_account_id is null or s.provider_usage_checked_at is null or s.provider_usage_checked_at<now()-interval '15 minutes'
  or s.provider_usage_checked_at>now()+interval '1 minute' or s.provider_cycle_start_at is null or s.provider_cycle_end_at is null
  or s.provider_cycle_start_at>now() or s.provider_cycle_end_at<=now() or s.provider_cycle_usage_usd is null or s.provider_cycle_limit_usd is null) then
  return jsonb_build_object('reason','live_setup_or_usage_unverified');
 end if;
 -- Unknown accepted starts and unknown final costs retain holds and block live
 -- starts, including across calendar-month/cycle transitions.
 if p_live and exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id and live and
  (status='uncertain' or status in ('succeeded','partial','failed') and actual_cost_usd is null or provider_terminal_status is not null and actual_cost_usd is null)) then return jsonb_build_object('reason','unreconciled_charges'); end if;
 if (select count(*) from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('dispatching','running','processing','uncertain'))>=2 then return jsonb_build_object('reason','concurrency_limit'); end if;
 select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()
  and (not p_live or kind not in ('profile','manual') or manual_authorized_by=p_owner_user_id)
 order by priority desc,scheduled_for,created_at,id for update skip locked limit 1;
 if not found then
  if p_live and p_kind in ('profile','manual') and exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id and kind=p_kind and status in ('pending','budget_paused') and manual_authorized_by is distinct from p_owner_user_id) then
   return jsonb_build_object('reason','manual_authorization_required');
  end if;
  return jsonb_build_object('reason','no_pending_jobs');
 end if;
 if p_live and (j.kind='backfill' and (j.results_limit<>100 or j.requested_profiles_count<>1) or j.kind<>'profile' and j.kind<>'backfill' and j.results_limit not between 10 and 30) then return jsonb_build_object('reason','provider_input_invalid'); end if;
 -- Retain creator links for persistent initial identity/audit. Do not delete
 -- detached/private entries and accidentally destroy a retry's linkage.
 if not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id
  and c.status not in ('private','unavailable','paused') and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)) then
  update public.scrape_jobs set status='failed',completed_at=now(),actual_cost_usd=0,billing_reconciled_at=now(),error_message='No eligible associated public creators' where id=j.id;
  return jsonb_build_object('reason','empty_job');
 end if;
 -- For routine batches, remove detached/ineligible links as in 002. Backfill
 -- jobs always preserve their one immutable creator association.
 if j.kind<>'backfill' then
  delete from public.scrape_job_creators jc where jc.job_id=j.id and not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id join public.creators c on c.id=wc.creator_id where wc.creator_id=jc.creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id and c.status not in ('private','unavailable','paused'));
 end if;
 select coalesce(sum(actual_cost_usd) filter(where live and billing_month=month_start),0),coalesce(sum(reserved_usd) filter(where live),0),
  coalesce(sum(actual_cost_usd) filter(where live and billing_reconciled_at>s.provider_usage_checked_at),0) into committed,reserved,cycle_unobserved from public.scrape_jobs where owner_user_id=p_owner_user_id;
 cap:=case when p_live then s.max_run_charge_usd else 0 end;
 select id into active_envelope from public.budget_envelopes where owner_user_id=p_owner_user_id and active;
 -- Claims scope a previously queued job too if an operator installed an envelope
 -- by approved direct SQL after queuing (the creation trigger covers all new jobs).
 if active_envelope is not null and j.envelope_id is distinct from active_envelope then
  if j.envelope_id is null then update public.scrape_jobs set envelope_id=active_envelope where id=j.id returning * into j;
  else return jsonb_build_object('reason','active_envelope_mismatch'); end if;
 end if;
 if j.envelope_id is not null then
  select e.limit_usd,coalesce((select sum(coalesce(j2.actual_cost_usd,0)+j2.reserved_usd) from public.scrape_jobs j2 where j2.envelope_id=e.id and j2.live),0) into envelope_limit,envelope_committed from public.budget_envelopes e where e.id=j.envelope_id and e.owner_user_id=p_owner_user_id;
 end if;
 if p_live and (committed+reserved+cap>least(s.monthly_budget_usd,4)
  or s.provider_cycle_usage_usd+cycle_unobserved+reserved+cap>s.provider_cycle_limit_usd
  or j.envelope_id is not null and envelope_committed+cap>envelope_limit) then
  update public.scrape_jobs set status='budget_paused',error_message='Monthly cap, verified provider cycle hard limit, or aggregate test envelope insufficient' where id=j.id;
  return jsonb_build_object('reason','budget_paused');
 end if;
 update public.scrape_jobs set status='dispatching',live=p_live,reserved_usd=cap,billing_month=month_start,dispatch_nonce=gen_random_uuid(),
  expected_actor_id=p_actor_id,expected_provider_user_id=case when p_live then s.provider_account_id else 'mock' end,
  lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',started_at=now(),attempt_count=attempt_count+1,
  requested_profiles_count=(select count(*) from public.scrape_job_creators where job_id=j.id),error_message=null where id=j.id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'creators',(select jsonb_agg(jsonb_build_object('id',c.id,'username',c.username) order by c.username) from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id),'max_total_charge_usd',cap);
end; $$;

-- Explicit service retry: never implicit on relink/import/manual backfill.
-- The first job remains referenced permanently; current job/version advance only
-- after a terminal reconciled attempt, with the initial 100/one-creator contract.
create function public.worker_retry_initial_backfill(p_owner_user_id uuid,p_creator_id uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare ci public.creator_initializations; prior public.scrape_jobs; jid uuid;
begin
 perform public.require_service();
 perform pg_advisory_xact_lock(hashtextextended('queue:'||p_owner_user_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 select * into ci from public.creator_initializations where creator_id=p_creator_id for update;
 if not found then raise exception 'initialization_not_found' using errcode='22023'; end if;
 select * into prior from public.scrape_jobs where id=ci.job_id for update;
 if prior.owner_user_id<>p_owner_user_id or not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=p_creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id) then raise exception 'forbidden' using errcode='42501'; end if;
 if prior.status not in ('partial','failed') or prior.reserved_usd<>0 or prior.live and (prior.actual_cost_usd is null or prior.billing_reconciled_at is null) then raise exception 'initialization_not_retryable' using errcode='22023'; end if;
 if exists(select 1 from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id where jc.creator_id=p_creator_id and j.status in ('pending','budget_paused','dispatching','running','processing','uncertain')) then raise exception 'creator_busy' using errcode='22023'; end if;
 insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,priority) values(p_owner_user_id,'backfill',1,100,0.005,100) returning id into jid;
 insert into public.scrape_job_creators(job_id,creator_id) values(jid,p_creator_id);
 update public.creator_initializations set job_id=jid,version=version+1,updated_at=now() where creator_id=p_creator_id;
 return jid;
end; $$;

create function public.worker_record_output_summary(p_job_id uuid,p_lease_token uuid,p_summary jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; u jsonb; cid uuid; seen uuid[]:='{}'; declared_count integer; sum_count bigint:=0; expected_users integer; verified boolean; reason text;
begin
 perform public.require_service();
 select * into j from public.scrape_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() or not j.dataset_finished then raise exception 'not_finished_or_lease_expired' using errcode='40001'; end if;
 if p_summary is null or jsonb_typeof(p_summary)<>'object' or jsonb_typeof(p_summary->'users') is distinct from 'array'
  or jsonb_typeof(p_summary->'ok') is distinct from 'boolean' or jsonb_typeof(p_summary->'complete') is distinct from 'boolean'
  or jsonb_array_length(p_summary->'users')>20 then raise exception 'invalid_output_summary' using errcode='22023'; end if;
 verified:=(p_summary->>'ok')::boolean and (p_summary->>'complete')::boolean;
 reason:=left(nullif(p_summary->>'reason',''),500);
 if p_summary->>'total_items' is null then verified:=false;
 elsif jsonb_typeof(p_summary->'total_items')<>'number' or p_summary->>'total_items' !~ '^\d+$' or (p_summary->>'total_items')::numeric>2147483647 then raise exception 'invalid_output_summary' using errcode='22023';
 elsif (p_summary->>'total_items')::integer<>j.dataset_cursor then verified:=false; end if;
 select count(*) into expected_users from public.scrape_job_creators where job_id=j.id;
 if jsonb_array_length(p_summary->'users')<>expected_users then verified:=false; end if;
 for u in select value from jsonb_array_elements(p_summary->'users') loop
  if jsonb_typeof(u)<>'object' or u->>'creator_id' is null or u->>'username' is null then raise exception 'invalid_output_summary' using errcode='22023'; end if;
  cid:=(u->>'creator_id')::uuid;
  if cid=any(seen) or not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id and jc.creator_id=cid and c.username=u->>'username') then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  seen:=array_append(seen,cid); declared_count:=null;
  if u->>'count' is not null then
   if jsonb_typeof(u->'count')<>'number' or u->>'count' !~ '^\d+$' or (u->>'count')::numeric>2147483647 then raise exception 'invalid_output_summary' using errcode='22023'; end if;
   declared_count:=(u->>'count')::integer; sum_count:=sum_count+declared_count;
  end if;
  if declared_count is null or not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=cid and received_count=declared_count) then verified:=false; end if;
 end loop;
 if sum_count<>j.dataset_cursor then verified:=false; end if;
 if not verified then reason:=coalesce(reason,'OUTPUT missing, incomplete or inconsistent with identity-scoped received dataset counts'); end if;
 update public.scrape_job_creators set completion_status='unknown',summary_authoritative=false,summary_delivered_count=null,summary_recorded_at=now() where job_id=j.id;
 for u in select value from jsonb_array_elements(p_summary->'users') loop
  cid:=(u->>'creator_id')::uuid; declared_count:=(u->>'count')::integer;
  update public.scrape_job_creators set summary_authoritative=verified,summary_delivered_count=declared_count,summary_recorded_at=now(),
   completion_status=case
    when nullif(u->>'error','') is not null then case when result_count>0 then 'partial' else 'failed' end
    when not verified then 'unknown'
    when error_message is not null or result_count<>received_count then case when result_count>0 then 'partial' else 'failed' end
    when result_count>=j.results_limit then 'completed'
    when j.kind='backfill' and coalesce((u->>'exhausted')::boolean,false) then 'fewer_available'
    when j.kind='backfill' then 'partial'
    else 'completed' end,
   error_message=case when nullif(u->>'error','') is not null then left(u->>'error',500) else error_message end
  where job_id=j.id and creator_id=cid;
 end loop;
 update public.scrape_jobs set output_summary_verified=verified,output_summary_recorded_at=now(),output_summary_reason=reason where id=j.id;
end; $$;

-- Replace the old seven-argument overload; default keeps old SQL callers working.
drop function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean);
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs; rec jsonb; er jsonb; cid uuid; rid uuid; old_creator uuid; fetched timestamptz; fs public.creator_follower_snapshots; accepted integer:=0; counts jsonb; kv record; received integer:=0;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'lease_expired' using errcode='40001'; end if;
 if j.dataset_cursor<>p_expected_cursor or j.dataset_finished then return jsonb_build_object('cursor',j.dataset_cursor,'duplicate',true); end if;
 if p_records is null or p_errors is null or p_expected_cursor is null or p_next_cursor is null or jsonb_typeof(p_records)<>'array' or jsonb_typeof(p_errors)<>'array' or jsonb_array_length(p_records)>100 or jsonb_array_length(p_errors)>100 or p_next_cursor<p_expected_cursor or p_next_cursor>p_expected_cursor+100 or p_finished is null or p_next_cursor=p_expected_cursor and (not p_finished or jsonb_array_length(p_records)>0 or jsonb_array_length(p_errors)>0) then raise exception 'invalid_page' using errcode='22023'; end if;
 if p_received_counts is not null and jsonb_typeof(p_received_counts)<>'object' then raise exception 'invalid_received_counts' using errcode='22023'; end if;
 counts:=coalesce(p_received_counts,'{}'::jsonb);
 -- Legacy seven-argument calls infer normalized record/error rows. Live workers
 -- pass explicit raw per-creator counts, including billed error rows.
 if p_received_counts is null then
  select coalesce(jsonb_object_agg(x.creator_id,x.n),'{}'::jsonb) into counts from (
   select value->>'creator_id' creator_id,count(*) n from (
    select value from jsonb_array_elements(p_records) union all select value from jsonb_array_elements(p_errors)
   ) raw_rows group by value->>'creator_id'
  ) x;
 end if;
 for kv in select key,value from jsonb_each(counts) loop
  if kv.key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   or jsonb_typeof(kv.value)<>'number' or kv.value::text !~ '^\d+$' or (kv.value::text)::numeric>100 then raise exception 'invalid_received_counts' using errcode='22023'; end if;
  if not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=kv.key::uuid) then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  received:=received+(kv.value::text)::integer;
 end loop;
 if received>p_next_cursor-p_expected_cursor then raise exception 'invalid_received_counts' using errcode='22023'; end if;
 for rec in select value from jsonb_array_elements(p_records) loop
  cid:=(rec->>'creator_id')::uuid;
  if not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id and jc.creator_id=cid and c.username=rec->>'username') then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  fetched:=(rec->>'fetched_at')::timestamptz;
  if fetched is null or fetched>now()+interval '5 minutes' then raise exception 'invalid_fetch_timestamp' using errcode='22023'; end if;
  if j.kind='profile' then
   if rec->>'followers_count' is null then
    update public.scrape_job_creators set status='failed',error_message='Follower metric unavailable' where job_id=j.id and creator_id=cid; continue;
   end if;
   insert into public.creator_follower_snapshots(creator_id,captured_date,followers_count,source,captured_at) values(cid,(fetched at time zone 'UTC')::date,(rec->>'followers_count')::bigint,rec->>'provider',fetched)
   on conflict(creator_id,captured_date) do update set followers_count=excluded.followers_count,source=excluded.source,captured_at=excluded.captured_at where public.creator_follower_snapshots.captured_at<=excluded.captured_at;
   update public.creators set followers_count=(rec->>'followers_count')::bigint,last_profile_fetch_at=fetched,display_name=coalesce(rec->>'display_name',display_name),avatar_url=coalesce(rec->>'avatar_url',avatar_url)
   where id=cid and (last_profile_fetch_at is null or last_profile_fetch_at<=fetched);
  else
   if rec->>'instagram_media_id' is not null and rec->>'instagram_media_id' !~ '^\d{1,40}(_\d{1,40})?$' then raise exception 'invalid_media_id' using errcode='22023'; end if;
   select creator_id into old_creator from public.reels where shortcode=rec->>'shortcode';
   if old_creator is not null and old_creator<>cid then raise exception 'shortcode_creator_mismatch' using errcode='42501'; end if;
   select * into fs from public.creator_follower_snapshots where creator_id=cid and captured_at<=fetched and followers_count>0 order by captured_at desc limit 1;
   insert into public.reels(creator_id,instagram_media_id,shortcode,reel_url,thumbnail_url,caption_preview,published_at,duration_seconds,latest_views,latest_likes,latest_comments,views_state,likes_state,comments_state,latest_fetched_at,provider)
   values(cid,rec->>'instagram_media_id',rec->>'shortcode',rec->>'reel_url',rec->>'thumbnail_url',coalesce(rec->>'caption_preview',''),(rec->>'published_at')::timestamptz,(rec->>'duration_seconds')::numeric,(rec->>'views')::bigint,(rec->>'likes')::bigint,(rec->>'comments')::bigint,rec->>'views_state',rec->>'likes_state',rec->>'comments_state',fetched,rec->>'provider')
   on conflict(shortcode) do update set instagram_media_id=coalesce(public.reels.instagram_media_id,excluded.instagram_media_id),reel_url=excluded.reel_url,thumbnail_url=excluded.thumbnail_url,caption_preview=excluded.caption_preview,duration_seconds=excluded.duration_seconds,
   latest_views=excluded.latest_views,latest_likes=excluded.latest_likes,latest_comments=excluded.latest_comments,views_state=excluded.views_state,likes_state=excluded.likes_state,comments_state=excluded.comments_state,latest_fetched_at=excluded.latest_fetched_at,provider=excluded.provider
   where public.reels.creator_id=excluded.creator_id and public.reels.latest_fetched_at<=excluded.latest_fetched_at returning id into rid;
   if rid is null then select id into rid from public.reels where shortcode=rec->>'shortcode' and creator_id=cid; end if;
   insert into public.reel_metric_snapshots(reel_id,snapshot_date,views,likes,comments,views_state,likes_state,comments_state,followers_at_snapshot,follower_captured_at,fetched_at,provider)
   values(rid,(fetched at time zone 'UTC')::date,(rec->>'views')::bigint,(rec->>'likes')::bigint,(rec->>'comments')::bigint,rec->>'views_state',rec->>'likes_state',rec->>'comments_state',fs.followers_count,fs.captured_at,fetched,rec->>'provider')
   on conflict(reel_id,snapshot_date) do update set views=excluded.views,likes=excluded.likes,comments=excluded.comments,views_state=excluded.views_state,likes_state=excluded.likes_state,comments_state=excluded.comments_state,followers_at_snapshot=excluded.followers_at_snapshot,follower_captured_at=excluded.follower_captured_at,fetched_at=excluded.fetched_at,provider=excluded.provider
   where public.reel_metric_snapshots.fetched_at<=excluded.fetched_at;
  end if;
  update public.scrape_job_creators set status='active',result_count=result_count+1 where job_id=j.id and creator_id=cid;
  accepted:=accepted+1;
 end loop;
 for er in select value from jsonb_array_elements(p_errors) loop
  cid:=(er->>'creator_id')::uuid;
  if not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=cid) then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  update public.scrape_job_creators set status=case when result_count>0 then 'active' else coalesce(er->>'status','failed') end,error_message=left(coalesce(er->>'message','Invalid provider result'),500) where job_id=j.id and creator_id=cid;
 end loop;
 for kv in select key,value from jsonb_each(counts) loop
  update public.scrape_job_creators set received_count=received_count+(kv.value::text)::integer where job_id=j.id and creator_id=kv.key::uuid;
 end loop;
 update public.scrape_jobs set dataset_cursor=p_next_cursor,dataset_finished=p_finished,returned_records_count=returned_records_count+accepted,lease_expires_at=now()+interval '3 minutes' where id=j.id;
 return jsonb_build_object('cursor',p_next_cursor,'accepted',accepted,'duplicate',false);
end; $$;

create or replace function public.worker_finish_processing(p_job_id uuid,p_lease_token uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; ok integer; errors integer;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
 if j.status in ('succeeded','partial','failed') then return to_jsonb(j); end if;
 if j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() or not j.dataset_finished then raise exception 'not_finished_or_lease_expired' using errcode='40001'; end if;
 update public.scrape_job_creators set status=case when status in ('private','unavailable','failed') then status else 'failed' end,completion_status='failed',error_message=coalesce(error_message,'No valid records returned; profile privacy cannot be inferred') where job_id=j.id and result_count=0;
 select count(*) filter(where result_count>0),count(*) filter(where status<>'active' or error_message is not null or completion_status not in ('completed','fewer_available')) into ok,errors from public.scrape_job_creators where job_id=j.id;
 update public.creators c set status=case when jc.result_count>0 then 'active' else jc.status end,last_error=coalesce(jc.error_message,case when jc.completion_status='unknown' then 'Provider OUTPUT completion could not be verified; valid records preserved' end),
 last_reels_fetch_at=case when j.kind<>'profile' and jc.result_count>0 then greatest(c.last_reels_fetch_at,j.result_fetched_at) else c.last_reels_fetch_at end
 from public.scrape_job_creators jc where jc.job_id=j.id and jc.creator_id=c.id;
 update public.scrape_jobs set status=case when ok=0 then 'failed' when errors>0 or not output_summary_verified or provider_terminal_status<>'SUCCEEDED' then 'partial' else 'succeeded' end,completed_at=now(),lease_token=null,lease_expires_at=null,
 error_message=case when ok=0 then 'No valid profile results' when not output_summary_verified then coalesce(output_summary_reason,'Provider OUTPUT completion unverified; partial records preserved') when errors>0 then 'Some profiles or records failed' when provider_terminal_status<>'SUCCEEDED' then 'Provider ended unsuccessfully; partial records preserved' else null end
 where id=j.id returning * into j;
 return to_jsonb(j);
end; $$;

create or replace function public.list_creators(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_workspace(p_workspace_id);
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.username) from (
 select c.id,c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at,c.status,c.last_reels_fetch_at,c.last_error,
 (select count(*) from public.reels r where r.creator_id=c.id) tracked_reels,(select max(r.published_at) from public.reels r where r.creator_id=c.id) latest_reel_date,
 ci.job_id initial_backfill_job_id,j.status initial_backfill_status
 from public.creators c join public.workspace_creators wc on wc.creator_id=c.id left join public.creator_initializations ci on ci.creator_id=c.id left join public.scrape_jobs j on j.id=ci.job_id
 where wc.workspace_id=p_workspace_id and wc.active) x),'[]'::jsonb);
end; $$;

create or replace function public.update_settings(p_settings jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; n integer;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 if p_settings is null or jsonb_typeof(p_settings)<>'object' or exists(select 1 from jsonb_object_keys(p_settings) k where k not in ('daily_limit','weekly_limit','monthly_budget_usd','budget_warning_pct','paused','capacity')) then raise exception 'invalid_settings' using errcode='22023'; end if;
 if p_settings ? 'daily_limit' and (p_settings->>'daily_limit')::integer not between 10 and 30 or p_settings ? 'weekly_limit' and (p_settings->>'weekly_limit')::integer not between 10 and 30 or p_settings ? 'monthly_budget_usd' and (p_settings->>'monthly_budget_usd')::numeric not between 0 and 4 then raise exception 'invalid_settings' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0)); perform pg_advisory_xact_lock(hashtextextended('budget:'||auth.uid()::text,0));
 select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=auth.uid();
 if coalesce((p_settings->>'capacity')::integer,1000)<n then raise exception 'capacity_below_current' using errcode='22023'; end if;
 update public.app_settings set daily_limit=coalesce((p_settings->>'daily_limit')::integer,daily_limit),weekly_limit=coalesce((p_settings->>'weekly_limit')::integer,weekly_limit),monthly_budget_usd=coalesce((p_settings->>'monthly_budget_usd')::numeric,monthly_budget_usd),budget_warning_pct=coalesce((p_settings->>'budget_warning_pct')::integer,budget_warning_pct),paused=coalesce((p_settings->>'paused')::boolean,paused),capacity=coalesce((p_settings->>'capacity')::integer,capacity) where owner_user_id=auth.uid() returning * into s;
 return jsonb_build_object('daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,'budget_warning_pct',s.budget_warning_pct,'paused',s.paused,'timezone',s.timezone,'capacity',s.capacity,'scraping_enabled',s.scraping_enabled,'initial_backfill_limit',s.initial_backfill_limit,'initial_backfill_enabled',s.initial_backfill_enabled);
end; $$;

create or replace function public.get_bootstrap() returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; usage jsonb; month_start date:=(date_trunc('month',now() at time zone 'UTC'))::date; actual numeric; reserved numeric; unknown integer; estimate numeric;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into s from public.app_settings where owner_user_id=auth.uid();
 select coalesce(sum(estimated_cost_usd) filter(where (scheduled_for at time zone 'UTC')::date>=month_start),0),coalesce(sum(actual_cost_usd) filter(where live and billing_month=month_start),0),coalesce(sum(reserved_usd) filter(where live),0),count(*) filter(where live and actual_cost_usd is null and status not in ('pending','budget_paused')) into estimate,actual,reserved,unknown from public.scrape_jobs where owner_user_id=auth.uid();
 usage:=jsonb_build_object('estimated_month_spend',estimate,'actual_month_spend',case when unknown>0 then null else actual end,'reserved_usd',reserved,'unreconciled_jobs',unknown,'remaining_allowance',greatest(0,least(s.monthly_budget_usd,4)-actual-reserved),'provider_balance_usd',null,
 'provider_usage_usd',case when s.provider_usage_checked_at>now()-interval '15 minutes' then s.provider_cycle_usage_usd end,'provider_limit_usd',case when s.provider_usage_checked_at>now()-interval '15 minutes' then s.provider_cycle_limit_usd end,'provider_cycle_start_at',s.provider_cycle_start_at,'provider_cycle_end_at',s.provider_cycle_end_at,'provider_usage_checked_at',s.provider_usage_checked_at);
 return jsonb_build_object('mode','supabase','workspaces',coalesce((select jsonb_agg(to_jsonb(w)-'owner_user_id' order by created_at) from public.workspaces w where public.is_workspace_member(w.id)),'[]'::jsonb),
 'settings',jsonb_build_object('daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,'budget_warning_pct',s.budget_warning_pct,'paused',s.paused,'timezone',s.timezone,'capacity',s.capacity,'scraping_enabled',s.scraping_enabled,'initial_backfill_limit',s.initial_backfill_limit,'initial_backfill_enabled',s.initial_backfill_enabled),
 'usage',usage,'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by scheduled_for desc) from (select id,kind,status,scheduled_for,started_at,completed_at,actor_run_id,requested_profiles_count,results_limit,returned_records_count,estimated_cost_usd,actual_cost_usd,error_message,attempt_count from public.scrape_jobs where owner_user_id=auth.uid() order by scheduled_for desc limit 50) j),'[]'::jsonb),'email',coalesce(auth.jwt()->>'email',''));
end; $$;

revoke execute on function public.assign_job_budget_envelope(),public.worker_configure_budget_envelope(uuid,numeric),public.worker_deactivate_budget_envelope(uuid,uuid),public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric),public.worker_retry_initial_backfill(uuid,uuid),public.worker_record_output_summary(uuid,uuid,jsonb),public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.worker_configure_budget_envelope(uuid,numeric),public.worker_deactivate_budget_envelope(uuid,uuid),public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric),public.worker_retry_initial_backfill(uuid,uuid),public.worker_record_output_summary(uuid,uuid,jsonb),public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) to service_role;
-- Preserve existing explicit role boundaries for replaced functions.
revoke execute on function public.queue_creator_jobs(uuid,uuid[],text),public.worker_schedule(uuid,text),public.worker_claim_dispatch(uuid,boolean,text,text),public.worker_finish_processing(uuid,uuid),public.add_creator(uuid,text),public.import_creators(uuid,jsonb),public.list_creators(uuid),public.update_settings(jsonb),public.get_bootstrap() from public,anon,authenticated,service_role;
grant execute on function public.queue_creator_jobs(uuid,uuid[],text),public.worker_schedule(uuid,text),public.worker_claim_dispatch(uuid,boolean,text,text),public.worker_finish_processing(uuid,uuid) to service_role;
grant execute on function public.add_creator(uuid,text),public.import_creators(uuid,jsonb),public.list_creators(uuid),public.update_settings(jsonb),public.get_bootstrap() to authenticated;
