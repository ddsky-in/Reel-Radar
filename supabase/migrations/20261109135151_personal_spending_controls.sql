-- Personal spending preferences. This migration never activates workers, installs
-- schedules, calls providers, changes pilot/per-run caps, or releases any hold.
alter table public.transcription_settings
 drop constraint transcription_settings_monthly_budget_usd_check,
 add constraint transcription_settings_monthly_budget_usd_check
 check(monthly_budget_usd between 0 and 10000),
 add column budget_warning_pct integer not null default 80
 check(budget_warning_pct between 1 and 100);

create or replace function public.update_settings(p_settings jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; n integer; item record; amount numeric;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 if p_settings is null or jsonb_typeof(p_settings)<>'object' or p_settings='{}'::jsonb then
  raise exception 'invalid_settings' using errcode='22023'; end if;
 for item in select key,value from jsonb_each(p_settings) loop
  if item.key='paused' then
   if jsonb_typeof(item.value)<>'boolean' then raise exception 'invalid_settings' using errcode='22023'; end if;
  elsif item.key in ('daily_limit','weekly_limit','monthly_budget_usd','budget_warning_pct','capacity') then
   if jsonb_typeof(item.value)<>'number' then raise exception 'invalid_settings' using errcode='22023'; end if;
   amount:=(item.value#>>'{}')::numeric;
   if item.key='monthly_budget_usd' then
    if amount not between 0 and 10000 or amount<>round(amount,6) then raise exception 'invalid_settings' using errcode='22023'; end if;
   elsif amount<>trunc(amount)
    or item.key in ('daily_limit','weekly_limit') and amount not between 10 and 30
    or item.key='budget_warning_pct' and amount not between 1 and 100
    or item.key='capacity' and amount not between 1 and 1000 then
    raise exception 'invalid_settings' using errcode='22023';
   end if;
  else raise exception 'invalid_settings' using errcode='22023'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 perform pg_advisory_xact_lock(hashtextextended('budget:'||auth.uid()::text,0));
 select * into s from public.app_settings where owner_user_id=auth.uid() for update;
 select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 where wc.active and w.archived_at is null and w.owner_user_id=auth.uid();
 if p_settings ? 'capacity' and (p_settings->>'capacity')::integer<n then
  raise exception 'capacity_below_current' using errcode='22023'; end if;
 update public.app_settings set daily_limit=coalesce((p_settings->>'daily_limit')::integer,daily_limit),
 weekly_limit=coalesce((p_settings->>'weekly_limit')::integer,weekly_limit),
 monthly_budget_usd=coalesce((p_settings->>'monthly_budget_usd')::numeric,monthly_budget_usd),
 budget_warning_pct=coalesce((p_settings->>'budget_warning_pct')::integer,budget_warning_pct),
 paused=coalesce((p_settings->>'paused')::boolean,paused),capacity=coalesce((p_settings->>'capacity')::integer,capacity)
 where owner_user_id=auth.uid() returning * into s;
 return jsonb_build_object('daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,
 'budget_warning_pct',s.budget_warning_pct,'paused',s.paused,'timezone',s.timezone,'capacity',s.capacity,
 'scraping_enabled',s.scraping_enabled,'initial_backfill_limit',s.initial_backfill_limit,'initial_backfill_enabled',s.initial_backfill_enabled);
end $$;

-- Remove only the legacy $4 clamp. The current core already contains the media
-- targeting/input guards and provider-cycle/envelope checks from migration011.
do $$ declare def text; old text:='committed+reserved+cap>least(s.monthly_budget_usd,4)'; begin
 select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into def;
 if (select count(*) from regexp_matches(def,'committed\+reserved\+cap>least\(s\.monthly_budget_usd,4\)','g'))<>1
 or def not like '%SET search_path TO ''pg_catalog'', ''public''%'
 or def not like '%provider_cycle_usage_usd+cycle_unobserved+reserved+cap>s.provider_cycle_limit_usd%'
 or def not like '%envelope_committed+cap>envelope_limit%'
 or def not like '%reelradar.media_job_id%' then raise exception 'personal_budget_dispatch_contract_drift'; end if;
 execute replace(def,old,'committed+reserved+cap>s.monthly_budget_usd');
end $$;

create or replace function public.get_bootstrap() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.app_settings; usage jsonb; month_start date:=date_trunc('month',now() at time zone 'UTC')::date;
 actual numeric; reserved numeric; unknown integer; estimate numeric;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into s from public.app_settings where owner_user_id=auth.uid();
 select coalesce(sum(estimated_cost_usd) filter(where (scheduled_for at time zone 'UTC')::date>=month_start),0),
 coalesce(sum(actual_cost_usd) filter(where live and billing_month=month_start),0),
 coalesce(sum(reserved_usd) filter(where live),0),
 count(*) filter(where live and actual_cost_usd is null and status not in ('pending','budget_paused'))
 into estimate,actual,reserved,unknown from public.scrape_jobs where owner_user_id=auth.uid();
 usage:=jsonb_build_object('estimated_month_spend',estimate,'actual_month_spend',case when unknown>0 then null else actual end,
 'reserved_usd',reserved,'unreconciled_jobs',unknown,'remaining_allowance',greatest(0,s.monthly_budget_usd-actual-reserved),
 'provider_balance_usd',null,'provider_usage_usd',case when s.provider_usage_checked_at>now()-interval '15 minutes' then s.provider_cycle_usage_usd end,
 'provider_limit_usd',case when s.provider_usage_checked_at>now()-interval '15 minutes' then s.provider_cycle_limit_usd end,
 'provider_cycle_start_at',s.provider_cycle_start_at,'provider_cycle_end_at',s.provider_cycle_end_at,'provider_usage_checked_at',s.provider_usage_checked_at);
 return jsonb_build_object('mode','supabase','workspaces',coalesce((select jsonb_agg(to_jsonb(w)-'owner_user_id' order by created_at)
 from public.workspaces w where public.is_workspace_member(w.id)),'[]'::jsonb),
 'settings',jsonb_build_object('daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,
 'budget_warning_pct',s.budget_warning_pct,'paused',s.paused,'timezone',s.timezone,'capacity',s.capacity,
 'scraping_enabled',s.scraping_enabled,'initial_backfill_limit',s.initial_backfill_limit,'initial_backfill_enabled',s.initial_backfill_enabled),
 'usage',usage,'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by scheduled_for desc) from
 (select id,kind,status,scheduled_for,started_at,completed_at,actor_run_id,requested_profiles_count,results_limit,returned_records_count,
 estimated_cost_usd,actual_cost_usd,error_message,attempt_count from public.scrape_jobs where owner_user_id=auth.uid()
 order by scheduled_for desc limit 50) j),'[]'::jsonb),'email',coalesce(auth.jwt()->>'email',''));
