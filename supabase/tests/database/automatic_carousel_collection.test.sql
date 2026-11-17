-- Isolated SQL regression suite. Run after the local migration chain in an empty
-- disposable PostgreSQL/PGlite database. All fixtures and assertions roll back.
-- No provider calls or enabled schedules are required (or permitted).
begin;
create function pg_temp.assert_true(p_value boolean,p_label text) returns void
language plpgsql as $$ begin if p_value is distinct from true then raise exception 'assertion_failed: %',p_label; end if; end $$;
create function pg_temp.assert_error(p_sql text,p_code text,p_message text) returns void
language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate=p_code and position(p_message in sqlerrm)>0 then return; end if;
    raise exception 'unexpected_error [%] %',sqlstate,sqlerrm;
  end;
  raise exception 'expected_error_missing: %',p_sql;
end $$;

create function pg_temp.http_requests() returns jsonb language plpgsql as $$
declare result jsonb;
begin
 if to_regclass('net.requests') is not null then
  execute 'select coalesce(jsonb_agg(to_jsonb(r) order by id),''[]'') from net.requests r' into result;
 elsif to_regclass('net.http_request_queue') is not null then
  execute 'select coalesce(jsonb_agg(to_jsonb(r) order by id),''[]'') from net.http_request_queue r' into result;
 else result:='[]'::jsonb; end if;
 return result;
end $$;

insert into auth.users(id) values('ca100000-0000-4000-8000-000000000001'),('ca100000-0000-4000-8000-000000000002');
select set_config('request.jwt.claims','{"role":"service_role","sub":"ca100000-0000-4000-8000-000000000001"}',true);
select public.provision_owner('ca100000-0000-4000-8000-000000000001');
update public.app_settings set scraping_enabled=true,paused=false,monthly_budget_usd=50,capacity=1000;
select public.worker_configure_apify_account('ca100000-0000-4000-8000-000000000001',1,'carousel-fixture-account',true,true);
select public.worker_record_account_usage('ca100000-0000-4000-8000-000000000001',1,'carousel-fixture-account',now()-interval '1 day',now()+interval '20 days',0,50);
insert into public.workspaces(id,owner_user_id,name,slug) values
  ('ca200000-0000-4000-8000-000000000001','ca100000-0000-4000-8000-000000000001','Carousel fixtures','carousel-fixtures'),
  ('ca200000-0000-4000-8000-000000000002','ca100000-0000-4000-8000-000000000001','Shared fixtures','shared-fixtures'),
  ('ca200000-0000-4000-8000-000000000003','ca100000-0000-4000-8000-000000000001','Archived fixtures','archived-fixtures'),
  ('ca200000-0000-4000-8000-000000000004','ca100000-0000-4000-8000-000000000001','No membership fixtures','no-membership-fixtures');
