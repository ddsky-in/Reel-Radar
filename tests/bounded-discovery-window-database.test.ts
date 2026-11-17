import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner } from './support/feature-database';

const migration = '202611150011_bounded_discovery_window.sql';
let f: Awaited<ReturnType<typeof featureDatabase>>;
beforeAll(async () => {
  // Exercise this historical rollout before later patches replace its contracts.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: [migration, ...later] });
}, 90_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
async function migrate() { await f.identity(); await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8')); }
async function schedule() { await f.identity('service_role'); return f.rpc<{ run_ids: string[]; job_ids: string[] }>('worker_schedule', [fixtureOwner, 'discovery']); }
async function job(id: string) { await f.identity(); return f.value<Record<string, unknown>>('select to_jsonb(j) v from public.scrape_jobs j where id=$1', [id]); }
async function reject(work: () => Promise<unknown>) {
  await f.db.exec('savepoint expected_rejection');
  try { await expect(work()).rejects.toThrow(); } finally { await f.db.exec('rollback to savepoint expected_rejection'); }
}
describe('bounded discovery window', () => {
  it('upgrades never-started jobs and keeps metrics tracked plus fifty unchanged', async () => {
    await f.reel(); const { job_ids: [id] } = await schedule();
    expect((await job(id)).results_limit).toBe(10000);
    await migrate(); expect(await job(id)).toMatchObject({ results_limit: 50, discovery_bounded: true, actual_cost_usd: null, reserved_usd: 0 });
    await f.identity('service_role'); const metrics = await f.rpc<{ job_ids: string[] }>('worker_schedule', [fixtureOwner, 'metrics']);
    expect(await job(metrics.job_ids[0])).toMatchObject({ results_limit: 51, metrics_tracked_count: 1, discovery_bounded: false });
    await reject(() => f.db.query('update public.scrape_jobs set results_limit=10000,discovery_bounded=false where id=$1', [id]));
    await f.identity('service_role'); const claimed = await f.rpc<{ job: Record<string, unknown> }>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'discovery']);
    expect(claimed.job).toMatchObject({ id, results_limit: 50, discovery_bounded: true, status: 'dispatching' });
  });
  it('preserves historical uncertain pins and unknown holds', async () => {
    const { job_ids: [id] } = await schedule();
    const claimed = await f.rpc<{ job: { dispatch_nonce: string } }>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'discovery']);
    await f.rpc('worker_start_uncertain', [id, claimed.job.dispatch_nonce]);
    const before = await job(id); await migrate();
    const after = await job(id); delete after.discovery_bounded;
    expect(after).toEqual(before);
    await reject(() => f.db.query('update public.scrape_jobs set discovery_bounded=true,results_limit=50 where id=$1', [id]));
  });
  it('finishes capped output partial with no same-window retry, watermark advance or guessed billing', async () => {
    await migrate(); const { job_ids: [id], run_ids: [runId] } = await schedule();
    await f.identity();
    await f.db.query("update public.scrape_jobs set status='processing',provider_terminal_status='SUCCEEDED',result_fetched_at=now(),live=true,reserved_usd=.25 where id=$1", [id]);
    const previousFetch = await f.value('select last_reels_fetch_at v from public.creators where id=$1', [f.creator]);
    await f.identity('service_role'); const claim = await f.rpc<{ job: { lease_token: string } }>('worker_claim_processing', [id]);
    const records = Array.from({ length: 50 }, (_, n) => ({ creator_id: f.creator, username: 'backend_fixture', shortcode: `CAPPED_${n}`,
      fetched_at: new Date().toISOString(), provider: 'fixture', published_at: '2026-01-01T00:00:00Z', published_at_basis: 'explicit_offset',
      reel_url: `https://www.instagram.com/reel/CAPPED_${n}/`, views: 100, likes: 1, comments: 0, views_state: 'known', likes_state: 'known', comments_state: 'known' }));
    await f.rpc('worker_ingest_page', [id, claim.job.lease_token, 0, JSON.stringify(records), '[]', 50, true, JSON.stringify({ [f.creator]: 50 })]);
    await f.rpc('worker_record_output_summary', [id, claim.job.lease_token, JSON.stringify({ ok: true, complete: false, total_items: 50,
      users: [{ creator_id: f.creator, username: 'backend_fixture', count: 50, error: null }], reason: 'discovery_window_capped' })]);
    expect(await f.rpc('worker_finish_processing', [id, claim.job.lease_token])).toMatchObject({ status: 'partial', actual_cost_usd: null, reserved_usd: .25 });
    await f.identity();
    expect(await f.value('select status v from public.competitor_refresh_runs where id=$1', [runId])).toBe('partial');
    expect(await f.value('select last_reels_fetch_at v from public.creators where id=$1', [f.creator])).toEqual(previousFetch);
    await f.identity('service_role'); expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    await f.identity(); expect(await f.value<number>('select count(*)::integer v from public.reels')).toBe(50);
    expect(await f.value<number>('select count(*)::integer v from cron.job')).toBe(0);
  });
});