end $$;

create or replace function public.get_transcription_overview() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; accounted numeric; held numeric; month_start date:=date_trunc('month',now() at time zone 'UTC')::date;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into s from public.transcription_settings where singleton;
 select coalesce(sum(accounted_usd) filter(where billing_month=month_start),0),coalesce(sum(reserved_usd),0)
 into accounted,held from
 (select accounted_usd,reserved_usd,billing_month from public.transcript_attempts
 union all select accounted_usd,reserved_usd,billing_month from public.transcription_media_refreshes where owner_user_id=auth.uid()) ledger;
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
end $$;

create function public.update_transcription_settings(p_settings jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare item record; amount numeric;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 if p_settings is null or jsonb_typeof(p_settings)<>'object' or p_settings='{}'::jsonb then
  raise exception 'invalid_transcription_settings' using errcode='22023'; end if;
 for item in select key,value from jsonb_each(p_settings) loop
  if item.key='paused' then
   if jsonb_typeof(item.value)<>'boolean' then raise exception 'invalid_transcription_settings' using errcode='22023'; end if;
  elsif item.key in ('monthly_budget_usd','budget_warning_pct') then
   if jsonb_typeof(item.value)<>'number' then raise exception 'invalid_transcription_settings' using errcode='22023'; end if;
   amount:=(item.value#>>'{}')::numeric;
   if item.key='monthly_budget_usd' and (amount not between 0 and 10000 or amount<>round(amount,6))
    or item.key='budget_warning_pct' and (amount<>trunc(amount) or amount not between 1 and 100) then
    raise exception 'invalid_transcription_settings' using errcode='22023'; end if;
  else raise exception 'invalid_transcription_settings' using errcode='22023'; end if;
 end loop;
 -- Match the worker lock order: singleton, owner budget, app-settings row.
 perform 1 from public.transcription_settings where singleton for update;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||auth.uid()::text,0));
 perform 1 from public.app_settings where owner_user_id=auth.uid() for update;
 update public.transcription_settings set paused=coalesce((p_settings->>'paused')::boolean,paused),
 monthly_budget_usd=coalesce((p_settings->>'monthly_budget_usd')::numeric,monthly_budget_usd),
 budget_warning_pct=coalesce((p_settings->>'budget_warning_pct')::integer,budget_warning_pct) where singleton;
 return public.get_transcription_overview();
