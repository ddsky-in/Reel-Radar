-- Private target-only recovery. No provider calls, secret writes, schedules, or global cap changes.
alter table public.transcription_settings
 add column pilot_verified boolean not null default false,
 add column account_pricing_validated boolean not null default false,
 add column validated_rate_usd_per_hour numeric(12,6),
 add column validated_max_item_usd numeric(12,6);
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.transcription_settings'::regclass
 and contype='c' and pg_get_constraintdef(oid) like '%NOT media_recovery_enabled%' loop
  execute format('alter table public.transcription_settings drop constraint %I',c.conname);
 end loop;
end $$;
alter table public.transcript_jobs add column media_recovery_eligible boolean not null default false;
-- Freeze the already-seeded, bounded manifest, not every future observation/enqueue.
update public.transcript_jobs set media_recovery_eligible=true where id in
 (select id from public.transcript_jobs where (select manifest_seeded from public.transcription_settings where singleton)
 order by created_at,id limit 41);
alter table public.transcript_attempts
 add column submit_checked_at timestamptz,
 add column submit_denied boolean not null default false,
 add column submit_authorized boolean not null default false;

create table public.transcription_media_refreshes (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null unique references public.scrape_jobs(id) on delete restrict,
 owner_user_id uuid not null references public.app_settings(owner_user_id),
 creator_id uuid not null references public.creators(id),
 phase text not null check(phase in ('pilot','automatic')),
 billing_month date not null,
 reserved_usd numeric(12,6) not null default .01 check(reserved_usd between 0 and .01),
 accounted_usd numeric(12,6) not null default 0 check(accounted_usd>=0),
 actual_cost_usd numeric(12,6) check(actual_cost_usd>=0),
 status text not null default 'active' check(status in ('active','settled')),
 target_count integer not null check(target_count between 1 and 100),
 created_at timestamptz not null default now(), reconciled_at timestamptz,
 unique(id,creator_id),
 check((status='settled')=(reconciled_at is not null)),
 check(status<>'settled' or reserved_usd=0 and actual_cost_usd is not null)
);
create unique index transcription_media_one_active_owner_creator on public.transcription_media_refreshes(owner_user_id,creator_id) where status='active';
create table public.transcription_media_targets (
 refresh_id uuid not null, creator_id uuid not null,
 reel_id uuid not null references public.reels(id) on delete restrict,
 shortcode text not null, observed_at timestamptz, observation_count integer not null default 0 check(observation_count>=0),
 primary key(refresh_id,reel_id), unique(refresh_id,shortcode),
 foreign key(refresh_id,creator_id) references public.transcription_media_refreshes(id,creator_id)
);
alter table public.transcription_media_refreshes enable row level security;
alter table public.transcription_media_targets enable row level security;
revoke all on public.transcription_media_refreshes,public.transcription_media_targets from public,anon,authenticated,service_role;
grant select on public.transcription_media_refreshes,public.transcription_media_targets to service_role;
create trigger owner_revision_changed after insert or update or delete on public.transcription_media_refreshes for each row execute function public.signal_owner_revision();

-- Cross-table linkage cannot be expressed in a CHECK; a deferrable constraint trigger
-- validates the complete enqueue transaction and prevents unbacked manual100 inserts.
alter table public.scrape_jobs drop constraint scrape_jobs_results_limit_check;
alter table public.scrape_jobs add constraint scrape_jobs_results_limit_check check (
 (kind='backfill' and results_limit=100 and requested_profiles_count=1)
 or (kind='manual' and results_limit=100 and requested_profiles_count=1)
 or (kind<>'backfill' and results_limit between 1 and 30)) not valid;
create function public.transcription_media_check_job() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare jid uuid; j public.scrape_jobs; m public.transcription_media_refreshes;
begin
 if tg_table_name='scrape_jobs' then jid:=new.id; else jid:=new.job_id; end if;
 select * into j from public.scrape_jobs where id=jid;
 select * into m from public.transcription_media_refreshes where job_id=jid;
 if j.kind='manual' and j.results_limit=100 or m.id is not null then
  if m.id is null or j.kind<>'manual' or j.results_limit<>100 or j.requested_profiles_count<>1
   or j.owner_user_id<>m.owner_user_id or j.manual_authorized_by is distinct from m.owner_user_id
   or (select count(*) from public.scrape_job_creators where job_id=j.id)<>1
   or not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=m.creator_id)
   or (select count(*) from public.transcription_media_targets where refresh_id=m.id)<>m.target_count then
   raise exception 'media_job_link_required' using errcode='23514';
  end if;
 end if;
 return null;
end $$;
create constraint trigger transcription_media_job_link after insert or update on public.scrape_jobs deferrable initially deferred for each row execute function public.transcription_media_check_job();
create constraint trigger transcription_media_refresh_link after insert or update on public.transcription_media_refreshes deferrable initially deferred for each row execute function public.transcription_media_check_job();

