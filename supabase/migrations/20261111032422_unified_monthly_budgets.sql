-- Only the two owner-editable monthly budgets govern application spending.
-- No settings amounts, processing switches, schedules or provider calls change.
-- Legacy envelope/job links and every outstanding reservation remain auditable.
do $$ declare core text; begin
 select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into core;
 if core not like '%when p_live and j.kind=''profile'' then least(.025,s.max_run_charge_usd)%'
 or core not like '%committed+reserved+cap>s.monthly_budget_usd%'
 or core not like '%envelope_committed+cap>envelope_limit%'
 or core not like '%reelradar.media_job_id%'
 or core not like '%manual_authorized_by=p_owner_user_id%'
 or core not like '%SET search_path TO ''pg_catalog'', ''public''%' then
   raise exception 'monthly_budget_dispatch_contract_drift';
 end if;
end $$;

drop trigger scrape_jobs_assign_envelope on public.scrape_jobs;
update public.budget_envelopes set active=false,deactivated_at=coalesce(deactivated_at,now()) where active;
comment on column public.app_settings.max_run_charge_usd is 'Legacy value; dispatch derives provider caps from the monthly collection budget.';
comment on column public.transcription_settings.pilot_limit_usd is 'Legacy pilot amount; only monthly_budget_usd limits transcription spending.';

create or replace function public.worker_configure_budget_envelope(p_owner_user_id uuid,p_limit_usd numeric)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 raise exception 'use_monthly_collection_budget' using errcode='22023';
end $$;

-- Media is charged once in scrape_jobs, against collection. The old media
-- ledger stays available for audit/settlement but creates no duplicate hold.
alter table public.transcription_media_refreshes alter column reserved_usd set default 0;

create or replace function public.transcription_combined_budget(p_add numeric) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select p_add is not null and p_add>=0 and
 coalesce((select coalesce(sum(accounted_usd) filter(where billing_month=date_trunc('month',now() at time zone 'UTC')::date),0)
 +coalesce(sum(reserved_usd),0) from public.transcript_attempts),0)+p_add<=s.monthly_budget_usd
 from public.transcription_settings s where singleton;
$$;

CREATE OR REPLACE FUNCTION public.transcription_claim_dispatch_core(p_owner_user_id uuid, p_live boolean, p_actor_id text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare s public.app_settings; j public.scrape_jobs; month_start date:=date_trunc('month',now() at time zone 'UTC')::date; committed numeric; reserved numeric; cap numeric; cycle_unobserved numeric; headroom numeric; slots integer;
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
 and (nullif(current_setting('reelradar.media_job_id',true),'') is null or id=nullif(current_setting('reelradar.media_job_id',true),'')::uuid)
 order by priority desc,scheduled_for,created_at,id for update skip locked limit 1;
 if not found then
  if p_live and p_kind in ('profile','manual') and exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id and kind=p_kind and status in ('pending','budget_paused') and manual_authorized_by is distinct from p_owner_user_id) then
   return jsonb_build_object('reason','manual_authorization_required');
  end if;
  return jsonb_build_object('reason','no_pending_jobs');
 end if;
 if p_live and (j.kind='backfill' and (j.results_limit<>100 or j.requested_profiles_count<>1) or j.kind<>'profile' and j.kind<>'backfill' and j.results_limit not between 10 and 30 and not (j.kind='manual' and j.results_limit=100 and j.requested_profiles_count=1 and exists(select 1 from public.transcription_media_refreshes m where m.job_id=j.id and m.owner_user_id=p_owner_user_id and m.status='active'))) then return jsonb_build_object('reason','provider_input_invalid'); end if;
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
 -- Each provider run reserves a share of the remaining monthly collection
 -- allowance. All Apify work, including media recovery, uses this one ledger.
 -- The provider-enforced cap equals the reservation; no fixed per-kind ceiling.
 headroom:=greatest(0,least(s.monthly_budget_usd-committed-reserved,
   s.provider_cycle_limit_usd-s.provider_cycle_usage_usd-cycle_unobserved-reserved));
 select greatest(1,least(
   2-(select count(*) from public.scrape_jobs where owner_user_id=p_owner_user_id
     and status in ('dispatching','running','processing','uncertain')),
   (select count(*) from public.scrape_jobs where owner_user_id=p_owner_user_id
     and status in ('pending','budget_paused') and scheduled_for<=now()
     and (kind not in ('profile','manual') or manual_authorized_by=p_owner_user_id)))) into slots;
 cap:=case when p_live then trunc(headroom/slots,6) else 0 end;
 if p_live and cap=0 and headroom>=.000001 then cap:=.000001; end if;
 if p_live and cap<=0 then
   update public.scrape_jobs set status='budget_paused',error_message='Monthly collection budget or verified provider account allowance exhausted.' where id=j.id;
   return jsonb_build_object('reason','budget_paused');
 end if;
 update public.scrape_jobs set status='dispatching',live=p_live,reserved_usd=cap,billing_month=month_start,dispatch_nonce=gen_random_uuid(),
  expected_actor_id=p_actor_id,expected_provider_user_id=case when p_live then s.provider_account_id else 'mock' end,
  lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',started_at=now(),attempt_count=attempt_count+1,
  requested_profiles_count=(select count(*) from public.scrape_job_creators where job_id=j.id),error_message=null where id=j.id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'creators',(select jsonb_agg(jsonb_build_object('id',c.id,'username',c.username) order by c.username) from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id),'max_total_charge_usd',cap);