end $$;

-- Keep the existing pause endpoint compatible with the same serialized write.
create or replace function public.update_transcription_preferences(p_paused boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 if p_paused is null then raise exception 'invalid_preference' using errcode='22023'; end if;
 return public.update_transcription_settings(jsonb_build_object('paused',p_paused));
end $$;

-- NULL defaults mean omitted operator budgets preserve the owner's selection.
-- The signature is unchanged and the public worker wrapper still prohibits enable.
create or replace function public.transcription_configure_pre_media(p_key_validated boolean,p_enabled boolean default false,
 p_phase text default 'pilot',p_monthly_budget_usd numeric default null,p_pilot_limit_usd numeric default null,
 p_contract_validated boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; monthly numeric; pilot numeric;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 monthly:=coalesce(p_monthly_budget_usd,s.monthly_budget_usd); pilot:=coalesce(p_pilot_limit_usd,s.pilot_limit_usd);
 if p_key_validated is null or p_contract_validated is null or p_enabled is null
 or (p_enabled and not (p_key_validated and p_contract_validated)) or p_phase is null or p_phase not in ('pilot','automatic')
 or monthly not between 0 and 10000 or monthly<>round(monthly,6)
 or pilot not between 0 and .25 or pilot<>round(pilot,6) then
  raise exception 'invalid_transcription_configuration' using errcode='22023'; end if;
 update public.transcription_settings set key_validated=p_key_validated,contract_validated=p_contract_validated,enabled=p_enabled,
 phase=p_phase,monthly_budget_usd=monthly,pilot_limit_usd=pilot where singleton returning * into s;
 return to_jsonb(s)-'singleton'-'manifest_seeded';
end $$;

create or replace function public.worker_transcription_configure(p_key_validated boolean,p_enabled boolean default false,
 p_phase text default 'pilot',p_monthly_budget_usd numeric default null,p_pilot_limit_usd numeric default null,
 p_contract_validated boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 if p_enabled then raise exception 'use_transcription_activate' using errcode='42501'; end if;
 if p_phase='automatic' and not (select pilot_verified from public.transcription_settings where singleton) then
  raise exception 'pilot_unverified' using errcode='42501'; end if;
 return public.transcription_configure_pre_media(p_key_validated,p_enabled,p_phase,p_monthly_budget_usd,p_pilot_limit_usd,p_contract_validated);
end $$;

-- Automatic recovery follows the canonical backlog, while pilot recovery remains
-- confined to its seeded manifest. Each target can enter a paid refresh only once;
-- a settled refresh permits different new targets without repaying missed rows.
create index transcription_media_targets_reel_idx on public.transcription_media_targets(reel_id);
create function public.transcription_recovery_target(p_owner_user_id uuid,p_reel_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.transcript_jobs t join public.reels r on r.id=t.reel_id
 join public.creators c on c.id=r.creator_id cross join public.transcription_settings s
 where s.singleton and r.id=p_reel_id and t.status='awaiting_media' and t.attempt_count<3
 and t.next_attempt_at<=now() and t.completed_at is null
 and (t.media_recovery_eligible or s.phase='automatic')
 and c.status not in ('private','unavailable','paused')
 and (r.duration_seconds is null or r.duration_seconds<=s.max_duration_seconds)
 and not exists(select 1 from public.reel_media_sources where reel_id=r.id and has_audio=false)
 and not exists(select 1 from public.reel_transcripts where reel_id=r.id)
 and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 join public.app_settings ap on ap.owner_user_id=w.owner_user_id
 where wc.creator_id=r.creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)
 and not exists(select 1 from public.transcription_media_targets mt
 join public.transcription_media_refreshes mr on mr.id=mt.refresh_id
 where mt.reel_id=r.id and mr.owner_user_id=p_owner_user_id));
$$;

create or replace function public.transcription_enqueue(p_reel_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare st text; eligible boolean;
begin
 if not exists(select 1 from public.reels r join public.creators c on c.id=r.creator_id
 join public.workspace_creators wc on wc.creator_id=r.creator_id join public.workspaces w on w.id=wc.workspace_id
 join public.app_settings ap on ap.owner_user_id=w.owner_user_id
 where r.id=p_reel_id and wc.active and w.archived_at is null and c.status not in ('private','unavailable','paused')) then
  return 'not_requested'; end if;
 if exists(select 1 from public.reel_transcripts where reel_id=p_reel_id) then
  select status into st from public.reel_transcripts where reel_id=p_reel_id; return st; end if;
 select case when m.source_url is not null or cardinality(m.candidates)>0 or m.has_audio=false then 'queued' else 'awaiting_media' end
 into st from public.reel_media_sources m where m.reel_id=p_reel_id;
 st:=coalesce(st,'awaiting_media');
 select phase='automatic' into eligible from public.transcription_settings where singleton;
 insert into public.transcript_jobs(reel_id,status,media_recovery_eligible) values(p_reel_id,st,coalesce(eligible,false))
 on conflict(reel_id,model,options_version) do update set status=excluded.status,error_message=null,completed_at=null,
 media_recovery_eligible=public.transcript_jobs.media_recovery_eligible or excluded.media_recovery_eligible
 where public.transcript_jobs.attempt_count<3
 -- Observations may retain an old URL; they cannot authorize retrying a terminal job.
 and public.transcript_jobs.status='awaiting_media'
 and (public.transcript_jobs.status is distinct from excluded.status or public.transcript_jobs.error_message is not null
 or public.transcript_jobs.completed_at is not null or excluded.media_recovery_eligible and not public.transcript_jobs.media_recovery_eligible);
 select status into st from public.transcript_jobs where reel_id=p_reel_id;
 return st;
end $$;

-- Missing duration on an automatic pending reel can be refreshed without changing
-- terminal/uncertain jobs, pilot starts, reservations, or the one-speech-claim limit.
do $$ declare def text; begin
 select pg_get_functiondef('public.worker_transcription_claim(integer)'::regprocedure) into def;
 if (select count(*) from regexp_matches(def,'j\.media_recovery_eligible and s\.media_recovery_enabled','g'))<>2
 or def not like '%jsonb_array_length(jobs)>=1%'
 or def not like '%public.transcription_combined_budget(s.reservation_usd)%'
 or def not like '%pilot_starts>=s.max_starts%' then raise exception 'automatic_recovery_claim_contract_drift'; end if;
 execute replace(def,'j.media_recovery_eligible and s.media_recovery_enabled',
 '(j.media_recovery_eligible or s.phase=''automatic'') and s.media_recovery_enabled');
end $$;

create or replace function public.worker_transcription_media_enqueue(p_creator_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
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
 elsif not public.transcription_combined_budget(.01) or (s.phase='pilot' and
 coalesce((select sum(accounted_usd+reserved_usd) from public.transcription_media_refreshes),0)+.01>.01) then reason:='budget_paused'; end if;
 if reason is not null then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason',reason); end if;
 insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd,manual_authorized_by,priority)
 values(owner_id,'manual',1,100,.01,owner_id,100) returning id into jid;
 insert into public.scrape_job_creators(job_id,creator_id) values(jid,p_creator_id);
 insert into public.transcription_media_refreshes(job_id,owner_user_id,creator_id,phase,billing_month,target_count)
 values(jid,owner_id,p_creator_id,s.phase,date_trunc('month',now() at time zone 'UTC')::date,cardinality(targets)) returning * into m;
 insert into public.transcription_media_targets(refresh_id,creator_id,reel_id,shortcode)
 select m.id,p_creator_id,r.id,r.shortcode from public.reels r where r.id=any(targets);
 return jsonb_build_object('job_id',jid,'refresh_id',m.id,'target_count',m.target_count,'reason',null);
end $$;

create or replace function public.worker_transcription_media_candidates(p_limit integer default 1) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid;
begin
 perform public.require_service();
 if p_limit is null or p_limit not between 1 and 4 then raise exception 'invalid_candidate_limit' using errcode='22023'; end if;
 if public.transcription_paid_gate() is not null or not (select media_recovery_enabled from public.transcription_settings where singleton) then
  return jsonb_build_object('creators','[]'::jsonb); end if;
 select owner_user_id into owner_id from public.app_settings where singleton;
 return jsonb_build_object('creators',coalesce((select jsonb_agg(to_jsonb(x) order by x.username,x.creator_id) from
 (select c.id creator_id,c.username from public.creators c where c.status not in ('private','unavailable','paused')
 and exists(select 1 from public.transcript_jobs t join public.reels r on r.id=t.reel_id
 where r.creator_id=c.id and public.transcription_recovery_target(owner_id,t.reel_id))
 and not exists(select 1 from public.transcription_media_refreshes m where m.owner_user_id=owner_id and m.creator_id=c.id and m.status='active')
 order by c.username,c.id limit p_limit) x),'[]'::jsonb));
end $$;

-- A provider-confirmed finished refresh with no target observation is terminal
-- for that target. Its persisted membership prevents another paid recovery.
-- Settlement/hold release still runs solely through the original verified core.
alter function public.worker_transcription_media_reconcile(uuid) rename to transcription_media_reconcile_pre_continuous;
create function public.worker_transcription_media_reconcile(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; previously_settled boolean;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 select reconciled_at is not null into previously_settled from public.transcription_media_refreshes where job_id=p_job_id;
 result:=public.transcription_media_reconcile_pre_continuous(p_job_id);
 if previously_settled=false and (result->>'actual_cost_known')::boolean then
  update public.transcript_jobs t set status='media_unavailable',completed_at=now(),
  error_message='Target media was not returned by the completed refresh.'
  from public.transcription_media_targets mt join public.transcription_media_refreshes mr on mr.id=mt.refresh_id
  where mr.job_id=p_job_id and mr.status='settled' and mt.observation_count=0
  and t.reel_id=mt.reel_id and t.status='awaiting_media'
  and not exists(select 1 from public.reel_transcripts where reel_id=t.reel_id);
 end if;
 return result;
end $$;

revoke all on function public.transcription_recovery_target(uuid,uuid),public.transcription_enqueue(uuid),
 public.worker_transcription_claim(integer),public.worker_transcription_media_enqueue(uuid),public.worker_transcription_media_candidates(integer),
 public.transcription_media_reconcile_pre_continuous(uuid),public.worker_transcription_media_reconcile(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.worker_transcription_claim(integer),public.worker_transcription_media_enqueue(uuid),
 public.worker_transcription_media_candidates(integer),public.worker_transcription_media_reconcile(uuid) to service_role;

revoke all on function public.update_settings(jsonb),public.get_bootstrap(),public.get_transcription_overview(),
 public.update_transcription_settings(jsonb),public.update_transcription_preferences(boolean),
 public.transcription_configure_pre_media(boolean,boolean,text,numeric,numeric,boolean),
 public.worker_transcription_configure(boolean,boolean,text,numeric,numeric,boolean),
 public.transcription_claim_dispatch_core(uuid,boolean,text,text) from public,anon,authenticated,service_role;
grant execute on function public.update_settings(jsonb),public.get_bootstrap(),public.get_transcription_overview(),
 public.update_transcription_settings(jsonb),public.update_transcription_preferences(boolean) to authenticated;
grant execute on function public.worker_transcription_configure(boolean,boolean,text,numeric,numeric,boolean) to service_role;
