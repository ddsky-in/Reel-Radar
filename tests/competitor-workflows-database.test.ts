import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });

async function schedule(kind: 'discovery' | 'metrics') {
  await f.identity('service_role');
  return f.rpc<{ run_ids: string[]; job_ids: string[] }>('worker_schedule', [fixtureOwner, kind]);
}
async function process(jobId: string, records: Record<string, unknown>[], verified = true) {
  await f.identity();
  await f.db.query(`update public.scrape_jobs set status='processing',provider_terminal_status='SUCCEEDED',result_fetched_at=now(),
    actual_cost_usd=0,billing_reconciled_at=now(),dataset_finished=false,lease_token=null where id=$1`, [jobId]);
  await f.identity('service_role');
  const { job } = await f.rpc<{ job: { lease_token: string } }>('worker_claim_processing', [jobId]);
  const args = [jobId, job.lease_token, 0, JSON.stringify(records), '[]', records.length, true, JSON.stringify({ [f.creator]: records.length })];
  const result = await f.rpc('worker_ingest_page', args);
  await f.rpc('worker_record_output_summary', [jobId, job.lease_token, JSON.stringify({ ok: verified, complete: verified, total_items: records.length,
    users: [{ creator_id: f.creator, username: 'backend_fixture', count: records.length, error: null }], reason: verified ? null : 'output_incomplete' })]);
  return { result, args, lease: job.lease_token };
}
async function record(reelId: string, views = 900) {
  await f.identity();
  const shortcode = await f.value<string>('select shortcode v from public.reels where id=$1', [reelId]);
  return { creator_id: f.creator, username: 'backend_fixture', shortcode, fetched_at: new Date().toISOString(), provider: 'fixture',
    published_at: '2026-01-01T00:00:00Z', published_at_basis: 'explicit_offset', reel_url: `https://www.instagram.com/reel/${shortcode}/`,
    views, likes: 40, comments: 7, views_state: 'known', likes_state: 'known', comments_state: 'known', duration_seconds: 60 };
}