insert into public.workspace_members(workspace_id,user_id)
select id,'ca100000-0000-4000-8000-000000000001' from public.workspaces where slug<>'no-membership-fixtures';
update public.workspaces set archived_at=now() where slug='archived-fixtures';
insert into public.creators(id,username,status)
select ('ca300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'carousel_fixture_'||n,'active' from generate_series(1,129) n;
insert into public.workspace_creators(workspace_id,creator_id)
select 'ca200000-0000-4000-8000-000000000001',id from public.creators where username<>'carousel_fixture_129';
insert into public.workspace_creators(workspace_id,creator_id)
select 'ca200000-0000-4000-8000-000000000002',id from public.creators where username='carousel_fixture_1';
insert into public.workspace_creators(workspace_id,creator_id)
select 'ca200000-0000-4000-8000-000000000003',id from public.creators where username='carousel_fixture_129';
update public.creators set status='private' where username='carousel_fixture_126';
update public.creators set status='unavailable' where username='carousel_fixture_127';
update public.creators set status='paused' where username='carousel_fixture_128';
create temporary table fixture_jobs(label text primary key,id uuid);
create temporary table fixture_snapshot(kind text primary key,rows jsonb);
insert into fixture_snapshot values
 ('schedules',(select coalesce(jsonb_agg(to_jsonb(j) order by jobid),'[]') from cron.job j)),
 ('requests',pg_temp.http_requests());

-- Restrictive ACLs despite hosted permissive defaults; helpers cannot bypass claims.
select pg_temp.assert_true(not has_function_privilege('authenticated','public.worker_carousel_maintain(uuid,integer)','execute'),'maintenance service-only');
select pg_temp.assert_true(not has_function_privilege('anon','public.worker_carousel_maintain(uuid,integer)','execute'),'maintenance anonymous denied');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.worker_configure_carousel_automation(uuid,boolean,boolean)','execute'),'configuration service-only');
select pg_temp.assert_true(has_function_privilege('service_role','public.worker_configure_carousel_automation(uuid,boolean,boolean)','execute'),'configuration service allowed');
select pg_temp.assert_true(has_function_privilege('authenticated','public.get_carousel_collection_status(uuid)','execute'),'owner status allowed');
select pg_temp.assert_true(not has_function_privilege('service_role','public.get_carousel_collection_status(uuid)','execute'),'status requires owner identity');
select pg_temp.assert_true(not has_function_privilege('anon','public.get_carousel_collection_status(uuid)','execute'),'anonymous status denied');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.carousel_automation_settings','update'),'configuration cannot be changed by browser');
select pg_temp.assert_true(not has_table_privilege('service_role','public.carousel_automation_settings','update'),'configuration mutation requires validated RPC');
select pg_temp.assert_true(not has_function_privilege('service_role','public.worker_claim_dispatch_pre_carousel_automation(uuid,boolean,text,text)','execute'),'old wrapper not callable');
select pg_temp.assert_true(not has_function_privilege('service_role','carousel_automation_private.cadence(uuid,uuid)','execute'),'private cadence not callable');
select pg_temp.assert_true((select relrowsecurity from pg_class where oid='public.carousel_automation_settings'::regclass),'configuration RLS');
select pg_temp.assert_error($q$select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',true,false)$q$,'22023','invalid_carousel_automation_configuration');
select pg_temp.assert_error($q$select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000002',true,true)$q$,'42501','owner_not_provisioned');
select pg_temp.assert_error($q$select public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001',11)$q$,'22023','invalid_carousel_maintenance_scope');
select pg_temp.assert_error($q$select public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001',0)$q$,'22023','invalid_carousel_maintenance_scope');
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000002')->>'reason'='owner_not_provisioned','foreign owner cannot create jobs');
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'reason'='setup_required','default automation fail closed');
select pg_temp.assert_true((select count(*)=0 from public.scrape_jobs),'default disabled means no work');

select set_config('request.jwt.claims','{"role":"authenticated","sub":"ca100000-0000-4000-8000-000000000001"}',true);
select pg_temp.assert_true(public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000001') @>
 '{"enabled":false,"provider_validated":false,"paused":false,"reason":"setup_required","pending_jobs":0,"active_jobs":0,"last_fetch_at":null,"next_due_at":null,"interval_hours":24,"window_limit":30}','initial status contract');
select pg_temp.assert_error($q$select public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')$q$,'42501','service_role_required');
select pg_temp.assert_error($q$select public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000004')$q$,'42501','forbidden');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"ca100000-0000-4000-8000-000000000002"}',true);
insert into public.workspace_members(workspace_id,user_id) values('ca200000-0000-4000-8000-000000000001','ca100000-0000-4000-8000-000000000002');
select pg_temp.assert_error($q$select public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000001')$q$,'42501','forbidden');
select set_config('request.jwt.claims','{"role":"service_role","sub":"ca100000-0000-4000-8000-000000000001"}',true);
select pg_temp.assert_true(public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',true,true)='{"enabled":true,"provider_validated":true}'::jsonb,'explicit service configuration return');
select pg_temp.assert_true((select count(*)=0 from public.scrape_jobs),'configuration never enqueues');

-- Legacy queue reuse is bounded and preserves historical low priority/identity.
insert into public.scrape_jobs(id,owner_user_id,kind,results_limit,requested_profiles_count,priority)
select ('ca400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'ca100000-0000-4000-8000-000000000001','carousel',30,1,0 from generate_series(1,15) n;
insert into public.scrape_job_creators(job_id,creator_id)
select ('ca400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('ca300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,15) n;
do $$ declare result jsonb; begin
 result:=public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001');
 perform pg_temp.assert_true(result->>'created'='0' and result->>'adopted'='10' and jsonb_array_length(result->'job_ids')=10,'default call adopts ten and creates zero');
 perform pg_temp.assert_true((select count(*)=15 from public.scrape_jobs),'adoption does not duplicate backlog');
 perform pg_temp.assert_true((select count(*)=10 from public.scrape_jobs where carousel_automatic),'ten marked authorized');
 perform pg_temp.assert_true((select bool_and(priority=0 and manual_authorized_by=owner_user_id and carousel_automation_scheduled_at=now()) from public.scrape_jobs where carousel_automatic),'adoption preserves priority and stamps owner consent');
end $$;

-- More than 120 creators progress over successive bounded invocations.
do $$ declare result jsonb; i integer; begin
 for i in 1..20 loop
  result:=public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001');
  perform pg_temp.assert_true(jsonb_array_length(result->'job_ids')<=10,'each continuation bound');
 end loop;
 perform pg_temp.assert_true((select count(*)=125 from public.scrape_jobs where kind='carousel'),'all 125 eligible canonical creators eventually queued once');
 perform pg_temp.assert_true((select count(distinct creator_id)=125 from public.scrape_job_creators),'shared creator deduplicated across workspaces');
 perform pg_temp.assert_true((select bool_and(results_limit=30 and requested_profiles_count=1 and actual_cost_usd is null and reserved_usd=0 and not live) from public.scrape_jobs),'one creator thirty photos no cost assumptions or reservations');
 perform pg_temp.assert_true((select bool_and(priority=5) from public.scrape_jobs where id::text not like 'ca400000%'),'new carousel priority below discovery metrics and initial backfill');
 perform pg_temp.assert_true((select count(*)=0 from public.scrape_job_creators where creator_id::text>='ca300000-0000-4000-8000-000000000126'),'private unavailable paused archived excluded');
 result:=public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001');
 perform pg_temp.assert_true(result @> '{"created":0,"adopted":0,"job_ids":[]}','repeated maintenance idempotent');
end $$;
insert into fixture_jobs select 'first',job_id from public.scrape_job_creators where creator_id='ca300000-0000-4000-8000-000000000001';
insert into fixture_snapshot values('jobs',(select jsonb_agg(to_jsonb(j) order by id) from public.scrape_jobs j));
select set_config('request.jwt.claims','{"role":"authenticated","sub":"ca100000-0000-4000-8000-000000000001"}',true);
select pg_temp.assert_true(public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000001') @> '{"pending_jobs":125,"active_jobs":0,"enabled":true,"reason":null}','workspace pending includes all selected carousel jobs');
select pg_temp.assert_true(public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000002') @> '{"pending_jobs":1,"active_jobs":0}','shared selected scope count does not multiply');
select pg_temp.assert_true(public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000003')->>'reason'='paused','archived workspace status paused');
select pg_temp.assert_true((select rows=(select jsonb_agg(to_jsonb(j) order by id) from public.scrape_jobs j) from fixture_snapshot where kind='jobs'),'status reads do not schedule or stamp jobs');
select set_config('request.jwt.claims','{"role":"service_role","sub":"ca100000-0000-4000-8000-000000000001"}',true);

-- Global switches and disabled configuration are rechecked AFTER queueing.
select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',false,true);
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'reason'='disabled','disabled maintenance inert');
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='disabled','queued automatic work not claimed after disable');
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',false,'mock-actor','carousel')->>'reason'='disabled','disabled automation also blocks dry automatic claims');
select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',false,false);
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='setup_required','queued automatic work blocks provider unvalidation');
select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',true,true);
update public.app_settings set paused=true;
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'reason'='paused','paused maintenance inert');
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='paused','all carousel claims honor pause');
update public.app_settings set paused=false,scraping_enabled=false;
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'reason'='scraping_disabled','global scraping off maintenance inert');
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='globalscraping_disabled','global scraping off claims inert');
update public.app_settings set scraping_enabled=true;
select pg_temp.assert_true((select sum(reserved_usd)=0 and bool_and(actual_cost_usd is null) from public.scrape_jobs),'blocked claims neither reserve nor invent final charges');

-- Unlink excludes scheduling; existing paid allocator still rejects an empty job.
update public.workspace_creators set active=false where creator_id='ca300000-0000-4000-8000-000000000001';
select set_config('reelradar.media_job_id',(select id::text from fixture_jobs where label='first'),true);
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='empty_job','unlinked automatic job cannot start');
select set_config('reelradar.media_job_id','',true);
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'created'='0','unlinked creator not recreated');
update public.workspace_creators set active=true where creator_id='ca300000-0000-4000-8000-000000000001';

-- Real reservation still comes only from the original owner/account allocator.
update public.app_settings set monthly_budget_usd=0;
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='budget_paused','owner monthly zero budget gate preserved');
update public.app_settings set monthly_budget_usd=50;
select public.worker_invalidate_account_usage('ca100000-0000-4000-8000-000000000001',1);
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='live_setup_or_usage_unverified','authoritative usage gate preserved');
select public.worker_record_account_usage('ca100000-0000-4000-8000-000000000001',1,'carousel-fixture-account',now()-interval '1 day',now()+interval '20 days',50,50);
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='budget_paused','verified account allowance exhaustion preserved');
select public.worker_record_account_usage('ca100000-0000-4000-8000-000000000001',1,'carousel-fixture-account',now()-interval '1 day',now()+interval '20 days',0,50);
do $$ declare result jsonb; jid uuid; begin
 result:=public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel');
 jid:=(result->'job'->>'id')::uuid;
 perform pg_temp.assert_true(jid is not null and (result->>'max_total_charge_usd')::numeric>0,'enabled automatic job claims through allocator');
 perform pg_temp.assert_true((result->'job'->>'reserved_usd')::numeric=(result->>'max_total_charge_usd')::numeric,'matching transactional cap and hold');
 perform pg_temp.assert_true(result->'job'->>'apify_account_slot'='1' and result->'job'->>'expected_provider_user_id'='carousel-fixture-account','claim pins account identity');
 perform pg_temp.assert_true(result->'job'->>'actual_cost_usd' is null,'claim cost remains unknown');
 perform pg_temp.assert_true(coalesce(current_setting('reelradar.media_job_id',true),'')='','wrapper restores prior target');
 insert into fixture_jobs values('paid',jid);
 perform public.worker_start_uncertain(jid,(result->'job'->>'dispatch_nonce')::uuid);
 perform pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='unreconciled_charges','uncertain account hold blocks later paid claims');
 perform pg_temp.assert_true((select reserved_usd=(result->>'max_total_charge_usd')::numeric and actual_cost_usd is null from public.scrape_jobs where id=jid),'uncertain hold retained unchanged');
