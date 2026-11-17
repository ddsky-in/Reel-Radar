import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

const migration = '202611150008_initial_carousel_window.sql';
let f: Awaited<ReturnType<typeof featureDatabase>>;
type Maintenance = { job_ids: string[]; created: number; adopted: number; reason?: string };
type Request = { id: string; owner_user_id: string; creator_id: string; state: string; initial_job_id: string | null };
type Job = { id: string; carousel_initial: boolean; carousel_initial_request_id: string | null; carousel_automatic: boolean; results_limit: number; requested_profiles_count: number; manual_authorized_by: string; owner_user_id: string; status: string; actual_cost_usd: number | null; reserved_usd: number; carousel_automation_scheduled_at: string };
async function add(username: string, workspace = f.workspace) {
  await f.identity('authenticated');
  return f.rpc<{ id: string; initial_backfill_job_id: string | null; profile_job_ids: string[] }>('add_creator', [workspace, username]);
}
async function request(creator: string): Promise<Request | undefined> {
  await f.identity();
  return (await f.db.query<Request>('select * from carousel_automation_private.initial_requests where owner_user_id=$1 and creator_id=$2', [fixtureOwner, creator])).rows[0];
}
async function enable() {
  await f.identity('service_role');
  await f.rpc('worker_configure_carousel_automation', [fixtureOwner, true, true]);
}
async function maintain(limit = 10) {
  await f.identity('service_role');
  return f.rpc<Maintenance>('worker_carousel_maintain', [fixtureOwner, limit]);
}
async function job(id: string) {
  await f.identity();
  return f.value<Job>('select to_jsonb(j) v from public.scrape_jobs j where id=$1', [id]);
}
async function rejected(work: () => Promise<unknown>, pattern: RegExp) {
  await f.db.exec('savepoint expected_failure');
  await expect(work()).rejects.toThrow(pattern);
  await f.db.exec('rollback to savepoint expected_failure');
}
async function count(creator: string) {
  await f.identity();
  return f.value<number>("select count(*)::integer v from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id where j.kind='carousel' and jc.creator_id=$1", [creator]);
}
async function legacyCarousel(creator: string, limit = 30) {
  await f.identity();
  const id = await f.value<string>("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,manual_authorized_by) values($1,'carousel',$2,1,$1) returning id v", [fixtureOwner, limit]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, creator]);
  return id;
}

beforeAll(async () => {
  // Exercise this historical rollout before later patches replace its contracts.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: [migration, ...later] });
  const oldJobs = await f.value<unknown>('select jsonb_agg(to_jsonb(j) order by id) v from public.scrape_jobs j');
  const schedules = await f.value<number>('select count(*)::integer v from cron.job');
  await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8'));
  expect(await f.value<number>('select count(*)::integer v from carousel_automation_private.initial_requests')).toBe(0);
  expect(await f.value<unknown>("select jsonb_agg(to_jsonb(j)-'carousel_initial'-'carousel_initial_request_id' order by id) v from public.scrape_jobs j")).toEqual(oldJobs);
  expect(await f.value<number>('select count(*)::integer v from cron.job')).toBe(schedules);
  expect(await f.value<number>('select count(*)::integer v from net.requests')).toBe(0);
}, 90_000);
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.query("update public.creators set status='paused' where id=$1", [f.creator]);
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
afterAll(async () => { await f.db.close(); });