-- Current UTC-month accounted charges plus EVERY outstanding hold (including old months).
-- Pilot lifetime accounting deliberately includes media from ALL phases, preventing phase cycling.
create function public.transcription_combined_budget(p_add numeric) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce((select coalesce(sum(accounted_usd) filter(where billing_month=date_trunc('month',now() at time zone 'UTC')::date),0)+coalesce(sum(reserved_usd),0) from public.transcript_attempts),0)
 +coalesce((select coalesce(sum(accounted_usd) filter(where billing_month=date_trunc('month',now() at time zone 'UTC')::date),0)+coalesce(sum(reserved_usd),0) from public.transcription_media_refreshes),0)+p_add<=s.monthly_budget_usd
 and (s.phase<>'pilot' or
 coalesce((select sum(accounted_usd+reserved_usd) from public.transcript_attempts where phase='pilot'),0)
 +coalesce((select sum(accounted_usd+reserved_usd) from public.transcription_media_refreshes),0)+p_add<=s.pilot_limit_usd)
 from public.transcription_settings s where singleton;
$$;
create function public.transcription_paid_gate() returns text
language sql stable security definer set search_path=pg_catalog,public as $$
 select case when not s.enabled or not s.key_validated or not s.contract_validated then 'disabled'
 when s.paused then 'paused' when not s.account_pricing_validated then 'pricing_unvalidated'
 when not exists(select 1 from public.transcription_webhook_setup w join vault.secrets v on v.id=w.secret_id
  where w.singleton and w.status='configured' and w.webhook_id is not null and v.name='reelradar_transcription_webhook_hmac_v1') then 'webhook_unconfigured'
 when s.phase='automatic' and not s.pilot_verified then 'pilot_unverified'
 when exists(select 1 from public.transcript_attempts where status='uncertain')
 or exists(select 1 from public.transcription_media_refreshes m join public.scrape_jobs j on j.id=m.job_id where j.status='uncertain'
  or j.live and j.status in ('succeeded','partial','failed') and m.actual_cost_usd is null) then 'uncertain' end
 from public.transcription_settings s where singleton;
$$;

create function public.worker_transcription_validate_account(p_rate_usd_per_hour numeric,p_max_item_usd numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 -- .22/hour Scribe pricing and .08/item upper bounds, never permission to raise .08 reserves.
 if p_rate_usd_per_hour is null or p_rate_usd_per_hour<=0 or p_rate_usd_per_hour>.22
 or p_max_item_usd is null or p_max_item_usd<=0 or p_max_item_usd>.08 then raise exception 'pricing_bounds_exceeded' using errcode='22023'; end if;
 update public.transcription_settings set account_pricing_validated=true,validated_rate_usd_per_hour=p_rate_usd_per_hour,validated_max_item_usd=p_max_item_usd where singleton;
 return jsonb_build_object('validated',true,'rate_usd_per_hour',p_rate_usd_per_hour,'max_item_usd',p_max_item_usd);
end $$;

create function public.worker_transcription_verify_pilot() returns jsonb
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
 and r.duration_seconds between .1 and 180 and mr.phase='pilot' and mr.status='settled' and mr.actual_cost_usd<=.01
 and sj.live and sj.status in ('succeeded','partial') and sj.dataset_finished and sj.provider_terminal_status='SUCCEEDED')
 and not exists(select 1 from public.transcript_attempts where status='uncertain')
 and not exists(select 1 from public.transcription_media_refreshes where status='active')
 and exists(select 1 from public.transcription_webhook_setup where singleton and status='configured' and webhook_id is not null and secret_id is not null)
 and (select account_pricing_validated and key_validated and contract_validated from public.transcription_settings where singleton) into ok;
 update public.transcription_settings set pilot_verified=ok where singleton and pilot_verified is distinct from ok;
 return jsonb_build_object('verified',ok,'reason',case when not ok then 'pilot_evidence_incomplete' end);