end; $function$;

CREATE OR REPLACE FUNCTION public.worker_claim_dispatch(p_owner_user_id uuid, p_live boolean, p_actor_id text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare j public.scrape_jobs; m public.transcription_media_refreshes; result jsonb; reason text;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
 select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()
 and (not p_live or kind not in ('profile','manual') or manual_authorized_by=p_owner_user_id)
 and (nullif(current_setting('reelradar.media_job_id',true),'') is null or id=nullif(current_setting('reelradar.media_job_id',true),'')::uuid)
 order by priority desc,scheduled_for,created_at,id for update skip locked limit 1;
 if j.kind='manual' and j.results_limit=100 then
  select * into m from public.transcription_media_refreshes where job_id=j.id and owner_user_id=p_owner_user_id and status='active';
  if m.id is null then return jsonb_build_object('reason','media_job_link_required'); end if;
  if not p_live then return jsonb_build_object('reason','media_requires_live_policy'); end if;
  reason:=public.transcription_paid_gate();
  if reason is not null then return jsonb_build_object('reason',reason); end if;
 end if;
 result:=public.transcription_claim_dispatch_core(p_owner_user_id,p_live,p_actor_id,p_kind);
 if result ? 'job' and (result->'job'->>'id')::uuid is distinct from j.id then raise exception 'dispatch_candidate_changed' using errcode='40001'; end if;
 return result;
end $function$;

CREATE OR REPLACE FUNCTION public.worker_transcription_media_enqueue(p_creator_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare s public.transcription_settings; owner_id uuid; m public.transcription_media_refreshes; jid uuid; targets uuid[]; reason text;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 reason:=public.transcription_paid_gate();
 if reason is not null or not s.media_recovery_enabled then
  return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason',coalesce(reason,'media_recovery_disabled')); end if;
 select w.owner_user_id into owner_id from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 join public.app_settings ap on ap.owner_user_id=w.owner_user_id join public.creators c on c.id=wc.creator_id
 where c.id=p_creator_id and c.status not in ('private','unavailable','paused') and wc.active and w.archived_at is null
 order by w.created_at,w.id limit 1;
 if owner_id is null then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason','creator_not_eligible'); end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
 perform 1 from public.app_settings where owner_user_id=owner_id for update;
 select * into m from public.transcription_media_refreshes where owner_user_id=owner_id and creator_id=p_creator_id and status='active';
 if found then return jsonb_build_object('job_id',m.job_id,'refresh_id',m.id,'target_count',m.target_count,'reason','already_queued'); end if;
 select array_agg(x.reel_id order by x.harvest_published_at desc nulls last,x.created_at,x.id) into targets from
 (select t.reel_id,t.created_at,t.id,case when s.phase='automatic' then r.published_at end harvest_published_at
 from public.transcript_jobs t join public.reels r on r.id=t.reel_id
 where r.creator_id=p_creator_id and public.transcription_recovery_target(owner_id,t.reel_id)
 order by harvest_published_at desc nulls last,t.created_at,t.id limit 100) x;
 if coalesce(cardinality(targets),0)=0 then reason:='no_awaiting_media';
 end if;
 if reason is not null then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason',reason); end if;
 insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,manual_authorized_by,priority)
 values(owner_id,'manual',1,100,.01,owner_id,100) returning id into jid;
 insert into public.scrape_job_creators(job_id,creator_id) values(jid,p_creator_id);
 insert into public.transcription_media_refreshes(job_id,owner_user_id,creator_id,phase,billing_month,target_count)
 values(jid,owner_id,p_creator_id,s.phase,date_trunc('month',now() at time zone 'UTC')::date,cardinality(targets)) returning * into m;
 insert into public.transcription_media_targets(refresh_id,creator_id,reel_id,shortcode)
 select m.id,p_creator_id,r.id,r.shortcode from public.reels r where r.id=any(targets);
 return jsonb_build_object('job_id',jid,'refresh_id',m.id,'target_count',m.target_count,'reason',null);
end $function$;

CREATE OR REPLACE FUNCTION reel_detail_private.enqueue_source_refresh(p_owner_id uuid, p_creator_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare s public.transcription_settings; m public.transcription_media_refreshes; jid uuid; targets uuid[]; reason text;
begin
  if coalesce(auth.jwt()->>'role','')='service_role' then perform public.require_service();
  elsif auth.uid() is distinct from p_owner_id or not public.is_allowed_owner() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  select * into s from public.transcription_settings where singleton for update;
  if not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
    join public.creators c on c.id=wc.creator_id join public.app_settings ap on ap.owner_user_id=w.owner_user_id
    where wc.creator_id=p_creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_id
    and c.status not in ('private','unavailable','paused')) then
    raise exception 'creator_not_authorized' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_id::text,0));
  perform 1 from public.app_settings where owner_user_id=p_owner_id for update;
  select mr.* into m from public.transcription_media_refreshes mr
    where mr.owner_user_id=p_owner_id and mr.creator_id=p_creator_id and mr.status='active';
  if found then
    if exists(select 1 from public.scrape_jobs where id=m.job_id and source_refresh) then
      return jsonb_build_object('job_id',m.job_id,'refresh_id',m.id,'target_count',m.target_count,'reason','already_queued');
    end if;
    return jsonb_build_object('job_id',null,'target_count',0,'reason','creator_busy');
  end if;
  if exists(select 1 from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
    where j.owner_user_id=p_owner_id and jc.creator_id=p_creator_id
      and j.status in ('pending','dispatching','running','processing','uncertain','budget_paused')) then
    return jsonb_build_object('job_id',null,'target_count',0,'reason','creator_busy');
  end if;
  reason:=public.transcription_paid_gate();
  if reason is null and (not s.media_recovery_enabled or s.phase<>'automatic') then reason:='source_refresh_disabled'; end if;
  select array_agg(r.id order by r.published_at desc nulls last,r.id) into targets from public.reels r where r.creator_id=p_creator_id;
  if coalesce(cardinality(targets),0)=0 then reason:=coalesce(reason,'initial_import_required');
  elsif cardinality(targets)>100 then reason:=coalesce(reason,'source_coverage_limit');
  end if;
  if reason is not null then return jsonb_build_object('job_id',null,'target_count',coalesce(cardinality(targets),0),'reason',reason); end if;
  insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,manual_authorized_by,priority,source_refresh)
    values(p_owner_id,'manual',1,100,.01,p_owner_id,100,true) returning id into jid;
  insert into public.scrape_job_creators(job_id,creator_id) values(jid,p_creator_id);
  insert into public.transcription_media_refreshes(job_id,owner_user_id,creator_id,phase,billing_month,target_count)
    values(jid,p_owner_id,p_creator_id,s.phase,date_trunc('month',now() at time zone 'UTC')::date,cardinality(targets)) returning * into m;
  insert into public.transcription_media_targets(refresh_id,creator_id,reel_id,shortcode)
    select m.id,p_creator_id,r.id,r.shortcode from public.reels r where r.id=any(targets);
  return jsonb_build_object('job_id',jid,'refresh_id',m.id,'target_count',m.target_count,'reason',null);
