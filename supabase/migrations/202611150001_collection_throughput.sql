-- Forward-only, local throughput controls. No schedules, networking, credentials,
-- monetary ceiling changes, or historical reservation releases.
set constraints all immediate;
create table public.collection_worker_settings (
  owner_user_id uuid primary key references public.app_settings(owner_user_id) on delete restrict,
  max_active integer not null default 2 check(max_active between 1 and 4),
  max_starts_per_wake integer not null default 2 check(max_starts_per_wake between 1 and 4),
  last_category text check(last_category in ('profile','reels','carousels')),
  wake_revision bigint not null default 0,
  drained_revision bigint not null default 0 check(drained_revision>=0 and drained_revision<=wake_revision)
);
alter table public.collection_worker_settings enable row level security;
revoke all on public.collection_worker_settings from public,anon,authenticated,service_role;
grant select on public.collection_worker_settings to service_role;
insert into public.collection_worker_settings(owner_user_id) select owner_user_id from public.app_settings;
create schema collection_worker_private;
revoke all on schema collection_worker_private from public,anon,authenticated,service_role;
create function collection_worker_private.provision() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  insert into public.collection_worker_settings(owner_user_id) values(new.owner_user_id);
  return new;
end $$;
create trigger app_settings_collection_worker after insert on public.app_settings
for each row execute function collection_worker_private.provision();

alter table public.scrape_jobs
  add column collection_source text not null default 'legacy'
    check(collection_source in ('legacy','ordinary','carousel_pilot','target_media','operator_settle')),
  add column collection_completion_wake_recorded boolean not null default false,
  add column collection_billing_wake_recorded boolean not null default false;