end $$;

-- Concurrency and processing exhaustion are not reset by automatic maintenance.
update public.scrape_jobs set carousel_automation_scheduled_at=now()-interval '25 hours';
update public.scrape_jobs set status='processing',processing_attempts=10 where id in
 (select job_id from public.scrape_job_creators where creator_id='ca300000-0000-4000-8000-000000000004');
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'created'='1','only detached-then-relinked unstarted failed job becomes due after 24 hours');
select pg_temp.assert_true((select count(*)=1 from public.scrape_job_creators where creator_id in
 (select creator_id from public.scrape_job_creators where job_id=(select id from fixture_jobs where label='paid'))),'uncertain creator has no duplicate job');
select pg_temp.assert_true((select count(*)=1 from public.scrape_job_creators where creator_id='ca300000-0000-4000-8000-000000000004'),'exhausted processing creator has no duplicate job');
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',true,'fixture-actor','carousel')->>'reason'='concurrency_limit','two active jobs preserve concurrency cap');
select pg_temp.assert_true((select processing_attempts=10 and status='processing' from public.scrape_jobs where id in
 (select job_id from public.scrape_job_creators where creator_id='ca300000-0000-4000-8000-000000000004')),'exhausted processing metadata unchanged');

-- A successful verified empty photo feed advances freshness and daily cadence,
-- while a missing authoritative charge stays null and its reservation survives.
update public.scrape_jobs set status='succeeded',provider_terminal_status='SUCCEEDED',dataset_finished=true,output_summary_verified=true,
 completed_at=now(),result_fetched_at=now(),live=true where id=(select id from fixture_jobs where label='paid');