end $function$;

CREATE OR REPLACE FUNCTION public.get_transcription_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare s public.transcription_settings; accounted numeric; held numeric; month_start date:=date_trunc('month',now() at time zone 'UTC')::date;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into s from public.transcription_settings where singleton;
 select coalesce(sum(accounted_usd) filter(where billing_month=month_start),0),coalesce(sum(reserved_usd),0)
 into accounted,held from
 public.transcript_attempts;
 return jsonb_build_object('enabled',s.enabled,'paused',s.paused,'monthly_budget_usd',s.monthly_budget_usd,
 'budget_warning_pct',s.budget_warning_pct,'preferences_editable',true,'pilot_limit_usd',s.pilot_limit_usd,'phase',s.phase,
 'pilot_verified',s.pilot_verified,'account_pricing_validated',s.account_pricing_validated,
 'processing_ready',public.transcription_paid_gate() is null and public.transcription_combined_budget(s.reservation_usd)
 and (s.phase<>'pilot' or (select count(*) from public.transcript_attempts where phase='pilot')<s.max_starts),
 'estimated_month_spend',accounted,'accounted_month_spend',accounted,'reserved_usd',held,
 'spending_warning',accounted+held>=s.monthly_budget_usd*s.budget_warning_pct/100,
 -- Accounted/reserved amounts are conservative ledger values, never an invoice.
 'actual_month_spend',null,'unreconciled_jobs',(select count(distinct job_id) from public.transcript_attempts where reconciled_at is null),
 'job_counts',coalesce((select jsonb_object_agg(x.status,x.n) from
 (select j.status,count(*) n from public.transcript_jobs j join public.reels r on r.id=j.reel_id
 where exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 where wc.creator_id=r.creator_id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid() and public.is_workspace_member(w.id))
 group by j.status) x),'{}'::jsonb),
 'jobs',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id) from
 (select j.id,j.reel_id,c.username,j.status,j.attempt_count,j.created_at,j.completed_at,j.error_message
 from public.transcript_jobs j join public.reels r on r.id=j.reel_id join public.creators c on c.id=r.creator_id
 where exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid() and public.is_workspace_member(w.id))
 order by j.created_at desc,j.id limit 100) x),'[]'::jsonb));
