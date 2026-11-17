-- Private transcription pipeline. No provider requests, schedules, secrets or public payload publication.
-- The singleton lock serializes every reservation/settlement/configuration across workers.
create table public.transcription_settings (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false, paused boolean not null default true,
 key_validated boolean not null default false, contract_validated boolean not null default false,
 phase text not null default 'pilot' check(phase in ('pilot','automatic')),
 monthly_budget_usd numeric(12,6) not null default 5 check(monthly_budget_usd between 0 and 5),
 pilot_limit_usd numeric(12,6) not null default .25 check(pilot_limit_usd between 0 and .25),
 max_starts integer not null default 3 check(max_starts=3),
 concurrency integer not null default 2 check(concurrency=2),
 max_duration_seconds integer not null default 180 check(max_duration_seconds=180),
 max_media_bytes bigint not null default 26214400 check(max_media_bytes=26214400),
 reservation_usd numeric(12,6) not null default .08 check(reservation_usd=.08),
 media_recovery_enabled boolean not null default false check(not media_recovery_enabled),
 manifest_seeded boolean not null default false,
 check(not enabled or (key_validated and contract_validated))
);
insert into public.transcription_settings(singleton) values(true);

create table public.reel_media_sources (
 reel_id uuid primary key references public.reels(id) on delete cascade,
 source_url text, candidates text[] not null default '{}', has_audio boolean,
 observed_at timestamptz not null,
 check(source_url is null or (source_url ~ '^https://' and char_length(source_url)<=8192)),
 check(cardinality(candidates)<=16)
);
create table public.transcript_jobs (
 id uuid primary key default gen_random_uuid(),
 reel_id uuid not null references public.reels(id) on delete cascade,
 model text not null default 'scribe_v2' check(model='scribe_v2'),
 options_version integer not null default 1 check(options_version=1),
 status text not null default 'awaiting_media' check(status in
 ('awaiting_media','queued','submitting','processing','ready','no_speech','media_unavailable','failed','budget_paused','uncertain')),
 attempt_count integer not null default 0 check(attempt_count between 0 and 3),
 current_attempt_id uuid,
 next_attempt_at timestamptz not null default now(),
 created_at timestamptz not null default now(), completed_at timestamptz, error_message text,
 unique(reel_id,model,options_version)
);
create table public.transcript_attempts (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.transcript_jobs(id) on delete cascade,
 attempt_number integer not null check(attempt_number between 1 and 3),
 lease_token uuid not null default gen_random_uuid(), lease_expires_at timestamptz not null,
 provider_job_id text unique, provider_transcription_id text unique,
 status text not null default 'submitting' check(status in ('submitting','processing','ready','no_speech','media_unavailable','failed','uncertain','not_started')),
 phase text not null check(phase in ('pilot','automatic')), billing_month date not null,
 reserved_usd numeric(12,6) not null check(reserved_usd>=0),
 estimated_cost_usd numeric(12,6) check(estimated_cost_usd>=0 and estimated_cost_usd<='10000'),
 accounted_usd numeric(12,6) not null default 0 check(accounted_usd>=0),
 actual_cost_usd numeric(12,6) check(actual_cost_usd>=0 and actual_cost_usd<='10000'),
 reconciled_at timestamptz,
 created_at timestamptz not null default now(), completed_at timestamptz,
 unique(job_id,attempt_number), unique(job_id,id)
);
alter table public.transcript_jobs add constraint transcript_jobs_current_attempt_fk
 foreign key(id,current_attempt_id) references public.transcript_attempts(job_id,id) deferrable initially deferred;
create index transcript_jobs_queue_idx on public.transcript_jobs(status,next_attempt_at,created_at);
create index transcript_attempts_month_idx on public.transcript_attempts(billing_month,phase);
create table public.reel_transcripts (
 reel_id uuid not null references public.reels(id) on delete cascade,
 model text not null check(model='scribe_v2'), options_version integer not null check(options_version=1),
 status text not null check(status in ('ready','no_speech')),
 text text not null check(char_length(text)<=200000), language text check(char_length(language)<=32),
 segments jsonb not null default '[]' check(jsonb_typeof(segments)='array'),
 completed_at timestamptz not null default now(),
 primary key(reel_id,model,options_version)
);