-- Never guess whether a historical job was a trial. New claims prove provenance
-- transactionally; legacy paid attempts remain isolated until reviewed.
create function collection_worker_private.record_completion(p_owner uuid,p_job uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.scrape_jobs set collection_completion_wake_recorded=true,
      collection_billing_wake_recorded=actual_cost_usd is not null
    where id=p_job and owner_user_id=p_owner and collection_source='ordinary'
      and live and status in ('succeeded','partial','failed') and provider_terminal_status is not null
      and (not collection_completion_wake_recorded or actual_cost_usd is not null and not collection_billing_wake_recorded)
      and not exists(select 1 from public.transcription_media_refreshes m where m.job_id=p_job);
  if found then
    update public.collection_worker_settings set wake_revision=wake_revision+1 where owner_user_id=p_owner;
  end if;
  return exists(select 1 from public.collection_worker_settings c join public.scrape_jobs j on j.owner_user_id=c.owner_user_id
    where c.owner_user_id=p_owner and j.id=p_job and j.collection_source='ordinary'
      and j.collection_completion_wake_recorded and c.wake_revision>c.drained_revision);
end $$;
create function collection_worker_private.completion_trigger() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- Completion and late authoritative billing both produce the same coalesced
  -- durable wake, in the finishing transaction, not after a best-effort ACK.
  if new.collection_source='ordinary'
    and (not new.collection_completion_wake_recorded or new.actual_cost_usd is not null and not new.collection_billing_wake_recorded)
    and new.live and new.status in ('succeeded','partial','failed')
    and new.provider_terminal_status is not null then
    perform collection_worker_private.record_completion(new.owner_user_id,new.id);
  end if;
  return new;
end $$;
create trigger scrape_jobs_collection_completion after insert or update of status,actual_cost_usd,provider_terminal_status on public.scrape_jobs
for each row execute function collection_worker_private.completion_trigger();

create function public.worker_configure_collection_throughput(p_owner_user_id uuid,p_max_active integer,p_max_starts_per_wake integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  if p_owner_user_id is null or p_max_active is null or p_max_active not between 1 and 4
    or p_max_starts_per_wake is null or p_max_starts_per_wake not between 1 and 4 then
    raise exception 'invalid_collection_throughput' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.collection_worker_settings set max_active=p_max_active,max_starts_per_wake=p_max_starts_per_wake
    where owner_user_id=p_owner_user_id;
  if not found then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
  return jsonb_build_object('max_active',p_max_active,'max_starts_per_wake',p_max_starts_per_wake);
end $$;
create function public.worker_collection_runtime(p_owner_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  return (select to_jsonb(c)||jsonb_build_object('wake_pending',c.wake_revision>c.drained_revision,
    'eligible_kinds',array_remove(array[
      case when not s.paused then 'daily' end,case when not s.paused then 'weekly' end,
      case when s.initial_backfill_enabled then 'backfill' end,'profile','manual',
      case when not s.paused then 'retry' end,case when not s.paused then 'discovery' end,
      case when not s.paused then 'metrics' end,case when not s.paused then 'carousel' end],null))
    from public.collection_worker_settings c join public.app_settings s using(owner_user_id)
    where c.owner_user_id=p_owner_user_id);
end $$;
create function public.worker_record_completion_wake(p_owner_user_id uuid,p_job_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  return collection_worker_private.record_completion(p_owner_user_id,p_job_id);
end $$;
create function public.worker_drain_completion_wake(p_owner_user_id uuid,p_revision bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.collection_worker_settings set drained_revision=greatest(drained_revision,p_revision)
    where owner_user_id=p_owner_user_id and p_revision between 0 and wake_revision;
  if not found then raise exception 'invalid_completion_wake_revision' using errcode='22023'; end if;
end $$;
create function public.worker_isolate_collection_settlement(p_owner_user_id uuid,p_job_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  update public.scrape_jobs set collection_source='operator_settle'
    where id=p_job_id and owner_user_id=p_owner_user_id and collection_source in ('ordinary','legacy');
end $$;

-- Existing status retains its public shape and fail-closed 15-minute gate.
-- Capacity is not credit exhaustion. One outstanding paid job per account,
-- including uncertain acceptance; unknown cost remains an account blocker.
do $$ declare def text; old text; begin
  select pg_get_functiondef('apify_accounts_private.status(uuid)'::regprocedure) into def;
  old:='elsif a.limit_usd-a.usage_usd-unobserved-hold<=0 then';
  if position(old in def)=0 then raise exception 'collection_account_status_drift'; end if;
  execute replace(def,old,$patch$elsif exists(select 1 from public.scrape_jobs busy where busy.owner_user_id=p_owner and busy.live
      and busy.apify_account_slot=a.slot and busy.status in ('dispatching','running','processing','uncertain')) then reason:='account_capacity_full';
    elsif a.limit_usd-a.usage_usd-unobserved-hold<=0 then$patch$);
  select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into def;
  if position('active_count>=2' in def)=0 or position('least(2-active_count' in def)=0
    or position('registry:=apify_accounts_private.status' in def)=0 then raise exception 'collection_allocator_drift'; end if;
  def:=replace(def,'active_count>=2','active_count>=(select max_active from public.collection_worker_settings where owner_user_id=p_owner_user_id)');
  def:=replace(def,'least(2-active_count','least((select max_active from public.collection_worker_settings where owner_user_id=p_owner_user_id)-active_count');
  def:=replace(def,'elsif entry->>''reason''=''allowance_exhausted'' then',
    'elsif entry->>''reason''=''account_capacity_full'' then fallback_reason:=''account_capacity_full'';'||E'\n      elsif entry->>''reason''=''allowance_exhausted'' then');
  def:=replace(def,'update public.scrape_jobs set status=''dispatching'',live=p_live,reserved_usd=cap',
    'update public.scrape_jobs set collection_source=case when exists(select 1 from public.transcription_media_refreshes m where m.job_id=j.id) then ''target_media'' else ''ordinary'' end,status=''dispatching'',live=p_live,reserved_usd=cap');
  execute def;
  select pg_get_functiondef('public.get_creator_collection_state(uuid,uuid[])'::regprocedure) into def;
  if position('active_count>=2' in def)=0 then raise exception 'collection_state_capacity_drift'; end if;
  def:=replace(def,'active_count>=2','active_count>=(select max_active from public.collection_worker_settings where owner_user_id=owner_id)');
  old:='elsif exists(select 1 from jsonb_array_elements(apify_accounts_private.status(owner_id)->''accounts'') a';
  if position(old in def)=0 then raise exception 'collection_state_account_capacity_drift'; end if;
  execute replace(def,old,$patch$elsif exists(select 1 from jsonb_array_elements(apify_accounts_private.status(owner_id)->'accounts') a
      where a->>'reason'='account_capacity_full') then reason:='concurrency_limit';
    elsif exists(select 1 from jsonb_array_elements(apify_accounts_private.status(owner_id)->'accounts') a$patch$);
end $$;

-- The exact pilot wrapper marks provenance in the SAME transaction as its cap.
create or replace function public.worker_claim_carousel_pilot(p_owner_user_id uuid,p_job_id uuid,p_actor_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; j public.scrape_jobs;
begin
  perform public.require_service();
  result:=carousel_pilot_private.claim(p_owner_user_id,p_job_id,p_actor_id);
  if result ? 'job' then
    update public.scrape_jobs set collection_source='carousel_pilot' where id=p_job_id and owner_user_id=p_owner_user_id returning * into j;
    return result||jsonb_build_object('job',to_jsonb(j));
  end if;
  return result;
end $$;

create function public.worker_claim_next(p_owner_user_id uuid,p_live boolean,p_actor_ids jsonb,p_eligible_kinds text[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cfg public.collection_worker_settings; categories text[]:=array['profile','reels','carousels']; category text;
  offset_index integer; start_index integer; candidate_index integer; j public.scrape_jobs; attempted_ids uuid[]:='{}'; prior_target text;
  result jsonb; last_reason text:='no_pending_jobs'; automatic_allowed boolean;
begin
  perform public.require_service();
  if p_owner_user_id is null or p_live is null or jsonb_typeof(p_actor_ids) is distinct from 'object'
    or p_eligible_kinds is null or cardinality(p_eligible_kinds)>9
    or exists(select 1 from unnest(p_eligible_kinds) k where k is null or k not in ('daily','weekly','backfill','profile','manual','retry','discovery','metrics','carousel')
      or coalesce(p_actor_ids->>k,'') !~ '^[A-Za-z0-9_-]{1,128}$') then
    raise exception 'invalid_next_claim' using errcode='22023';
  end if;
  -- Preserve established lock order and wrappers: carousel005 -> media -> core.
  perform 1 from public.transcription_settings where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
  -- Owner advisory lock serializes fairness. Do not hold the wake row while
  -- acquiring a job: completion triggers acquire job then wake row.
  select * into cfg from public.collection_worker_settings where owner_user_id=p_owner_user_id;
  if not found then return jsonb_build_object('reason','owner_not_provisioned'); end if;
  prior_target:=coalesce(current_setting('reelradar.media_job_id',true),'');
  automatic_allowed:=exists(select 1 from public.carousel_automation_settings a join public.app_settings s using(owner_user_id)
    where a.owner_user_id=p_owner_user_id and a.enabled and a.provider_validated and s.scraping_enabled and not s.paused);
  start_index:=coalesce(array_position(categories,cfg.last_category),0);
  for offset_index in 1..3 loop
    category:=categories[1+((start_index+offset_index-1)%3)];
    -- Bound each category independently so a long invalid queue cannot consume
    -- the other categories' opportunity. A rejection skips one ID, never a kind.
    for candidate_index in 1..32 loop
      select q.* into j from public.scrape_jobs q
        where q.owner_user_id=p_owner_user_id and q.status in ('pending','budget_paused') and q.scheduled_for<=now()
          and q.kind=any(p_eligible_kinds) and not q.id=any(attempted_ids)
          -- Paid-start provenance is not a retry policy. Never replay a pinned
          -- account or any live prior-start evidence, even with settled billing.
          and q.apify_account_slot is null
          and not (q.live and (q.attempt_count>0 or q.started_at is not null or q.dispatch_nonce is not null
            or q.actor_run_id is not null or q.provider_terminal_status is not null))
          and (case when q.kind='profile' then 'profile' when q.kind='carousel' then 'carousels' else 'reels' end)=category
          and (prior_target='' or q.id=prior_target::uuid)
          and q.collection_source not in ('carousel_pilot','target_media','operator_settle')
          and not exists(select 1 from public.transcription_media_refreshes m where m.job_id=q.id)
          and (not p_live or q.kind not in ('profile','manual','carousel') or q.manual_authorized_by=p_owner_user_id)
          and (not q.carousel_automatic or automatic_allowed and q.attempt_count=0 and q.started_at is null and q.dispatch_nonce is null
            and q.actor_run_id is null and q.apify_account_slot is null and not q.live and q.processing_attempts=0
            and not exists(select 1 from public.scrape_job_creators target join public.scrape_job_creators other on other.creator_id=target.creator_id
              join public.scrape_jobs busy on busy.id=other.job_id where target.job_id=q.id and busy.id<>q.id and busy.owner_user_id=p_owner_user_id
              and busy.kind='carousel' and (busy.status in ('dispatching','running','processing','uncertain')
                or busy.processing_attempts>=10 and busy.status<>'succeeded'
                or busy.live and busy.actual_cost_usd is null and (busy.attempt_count>0 or busy.actor_run_id is not null or busy.provider_terminal_status is not null))))
        order by q.priority desc,q.scheduled_for,q.created_at,q.id for update of q skip locked limit 1;
      exit when not found;
      perform set_config('reelradar.media_job_id',j.id::text,true);
      result:=public.worker_claim_dispatch(p_owner_user_id,p_live,p_actor_ids->>j.kind,j.kind);
      perform set_config('reelradar.media_job_id',prior_target,true);
      if result ? 'job' then
        if (result->'job'->>'id')::uuid is distinct from j.id then raise exception 'dispatch_candidate_changed' using errcode='40001'; end if;
        update public.collection_worker_settings set last_category=category where owner_user_id=p_owner_user_id;
        return result;
      end if;
      last_reason:=coalesce(result->>'reason',last_reason);
      -- Existing-start candidates were filtered above, so these failures now
      -- describe owner/account-wide gates rather than one unsafe queue head.
      if last_reason in ('concurrency_limit','globalscraping_disabled','account_capacity_full','unreconciled_charges','live_setup_or_usage_unverified','budget_paused') then return result; end if;
      attempted_ids:=array_append(attempted_ids,j.id);
    end loop;
  end loop;
  return jsonb_build_object('reason',last_reason);
end $$;

revoke all on all functions in schema collection_worker_private from public,anon,authenticated,service_role;
revoke all on function public.worker_configure_collection_throughput(uuid,integer,integer),public.worker_collection_runtime(uuid),
  public.worker_claim_next(uuid,boolean,jsonb,text[]),public.worker_record_completion_wake(uuid,uuid),
  public.worker_drain_completion_wake(uuid,bigint),public.worker_isolate_collection_settlement(uuid,uuid),
  public.worker_claim_carousel_pilot(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.worker_configure_collection_throughput(uuid,integer,integer),public.worker_collection_runtime(uuid),
  public.worker_claim_next(uuid,boolean,jsonb,text[]),public.worker_record_completion_wake(uuid,uuid),
  public.worker_drain_completion_wake(uuid,bigint),public.worker_isolate_collection_settlement(uuid,uuid),
  public.worker_claim_carousel_pilot(uuid,uuid,text) to service_role;