update public.scrape_job_creators set completion_status='completed',summary_authoritative=true,summary_delivered_count=0,
 status='active',result_count=0,error_message=null where job_id=(select id from fixture_jobs where label='paid');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"ca100000-0000-4000-8000-000000000001"}',true);
select pg_temp.assert_true((public.get_carousel_collection_status('ca200000-0000-4000-8000-000000000001')->>'last_fetch_at')::timestamptz=now(),'verified empty successful feed counts as last fetch');
select pg_temp.assert_true((select actual_cost_usd is null and reserved_usd>0 from public.scrape_jobs where id=(select id from fixture_jobs where label='paid')),'output success does not reconcile charges');
select set_config('request.jwt.claims','{"role":"service_role","sub":"ca100000-0000-4000-8000-000000000001"}',true);
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'created'='0','successful empty feed cooldown prevents duplicate');

-- New creators do not wait for a 120-item window or unrelated pending Reel work.
insert into public.creators(id,username,status) values('ca300000-0000-4000-8000-000000000130','carousel_fixture_new','active');
insert into public.workspace_creators(workspace_id,creator_id) values('ca200000-0000-4000-8000-000000000001','ca300000-0000-4000-8000-000000000130');
insert into public.scrape_jobs(id,owner_user_id,kind,results_limit,requested_profiles_count,priority)
values('ca400000-0000-4000-8000-000000000130','ca100000-0000-4000-8000-000000000001','backfill',100,1,80);
insert into public.scrape_job_creators(job_id,creator_id) values('ca400000-0000-4000-8000-000000000130','ca300000-0000-4000-8000-000000000130');
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001',1)->>'created'='1','new canonical creator progresses independently of Reel backfill');
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'created'='0','new creator daily duplicate prevented');