-- Hosted default privileges must not accidentally expose these new tables or functions.
-- No policies grant browser table access, and even service writes go through audited RPCs.
do $$ declare t text; begin
 foreach t in array array['transcription_settings','reel_media_sources','transcript_jobs','transcript_attempts','reel_transcripts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
  execute format('create trigger owner_revision_changed after insert or update or delete on public.%I for each row execute function public.signal_owner_revision()',t);
 end loop;
end $$;

create function public.transcription_enqueue(p_reel_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare st text;
begin
 if not exists(select 1 from public.reels r join public.creators c on c.id=r.creator_id join public.workspace_creators wc on wc.creator_id=r.creator_id
  join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.active and w.archived_at is null and c.status not in ('private','unavailable','paused')) then return 'not_requested'; end if;
 if exists(select 1 from public.reel_transcripts where reel_id=p_reel_id) then
  select status into st from public.reel_transcripts where reel_id=p_reel_id; return st;
 end if;
 select case when m.source_url is not null or cardinality(m.candidates)>0 or m.has_audio=false then 'queued' else 'awaiting_media' end
 into st from public.reel_media_sources m where m.reel_id=p_reel_id;
 st:=coalesce(st,'awaiting_media');
 insert into public.transcript_jobs(reel_id,status) values(p_reel_id,st)
 on conflict(reel_id,model,options_version) do update set status=excluded.status,error_message=null
 where public.transcript_jobs.status in ('awaiting_media','media_unavailable') and public.transcript_jobs.attempt_count<3;
 select status into st from public.transcript_jobs where reel_id=p_reel_id;
 return st;
end $$;

create function public.transcription_valid_media_url(p_url text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select p_url is not null and char_length(p_url)<=8192 and p_url !~ '[[:space:]]'
 and p_url ~ '^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(cdninstagram\.com|fbcdn\.net)/';
$$;

create function public.worker_observe_reel_media(p_reel_id uuid,p_media_source_url text,p_media_candidates jsonb,p_has_audio boolean,p_observed_at timestamptz) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare urls text[]; st text;
begin
 perform public.require_service();
 if not exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id
  join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.active and w.archived_at is null) then
  raise exception 'reel_not_authorized' using errcode='42501';
 end if;
 if p_observed_at is null or p_observed_at>now()+interval '5 minutes' then raise exception 'invalid_media_observation' using errcode='22023'; end if;
 if p_media_source_url is not null and not public.transcription_valid_media_url(p_media_source_url) then raise exception 'invalid_media_source' using errcode='22023'; end if;
 if p_media_candidates is not null and (jsonb_typeof(p_media_candidates)<>'array' or jsonb_array_length(p_media_candidates)>16) then raise exception 'invalid_media_candidates' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_media_candidates,'[]')) x where jsonb_typeof(x)<>'string' or not public.transcription_valid_media_url(x#>>'{}')) then raise exception 'invalid_media_candidates' using errcode='22023'; end if;
 select coalesce(array_agg(distinct value),'{}') into urls from jsonb_array_elements_text(coalesce(p_media_candidates,'[]'));
 -- Empty/missing provider values cannot erase a previously usable observation. Old data cannot overwrite new.
 insert into public.reel_media_sources(reel_id,source_url,candidates,has_audio,observed_at)
 values(p_reel_id,p_media_source_url,urls,p_has_audio,p_observed_at)
 on conflict(reel_id) do update set
 source_url=coalesce(excluded.source_url,public.reel_media_sources.source_url),
 candidates=case when cardinality(excluded.candidates)>0 then excluded.candidates else public.reel_media_sources.candidates end,
 has_audio=coalesce(excluded.has_audio,public.reel_media_sources.has_audio),
 observed_at=excluded.observed_at
 where public.reel_media_sources.observed_at<=excluded.observed_at
 and (excluded.source_url is not null or cardinality(excluded.candidates)>0 or excluded.has_audio is not null);
 st:=public.transcription_enqueue(p_reel_id);
 return jsonb_build_object('status',st);
end $$;

-- Rename the exact current implementation instead of rebuilding the migration004/005 lease/date/count logic.
-- The wrapper calls it inside the same transaction; any invalid media rolls the entire page back.
alter function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) rename to worker_ingest_page_pre_transcription;
revoke all on function public.worker_ingest_page_pre_transcription(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; rec jsonb; rid uuid; kind text;
begin
 perform public.require_service();
 result:=public.worker_ingest_page_pre_transcription(p_job_id,p_lease_token,p_expected_cursor,p_records,p_errors,p_next_cursor,p_finished,p_received_counts);
 if (result->>'duplicate')::boolean then return result; end if;
 select j.kind into kind from public.scrape_jobs j where id=p_job_id;
 if kind<>'profile' then
  for rec in select value from jsonb_array_elements(p_records) loop
   select id into rid from public.reels where shortcode=rec->>'shortcode' and creator_id=(rec->>'creator_id')::uuid;
   -- Unlinked creators are not eligible for new private transcription work.
   if exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id join public.workspaces w on w.id=wc.workspace_id where r.id=rid and wc.active and w.archived_at is null) then
    if (rec ? 'media_source_url' and jsonb_typeof(rec->'media_source_url') not in ('string','null'))
     or (rec ? 'has_audio' and jsonb_typeof(rec->'has_audio') not in ('boolean','null')) then raise exception 'invalid_media_observation' using errcode='22023'; end if;
    perform public.worker_observe_reel_media(rid,rec->>'media_source_url',nullif(rec->'media_candidates','null'::jsonb),(rec->>'has_audio')::boolean,(rec->>'fetched_at')::timestamptz);
   end if;
  end loop;
 end if;
 return result;