end $function$;

create or replace function public.worker_transcription_verify_pilot() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare ok boolean;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 select exists(select 1 from public.transcript_attempts a join public.transcript_jobs t on t.id=a.job_id
 join public.reel_transcripts rt on rt.reel_id=t.reel_id and rt.status='ready'
 join public.reels r on r.id=t.reel_id
 join public.transcription_media_targets mt on mt.reel_id=r.id and mt.observation_count>0
 join public.transcription_media_refreshes mr on mr.id=mt.refresh_id
 join public.scrape_jobs sj on sj.id=mr.job_id
 where a.phase='pilot' and a.status='ready' and a.provider_job_id is not null and a.provider_transcription_id is not null
 and a.submit_authorized and a.reserved_usd=0 and a.accounted_usd between 0 and .08
 and r.duration_seconds between .1 and 180 and mr.phase='pilot' and mr.status='settled' and mr.actual_cost_usd>=0
 and sj.live and sj.status in ('succeeded','partial') and sj.dataset_finished and sj.provider_terminal_status='SUCCEEDED')
 and not exists(select 1 from public.transcript_attempts where status='uncertain')
 and not exists(select 1 from public.transcription_media_refreshes where status='active')
 and exists(select 1 from public.transcription_webhook_setup where singleton and status='configured' and webhook_id is not null and secret_id is not null)
 and (select account_pricing_validated and key_validated and contract_validated from public.transcription_settings where singleton) into ok;
 update public.transcription_settings set pilot_verified=ok where singleton and pilot_verified is distinct from ok;
 return jsonb_build_object('verified',ok,'reason',case when not ok then 'pilot_evidence_incomplete' end);
end $$;

-- No new browser-callable helpers or broadened grants.
revoke all on function public.transcription_combined_budget(numeric),public.transcription_claim_dispatch_core(uuid,boolean,text,text),
 reel_detail_private.enqueue_source_refresh(uuid,uuid) from public,anon,authenticated,service_role;