-- Disable automatic work without starving an explicitly authorized manual pilot.
-- Normal account holds still apply; use dry claim to prove selection only.
select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',false,false);
insert into public.scrape_jobs(id,owner_user_id,kind,results_limit,requested_profiles_count,priority,manual_authorized_by)
values('ca400000-0000-4000-8000-000000000140','ca100000-0000-4000-8000-000000000001','carousel',30,1,0,'ca100000-0000-4000-8000-000000000001');
insert into public.scrape_job_creators(job_id,creator_id) values('ca400000-0000-4000-8000-000000000140','ca300000-0000-4000-8000-000000000125');
update public.scrape_jobs set status='failed' where status='processing';
select pg_temp.assert_true(public.worker_claim_dispatch('ca100000-0000-4000-8000-000000000001',false,'mock-actor','carousel')->'job'->>'id'='ca400000-0000-4000-8000-000000000140','manual candidate behind disabled automatic jobs still selected');
select pg_temp.assert_true((select reserved_usd=0 and not live and not carousel_automatic from public.scrape_jobs where id='ca400000-0000-4000-8000-000000000140'),'manual flag and no dry budget spend preserved');

-- Preserve a legacy shared batch rather than changing its shape or duplicating
-- either creator. Exhausted processing remains an operator task after failure.
select public.worker_configure_carousel_automation('ca100000-0000-4000-8000-000000000001',true,true);
insert into public.creators(id,username,status) values
 ('ca300000-0000-4000-8000-000000000141','carousel_fixture_shared_a','active'),
 ('ca300000-0000-4000-8000-000000000142','carousel_fixture_shared_b','active');
insert into public.workspace_creators(workspace_id,creator_id) values
 ('ca200000-0000-4000-8000-000000000001','ca300000-0000-4000-8000-000000000141'),
 ('ca200000-0000-4000-8000-000000000002','ca300000-0000-4000-8000-000000000142');
insert into public.scrape_jobs(id,owner_user_id,kind,results_limit,requested_profiles_count,priority)
values('ca400000-0000-4000-8000-000000000141','ca100000-0000-4000-8000-000000000001','carousel',30,2,0);
insert into public.scrape_job_creators(job_id,creator_id) values
 ('ca400000-0000-4000-8000-000000000141','ca300000-0000-4000-8000-000000000141'),
 ('ca400000-0000-4000-8000-000000000141','ca300000-0000-4000-8000-000000000142');
select pg_temp.assert_true(public.worker_carousel_maintain('ca100000-0000-4000-8000-000000000001')->>'created'='0','legacy shared batch and failed exhausted-processing jobs block duplicate creation');
select pg_temp.assert_true((select not carousel_automatic and manual_authorized_by is null and requested_profiles_count=2 and priority=0
 from public.scrape_jobs where id='ca400000-0000-4000-8000-000000000141'),'shared legacy batch metadata left intact');
select pg_temp.assert_true((select count(*)=2 from public.scrape_job_creators where job_id='ca400000-0000-4000-8000-000000000141'),'shared legacy links preserved');
select pg_temp.assert_true((select count(*)=1 from public.scrape_job_creators where creator_id='ca300000-0000-4000-8000-000000000004'),'terminal exhausted processing never retried with a fresh paid job');
select pg_temp.assert_true((select rows=(select coalesce(jsonb_agg(to_jsonb(j) order by jobid),'[]') from cron.job j) from fixture_snapshot where kind='schedules'),'no schedule created or enabled');
select pg_temp.assert_true((select rows=pg_temp.http_requests() from fixture_snapshot where kind='requests'),'no external request from maintenance config status claims');
-- TAP trailer lets pg_prove/Supabase's SQL runner consume the assertion suite,
-- without requiring a pgTAP extension in the isolated PGlite runtime.
select '1..1';
select 'ok 1 - automatic carousel SQL regression assertions passed';
rollback;