end $$;

create function public.get_reel_transcript(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare t public.reel_transcripts; j public.transcript_jobs;
begin
 perform public.require_workspace(p_workspace_id);
 if not exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id
  join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.workspace_id=p_workspace_id and wc.active and w.archived_at is null) then
  raise exception 'reel_not_in_workspace' using errcode='42501';
 end if;
 select * into t from public.reel_transcripts where reel_id=p_reel_id and model='scribe_v2' and options_version=1;
 select * into j from public.transcript_jobs where reel_id=p_reel_id and model='scribe_v2' and options_version=1;
 return jsonb_build_object('reel_id',p_reel_id,'status',coalesce(t.status,j.status,'not_requested'),
 'text',t.text,'language',t.language,'segments',coalesce(t.segments,'[]'::jsonb),'model',coalesce(t.model,j.model),
 'completed_at',coalesce(t.completed_at,j.completed_at),'error_message',case when t.reel_id is null then j.error_message end);
end $$;

create function public.get_transcription_overview() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; result jsonb;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into s from public.transcription_settings where singleton;
 select jsonb_build_object('enabled',s.enabled,'paused',s.paused,'monthly_budget_usd',s.monthly_budget_usd,
 'pilot_limit_usd',s.pilot_limit_usd,'phase',s.phase,
 'estimated_month_spend',coalesce((select sum(accounted_usd) from public.transcript_attempts where billing_month=date_trunc('month',now() at time zone 'UTC')::date),0),
 'reserved_usd',coalesce((select sum(reserved_usd) from public.transcript_attempts),0),
 -- An attempt's known charge is not authoritative account-month billing. Never fabricate a total.
 'actual_month_spend',null,
 'unreconciled_jobs',(select count(distinct job_id) from public.transcript_attempts where reconciled_at is null),
 'jobs',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id) from (
 select j.id,j.reel_id,c.username,j.status,j.attempt_count,j.created_at,j.completed_at,j.error_message
 from public.transcript_jobs j join public.reels r on r.id=j.reel_id join public.creators c on c.id=r.creator_id
 where exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
  where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=auth.uid() and public.is_workspace_member(w.id))
 order by j.created_at desc,j.id limit 100) x),'[]'::jsonb)) into result;
 return result;