end $$;
create function public.worker_transcription_activate(p_phase text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 if p_phase is null or p_phase not in ('pilot','automatic') then raise exception 'invalid_phase' using errcode='22023'; end if;
 if not s.key_validated or not s.contract_validated or not s.account_pricing_validated
 or not exists(select 1 from public.transcription_webhook_setup w join vault.secrets v on v.id=w.secret_id
 where w.singleton and w.status='configured' and w.webhook_id is not null and v.name='reelradar_transcription_webhook_hmac_v1') then
  raise exception 'activation_unvalidated' using errcode='42501'; end if;
 if p_phase='automatic' and not (public.worker_transcription_verify_pilot()->>'verified')::boolean then raise exception 'pilot_unverified' using errcode='42501'; end if;
 update public.transcription_settings set enabled=true,paused=false,phase=p_phase,media_recovery_enabled=true where singleton returning * into s;
 return to_jsonb(s)-'singleton'-'manifest_seeded';
end $$;

-- Keep configuration's existing numeric/credential validation; activation is the ONLY enable path.
alter function public.worker_transcription_configure(boolean,boolean,text,numeric,numeric,boolean) rename to transcription_configure_pre_media;
create function public.worker_transcription_configure(p_key_validated boolean,p_enabled boolean default false,p_phase text default 'pilot',p_monthly_budget_usd numeric default 5,p_pilot_limit_usd numeric default .25,p_contract_validated boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 if p_enabled then raise exception 'use_transcription_activate' using errcode='42501'; end if;
 if p_phase='automatic' and not (select pilot_verified from public.transcription_settings where singleton) then raise exception 'pilot_unverified' using errcode='42501'; end if;
 return public.transcription_configure_pre_media(p_key_validated,p_enabled,p_phase,p_monthly_budget_usd,p_pilot_limit_usd,p_contract_validated);
end $$;

create function public.worker_transcription_media_enqueue(p_creator_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; owner_id uuid; m public.transcription_media_refreshes; jid uuid; targets uuid[]; reason text;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 reason:=public.transcription_paid_gate();
 if reason is not null or not s.media_recovery_enabled then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason',coalesce(reason,'media_recovery_disabled')); end if;
 select w.owner_user_id into owner_id from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 join public.creators c on c.id=wc.creator_id where c.id=p_creator_id and c.status not in ('private','unavailable','paused') and wc.active and w.archived_at is null order by w.created_at,w.id limit 1;
 if owner_id is null then return jsonb_build_object('job_id',null,'refresh_id',null,'target_count',0,'reason','creator_not_eligible'); end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
 perform 1 from public.app_settings where owner_user_id=owner_id for update;
 select * into m from public.transcription_media_refreshes where owner_user_id=owner_id and creator_id=p_creator_id and status='active';
 if found then return jsonb_build_object('job_id',m.job_id,'refresh_id',m.id,'target_count',m.target_count,'reason','already_queued'); end if;
 select array_agg(x.reel_id order by x.created_at,x.id) into targets from
 (select t.reel_id,t.created_at,t.id from public.transcript_jobs t join public.reels r on r.id=t.reel_id
 where r.creator_id=p_creator_id and t.media_recovery_eligible and t.status='awaiting_media' and t.attempt_count<3
 and not exists(select 1 from public.reel_transcripts where reel_id=t.reel_id) order by t.created_at,t.id limit 100) x;
 if coalesce(cardinality(targets),0)=0 then reason:='no_awaiting_media';
 elsif not public.transcription_combined_budget(.01) or (s.phase='pilot' and
 coalesce((select sum(accounted_usd+reserved_usd) from public.transcription_media_refreshes),0)+.01>.01) then reason:='budget_paused';
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
end $$;
create function public.worker_transcription_media_jobs() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 return jsonb_build_object('jobs',coalesce((select jsonb_agg(to_jsonb(x)-'created_at' order by x.created_at,x.id) from
 (select j.id,j.status,j.actor_run_id,m.creator_id,m.created_at from public.transcription_media_refreshes m
 join public.scrape_jobs j on j.id=m.job_id where m.status='active' order by m.created_at,m.id limit 4) x),'[]'::jsonb));
end $$;
create function public.worker_transcription_media_reconcile(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.transcription_media_refreshes; j public.scrape_jobs; owner_id uuid;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 select owner_user_id into owner_id from public.transcription_media_refreshes where job_id=p_job_id;
 if owner_id is null then return jsonb_build_object('status','not_linked','actual_cost_usd',null,'actual_cost_known',false,'reason','not_linked'); end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
 perform 1 from public.app_settings where owner_user_id=owner_id for update;
 select * into j from public.scrape_jobs where id=p_job_id for update;
 select * into m from public.transcription_media_refreshes where job_id=p_job_id for update;
 if m.reconciled_at is null and j.status in ('succeeded','partial','failed') and j.actual_cost_usd is not null and j.billing_reconciled_at is not null
 and (not j.live and j.actual_cost_usd=0 or j.live and j.actor_run_id is not null and j.expected_provider_user_id is not null and j.provider_terminal_status is not null) then
  update public.transcription_media_refreshes set status='settled',actual_cost_usd=j.actual_cost_usd,
  accounted_usd=greatest(accounted_usd,j.actual_cost_usd),reserved_usd=0,reconciled_at=now() where id=m.id returning * into m;
 end if;
 return jsonb_build_object('status',j.status,'actual_cost_usd',m.actual_cost_usd,'actual_cost_known',m.reconciled_at is not null,
 'reason',case when m.reconciled_at is null then 'cost_or_completion_unverified' end);
end $$;

-- Modify EXACTLY the old input guard and per-linked cap, preserving all original live
-- policy/cycle/envelope/identity checks and fixed search_path. Abort if contract drifted.
do $$ declare def text; old_guard text:='j.kind<>''profile'' and j.kind<>''backfill'' and j.results_limit not between 10 and 30';
 old_cap text:='cap:=case when p_live then s.max_run_charge_usd else 0 end;';
begin
 select pg_get_functiondef('public.worker_claim_dispatch(uuid,boolean,text,text)'::regprocedure) into def;
 if (select count(*) from regexp_matches(def,'j\.kind<>''profile'' and j\.kind<>''backfill'' and j\.results_limit not between 10 and 30','g'))<>1
 or (select count(*) from regexp_matches(def,'cap:=case when p_live then s\.max_run_charge_usd else 0 end;','g'))<>1
 or def not like '%SET search_path TO ''pg_catalog'', ''public''%'
 or def not like '%provider_cycle_usage_usd+cycle_unobserved+reserved+cap>s.provider_cycle_limit_usd%'
 or def not like '%manual_authorized_by=p_owner_user_id%' then raise exception 'dispatch_contract_drift'; end if;
 def:=replace(def,old_guard,'j.kind<>''profile'' and j.kind<>''backfill'' and j.results_limit not between 10 and 30 and not (j.kind=''manual'' and j.results_limit=100 and j.requested_profiles_count=1 and exists(select 1 from public.transcription_media_refreshes m where m.job_id=j.id and m.owner_user_id=p_owner_user_id and m.status=''active'' and m.reserved_usd=.01))');
 def:=replace(def,old_cap,'cap:=case when p_live and j.kind=''manual'' and j.results_limit=100 and exists(select 1 from public.transcription_media_refreshes m where m.job_id=j.id and m.owner_user_id=p_owner_user_id and m.status=''active'' and m.reserved_usd=.01) then least(.01,s.max_run_charge_usd) when p_live then s.max_run_charge_usd else 0 end;');
 execute def;
end $$;
alter function public.worker_claim_dispatch(uuid,boolean,text,text) rename to transcription_claim_dispatch_core;
create function public.worker_claim_dispatch(p_owner_user_id uuid,p_live boolean,p_actor_id text,p_kind text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; m public.transcription_media_refreshes; result jsonb; reason text;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 perform 1 from public.app_settings where owner_user_id=p_owner_user_id for update;
 select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()
 and (not p_live or kind not in ('profile','manual') or manual_authorized_by=p_owner_user_id)
 order by priority desc,scheduled_for,created_at,id for update skip locked limit 1;
 if j.kind='manual' and j.results_limit=100 then
  select * into m from public.transcription_media_refreshes where job_id=j.id and owner_user_id=p_owner_user_id and status='active' and reserved_usd=.01;
  if m.id is null then return jsonb_build_object('reason','media_job_link_required'); end if;
  if not p_live then return jsonb_build_object('reason','media_requires_live_policy'); end if;
  reason:=public.transcription_paid_gate();
  if reason is not null then return jsonb_build_object('reason',reason); end if;
  if not public.transcription_combined_budget(0) then return jsonb_build_object('reason','budget_paused'); end if;
  if (select max_run_charge_usd from public.app_settings where owner_user_id=p_owner_user_id)<.01 then return jsonb_build_object('reason','media_run_cap_insufficient'); end if;
 end if;
 result:=public.transcription_claim_dispatch_core(p_owner_user_id,p_live,p_actor_id,p_kind);
 if result ? 'job' and (result->'job'->>'id')::uuid is distinct from j.id then raise exception 'dispatch_candidate_changed' using errcode='40001'; end if;
 return result;
end $$;

-- Explicit replacement tolerates equivalent compressed hosted007 function bodies.
create or replace function public.worker_transcription_claim(p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; j public.transcript_jobs; a public.transcript_attempts; r public.reels; m public.reel_media_sources;
 jobs jsonb:='[]'; reason text; outstanding integer; pilot_starts integer; owner_id uuid;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 if p_limit is null or p_limit not between 1 and 2 then raise exception 'invalid_claim_limit' using errcode='22023'; end if;
 update public.transcript_jobs set status='uncertain',error_message='Acceptance unknown; manual reconciliation required.'
 where status in ('submitting','processing') and current_attempt_id in (select id from public.transcript_attempts where lease_expires_at<now());
 update public.transcript_attempts set status='uncertain' where status in ('submitting','processing') and lease_expires_at<now();
 reason:=public.transcription_paid_gate();
 if reason is not null then return jsonb_build_object('reason',reason,'jobs',jobs); end if;
 select count(*) into outstanding from public.transcript_attempts where status in ('submitting','processing','uncertain');
 for j in select jj.* from public.transcript_jobs jj join public.reels rr on rr.id=jj.reel_id join public.creators c on c.id=rr.creator_id
 where jj.status in ('queued','budget_paused','awaiting_media') and jj.attempt_count<3 and jj.next_attempt_at<=now()
 and c.status not in ('private','unavailable','paused')
 and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null)
 and not exists(select 1 from public.reel_transcripts t where t.reel_id=jj.reel_id)
 order by jj.created_at,jj.id for update of jj loop
  exit when jsonb_array_length(jobs)>=1;
  select * into r from public.reels where id=j.reel_id;
  select * into m from public.reel_media_sources where reel_id=j.reel_id;
  if m.has_audio=false then
   insert into public.reel_transcripts(reel_id,model,options_version,status,text) values(j.reel_id,j.model,j.options_version,'no_speech','') on conflict do nothing;
   update public.transcript_jobs set status='no_speech',completed_at=now(),error_message=null where id=j.id; continue;
  end if;
  if r.duration_seconds is null or r.duration_seconds<.1 then
   update public.transcript_jobs set status=case when j.media_recovery_eligible and s.media_recovery_enabled then 'awaiting_media' else 'media_unavailable' end,error_message=null
   where id=j.id and (status is distinct from case when j.media_recovery_eligible and s.media_recovery_enabled then 'awaiting_media' else 'media_unavailable' end or error_message is not null); continue;
  elsif r.duration_seconds>s.max_duration_seconds then
   update public.transcript_jobs set status='media_unavailable',error_message='Media exceeds the duration limit.' where id=j.id; continue;
  end if;
  if m.source_url is null and coalesce(cardinality(m.candidates),0)=0 then
   update public.transcript_jobs set status='awaiting_media',error_message=null where id=j.id and (status is distinct from 'awaiting_media' or error_message is not null); continue;
  end if;
  if outstanding>=s.concurrency then reason:='concurrency'; exit; end if;
  select w.owner_user_id into owner_id from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
  where wc.creator_id=r.creator_id and wc.active and w.archived_at is null order by w.created_at,w.id limit 1;
  perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
  perform 1 from public.app_settings where owner_user_id=owner_id for update;
  select count(*) into pilot_starts from public.transcript_attempts where phase='pilot';
  if not public.transcription_combined_budget(s.reservation_usd) or s.phase='pilot' and pilot_starts>=s.max_starts then
   update public.transcript_jobs set status='budget_paused',error_message='Transcription budget or pilot start limit reached.'
   where id=j.id and (status is distinct from 'budget_paused' or error_message is distinct from 'Transcription budget or pilot start limit reached.');
   reason:='budget_paused'; continue;
  end if;
  insert into public.transcript_attempts(job_id,attempt_number,lease_expires_at,phase,billing_month,reserved_usd)
  values(j.id,j.attempt_count+1,now()+interval '15 minutes',s.phase,date_trunc('month',now() at time zone 'UTC')::date,s.reservation_usd) returning * into a;
  update public.transcript_jobs set status='submitting',attempt_count=attempt_count+1,current_attempt_id=a.id,error_message=null,completed_at=null where id=j.id;
  outstanding:=outstanding+1;
  jobs:=jobs||jsonb_build_array(jsonb_build_object('id',j.id,'reel_id',j.reel_id,'attempt_id',a.id,'lease_token',a.lease_token,'lease_expires_at',a.lease_expires_at,
  'source_url',m.source_url,'candidates',m.candidates,'has_audio',m.has_audio,'duration_seconds',r.duration_seconds,'model',j.model,'options_version',j.options_version,
  'reservation_usd',s.reservation_usd,'max_duration_seconds',s.max_duration_seconds,'max_media_bytes',s.max_media_bytes));
 end loop;
 return jsonb_build_object('reason',case when jsonb_array_length(jobs)>0 then null else coalesce(reason,'empty') end,'jobs',jobs);
end $$;
create or replace function public.worker_transcription_manifest(p_limit integer default 41) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; r record; items jsonb:='[]';
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 if p_limit is null or p_limit not between 1 and 41 then raise exception 'invalid_manifest_limit' using errcode='22023'; end if;
 if s.manifest_seeded then return jsonb_build_object('items','[]'::jsonb,'already_seeded',true); end if;
 for r in select rr.id reel_id,rr.shortcode,rr.reel_url,c.username from public.reels rr join public.creators c on c.id=rr.creator_id
 where c.status not in ('private','unavailable','paused') and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.archived_at is null)
 order by rr.first_seen_at,rr.id limit p_limit loop
  perform public.transcription_enqueue(r.reel_id);
  update public.transcript_jobs set media_recovery_eligible=true where reel_id=r.reel_id and not media_recovery_eligible;
  items:=items||jsonb_build_array(to_jsonb(r));
 end loop;
 update public.transcription_settings set manifest_seeded=true where singleton;
 return jsonb_build_object('items',items,'already_seeded',false);
end $$;
create or replace function public.transcription_enqueue(p_reel_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare st text;
begin
 if not exists(select 1 from public.reels r join public.creators c on c.id=r.creator_id join public.workspace_creators wc on wc.creator_id=r.creator_id
 join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.active and w.archived_at is null and c.status not in ('private','unavailable','paused')) then return 'not_requested'; end if;
 if exists(select 1 from public.reel_transcripts where reel_id=p_reel_id) then select status into st from public.reel_transcripts where reel_id=p_reel_id; return st; end if;
 select case when m.source_url is not null or cardinality(m.candidates)>0 or m.has_audio=false then 'queued' else 'awaiting_media' end
 into st from public.reel_media_sources m where m.reel_id=p_reel_id;
 st:=coalesce(st,'awaiting_media');
 insert into public.transcript_jobs(reel_id,status) values(p_reel_id,st)
 on conflict(reel_id,model,options_version) do update set status=excluded.status,error_message=null
 where public.transcript_jobs.status in ('awaiting_media','media_unavailable') and public.transcript_jobs.attempt_count<3
 and (public.transcript_jobs.status is distinct from excluded.status or public.transcript_jobs.error_message is not null);
 select status into st from public.transcript_jobs where reel_id=p_reel_id;
 return st;
end $$;
create or replace function public.worker_observe_reel_media(p_reel_id uuid,p_media_source_url text,p_media_candidates jsonb,p_has_audio boolean,p_observed_at timestamptz) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare urls text[]; st text;
begin
 perform public.require_service();
 if not exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id
 join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.active and w.archived_at is null) then raise exception 'reel_not_authorized' using errcode='42501'; end if;
 if p_observed_at is null or p_observed_at>now()+interval '5 minutes' then raise exception 'invalid_media_observation' using errcode='22023'; end if;
 if p_media_source_url is not null and not public.transcription_valid_media_url(p_media_source_url) then raise exception 'invalid_media_source' using errcode='22023'; end if;
 if p_media_candidates is not null and (jsonb_typeof(p_media_candidates)<>'array' or jsonb_array_length(p_media_candidates)>16) then raise exception 'invalid_media_candidates' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_media_candidates,'[]')) x where jsonb_typeof(x)<>'string' or not public.transcription_valid_media_url(x#>>'{}')) then raise exception 'invalid_media_candidates' using errcode='22023'; end if;
 select coalesce(array_agg(value order by ordinal),'{}') into urls from
 (select value,min(ordinal) ordinal from jsonb_array_elements_text(coalesce(p_media_candidates,'[]')) with ordinality x(value,ordinal) group by value) ordered;
 insert into public.reel_media_sources(reel_id,source_url,candidates,has_audio,observed_at)
 values(p_reel_id,coalesce(p_media_source_url,urls[1]),urls,p_has_audio,p_observed_at)
 on conflict(reel_id) do update set source_url=coalesce(excluded.source_url,public.reel_media_sources.source_url),
 candidates=case when cardinality(excluded.candidates)>0 then excluded.candidates else public.reel_media_sources.candidates end,
 has_audio=coalesce(excluded.has_audio,public.reel_media_sources.has_audio),observed_at=excluded.observed_at
 where public.reel_media_sources.observed_at<=excluded.observed_at
 and (excluded.source_url is not null or cardinality(excluded.candidates)>0 or excluded.has_audio is not null);
 st:=public.transcription_enqueue(p_reel_id);
 return jsonb_build_object('status',st);
end $$;

create function public.worker_transcription_before_submit(p_attempt_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; reason text; owner_id uuid; eligible boolean;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 select w.owner_user_id into owner_id from public.transcript_attempts attempt_row join public.transcript_jobs j on j.id=attempt_row.job_id
 join public.reels r on r.id=j.reel_id join public.workspace_creators wc on wc.creator_id=r.creator_id join public.workspaces w on w.id=wc.workspace_id
 where attempt_row.id=p_attempt_id and wc.active and w.archived_at is null order by w.created_at,w.id limit 1;
 if owner_id is not null then
  perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
  perform 1 from public.app_settings where owner_user_id=owner_id for update;
 end if;
 a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
 if a.submit_authorized or a.provider_job_id is not null or a.status<>'submitting' then return jsonb_build_object('allow',false,'reason','already_submitted_or_terminal'); end if;
 reason:=public.transcription_paid_gate();
 if a.lease_expires_at<now() then reason:='lease_expired'; end if;
 select exists(select 1 from public.transcript_jobs j join public.reels r on r.id=j.reel_id join public.creators c on c.id=r.creator_id
 where j.id=a.job_id and c.status not in ('private','unavailable','paused') and r.duration_seconds between .1 and 180
 and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
 join public.app_settings ap on ap.owner_user_id=w.owner_user_id where wc.creator_id=r.creator_id and wc.active and w.archived_at is null)) into eligible;
 if not eligible then reason:='workspace_or_creator_inactive'; end if;
 if not public.transcription_combined_budget(0) then reason:='budget_paused'; end if;
 update public.transcript_attempts set submit_checked_at=now(),submit_denied=reason is not null,submit_authorized=reason is null where id=a.id;
 return jsonb_build_object('allow',reason is null,'reason',reason);
end $$;
create function public.worker_transcription_cancel_not_started(p_attempt_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
 if a.status='not_started' then return jsonb_build_object('status','not_started','duplicate',true); end if;
 if a.status<>'submitting' or not a.submit_denied or a.submit_authorized or a.provider_job_id is not null or a.submit_checked_at is null then raise exception 'nonacceptance_not_proven' using errcode='40001'; end if;
 update public.transcript_attempts set status='not_started',reserved_usd=0,accounted_usd=0,actual_cost_usd=0,reconciled_at=now(),completed_at=now() where id=a.id;
 update public.transcript_jobs set status=case when attempt_count<3 then 'queued' else 'failed' end,next_attempt_at=now(),error_message='Submission gate closed before paid start.' where id=a.job_id;
 return jsonb_build_object('status','not_started','duplicate',false);
end $$;

-- Media-only pages never call the old canonical upsert/snapshot core. Raw received counts
-- still cover all billed rows; only frozen creator+shortcode targets can update observations.
alter function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) rename to transcription_ingest_page_pre_media;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; m public.transcription_media_refreshes; rec jsonb; er jsonb; rid uuid; fetched timestamptz; received integer:=0; accepted integer:=0; kv record; counts jsonb; duration numeric;
begin
 perform public.require_service();
 select * into m from public.transcription_media_refreshes where job_id=p_job_id;
 if m.id is null then return public.transcription_ingest_page_pre_media(p_job_id,p_lease_token,p_expected_cursor,p_records,p_errors,p_next_cursor,p_finished,p_received_counts); end if;
 select * into j from public.scrape_jobs where id=p_job_id for update;
 if j.status<>'processing' or p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null or j.lease_expires_at<now() then raise exception 'lease_expired' using errcode='40001'; end if;
 if p_expected_cursor is null then raise exception 'invalid_page' using errcode='22023'; end if;
 if j.dataset_cursor<>p_expected_cursor or j.dataset_finished then return jsonb_build_object('cursor',j.dataset_cursor,'duplicate',true); end if;
 if p_records is null or p_errors is null or p_next_cursor is null or jsonb_typeof(p_records)<>'array' or jsonb_typeof(p_errors)<>'array'
 or jsonb_array_length(p_records)>100 or jsonb_array_length(p_errors)>100 or p_next_cursor<p_expected_cursor or p_next_cursor>p_expected_cursor+100 or p_next_cursor>100
 or p_finished is null or p_next_cursor=p_expected_cursor and (not p_finished or jsonb_array_length(p_records)>0 or jsonb_array_length(p_errors)>0) then raise exception 'invalid_page' using errcode='22023'; end if;
 if p_received_counts is not null and jsonb_typeof(p_received_counts)<>'object' then raise exception 'invalid_received_counts' using errcode='22023'; end if;
 counts:=p_received_counts;
 if counts is null then
  select jsonb_build_object(m.creator_id::text,jsonb_array_length(p_records)+jsonb_array_length(p_errors)) into counts;
 end if;
 for kv in select key,value from jsonb_each(counts) loop
  if kv.key<>m.creator_id::text or jsonb_typeof(kv.value)<>'number' or kv.value::text !~ '^\d+$' or kv.value::text::numeric>100 then raise exception 'invalid_received_counts' using errcode='22023'; end if;
  received:=received+kv.value::text::integer;
 end loop;
 if received>p_next_cursor-p_expected_cursor or jsonb_array_length(p_records)+jsonb_array_length(p_errors)>received then raise exception 'invalid_received_counts' using errcode='22023'; end if;
 for rec in select value from jsonb_array_elements(p_records) loop
  if jsonb_typeof(rec)<>'object' or rec->>'creator_id' is distinct from m.creator_id::text
   or not exists(select 1 from public.creators where id=m.creator_id and username=rec->>'username') then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  select t.reel_id into rid from public.transcription_media_targets t join public.reels r on r.id=t.reel_id and r.creator_id=t.creator_id and r.shortcode=t.shortcode
  where t.refresh_id=m.id and t.creator_id=m.creator_id and t.shortcode=rec->>'shortcode';
  if rid is null then continue; end if;
  fetched:=(rec->>'fetched_at')::timestamptz;
  if fetched is null or fetched>now()+interval '5 minutes' then raise exception 'invalid_fetch_timestamp' using errcode='22023'; end if;
  if (rec ? 'media_source_url' and jsonb_typeof(rec->'media_source_url') not in ('string','null'))
  or (rec ? 'has_audio' and jsonb_typeof(rec->'has_audio') not in ('boolean','null')) then raise exception 'invalid_media_observation' using errcode='22023'; end if;
  perform public.worker_observe_reel_media(rid,rec->>'media_source_url',nullif(rec->'media_candidates','null'::jsonb),(rec->>'has_audio')::boolean,fetched);
  duration:=(rec->>'duration_seconds')::numeric;
  if duration is not null then
   if duration<0 or duration>86400 then raise exception 'invalid_duration' using errcode='22023'; end if;
   update public.reels r set duration_seconds=duration where id=rid and duration>0
   and duration_seconds is distinct from duration and not exists(select 1 from public.reel_media_sources where reel_id=rid and observed_at>fetched);
  end if;
  update public.transcription_media_targets set observed_at=greatest(observed_at,fetched),observation_count=observation_count+1 where refresh_id=m.id and reel_id=rid;
  accepted:=accepted+1;
 end loop;
 for er in select value from jsonb_array_elements(p_errors) loop
  if er->>'creator_id' is distinct from m.creator_id::text then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
 end loop;
 -- result_count counts valid normalized harvest rows for the unchanged OUTPUT completion contract;
 -- accepted/returned_records_count count only target observations, never outsiders.
 update public.scrape_job_creators set status=case when jsonb_array_length(p_records)>0 then 'active' else status end,
 result_count=result_count+jsonb_array_length(p_records),received_count=received_count+received where job_id=j.id and creator_id=m.creator_id;
 update public.scrape_jobs set dataset_cursor=p_next_cursor,dataset_finished=p_finished,returned_records_count=returned_records_count+accepted,
 lease_expires_at=now()+interval '3 minutes' where id=j.id;
 return jsonb_build_object('cursor',p_next_cursor,'accepted',accepted,'duplicate',false);
end $$;

-- Transaction-local targeting restricts BOTH selectors; settings/budget locks are acquired
-- by the wrapper. Reset the selector even when a caller catches an exception.
do $$ declare def text; old text:='and (not p_live or kind not in (''profile'',''manual'') or manual_authorized_by=p_owner_user_id)'; begin
 select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) into def;
 if (select count(*) from regexp_matches(def,'and \(not p_live or kind not in \(''profile'',''manual''\) or manual_authorized_by=p_owner_user_id\)','g'))<>1 then raise exception 'target_selector_contract_drift'; end if;
 def:=replace(def,old,old||E'\n and (nullif(current_setting(''reelradar.media_job_id'',true),'''') is null or id=nullif(current_setting(''reelradar.media_job_id'',true),'''')::uuid)');
 execute def;
 select pg_get_functiondef('public.worker_claim_dispatch(uuid,boolean,text,text)'::regprocedure) into def;
 if strpos(def,old)=0 then raise exception 'target_wrapper_contract_drift'; end if;
 def:=replace(def,old,old||E'\n and (nullif(current_setting(''reelradar.media_job_id'',true),'''') is null or id=nullif(current_setting(''reelradar.media_job_id'',true),'''')::uuid)');
 execute def;
end $$;
create function public.worker_transcription_media_claim(p_job_id uuid,p_actor_id text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare owner_id uuid; result jsonb; prior text;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 select owner_user_id into owner_id from public.transcription_media_refreshes where job_id=p_job_id and status='active';
 if owner_id is null then return jsonb_build_object('reason','media_job_not_claimable'); end if;
 prior:=coalesce(current_setting('reelradar.media_job_id',true),'');
 perform set_config('reelradar.media_job_id',p_job_id::text,true);
 result:=public.worker_claim_dispatch(owner_id,true,p_actor_id,'manual');
 perform set_config('reelradar.media_job_id',prior,true);
 if result ? 'job' and (result->'job'->>'id')::uuid is distinct from p_job_id then raise exception 'dispatch_candidate_changed' using errcode='40001'; end if;
 return result;
end $$;
create function public.worker_transcription_media_candidates(p_limit integer default 1) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 if p_limit is null or p_limit not between 1 and 4 then raise exception 'invalid_candidate_limit' using errcode='22023'; end if;
 return jsonb_build_object('creators',coalesce((select jsonb_agg(to_jsonb(x) order by x.username,x.creator_id) from
 (select c.id creator_id,c.username from public.creators c where c.status not in ('private','unavailable','paused')
 and exists(select 1 from public.transcript_jobs t join public.reels r on r.id=t.reel_id where r.creator_id=c.id and t.media_recovery_eligible and t.status='awaiting_media' and t.attempt_count<3)
 and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.archived_at is null)
 and not exists(select 1 from public.transcription_media_refreshes m where m.creator_id=c.id)
 order by c.username,c.id limit p_limit) x),'[]'::jsonb));
end $$;

-- Explicit grants defeat hosted default privileges; old/core helpers have no service execute.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like 'transcription_%' or p.proname like 'worker_transcription_%'
 or p.proname in ('worker_claim_dispatch','worker_ingest_page','worker_observe_reel_media')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  if f.proname like 'worker_%' then execute format('grant execute on function %s to service_role',f.signature); end if;
 end loop;
end $$;
