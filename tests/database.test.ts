import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const owner = 'a0000000-0000-4000-8000-000000000001';
const stranger = 'a0000000-0000-4000-8000-000000000002';
const db = new PGlite();
let workspaceA: string, workspaceB: string, creator: string;
async function identity(role: 'postgres' | 'anon' | 'authenticated' | 'service_role', user = owner) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user, role, email: 'owner@example.test' })]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
  const result = await db.query<{ value: T }>(sql, args);
  return result.rows[0].value;
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
  `);
  for (const file of ['202611080001_schema.sql', '202611080002_queue.sql']) await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8'));
  await db.query('insert into auth.users values ($1),($2)', [owner, stranger]);
  await identity('service_role');
  await db.query('select public.provision_owner($1)', [owner]);
  await identity('authenticated');
  workspaceA = (await value<{ id: string }>('select public.create_workspace($1) as value', ['Test AI'])).id;
  workspaceB = (await value<{ id: string }>('select public.create_workspace($1) as value', ['Test Business'])).id;
  creator = (await value<{ id: string }>('select public.add_creator($1,$2) as value', [workspaceA, '@Example'])).id;
}, 60000);
afterAll(async () => { await db.close(); });

describe('actual PostgreSQL migrations with emulated Supabase auth', () => {
  it('limits grants even when Supabase-style broad defaults exist', async () => {
    await identity('postgres');
    expect(await value<boolean>("select has_table_privilege('anon','public.reels_summary','select') as value")).toBe(false);
    expect(await value<boolean>("select has_table_privilege('authenticated','public.reels_summary','insert') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('anon','public.queue_creator_jobs(uuid,uuid[],text)','execute') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('service_role','public.create_workspace(text,text)','execute') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('service_role','public.worker_claim_dispatch(uuid,boolean,text,text)','execute') as value")).toBe(true);
  });
  it('deduplicates global creators across workspaces', async () => {
    await identity('authenticated');
    const second = await value<{ id: string }>('select public.add_creator($1,$2) as value', [workspaceB, 'https://instagram.com/Example/reels/?igsh=x']);
    expect(second.id).toBe(creator);
    expect(await value<number>('select count(*)::int as value from public.creators')).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.workspace_creators')).toBe(2);
  });
  it('denies anonymous reads and mutations', async () => {
    await identity('anon', stranger);
    await expect(db.query('select * from public.workspaces')).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.create_workspace($1)', ['No access'])).rejects.toThrow(/permission denied/);
  });
  it('denies authenticated non-owner access and RPC mutations', async () => {
    await identity('authenticated', stranger);
    expect(await value<number>('select count(*)::int as value from public.creators')).toBe(0);
    expect(await value<number>('select count(*)::int as value from public.workspaces')).toBe(0);
    await expect(db.query('select public.query_reels($1)', [workspaceA])).rejects.toThrow(/forbidden/);
    await expect(db.query('select public.add_creator($1,$2)', [workspaceA, 'other'])).rejects.toThrow(/forbidden/);
  });
  it('denies direct writes and service-only worker RPCs', async () => {
    await identity('authenticated');
    await expect(db.query("insert into public.creators(username) values ('bypass')")).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.worker_claim_dispatch($1,false,$2,$3)', [owner, 'mock-reels', 'manual'])).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.update_settings($1)', [{ scraping_enabled: true }])).rejects.toThrow(/invalid_settings/);
  });
  it('enforces atomic capacity and imports without orphan profiles', async () => {
    await identity('authenticated');
    await db.query('select public.update_settings($1)', [{ capacity: 1 }]);
    await expect(db.query('select public.import_creators($1,$2)', [workspaceA, [{ username: 'newone' }, { username: 'newtwo', workspace: 'Temporary' }]])).rejects.toThrow(/capacity_exceeded/);
    expect(await value<number>('select count(*)::int as value from public.creators')).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.workspaces')).toBe(2);
    await db.query('select public.update_settings($1)', [{ capacity: 120 }]);
  });
  it('rejects unsafe direct normalization and broad query requests', async () => {
    await identity('authenticated');
    await expect(db.query('select public.normalize_username($1)', ['instagram.com/example/evil'])).rejects.toThrow();
    await expect(db.query('select public.query_reels($1,$2)', [workspaceA, { limit: 10000 }])).rejects.toThrow(/invalid_pagination/);
    await expect(db.query('select public.query_reels($1,$2)', [workspaceA, { from: '2020-01-01', to: '2026-01-01' }])).rejects.toThrow();
  });
  it('enqueues a creator once even when shared across workspaces', async () => {
    await identity('authenticated');
    const first = await value<{ job_ids: string[] }>('select public.enqueue_refresh($1) as value', [workspaceA]);
    const second = await value<{ job_ids: string[] }>('select public.enqueue_refresh($1) as value', [workspaceB]);
    expect(first.job_ids).toHaveLength(1); expect(second.job_ids).toHaveLength(0);
  });
  it('reserves caps, rejects over-budget work, and never relaunches uncertain starts', async () => {
    await identity('postgres');
    await db.query('update public.app_settings set paused=false,scraping_enabled=true,provider_account_id=$1,max_run_charge_usd=0.25,monthly_budget_usd=0.20 where owner_user_id=$2', ['apify-owner', owner]);
    await identity('service_role');
    await db.query("select public.worker_record_balance($1,$2,5,0,date_trunc('month',now())::date)", [owner, 'apify-owner']);
    expect(await value<{ reason: string }>('select public.worker_claim_dispatch($1,true,$2,$3) as value', [owner, 'verified-actor', 'manual'])).toEqual({ reason: 'budget_paused' });
    expect(await value<number>('select count(*)::int as value from public.scrape_jobs where actor_run_id is not null')).toBe(0);
    await identity('postgres'); await db.query('update public.app_settings set monthly_budget_usd=4 where owner_user_id=$1', [owner]);
    await identity('service_role');
    const claimed = await value<{ job: { id: string; dispatch_nonce: string; reserved_usd: number } }>('select public.worker_claim_dispatch($1,true,$2,$3) as value', [owner, 'verified-actor', 'manual']);
    expect(Number(claimed.job.reserved_usd)).toBe(0.25);
    await db.query('select public.worker_start_uncertain($1,$2)', [claimed.job.id, claimed.job.dispatch_nonce]);
    expect(await value<{ reason: string }>('select public.worker_claim_dispatch($1,true,$2,$3) as value', [owner, 'verified-actor', 'manual'])).toEqual({ reason: 'unreconciled_charges' });
  });
  it('ingests idempotent snapshots, computes scores, isolates saves, and preserves history on failures', async () => {
    await identity('postgres');
    const other = await value<string>("insert into public.creators(username) values ('unassociated') returning id as value");
    await db.query("insert into public.creator_follower_snapshots(creator_id,captured_date,followers_count,source,captured_at) values ($1,current_date,100000,'test',now())", [creator]);
    await db.query('update public.creators set followers_count=100000,last_profile_fetch_at=now() where id=$1', [creator]);
    await db.query("update public.scrape_jobs set status='failed',reserved_usd=0,actual_cost_usd=0 where status='uncertain'");
    await identity('authenticated');
    const enqueue = await value<{ job_ids: string[] }>('select public.enqueue_refresh($1) as value', [workspaceA]);
    await identity('service_role');
    const claim = await value<{ job: { id: string; dispatch_nonce: string; started_at: string } }>('select public.worker_claim_dispatch($1,false,$2,$3) as value', [owner, 'mock-reels', 'manual']);
    expect(claim.job.id).toBe(enqueue.job_ids[0]);
    await db.query('select public.worker_attach_run($1,$2,$3,$4,$5,$6)', [claim.job.id, claim.job.dispatch_nonce, 'test-run', 'mock-reels', 'mock', 'test-dataset']);
    await expect(db.query('select public.worker_reconcile_run($1,$2,$3,$4,$5,$6,$7)', [claim.job.id, 'test-run', 'wrong-actor', 'mock', 'SUCCEEDED', 'test-dataset', 0])).rejects.toThrow(/run_identity_mismatch/);
    await db.query('select public.worker_reconcile_run($1,$2,$3,$4,$5,$6,$7)', [claim.job.id, 'test-run', 'mock-reels', 'mock', 'SUCCEEDED', 'test-dataset', 0]);
    const processing = await value<{ job: { lease_token: string; result_fetched_at: string } }>('select public.worker_claim_processing($1) as value', [claim.job.id]);
    const record = { creator_id: creator, username: 'example', shortcode: 'TEST123', reel_url: 'https://www.instagram.com/reel/TEST123/', published_at: new Date().toISOString(), fetched_at: processing.job.result_fetched_at, views: 1000000, likes: 20000, comments: 500, views_state: 'known', likes_state: 'known', comments_state: 'known', provider: 'test' };
    const args = [claim.job.id, processing.job.lease_token, 0, [record], [], 1, true];
    await db.query('select public.worker_ingest_page($1,$2,$3,$4,$5,$6,$7)', args);
    expect((await value<{ duplicate: boolean }>('select public.worker_ingest_page($1,$2,$3,$4,$5,$6,$7) as value', args)).duplicate).toBe(true);
    await db.query('select public.worker_finish_processing($1,$2)', [claim.job.id, processing.job.lease_token]);
    await db.query('select public.worker_reconcile_run($1,$2,$3,$4,$5,$6,$7)', [claim.job.id, 'test-run', 'mock-reels', 'mock', 'SUCCEEDED', 'test-dataset', 0]);
    expect(await value<number>('select count(*)::int as value from public.reel_metric_snapshots')).toBe(1);
    await identity('authenticated');
    const result = await value<{ items: { id: string; follower_outlier_score: number; engagement_rate_pct: number }[] }>('select public.query_reels($1,$2) as value', [workspaceA, { min_outlier: 10 }]);
    expect(result.items[0].follower_outlier_score).toBe(10.205);
    expect(result.items[0].engagement_rate_pct).toBe(2.05);
    const reelId = result.items[0].id;
    await db.query('select public.set_bookmark($1,$2,true,$3,$4)', [workspaceA, reelId, 'Useful hook', ['hook']]);
    expect((await value<{ total: number }>('select public.query_reels($1,$2) as value', [workspaceA, { saved: true }])).total).toBe(1);
    expect((await value<{ total: number }>('select public.query_reels($1,$2) as value', [workspaceB, { saved: true }])).total).toBe(0);
    await identity('postgres');
    const foreignReel = await value<string>("insert into public.reels(creator_id,shortcode,published_at,latest_fetched_at,provider) values ($1,'OTHER123',now(),now(),'test') returning id as value", [other]);
    await identity('authenticated');
    await expect(db.query('select public.set_bookmark($1,$2,true)', [workspaceA, foreignReel])).rejects.toThrow(/reel_not_in_workspace/);
    await db.query('select public.set_bookmark($1,$2,false)', [workspaceA, reelId]);
    await db.query('select public.remove_creator($1,$2)', [workspaceA, creator]);
    expect((await value<{ total: number }>('select public.query_reels($1) as value', [workspaceB])).total).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.reel_metric_snapshots')).toBe(1);
  });
});