describe('future-only bounded initial carousel database rollout', () => {
  it('preserves restrictive inherited ACLs and hides all request state from browser, service SQL and realtime', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await f.value<boolean>("select has_table_privilege($1,'carousel_automation_private.initial_requests','select') v", [role])).toBe(false);
      for (const helper of ['creator_profile_private.add_creator_pre_initial_carousel(uuid,text,boolean)', 'carousel_automation_private.maintain_pre_initial(uuid,integer)', 'carousel_automation_private.assert_initial_job(uuid)']) {
        expect(await f.value<boolean>('select has_function_privilege($1,$2,\'execute\') v', [role, helper])).toBe(false);
      }
    }
    expect(await f.value<boolean>("select relrowsecurity v from pg_class where oid='carousel_automation_private.initial_requests'::regclass")).toBe(true);
    expect(await f.value<number>("select count(*)::integer v from pg_publication_tables where schemaname='carousel_automation_private'")).toBe(0);
    expect(await f.value<boolean>("select has_function_privilege('authenticated','creator_profile_private.add_creator(uuid,text,boolean)','execute') v")).toBe(true);
    expect(await f.value<boolean>("select has_function_privilege('service_role','public.worker_carousel_maintain(uuid,integer)','execute') v")).toBe(true);
    await f.identity('authenticated');
    await rejected(() => f.rpc('worker_carousel_maintain', [fixtureOwner]), /permission denied/);
    await rejected(() => f.db.query('select creator_profile_private.add_creator_pre_initial_carousel($1,$2,true)', [f.workspace, 'bypass']), /permission denied/);
    await rejected(() => f.db.query('select * from carousel_automation_private.initial_requests'), /permission denied/);
    await f.identity('authenticated', fixtureStranger);
    await rejected(() => f.rpc('add_creator', [f.workspace, 'foreign_creator']), /forbidden/);
    await f.identity();
    expect(await f.value<number>('select count(*)::integer v from carousel_automation_private.initial_requests')).toBe(0);
  });

  it('registers single/bulk/import additions but queues exactly one latest50 only from authorized maintenance', async () => {
    const added = await add('@Initial_One');
    expect(added.initial_backfill_job_id).toBeTruthy();
    expect(added.profile_job_ids).toHaveLength(1);
    expect(await request(added.id)).toMatchObject({ state: 'pending', initial_job_id: null, owner_user_id: fixtureOwner });
    expect(await count(added.id)).toBe(0);
    await f.identity('authenticated');
    const imported = await f.rpc<{ added: number; duplicates: number; profile_job_ids: string[] }>('import_creators', [f.workspace, [{ username: 'bulk_two' }, { username: '@bulk_two' }, { username: 'bulk_three', workspace: 'Imported workspace' }]]);
    expect(imported).toMatchObject({ added: 2, duplicates: 1 });
    expect(imported.profile_job_ids).toHaveLength(1);
    await f.identity('service_role');
    await rejected(() => f.rpc('worker_carousel_maintain', [fixtureOwner, 0]), /invalid_carousel_maintenance_scope/);
    await rejected(() => f.rpc('worker_carousel_maintain', [fixtureOwner, 11]), /invalid_carousel_maintenance_scope/);
    expect(await f.rpc('worker_carousel_maintain', [fixtureStranger])).toMatchObject({ created: 0, reason: 'owner_not_provisioned' });
    await f.identity();
    expect(await f.value<number>("select count(*)::integer v from carousel_automation_private.initial_requests where state='pending'")).toBe(3);
    await enable();
    const first = await maintain(1);
    expect(first).toMatchObject({ created: 1, adopted: 0 });
    expect(first.job_ids).toHaveLength(1);
    const j = await job(first.job_ids[0]);
    expect(j).toMatchObject({ kind: 'carousel', results_limit: 50, requested_profiles_count: 1, carousel_initial: true, carousel_automatic: true, owner_user_id: fixtureOwner, manual_authorized_by: fixtureOwner, actual_cost_usd: null, live: false });
    expect(Number(j.reserved_usd)).toBe(0);
    expect(j.carousel_automation_scheduled_at).toBeTruthy();
    expect(await f.value<number>('select count(*)::integer v from public.scrape_job_creators where job_id=$1', [j.id])).toBe(1);
    expect(await f.value<Request>('select to_jsonb(r) v from carousel_automation_private.initial_requests r where id=$1', [j.carousel_initial_request_id])).toMatchObject({ state: 'bound', initial_job_id: j.id });
    expect(await maintain()).toMatchObject({ created: 2, adopted: 0 });
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await f.identity(); await f.db.exec('set constraints all immediate');
    expect(await f.value<number>("select count(*)::integer v from public.scrape_jobs where kind='carousel' and carousel_initial")).toBe(3);
  });

  it('retains default-disabled reasons, pause/scraping switches, archived/private exclusions and pending requests', async () => {
    const added = await add('disabled_initial');
    expect(await maintain()).toMatchObject({ created: 0, reason: 'setup_required' });
    await f.identity('service_role'); await f.rpc('worker_configure_carousel_automation', [fixtureOwner, false, true]);
    expect(await maintain()).toMatchObject({ created: 0, reason: 'disabled' });
    await enable();
    await f.identity(); await f.db.query('update public.app_settings set scraping_enabled=false where owner_user_id=$1', [fixtureOwner]);
    expect(await maintain()).toMatchObject({ created: 0, reason: 'scraping_disabled' });
    await f.identity(); await f.db.query('update public.app_settings set scraping_enabled=true,paused=true where owner_user_id=$1', [fixtureOwner]);
    expect(await maintain()).toMatchObject({ created: 0, reason: 'paused' });
    await f.identity(); await f.db.query('update public.app_settings set paused=false where owner_user_id=$1', [fixtureOwner]);
    await f.db.query('update public.workspaces set archived_at=now() where id=$1', [f.workspace]);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await f.identity('authenticated');
    await rejected(() => f.rpc('add_creator', [f.workspace, 'archived_add']), /workspace_archived/);
    await f.identity(); await f.db.query('update public.workspaces set archived_at=null where id=$1', [f.workspace]);
    for (const status of ['private', 'unavailable', 'paused']) {
      await f.identity(); await f.db.query('update public.creators set status=$1 where id=$2', [status, added.id]);
      expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    }
    expect(await request(added.id)).toMatchObject({ state: 'pending' });
    expect(await count(added.id)).toBe(0);
    await f.identity();
    expect(await f.value<number>('select count(*)::integer v from net.requests')).toBe(0);
  });

  it('deduplicates normalized handles, workspaces, unlink/reactivation and successful empty data', async () => {
    const added = await add('repeat_initial');
    await f.identity('authenticated');
    const other = (await f.rpc<{ id: string }>('create_workspace', ['Shared window'])).id;
    expect((await add('https://instagram.com/repeat_initial/', other)).id).toBe(added.id);
    await enable(); const initial = (await maintain()).job_ids[0];
    const original = await request(added.id);
    await f.identity(); await f.db.query('update public.workspace_creators set active=false where creator_id=$1', [added.id]);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await add('@REPEAT_INITIAL');
    await f.identity();
    await f.db.query("update public.scrape_jobs set status='succeeded',completed_at=now(),result_fetched_at=now(),provider_terminal_status='SUCCEEDED',output_summary_verified=true,live=true where id=$1", [initial]);
    await f.db.query("update public.scrape_job_creators set completion_status='completed',summary_authoritative=true,summary_delivered_count=0,error_message=null where job_id=$1", [initial]);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    expect(await request(added.id)).toEqual(original);
    expect(await count(added.id)).toBe(1);
    expect((await job(initial)).actual_cost_usd).toBeNull();
  });

  it('returns a successful initial window to unchanged daily30 only after24h and known-charge reconciliation', async () => {
    const added = await add('daily_after_initial'); await enable(); const id = (await maintain()).job_ids[0];
    await f.identity();
    await f.db.query("update public.scrape_jobs set status='succeeded',live=true,provider_terminal_status='SUCCEEDED',output_summary_verified=true,result_fetched_at=now(),completed_at=now() where id=$1", [id]);
    await f.db.query("update public.scrape_job_creators set completion_status='completed',summary_authoritative=true,summary_delivered_count=0,error_message=null where job_id=$1", [id]);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await f.identity();
    await f.db.query("update public.scrape_jobs set carousel_automation_scheduled_at=now()-interval '25 hours',started_at=now()-interval '25 hours',result_fetched_at=now()-interval '25 hours',completed_at=now()-interval '25 hours',attempt_count=1 where id=$1", [id]);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await f.identity(); await f.db.query('update public.scrape_jobs set actual_cost_usd=0,billing_reconciled_at=now() where id=$1', [id]);
    const daily = await maintain();
    expect(daily).toMatchObject({ created: 1, adopted: 0 });
    expect(await job(daily.job_ids[0])).toMatchObject({ results_limit: 30, carousel_initial: false, carousel_initial_request_id: null });
    expect(await request(added.id)).toMatchObject({ state: 'bound', initial_job_id: id });
    expect(await count(added.id)).toBe(2);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
  });

  it.each(['pending', 'budget_paused', 'dispatching', 'running', 'processing', 'uncertain', 'failed', 'partial'])('never recreates or falls through to daily30 for a bound %s initial attempt', async status => {
    const added = await add(`bound_${status}`); await enable();
    const id = (await maintain()).job_ids[0];
    await f.identity();
    await f.db.query("update public.scrape_jobs set status=$1,carousel_automation_scheduled_at=now()-interval '25 hours',actual_cost_usd=0 where id=$2", [status, id]);
    const before = await job(id);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await add(`bound_${status}`);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    expect(await count(added.id)).toBe(1);
    expect(await job(id)).toEqual(before);
  });

  it('reuses existing canonical shared history, and awaits manual30 without upgrading or adopting it', async () => {
    const fresh = await add('manual_precedes_initial');
    const manual = await legacyCarousel(fresh.id);
    const before = await job(manual);
    await enable();
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    expect(await request(fresh.id)).toMatchObject({ state: 'reused', initial_job_id: null });
    expect(await job(manual)).toEqual(before);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    await f.identity();
    const shared = await f.value<string>("insert into public.creators(username,status) values('shared_history','active') returning id v");
    await f.db.query("insert into public.carousel_posts(creator_id,shortcode,slides,latest_fetched_at,provider,likes_state,comments_state) values($1,'SHARED_INITIAL','[]',now(),'fixture','not_fetched','not_fetched')", [shared]);
    expect((await add('shared_history')).id).toBe(shared);
    expect(await request(shared)).toMatchObject({ state: 'reused' });
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    expect(await count(shared)).toBe(0);
  });

  it('keeps the old owner cohort and existing no-history canonical on ordinary daily30 with no backfill enrollment', async () => {
    await add('backend_fixture');
    expect(await request(f.creator)).toBeUndefined();
    await f.identity();
    await f.db.query("update public.creators set status='active' where id=$1", [f.creator]);
    const oldShared = await f.value<string>("insert into public.creators(username,status) values('old_no_history','active') returning id v");
    await add('old_no_history');
    expect(await request(oldShared)).toMatchObject({ state: 'reused' });
    await enable(); const result = await maintain();
    expect(result).toMatchObject({ created: 2, adopted: 0 });
    expect(result.job_ids).toHaveLength(2);
    for (const id of result.job_ids) expect(await job(id)).toMatchObject({ results_limit: 30, carousel_initial: false, carousel_initial_request_id: null, carousel_automatic: true });
  });

  it('rolls all initialization decisions back together with inherited capacity failures', async () => {
    await f.identity(); await f.db.query('update public.app_settings set capacity=2 where owner_user_id=$1', [fixtureOwner]);
    await f.identity('authenticated');
    await rejected(() => f.rpc('import_creators', [f.workspace, [{ username: 'overflow_one' }, { username: 'overflow_two' }]]), /capacity_exceeded/);
    await f.identity();
    expect(await f.value<number>('select count(*)::integer v from carousel_automation_private.initial_requests')).toBe(0);
    expect(await f.value<number>("select count(*)::integer v from public.creators where username like 'overflow_%'")).toBe(0);
  });

  it('allows50 only with immutable owner/request/exact creator provenance and preserves100/10000 constraints', async () => {
    const added = await add('provenance_initial'); await enable();
    const id = (await maintain()).job_ids[0];
    const j = await job(id);
    await f.db.exec('set constraints all immediate');
    await rejected(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count) values($1,'carousel',50,1)", [fixtureOwner]), /scrape_jobs_results_limit_check/);
    await rejected(() => f.db.query('update public.scrape_jobs set carousel_initial=false,carousel_initial_request_id=null,results_limit=30 where id=$1', [id]), /initial_carousel_job_is_durable/);
    await rejected(() => f.db.query('update public.scrape_jobs set requested_profiles_count=2 where id=$1', [id]), /scrape_jobs_carousel_initial_check/);
    await rejected(() => f.db.query('update public.scrape_jobs set manual_authorized_by=$1 where id=$2', [fixtureStranger, id]), /scrape_jobs_carousel_initial_check|scrape_jobs_carousel_automatic_check/);
    await rejected(() => f.db.query('update public.scrape_jobs set carousel_automatic=false where id=$1', [id]), /scrape_jobs_carousel_initial_check/);
    await rejected(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,manual_authorized_by,carousel_initial,carousel_automatic,carousel_automation_scheduled_at,carousel_initial_request_id) values($1,'carousel',50,1,$1,true,true,now(),gen_random_uuid())", [fixtureOwner]), /foreign key constraint/);
    await rejected(() => f.db.query('update public.scrape_jobs set results_limit=51 where id=$1', [id]), /scrape_jobs_carousel_initial_check|scrape_jobs_results_limit_check/);
    await rejected(() => f.db.query('update public.scrape_jobs set dataset_cursor=51 where id=$1', [id]), /scrape_jobs_carousel_initial_check/);
    await rejected(() => f.db.query('update public.scrape_jobs set returned_records_count=51 where id=$1', [id]), /scrape_jobs_carousel_initial_check/);
    await rejected(() => f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]), /invalid_initial_carousel_provenance/);
    await rejected(() => f.db.query('delete from public.scrape_job_creators where job_id=$1', [id]), /invalid_initial_carousel_provenance/);
    await rejected(() => f.db.query("update carousel_automation_private.initial_requests set state='pending',initial_job_id=null where id=$1", [j.carousel_initial_request_id]), /initial_carousel_request_is_durable/);
    const forgery = await add('unbound_request');
    const unbound = await request(forgery.id);
    await rejected(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,manual_authorized_by,carousel_initial,carousel_automatic,carousel_automation_scheduled_at,carousel_initial_request_id) values($1,'carousel',50,1,$1,true,true,now(),$2)", [fixtureOwner, unbound?.id]), /invalid_initial_carousel_provenance/);
    await rejected(() => f.db.query('delete from public.scrape_jobs where id=$1', [id]), /foreign key constraint/);
    await rejected(() => f.db.query('delete from carousel_automation_private.initial_requests where id=$1', [j.carousel_initial_request_id]), /initial_carousel_request_is_durable/);
    await rejected(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count) values($1,'daily',50,1)", [fixtureOwner]), /scrape_jobs_results_limit_check/);
    const validBackfill = await f.value<string>("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count) values($1,'backfill',100,1) returning id v", [fixtureOwner]);
    expect((await job(validBackfill)).results_limit).toBe(100);
    await rejected(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count) values($1,'manual',100,1)", [fixtureOwner]), /media_job_link_required/);
    for (const kind of ['manual', 'backfill']) {
      await rejected(() => f.db.query('insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count) values($1,$2,100,2)', [fixtureOwner, kind]), /scrape_jobs_results_limit_check/);
    }
    expect(await request(added.id)).toMatchObject({ state: 'bound', initial_job_id: id });
    expect(await f.value<boolean>("select convalidated v from pg_constraint where conrelid='public.scrape_jobs'::regclass and conname='scrape_jobs_results_limit_check'")).toBe(false);
    expect(await f.value<string>("select pg_get_constraintdef(oid) v from pg_constraint where conrelid='public.scrape_jobs'::regclass and conname='scrape_jobs_results_limit_check'")).toContain('10000');
  });

  it('enforces the raw50 ingestion cap without altering ordinary carousel reads or older holdings', async () => {
    const added = await add('ingest_initial'); await enable(); const id = (await maintain()).job_ids[0];
    await f.identity();
    const lease = await f.value<string>("update public.scrape_jobs set status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',provider_terminal_status='SUCCEEDED' where id=$1 returning lease_token v", [id]);
    await f.identity('service_role');
    const args = [id, lease, 0, [], [], 51, true, { [added.id]: 51 }];
    await rejected(() => f.rpc('worker_ingest_page', args), /scrape_jobs_carousel_initial_check/);
    expect((await job(id))).toMatchObject({ dataset_cursor: 0, returned_records_count: 0 });
    await f.identity('service_role');
    expect(await f.rpc('worker_ingest_page', [id, lease, 0, [], [], 50, true, { [added.id]: 50 }])).toMatchObject({ cursor: 50, accepted: 0, duplicate: false });
    await f.identity(); await f.db.exec('set constraints all immediate');
    expect((await job(id))).toMatchObject({ dataset_cursor: 50, returned_records_count: 0 });
    expect(await f.value<number>('select count(*)::integer v from public.carousel_posts')).toBe(0);
  });

  it('uses the unchanged claim allocator for50, fails closed after disable, retains unknown holds, and does not starve manual30', async () => {
    const added = await add('claim_initial'); await enable(); const id = (await maintain()).job_ids[0];
    await f.identity('service_role'); await f.rpc('worker_configure_carousel_automation', [fixtureOwner, false, true]);
    expect(await f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'carousel'])).toEqual({ reason: 'disabled' });
    const manual = await legacyCarousel(f.creator);
    await f.identity(); await f.db.query("update public.creators set status='active' where id=$1", [f.creator]);
    await f.identity('service_role');
    expect(await f.rpc<{ job: Job }>('worker_claim_dispatch', [fixtureOwner, false, 'mock-actor', 'carousel'])).toMatchObject({ job: { id: manual, results_limit: 30, carousel_initial: false } });
    await f.identity(); await f.db.query("update public.scrape_jobs set status='failed' where id=$1", [manual]);
    await enable();
    await f.identity(); await f.db.query('update public.app_settings set monthly_budget_usd=0 where owner_user_id=$1', [fixtureOwner]);
    await f.identity('service_role');
    expect(await f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'carousel'])).toEqual({ reason: 'budget_paused' });
    expect(Number((await job(id)).reserved_usd)).toBe(0);
    await f.identity(); await f.db.query('update public.app_settings set monthly_budget_usd=50 where owner_user_id=$1', [fixtureOwner]);
    await f.identity('service_role');
    const claimed = await f.rpc<{ job: Job & { dispatch_nonce: string }; max_total_charge_usd: number }>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'carousel']);
    expect(claimed.job).toMatchObject({ id, results_limit: 50, carousel_initial: true, carousel_automatic: true, actual_cost_usd: null, apify_account_slot: 1 });
    expect(Number(claimed.job.reserved_usd)).toBeGreaterThan(0);
    expect(Number(claimed.job.reserved_usd)).toBe(Number(claimed.max_total_charge_usd));
    await f.rpc('worker_start_uncertain', [id, claimed.job.dispatch_nonce]);
    const hold = await job(id);
    await f.identity(); await f.db.query("update public.scrape_jobs set carousel_automation_scheduled_at=now()-interval '25 hours' where id=$1", [id]);
    await f.db.query("update public.creators set status='paused' where id=$1", [f.creator]);
    expect(await maintain()).toEqual({ job_ids: [], created: 0, adopted: 0 });
    expect(await count(added.id)).toBe(1);
    expect(await job(id)).toMatchObject({ status: 'uncertain', reserved_usd: hold.reserved_usd, actual_cost_usd: null, actor_run_id: null });
  });
});
