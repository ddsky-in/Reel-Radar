-- Disposable local database only. No provider, deployment, or Cron actions.
begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select plan(15);
insert into auth.users(id,email) values
  ('fb100000-0000-4000-8000-000000000001','revision-owner@test.invalid'),
  ('fb100000-0000-4000-8000-000000000002','revision-stranger@test.invalid');
select set_config('request.jwt.claims','{"sub":"fb100000-0000-4000-8000-000000000001","role":"service_role"}',true);
select public.provision_owner('fb100000-0000-4000-8000-000000000001');
insert into public.workspaces(id,owner_user_id,name,slug) values
  ('fb200000-0000-4000-8000-000000000001','fb100000-0000-4000-8000-000000000001','Scoped revisions','scoped-revisions');
insert into public.workspace_members(workspace_id,user_id) values
  ('fb200000-0000-4000-8000-000000000001','fb100000-0000-4000-8000-000000000001');
insert into public.creators(id,username) values('fb300000-0000-4000-8000-000000000001','scoped_revision_fixture');
insert into public.workspace_creators(workspace_id,creator_id) values
  ('fb200000-0000-4000-8000-000000000001','fb300000-0000-4000-8000-000000000001');
insert into public.reels(id,creator_id,shortcode,published_at,latest_fetched_at,provider) values
  ('fb400000-0000-4000-8000-000000000001','fb300000-0000-4000-8000-000000000001','SCOPED_REVISION_FIXTURE',now(),now(),'synthetic-test');
-- Flush this disposable fixture explicitly; production worker signals stay
-- deferred until commit to preserve source/budget/revision lock ordering.
set constraints all immediate;
select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='owner_resource_revisions'),'scoped signal published');
select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='owner_revisions'),'legacy signal preserved');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='owner_resource_revisions'),
  array['owner_user_id','family','workspace_id','scope_key','revision','updated_at'],'only safe scope metadata published');
select ok(exists(select 1 from pg_constraint where conrelid='public.owner_resource_revisions'::regclass and contype='p'),'Realtime authorization primary key present');
select ok(not has_table_privilege('authenticated','public.owner_resource_revisions','INSERT'),'browser inserts denied');
select ok(not has_table_privilege('authenticated','public.owner_resource_revisions','UPDATE'),'browser updates denied');
select ok(not has_table_privilege('authenticated','public.owner_resource_revisions','DELETE'),'browser deletes denied');
select ok(not has_table_privilege('anon','public.owner_resource_revisions','SELECT'),'anonymous reads denied');
select ok(not has_function_privilege('authenticated','public.signal_owner_resource_revision()','EXECUTE'),'direct signal trigger denied');
-- Already in one transaction: ten more creator changes must not increment it
-- again, and later bookmarks/filters must still create their independent rows.
create temporary table revision_baseline as select revision from public.owner_resource_revisions where owner_user_id='fb100000-0000-4000-8000-000000000001' and family='creators' and workspace_id is null;
do $$ begin for i in 1..10 loop update public.creators set display_name='Atomic '||i where id='fb300000-0000-4000-8000-000000000001'; end loop; end $$;
select is((select revision from public.owner_resource_revisions where owner_user_id='fb100000-0000-4000-8000-000000000001' and family='creators' and workspace_id is null),
  (select revision from revision_baseline),'ten same-transaction updates coalesced');
insert into public.saved_reels(workspace_id,reel_id,saved_by_user_id) values
  ('fb200000-0000-4000-8000-000000000001','fb400000-0000-4000-8000-000000000001','fb100000-0000-4000-8000-000000000001');
insert into public.saved_reel_filters(owner_user_id,name,config) values('fb100000-0000-4000-8000-000000000001','Independent preset','{"version":1,"query":{}}');
select ok(exists(select 1 from public.owner_resource_revisions where family='saved_reels' and workspace_id='fb200000-0000-4000-8000-000000000001'),'later bookmark domain retained within transaction');
select ok(exists(select 1 from public.owner_resource_revisions where family='reel_filters' and workspace_id is null),'later filter domain retained within transaction');
select set_config('request.jwt.claims','{"sub":"fb100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select ok((select count(*) from public.owner_resource_revisions)>0,'authorized owner reads own scopes');
reset role;
select set_config('request.jwt.claims','{"sub":"fb100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*)::integer from public.owner_resource_revisions),0,'foreign owner cannot read scopes');
reset role;
select is((select count(*)::integer from public.owner_resource_revisions where family='saved_reels' and workspace_id is null),0,'bookmark scope does not widen to global family');
select * from finish();
rollback;