describe('durable competitor workflows', () => {
  it('does not enable schedules or make network requests in migrations', async () => {
    expect(await f.value<number>('select count(*)::int v from cron.job')).toBe(0);
    expect(await f.value<number>('select count(*)::int v from net.requests')).toBe(0);
  });
  it('creates independent once-per-slot workflows and freezes every stored Reel, including older than 100', async () => {
    await f.db.query(`insert into public.reels(creator_id,shortcode,published_at,latest_fetched_at,provider)
      select $1,'HISTORY_'||n,now()-make_interval(days=>n),now(),'fixture' from generate_series(1,125) n`, [f.creator]);
    const metrics = await schedule('metrics'), discovery = await schedule('discovery');
    expect(metrics.job_ids).toHaveLength(1); expect(discovery.job_ids).toHaveLength(1);
    expect((await schedule('metrics')).job_ids).toEqual([]);
    expect((await schedule('discovery')).job_ids).toEqual([]);
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.competitor_refresh_targets')).toBe(125);
    expect((await f.db.query('select kind,results_limit,collection_since is not null has_cutoff from public.scrape_jobs where competitor_run_id is not null order by kind')).rows)
      .toEqual([{ kind: 'discovery', results_limit: 50, has_cutoff: true }, { kind: 'metrics', results_limit: 175, has_cutoff: true }]);
  });
  it('deduplicates a competitor shared across workspaces and excludes paused/archived associations', async () => {
    await f.identity('authenticated');
    const second = await f.rpc<{ id: string }>('create_workspace', ['Shared fixture']);
    await f.rpc('add_creator', [second.id, 'backend_fixture']);
    expect((await schedule('discovery')).run_ids).toHaveLength(1);
    await f.identity(); await f.db.exec("update public.creators set status='paused'");
    expect((await schedule('metrics')).job_ids).toEqual([]);
  });
  it('updates frozen metrics and snapshots in place, ignores newly discovered records, and makes replay idempotent', async () => {
    const id = await f.reel(); const { job_ids: [jobId] } = await schedule('metrics');
    const existing = await record(id);
    const extra = { ...existing, shortcode: 'UNRELATED_NEW', reel_url: 'https://www.instagram.com/reel/UNRELATED_NEW/' };
    const { args, lease } = await process(jobId, [existing, extra]);
    expect(await f.rpc('worker_ingest_page', args)).toMatchObject({ duplicate: true });
    expect(await f.rpc('worker_finish_processing', [jobId, lease])).toMatchObject({ status: 'succeeded' });
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.reels')).toBe(1);
    expect(await f.value<number>('select latest_views::int v from public.reels where id=$1', [id])).toBe(900);
    expect(await f.value<number>('select count(*)::int v from public.reel_metric_snapshots')).toBe(1);
    expect(await f.value<number>('select observed_reels v from public.competitor_refresh_runs where id=(select competitor_run_id from public.scrape_jobs where id=$1)', [jobId])).toBe(1);
  });
  it('completes a full bounded metrics window without importing the 50 extra Reels or scheduling another fetch', async () => {
    const id = await f.reel(); const { job_ids: [jobId] } = await schedule('metrics');
    const existing = await record(id);
    const extras = Array.from({ length: 50 }, (_, index) => ({ ...existing, shortcode: `BUFFER_${index}`,
      reel_url: `https://www.instagram.com/reel/BUFFER_${index}/` }));
    const { lease } = await process(jobId, [existing, ...extras]);
    expect(await f.rpc('worker_finish_processing', [jobId, lease])).toMatchObject({ status: 'succeeded', results_limit: 51, metrics_tracked_count: 1 });
    expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.reels')).toBe(1);
    expect(await f.value<number>('select count(*)::int v from public.reel_metric_snapshots')).toBe(1);
  });
  it('imports new discovery records only once across dataset retries and later workflows', async () => {
    const id = await f.reel(); const { job_ids: [jobId] } = await schedule('discovery');
    const existing = await record(id), added = { ...existing, shortcode: 'NEW_UPLOAD', reel_url: 'https://www.instagram.com/reel/NEW_UPLOAD/' };
    const { args, lease } = await process(jobId, [existing, added]);
    await f.rpc('worker_ingest_page', args);
    await f.rpc('worker_finish_processing', [jobId, lease]);
    await f.identity(); expect(await f.value<number>('select count(*)::int v from public.reels')).toBe(2);
  });
  it('reports missing old Reels and retries only after backoff and authoritative settlement', async () => {
    const id = await f.reel(); await f.reel(); const { job_ids: [jobId] } = await schedule('metrics');
    const { lease } = await process(jobId, [await record(id)]);
    expect(await f.rpc('worker_finish_processing', [jobId, lease])).toMatchObject({ status: 'partial', error_message: '1 of 2 stored Reels were not returned; existing values preserved.' });
    expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    await f.identity(); await f.db.exec("update public.competitor_refresh_runs set next_attempt_at=now()-interval '1 minute'");
    await f.db.query('update public.scrape_jobs set live=true,actual_cost_usd=null where id=$1', [jobId]);
    await f.identity('service_role'); expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    await f.identity(); expect(await f.value<string>('select status v from public.competitor_refresh_runs')).toBe('blocked');
    await f.db.query("update public.scrape_jobs set actual_cost_usd=.002,completed_at=now()-interval '6 minutes' where id=$1", [jobId]);
    await f.db.exec("update public.competitor_refresh_runs set next_attempt_at=now()-interval '1 minute'");
    await f.identity('service_role'); expect((await f.rpc<{ job_ids: string[] }>('worker_competitor_maintain', [fixtureOwner])).job_ids).toHaveLength(1);
    expect((await f.rpc<{ job_ids: string[] }>('worker_competitor_maintain', [fixtureOwner])).job_ids).toHaveLength(0);
  });
  it('respects owner budgets, concurrency, global pause, and expired provider usage on new job kinds', async () => {
    await schedule('discovery');
    await f.identity(); await f.db.exec('update public.app_settings set monthly_budget_usd=0');
    await f.identity('service_role');
    expect(await f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture_actor', 'discovery'])).toMatchObject({ reason: 'budget_paused' });
    await f.identity(); await f.db.exec('update public.app_settings set monthly_budget_usd=50,paused=true');
    await f.identity('service_role');
    expect(await f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture_actor', 'discovery'])).toMatchObject({ reason: 'paused' });
    await f.identity(); await f.db.exec("update public.app_settings set paused=false,provider_usage_checked_at=now()-interval '1 hour'");
    await f.db.query("update public.apify_accounts set usage_checked_at=now()-interval '1 hour' where owner_id=$1 and slot=1", [fixtureOwner]);
    await f.identity('service_role');
    expect(await f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture_actor', 'discovery'])).toMatchObject({ reason: 'live_setup_or_usage_unverified' });
  });
  it('completes a verified empty discovery without fabricating a Reel or a zero bill', async () => {
    const { job_ids: [jobId] } = await schedule('discovery');
    const { lease } = await process(jobId, []);
    await f.identity(); await f.db.query('update public.scrape_jobs set live=true,actual_cost_usd=null,reserved_usd=.25 where id=$1', [jobId]);
    await f.identity('service_role');
    expect(await f.rpc('worker_finish_processing', [jobId, lease])).toMatchObject({ status: 'succeeded', actual_cost_usd: null, reserved_usd: .25 });
    await f.identity(); expect(await f.value<number>('select count(*)::int v from public.reels')).toBe(0);
  });
  it('stops incomplete coverage after three settled attempts and retains all original records', async () => {
    const id = await f.reel(); await f.reel();
    let { job_ids: [jobId] } = await schedule('metrics');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { lease } = await process(jobId, [await record(id)]);
      await f.rpc('worker_finish_processing', [jobId, lease]);
      await f.identity();
      await f.db.query("update public.scrape_jobs set completed_at=now()-interval '20 minutes' where id=$1", [jobId]);
      await f.db.exec("update public.competitor_refresh_runs set next_attempt_at=now()-interval '1 minute'");
      await f.identity('service_role');
      const next = await f.rpc<{ job_ids: string[] }>('worker_competitor_maintain', [fixtureOwner]);
      expect(next.job_ids).toHaveLength(attempt < 3 ? 1 : 0);
      jobId = next.job_ids[0];
    }
    await f.identity();
    expect((await f.db.query('select status,attempt_count,expected_reels,observed_reels from public.competitor_refresh_runs')).rows)
      .toEqual([{ status: 'partial', attempt_count: 3, expected_reels: 2, observed_reels: 1 }]);
    expect(await f.value<number>('select count(*)::int v from public.reels')).toBe(2);
    expect(await f.value<number>('select count(*)::int v from public.scrape_jobs where competitor_run_id is not null')).toBe(3);
  });
  it('enforces backoff even when dataset processing exhausts retries before its finish hook', async () => {
    await f.reel(); const { job_ids: [jobId] } = await schedule('metrics');
    await f.identity(); await f.db.query("update public.scrape_jobs set status='failed',processing_attempts=10,completed_at=now(),actual_cost_usd=.002 where id=$1", [jobId]);
    await f.identity('service_role'); expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    await f.identity(); expect(await f.value<boolean>("select next_attempt_at>=now()+interval '5 minutes' v from public.competitor_refresh_runs")).toBe(true);
  });
  it('installs two distinct schedules plus recovery once, without exposing secrets to browser roles', async () => {
    await f.identity('service_role');
    const args = [fixtureOwner, 'https://fixture.supabase.co', 'synthetic-install-fixture-12345678901234567890'];
    expect(await f.rpc('worker_install_competitor_schedules', args)).toMatchObject({ installed: true });
    await f.rpc('worker_install_competitor_schedules', args);
    await f.identity();
    expect((await f.db.query('select schedule from cron.job order by jobname')).rows).toEqual([
      { schedule: '0 0,12 * * *' }, { schedule: '2-59/5 * * * *' }, { schedule: '30 0 * * *' },
    ]);
    expect(await f.value<number>('select count(*)::int v from vault.secrets')).toBe(1);
    expect(await f.value<boolean>("select has_function_privilege('authenticated','competitor_refresh_private.wake(text)','execute') v")).toBe(false);
  });
  it('recovers missed scheduler wakes and uses slots to prevent duplicate catch-up jobs', async () => {
    await f.reel(); await f.identity('service_role');
    await f.rpc('worker_install_competitor_schedules', [fixtureOwner, 'https://fixture.supabase.co', 'synthetic-install-fixture-12345678901234567890']);
    expect((await f.rpc<{ job_ids: string[] }>('worker_competitor_maintain', [fixtureOwner])).job_ids).toHaveLength(2);
    expect((await f.rpc<{ job_ids: string[] }>('worker_competitor_maintain', [fixtureOwner])).job_ids).toHaveLength(0);
    await f.identity(); expect(await f.value<number>('select count(*)::int v from public.competitor_refresh_runs')).toBe(2);
  });
  it('denies foreign owners and browser scheduler/worker access', async () => {
    await schedule('discovery');
    await f.identity('authenticated', fixtureStranger);
    expect((await f.db.query('select * from public.competitor_refresh_runs')).rows).toEqual([]);
    await expect(f.rpc('worker_schedule', [fixtureOwner, 'discovery'])).rejects.toThrow(/permission denied/);
  });
});