end $$;

create function public.update_transcription_preferences(p_paused boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 if p_paused is null then raise exception 'invalid_preference' using errcode='22023'; end if;
 update public.transcription_settings set paused=p_paused where singleton;
 return public.get_transcription_overview();
end $$;

create function public.worker_transcription_configure(p_key_validated boolean,p_enabled boolean default false,p_phase text default 'pilot',p_monthly_budget_usd numeric default 5,p_pilot_limit_usd numeric default .25,p_contract_validated boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 if p_key_validated is null or p_contract_validated is null or p_enabled is null or (p_enabled and not (p_key_validated and p_contract_validated)) or p_phase is null or p_phase not in ('pilot','automatic')
  or p_monthly_budget_usd is null or p_monthly_budget_usd not between 0 and 5 or p_pilot_limit_usd is null or p_pilot_limit_usd not between 0 and .25 then
  raise exception 'invalid_transcription_configuration' using errcode='22023'; end if;
 update public.transcription_settings set key_validated=p_key_validated,contract_validated=p_contract_validated,enabled=p_enabled,phase=p_phase,
 monthly_budget_usd=p_monthly_budget_usd,pilot_limit_usd=p_pilot_limit_usd where singleton returning * into s;
 return to_jsonb(s)-'singleton'-'manifest_seeded';
end $$;

create function public.worker_transcription_manifest(p_limit integer default 41) returns jsonb
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
  items:=items||jsonb_build_array(to_jsonb(r));
 end loop;
 update public.transcription_settings set manifest_seeded=true where singleton;
 return jsonb_build_object('items',items,'already_seeded',false);
end $$;

create function public.worker_transcription_claim(p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.transcription_settings; j public.transcript_jobs; a public.transcript_attempts; r public.reels; m public.reel_media_sources;
 jobs jsonb:='[]'; reason text; outstanding integer; month_spend numeric; held numeric; pilot_spend numeric; pilot_starts integer;
begin
 perform public.require_service(); select * into s from public.transcription_settings where singleton for update;
 if p_limit is null or p_limit not between 1 and 2 then raise exception 'invalid_claim_limit' using errcode='22023'; end if;
 -- An expired dispatch might have been accepted, including during media fetch. Never automatically relaunch it.
 update public.transcript_jobs set status='uncertain',error_message='Acceptance unknown; manual reconciliation required.'
 where status in ('submitting','processing') and current_attempt_id in (select id from public.transcript_attempts where lease_expires_at<now());
 update public.transcript_attempts set status='uncertain' where status in ('submitting','processing') and lease_expires_at<now();
 if not s.enabled or not s.key_validated or not s.contract_validated then reason:='disabled'; elsif s.paused then reason:='paused';
 elsif exists(select 1 from public.transcript_attempts where status='uncertain' and reserved_usd>0) then reason:='uncertain'; end if;
 if reason is not null then return jsonb_build_object('reason',reason,'jobs',jobs); end if;
 select count(*) into outstanding from public.transcript_attempts where status in ('submitting','processing','uncertain');
 for j in select jj.* from public.transcript_jobs jj join public.reels rr on rr.id=jj.reel_id join public.creators c on c.id=rr.creator_id
  where jj.status in ('queued','budget_paused','awaiting_media') and jj.attempt_count<3 and jj.next_attempt_at<=now()
  and c.status not in ('private','unavailable','paused')
  and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=rr.creator_id and wc.active and w.archived_at is null)
  and not exists(select 1 from public.reel_transcripts t where t.reel_id=jj.reel_id)
  order by jj.created_at,jj.id for update of jj loop
  exit when jsonb_array_length(jobs)>=p_limit;
  select * into r from public.reels where id=j.reel_id;
  select * into m from public.reel_media_sources where reel_id=j.reel_id;
  if m.has_audio=false then
   insert into public.reel_transcripts(reel_id,model,options_version,status,text) values(j.reel_id,j.model,j.options_version,'no_speech','') on conflict do nothing;
   update public.transcript_jobs set status='no_speech',completed_at=now(),error_message=null where id=j.id; continue;
  end if;
  if r.duration_seconds is null or r.duration_seconds<.1 then
   update public.transcript_jobs set status='media_unavailable',error_message='Media duration unavailable; automatic recovery disabled.' where id=j.id; continue;
  elsif r.duration_seconds>s.max_duration_seconds then
   update public.transcript_jobs set status='media_unavailable',error_message='Media exceeds the duration limit.' where id=j.id; continue;
  end if;
  if m.source_url is null and coalesce(cardinality(m.candidates),0)=0 then
   update public.transcript_jobs set status='awaiting_media',error_message=null where id=j.id; continue;
  end if;
  if outstanding>=s.concurrency then reason:='concurrency'; exit; end if;
  select coalesce(sum(accounted_usd) filter(where billing_month=date_trunc('month',now() at time zone 'UTC')::date),0),coalesce(sum(reserved_usd),0),
  coalesce(sum(accounted_usd+reserved_usd) filter(where phase='pilot'),0),count(*) filter(where phase='pilot')
  into month_spend,held,pilot_spend,pilot_starts from public.transcript_attempts;
  if month_spend+held+s.reservation_usd>s.monthly_budget_usd or
   (s.phase='pilot' and (pilot_starts>=s.max_starts or pilot_spend+s.reservation_usd>s.pilot_limit_usd)) then
   update public.transcript_jobs set status='budget_paused',error_message='Transcription budget or pilot start limit reached.' where id=j.id;
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

-- The settings -> job -> attempt lock order is common to all worker settlements.
create function public.transcription_locked_attempt(p_attempt_id uuid,p_lease_token uuid) returns public.transcript_attempts
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; j public.transcript_jobs; jid uuid;
begin
 select job_id into jid from public.transcript_attempts where id=p_attempt_id;
 select * into j from public.transcript_jobs where id=jid for update;
 select * into a from public.transcript_attempts where id=p_attempt_id for update;
 if a.id is null or p_lease_token is null or a.lease_token is distinct from p_lease_token or j.current_attempt_id is distinct from a.id then raise exception 'lease_expired' using errcode='40001'; end if;
 return a;
end $$;

create function public.worker_transcription_attach(p_attempt_id uuid,p_lease_token uuid,p_provider_job_id text,p_provider_transcription_id text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
 if p_provider_job_id is null or char_length(p_provider_job_id) not between 1 and 200
  or (p_provider_transcription_id is not null and char_length(p_provider_transcription_id) not between 1 and 200) then raise exception 'invalid_provider_job_id' using errcode='22023'; end if;
 if (a.provider_job_id is not null and a.provider_job_id<>p_provider_job_id)
  or (a.provider_transcription_id is not null and p_provider_transcription_id is not null and a.provider_transcription_id<>p_provider_transcription_id) then raise exception 'provider_job_mismatch' using errcode='40001'; end if;
 if a.status in ('ready','no_speech','failed','media_unavailable','not_started') then
  -- Completion may arrive before the submission response. Attach identity without downgrading the result.
  update public.transcript_attempts set provider_job_id=coalesce(provider_job_id,p_provider_job_id),provider_transcription_id=coalesce(provider_transcription_id,p_provider_transcription_id) where id=a.id;
  return jsonb_build_object('status',a.status,'duplicate',true);
 end if;
 if a.status='uncertain' or a.lease_expires_at<now() then
  -- A signed late callback may establish identity after timeout. Keep its hold/status until completion.
  update public.transcript_attempts set provider_job_id=coalesce(provider_job_id,p_provider_job_id),provider_transcription_id=coalesce(provider_transcription_id,p_provider_transcription_id),status='uncertain' where id=a.id;
  update public.transcript_jobs set status='uncertain',error_message='Acceptance unknown; manual reconciliation required.' where id=a.job_id;
  return jsonb_build_object('status','uncertain','duplicate',a.provider_job_id is not null);
 end if;
 update public.transcript_attempts set provider_job_id=p_provider_job_id,provider_transcription_id=coalesce(provider_transcription_id,p_provider_transcription_id),status='processing' where id=a.id;
 update public.transcript_jobs set status='processing' where id=a.job_id;
 return jsonb_build_object('status','processing','duplicate',a.provider_job_id is not null);
end $$;

create function public.worker_transcription_complete(p_attempt_id uuid,p_lease_token uuid,p_text text,p_language text default null,p_segments jsonb default '[]',p_no_speech boolean default false,p_estimated_cost_usd numeric default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; j public.transcript_jobs; st text; seg jsonb; normalized jsonb:='[]'; last_end numeric:=0; start_ms numeric; end_ms numeric;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
 if a.status in ('ready','no_speech') then return jsonb_build_object('status',a.status,'duplicate',true); end if;
 if a.status not in ('submitting','processing','uncertain') then raise exception 'attempt_not_completable' using errcode='40001'; end if;
 if p_text is null or char_length(p_text)>200000 or (p_language is not null and char_length(p_language)>32) or p_no_speech is null
  or p_segments is null or jsonb_typeof(p_segments)<>'array' or jsonb_array_length(p_segments)>5000
  or (p_estimated_cost_usd is not null and p_estimated_cost_usd not between 0 and 10000) then raise exception 'invalid_transcript' using errcode='22023'; end if;
 for seg in select value from jsonb_array_elements(p_segments) loop
  if jsonb_typeof(seg)<>'object' or jsonb_typeof(seg->'start_ms') is distinct from 'number' or jsonb_typeof(seg->'end_ms') is distinct from 'number'
   or jsonb_typeof(seg->'text') is distinct from 'string' then raise exception 'invalid_segments' using errcode='22023'; end if;
  start_ms:=(seg->>'start_ms')::numeric; end_ms:=(seg->>'end_ms')::numeric;
  if start_ms<0 or end_ms<start_ms or end_ms>180000 or start_ms<>trunc(start_ms) or end_ms<>trunc(end_ms) or start_ms<last_end or char_length(seg->>'text')>200000 then raise exception 'invalid_segments' using errcode='22023'; end if;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('start_ms',start_ms,'end_ms',end_ms,'text',seg->>'text')); last_end:=end_ms;
 end loop;
 st:=case when p_no_speech or btrim(p_text)='' then 'no_speech' else 'ready' end;
 select * into j from public.transcript_jobs where id=a.job_id;
 insert into public.reel_transcripts(reel_id,model,options_version,status,text,language,segments)
 values(j.reel_id,j.model,j.options_version,st,case when st='no_speech' then '' else p_text end,p_language,case when st='no_speech' then '[]'::jsonb else normalized end) on conflict do nothing;
 select status into st from public.reel_transcripts where reel_id=j.reel_id and model=j.model and options_version=j.options_version;
 update public.transcript_attempts set status=st,completed_at=now(),estimated_cost_usd=p_estimated_cost_usd,
 accounted_usd=greatest(accounted_usd,reserved_usd,coalesce(p_estimated_cost_usd,0)),reserved_usd=0 where id=a.id;
 update public.transcript_jobs set status=st,completed_at=now(),error_message=null where id=j.id;
 return jsonb_build_object('status',st,'duplicate',false);
end $$;

create function public.worker_transcription_fail(p_attempt_id uuid,p_lease_token uuid,p_status text,p_error_message text default null,p_estimated_cost_usd numeric default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; j public.transcript_jobs; st text; msg text;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
 if a.status in ('ready','no_speech','failed','media_unavailable','not_started') then return jsonb_build_object('status',a.status,'duplicate',true); end if;
 if p_status is null or p_status not in ('uncertain','media_unavailable','failed') or (p_estimated_cost_usd is not null and p_estimated_cost_usd not between 0 and 10000) then raise exception 'invalid_failure' using errcode='22023'; end if;
 -- Caller detail is deliberately NOT copied to a browser-visible field (may contain signed URLs or secrets).
 msg:=case p_status when 'uncertain' then 'Acceptance unknown; manual reconciliation required.' when 'media_unavailable' then 'Media unavailable or exceeds download limits; automatic recovery disabled.' else 'Transcription failed.' end;
 select * into j from public.transcript_jobs where id=a.job_id;
 if a.status='uncertain' and p_status<>'uncertain' then raise exception 'reconciliation_required' using errcode='40001'; end if;
 update public.transcript_attempts set status=p_status,completed_at=case when p_status<>'uncertain' then now() end,estimated_cost_usd=p_estimated_cost_usd,
 accounted_usd=case when p_status='uncertain' then accounted_usd else greatest(accounted_usd,reserved_usd,coalesce(p_estimated_cost_usd,0)) end,
 reserved_usd=case when p_status='uncertain' then reserved_usd else 0 end where id=a.id;
 st:=case when p_status='failed' and j.attempt_count<3 then 'queued' else p_status end;
 update public.transcript_jobs set status=st,error_message=msg,next_attempt_at=now()+interval '5 minutes',completed_at=case when st in ('failed','media_unavailable') then now() end where id=j.id;
 return jsonb_build_object('status',st,'duplicate',a.status=p_status);
end $$;

-- Only the worker's verified provider-error path calls this after attaching the callback request identity.
-- Generic timeouts cannot turn uncertainty into confirmed failure or release an acceptance hold.
create function public.worker_transcription_provider_failure(p_attempt_id uuid,p_lease_token uuid,p_provider_job_id text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; j public.transcript_jobs; duplicate boolean;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 a:=public.transcription_locked_attempt(p_attempt_id,p_lease_token);
 if p_provider_job_id is null or a.provider_job_id is null or a.provider_job_id is distinct from p_provider_job_id then
  raise exception 'provider_job_mismatch' using errcode='40001';
 end if;
 if a.status in ('ready','no_speech') then return jsonb_build_object('status',a.status,'duplicate',true); end if;
 if a.status not in ('submitting','processing','uncertain','failed') then raise exception 'attempt_not_failable' using errcode='40001'; end if;
 select * into j from public.transcript_jobs where id=a.job_id;
 duplicate:=a.status='failed' and j.status='failed';
 if duplicate then return jsonb_build_object('status','failed','duplicate',true); end if;
 update public.transcript_attempts set status='failed',completed_at=coalesce(completed_at,now()),
  accounted_usd=greatest(accounted_usd,reserved_usd,coalesce(estimated_cost_usd,0)),reserved_usd=0 where id=a.id;
 -- Acceptance is confirmed but the provider failed. Do not automatically pay for another attempt.
 update public.transcript_jobs set status='failed',completed_at=coalesce(completed_at,now()),
  error_message='Provider confirmed transcription failure.' where id=j.id;
 return jsonb_build_object('status','failed','duplicate',false);
end $$;

create function public.worker_transcription_reconcile(p_attempt_id uuid,p_outcome text,p_actual_cost_usd numeric default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.transcript_attempts; j public.transcript_jobs; jid uuid; st text;
begin
 perform public.require_service(); perform 1 from public.transcription_settings where singleton for update;
 select job_id into jid from public.transcript_attempts where id=p_attempt_id;
 select * into j from public.transcript_jobs where id=jid for update;
 select * into a from public.transcript_attempts where id=p_attempt_id for update;
 if a.id is null then raise exception 'attempt_not_found' using errcode='22023'; end if;
 if p_outcome is null or p_outcome not in ('charged','not_started') or (p_actual_cost_usd is not null and p_actual_cost_usd not between 0 and 10000)
  or (p_outcome='charged' and p_actual_cost_usd is null) or (p_outcome='not_started' and coalesce(p_actual_cost_usd,0)<>0) then raise exception 'invalid_reconciliation' using errcode='22023'; end if;
 if a.reconciled_at is not null then
  if (p_outcome='not_started')<>(a.status='not_started') or coalesce(p_actual_cost_usd,0)<>coalesce(a.actual_cost_usd,0) then raise exception 'reconciliation_mismatch' using errcode='40001'; end if;
  return jsonb_build_object('status',j.status);
 end if;
 if p_outcome='not_started' then
  if a.status<>'uncertain' then raise exception 'nonacceptance_requires_uncertain' using errcode='40001'; end if;
  update public.transcript_attempts set status='not_started',reserved_usd=0,accounted_usd=0,actual_cost_usd=0,reconciled_at=now(),completed_at=now() where id=a.id;
  if j.current_attempt_id=a.id then
   update public.transcript_jobs set status=case when attempt_count<3 then 'queued' else 'failed' end,next_attempt_at=now(),error_message='Provider nonacceptance verified.' where id=j.id returning status into st;
  end if;
 else
  if a.status in ('submitting','processing') then raise exception 'attempt_still_active' using errcode='40001'; end if;
  update public.transcript_attempts set accounted_usd=greatest(accounted_usd,reserved_usd,p_actual_cost_usd),reserved_usd=0,actual_cost_usd=p_actual_cost_usd,reconciled_at=now(),
   status=case when status='uncertain' then 'failed' else status end,completed_at=coalesce(completed_at,now()) where id=a.id;
  if j.current_attempt_id=a.id and j.status='uncertain' then
   -- Charged but no result: terminal, not eligible for a blind paid retry.
   update public.transcript_jobs set status='failed',completed_at=now(),error_message='Charge verified but transcript unavailable.' where id=j.id returning status into st;
  end if;
 end if;
 return jsonb_build_object('status',coalesce(st,j.status));
end $$;

create function public.worker_transcription_config() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 return (select to_jsonb(s)-'singleton'-'manifest_seeded' from public.transcription_settings s where singleton);
end $$;

create function public.worker_transcription_candidates(p_limit integer default 10) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_candidate_limit' using errcode='22023'; end if;
 return jsonb_build_object('jobs',coalesce((select jsonb_agg(to_jsonb(x)) from (
  select j.id,j.reel_id,a.id attempt_id,a.lease_token,a.provider_job_id,a.provider_transcription_id,a.status
  from public.transcript_attempts a join public.transcript_jobs j on j.id=a.job_id and j.current_attempt_id=a.id
  where a.status in ('submitting','processing','uncertain') order by a.created_at,a.id limit p_limit
 ) x),'[]'::jsonb));
end $$;

create function public.worker_transcription_callback_context(p_attempt_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_service();
 return jsonb_build_object('job',(select jsonb_build_object('id',j.id,'reel_id',j.reel_id,'attempt_id',a.id,'lease_token',a.lease_token,
  'provider_job_id',a.provider_job_id,'provider_transcription_id',a.provider_transcription_id,'status',a.status,'model',j.model,'duration_seconds',r.duration_seconds,'max_duration_seconds',s.max_duration_seconds)
  from public.transcript_attempts a join public.transcript_jobs j on j.id=a.job_id and j.current_attempt_id=a.id
  join public.reels r on r.id=j.reel_id cross join public.transcription_settings s where a.id=p_attempt_id and s.singleton));
end $$;

-- Only explicitly enumerated browser/service entry points survive hosted default grants.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like 'worker_transcription_%' or p.proname in
 ('transcription_enqueue','transcription_valid_media_url','transcription_locked_attempt','worker_observe_reel_media','get_reel_transcript','get_transcription_overview','update_transcription_preferences','worker_ingest_page')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  if f.proname in ('get_reel_transcript','get_transcription_overview','update_transcription_preferences') then
   execute format('grant execute on function %s to authenticated',f.signature);
  elsif f.proname like 'worker_transcription_%' or f.proname in ('worker_observe_reel_media','worker_ingest_page') then
   execute format('grant execute on function %s to service_role',f.signature);
  end if;
 end loop;
end $$;
