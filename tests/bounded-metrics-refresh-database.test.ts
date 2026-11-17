import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

const migration = '202611150009_bounded_metrics_refresh.sql';
let f: Awaited<ReturnType<typeof featureDatabase>>;
let sequence = 0;
type Scheduled = { run_ids: string[]; job_ids: string[] };
type Job = {
  id: string; kind: string; status: string; results_limit: number; metrics_tracked_count: number | null;
  requested_profiles_count: number; competitor_run_id: string; workflow_attempt: number; collection_since: string | null;
  owner_user_id: string; reserved_usd: number; actual_cost_usd: number | null; dispatch_nonce: string | null;
  expected_actor_id: string | null; expected_provider_user_id: string | null; apify_account_slot: number | null;
  actor_run_id: string | null; dataset_id: string | null; live: boolean;
};
type Claim = { reason?: string; job?: Job; creators?: { id: string; username: string }[]; max_total_charge_usd?: number };

beforeAll(async () => {
  // Exercise this historical rollout before later patches replace its contracts.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: [migration, ...later] });
}, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });

// Every rollout is applied from the real migration inside this test's rollback
// transaction. The inherited Cron/net implementations are inert SQL fixtures;
// these tests never install schedules, submit provider requests or use credentials.
async function migrate() {
  await f.identity();
  await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8'));
}
async function seed(count: number, creator = f.creator) {
  await f.identity();
  await f.db.query(`insert into public.reels(creator_id,shortcode,reel_url,published_at,latest_fetched_at,provider,latest_views,views_state)
    select $1,$2||n,'https://www.instagram.com/reel/'||$2||n||'/',now()-make_interval(days=>n),
      now()-interval '2 days','fixture',100,'known' from generate_series(1,$3::integer) n`,
  [creator, `BOUNDED_${++sequence}_`, count]);
}
async function addCreator(username: string, owner = fixtureOwner, workspace = f.workspace) {
  await f.identity('authenticated', owner);
  const { id } = await f.rpc<{ id: string }>('add_creator', [workspace, username]);
  await f.identity();
  await f.db.query("update public.creators set status='active' where id=$1", [id]);
  await f.db.exec("update public.scrape_jobs set status='failed',actual_cost_usd=0,completed_at=now() where competitor_run_id is null");
  return id;
}
async function schedule(kind: 'metrics' | 'discovery' = 'metrics', owner = fixtureOwner) {
  await f.identity('service_role', owner);
  return f.rpc<Scheduled>('worker_schedule', [owner, kind]);
}
async function job(id: string) {
  await f.identity();
  return f.value<Job>('select to_jsonb(j) v from public.scrape_jobs j where id=$1', [id]);
}
async function legacyJob(id: string) {
  await f.identity();
  return f.value<Record<string, unknown>>("select to_jsonb(j)-'metrics_tracked_count' v from public.scrape_jobs j where id=$1", [id]);
}
async function targets(runId: string) {
  await f.identity();
  return f.value<string[]>('select array_agg(reel_id::text order by reel_id) v from public.competitor_refresh_targets where run_id=$1', [runId]);
}
async function claim() {
  await f.identity('service_role');
  return f.rpc<Claim>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'metrics']);
}
async function rejected(work: () => Promise<unknown>, message: RegExp) {
  await f.db.exec('savepoint rejected_metrics_call');
  try { await expect(work()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint rejected_metrics_call; release savepoint rejected_metrics_call'); }
}
async function identityAndHold(id: string) {
  await f.identity();
  return f.value<Record<string, unknown>>(`select jsonb_build_object('id',id,'owner_user_id',owner_user_id,'kind',kind,
    'competitor_run_id',competitor_run_id,'workflow_attempt',workflow_attempt,'results_limit',results_limit,
    'metrics_tracked_count',metrics_tracked_count,'collection_since',collection_since,'dispatch_nonce',dispatch_nonce,
    'expected_actor_id',expected_actor_id,'expected_provider_user_id',expected_provider_user_id,
    'apify_account_slot',apify_account_slot,'reserved_usd',reserved_usd,'actual_cost_usd',actual_cost_usd,'live',live) v
    from public.scrape_jobs where id=$1`, [id]);
}

describe('bounded metrics refresh database contract', () => {
  it('bounds independent per-profile windows at 122 -> 172 and 7 -> 57 without changing discovery', async () => {
    const other = await addCreator('bounded_other');
    await seed(122); await seed(7, other); await migrate();
    const metrics = await schedule(), discovery = await schedule('discovery');
    expect(metrics.job_ids).toHaveLength(2); expect(discovery.job_ids).toHaveLength(2);
    await f.identity();
    expect((await f.db.query(`select r.creator_id,j.kind,j.requested_profiles_count,j.metrics_tracked_count,j.results_limit,
      j.collection_since is not null has_cutoff from public.scrape_jobs j join public.competitor_refresh_runs r on r.id=j.competitor_run_id
      where j.kind='metrics' order by j.metrics_tracked_count desc`)).rows).toEqual([
      { creator_id: f.creator, kind: 'metrics', requested_profiles_count: 1, metrics_tracked_count: 122, results_limit: 172, has_cutoff: true },
      { creator_id: other, kind: 'metrics', requested_profiles_count: 1, metrics_tracked_count: 7, results_limit: 57, has_cutoff: true },
    ]);
    expect((await f.db.query("select requested_profiles_count,results_limit,metrics_tracked_count from public.scrape_jobs where kind='discovery'")).rows)
      .toEqual(Array.from({ length: 2 }, () => ({ requested_profiles_count: 1, results_limit: 10000, metrics_tracked_count: null })));
    expect((await schedule()).job_ids).toEqual([]);
    expect((await schedule('discovery')).job_ids).toEqual([]);
    await f.identity();
    expect(await f.value<number>('select count(*)::integer v from public.competitor_refresh_targets')).toBe(129);
    expect(await f.value<number>('select count(*)::integer v from cron.job')).toBe(0);
    expect(await f.value<number>('select count(*)::integer v from net.requests')).toBe(0);
  });

  it('uses the frozen count and exact target identities for every retry despite later Reel imports', async () => {
    await seed(7); await migrate();
    const scheduled = await schedule();
    const runId = scheduled.run_ids[0], frozen = await targets(runId);
    let id = scheduled.job_ids[0];
    const cutoff = (await job(id)).collection_since;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await job(id)).toMatchObject({ results_limit: 57, metrics_tracked_count: 7, requested_profiles_count: 1,
        competitor_run_id: runId, workflow_attempt: attempt, collection_since: cutoff });
      await seed(20);
      await f.db.query(`update public.scrape_jobs set status='failed',live=true,actual_cost_usd=.002,
        billing_reconciled_at=now(),completed_at=now()-interval '20 minutes',processing_attempts=10 where id=$1`, [id]);
      await f.db.query("update public.competitor_refresh_runs set next_attempt_at=now()-interval '1 minute' where id=$1", [runId]);
      await f.identity('service_role');
      const next = await f.rpc<{ job_ids: string[] }>('worker_competitor_maintain', [fixtureOwner]);
      expect(next.job_ids).toHaveLength(attempt < 3 ? 1 : 0);
      expect(await targets(runId)).toEqual(frozen);
      id = next.job_ids[0];
    }
    await f.identity();
    expect(await f.value<number>('select count(*)::integer v from public.reels')).toBe(67);
    expect((await f.db.query('select expected_reels,attempt_count,status from public.competitor_refresh_runs where id=$1', [runId])).rows)
      .toEqual([{ expected_reels: 7, attempt_count: 3, status: 'failed' }]);
  });

  it('skips profiles with zero stored targets rather than queueing a zero-count metrics job', async () => {
    await migrate();
    expect(await schedule()).toMatchObject({ run_ids: [], job_ids: [] });
    await f.identity('service_role');
    expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    expect((await schedule('discovery')).job_ids).toHaveLength(1);
    await f.identity();
    expect(await f.value<number>("select count(*)::integer v from public.competitor_refresh_runs where kind='metrics'")).toBe(0);
  });

  it.each([9950, 10001])('caps %s frozen targets at 10000 without truncating the frozen set', async count => {
    await seed(count); await migrate();
    const { run_ids: [runId], job_ids: [id] } = await schedule();
    expect(await job(id)).toMatchObject({ results_limit: 10000, metrics_tracked_count: count, requested_profiles_count: 1 });
    expect(await targets(runId)).toHaveLength(count);
    expect(await f.value<number>('select expected_reels v from public.competitor_refresh_runs where id=$1', [runId])).toBe(count);
  }, 60_000);

  it('bounds old scheduler-style inserts and prevents rewriting a durable bounded window', async () => {
    await seed(7); await migrate();
    const { run_ids: [runId], job_ids: [id] } = await schedule();
    await f.identity();
    const retry = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,competitor_run_id,workflow_attempt)
      values($1,'metrics',1,10000,$2,2) returning id v`, [fixtureOwner, runId]);
    expect(await job(retry)).toMatchObject({ metrics_tracked_count: 7, results_limit: 57 });
    await rejected(() => f.db.query('update public.scrape_jobs set metrics_tracked_count=8,results_limit=58 where id=$1', [id]), /metrics_window_is_durable/);
    await rejected(() => f.db.query('update public.scrape_jobs set metrics_tracked_count=null,results_limit=10000 where id=$1', [id]), /metrics_window_is_durable/);
    await rejected(() => f.db.query('update public.scrape_jobs set results_limit=10000 where id=$1', [id]), /metrics_window_is_durable/);
    await rejected(() => f.db.query(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,competitor_run_id,workflow_attempt,metrics_tracked_count)
      values($1,'metrics',1,58,$2,3,8)`, [fixtureOwner, runId]), /metrics_target_count_mismatch/);
    expect(await job(id)).toMatchObject({ metrics_tracked_count: 7, results_limit: 57, reserved_usd: 0, actual_cost_usd: null });
  });

  it.each(['pending', 'budget_paused'])('upgrades only a never-started legacy %s job and dispatches its bounded input', async status => {
    await seed(122);
    const { run_ids: [runId], job_ids: [id] } = await schedule();
    await f.identity();
    await f.db.query('update public.scrape_jobs set status=$1 where id=$2', [status, id]);
    const before = await legacyJob(id), frozen = await targets(runId);
    expect(before).toMatchObject({ results_limit: 10000, actual_cost_usd: null, reserved_usd: 0, attempt_count: 0 });
    await migrate();
    expect(await legacyJob(id)).toEqual({ ...before, results_limit: 172 });
    expect(await targets(runId)).toEqual(frozen);
    const result = await claim();
    expect(result.job).toMatchObject({ id, status: 'dispatching', metrics_tracked_count: 122, results_limit: 172,
      requested_profiles_count: 1, actual_cost_usd: null, expected_actor_id: 'fixture-actor', expected_provider_user_id: 'fixture', apify_account_slot: 1 });
    expect(result.creators).toEqual([{ id: f.creator, username: 'backend_fixture' }]);
    expect(result.job!.reserved_usd).toBeGreaterThan(0);
    expect(result.max_total_charge_usd).toBe(result.job!.reserved_usd);
  });

  it.each(['missing association', 'wrong association', 'multiple associations', 'missing target', 'wrong target creator', 'mismatched count', 'zero targets', 'wrong run kind'] as const)(
    'rejects legacy %s scope in direct dispatch before any reservation or identity assignment', async defect => {
      const other = await addCreator('malformed_other');
      await seed(7); await seed(1, other);
      const { run_ids, job_ids } = await schedule();
      await f.identity();
      const runId = await f.value<string>('select id v from public.competitor_refresh_runs where creator_id=$1 and id=any($2::uuid[])', [f.creator, run_ids]);
      const id = await f.value<string>('select id v from public.scrape_jobs where competitor_run_id=$1 and id=any($2::uuid[])', [runId, job_ids]);
      // The unrelated valid profile must not become a fallback candidate.
      await f.db.query("update public.scrape_jobs set scheduled_for=now()+interval '1 day' where id<>$1 and competitor_run_id is not null", [id]);
      if (defect === 'missing association') await f.db.query('delete from public.scrape_job_creators where job_id=$1', [id]);
      if (defect === 'wrong association') await f.db.query('update public.scrape_job_creators set creator_id=$2 where job_id=$1', [id, other]);
      if (defect === 'multiple associations') await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, other]);
      if (defect === 'missing target') await f.db.query('delete from public.competitor_refresh_targets where run_id=$1 and reel_id=(select min(reel_id::text)::uuid from public.competitor_refresh_targets where run_id=$1)', [runId]);
      if (defect === 'wrong target creator') await f.db.query(`update public.competitor_refresh_targets set reel_id=(select id from public.reels where creator_id=$2 limit 1),
        shortcode=(select shortcode from public.reels where creator_id=$2 limit 1) where run_id=$1 and reel_id=(select min(reel_id::text)::uuid from public.competitor_refresh_targets where run_id=$1)`, [runId, other]);
      if (defect === 'mismatched count') await f.db.query('update public.competitor_refresh_runs set expected_reels=8 where id=$1', [runId]);
      if (defect === 'zero targets') {
        await f.db.query('delete from public.competitor_refresh_targets where run_id=$1', [runId]);
        await f.db.query('update public.competitor_refresh_runs set expected_reels=0 where id=$1', [runId]);
      }
      if (defect === 'wrong run kind') await f.db.query("update public.competitor_refresh_runs set kind='discovery' where id=$1", [runId]);
      const before = await legacyJob(id);
      await migrate();
      expect(await job(id)).toMatchObject({ metrics_tracked_count: null, results_limit: 10000 });
      expect(await claim()).toEqual({ reason: 'provider_input_invalid' });
      expect(await legacyJob(id)).toEqual(before);
      await f.identity();
      expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs')).toBe(0);
    },
  );

  it.each(['running', 'uncertain'] as const)('preserves a legacy accepted/uncertain %s identity and unknown hold during rollout and reconciliation', async status => {
    await seed(7);
    const { run_ids: [runId], job_ids: [id] } = await schedule();
    const claimed = await claim();
    expect(claimed.job).toMatchObject({ id, results_limit: 10000, actual_cost_usd: null });
    const nonce = claimed.job!.dispatch_nonce;
    if (status === 'running') await f.rpc('worker_attach_run', [id, nonce, 'synthetic-metrics-run', 'fixture-actor', 'fixture', 'synthetic-dataset']);
    else await f.rpc('worker_start_uncertain', [id, nonce]);
    const before = await legacyJob(id);
    await migrate();
    expect(await legacyJob(id)).toEqual(before);
    expect(await job(id)).toMatchObject({ status, metrics_tracked_count: null, results_limit: 10000, actual_cost_usd: null });
    const pinned = await identityAndHold(id);
    expect(pinned.reserved_usd).toBeGreaterThan(0);
    expect(await f.value<boolean>('select competitor_refresh_private.prepare_metrics_window($1,$2) v', [id, fixtureOwner])).toBe(false);
    await rejected(() => f.db.query('update public.scrape_jobs set metrics_tracked_count=7,results_limit=57 where id=$1', [id]), /metrics_window_already_started/);
    await f.identity('service_role');
    expect(await f.rpc('worker_record_callback_receipt', [fixtureOwner, id, nonce, 'synthetic-metrics-run', 'fixture-actor', 'fixture'])).toEqual({ accepted: true });
    const reconciliation = await f.rpc<{ job: Job }[]>('worker_claim_reconciliation', [fixtureOwner, id, null, 10]);
    expect(reconciliation).toHaveLength(1);
    expect(reconciliation[0].job).toMatchObject({ id, results_limit: 10000, metrics_tracked_count: null, reserved_usd: pinned.reserved_usd });
    if (status === 'uncertain') await f.rpc('worker_attach_run', [id, nonce, 'synthetic-metrics-run', 'fixture-actor', 'fixture', 'synthetic-dataset']);
    await f.rpc('worker_reconcile_run', [id, 'synthetic-metrics-run', 'fixture-actor', 'fixture', 'SUCCEEDED', 'synthetic-dataset', null]);
    expect(await identityAndHold(id)).toEqual(pinned);
    expect(await job(id)).toMatchObject({ actor_run_id: 'synthetic-metrics-run', dataset_id: 'synthetic-dataset', actual_cost_usd: null });
    await f.identity('service_role');
    expect(await f.rpc('worker_competitor_maintain', [fixtureOwner])).toMatchObject({ job_ids: [] });
    await f.identity();
    expect(await f.value<number>('select attempt_count v from public.competitor_refresh_runs where id=$1', [runId])).toBe(1);
    expect(await f.value<number>('select count(*)::integer v from net.requests')).toBe(0);
  });

  it('denies authenticated access to private helpers and exposes only the safe owner-scoped count in bootstrap', async () => {
    await seed(7); await migrate();
    const { job_ids: [id] } = await schedule();
    await f.identity();
    expect(await f.value<boolean>('select competitor_refresh_private.prepare_metrics_window($1,$2) v', [id, fixtureStranger])).toBe(false);
    for (const helper of ['competitor_refresh_private.metrics_never_started(public.scrape_jobs)',
      'competitor_refresh_private.protect_metrics_window()', 'competitor_refresh_private.prepare_metrics_window(uuid,uuid)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await f.value<boolean>('select has_function_privilege($1,$2,\'execute\') v', [role, helper])).toBe(false);
      }
    }
    await f.identity('authenticated');
    await rejected(() => f.db.query('select competitor_refresh_private.prepare_metrics_window($1,$2)', [id, fixtureOwner]), /permission denied/);
    await rejected(() => f.db.query('select competitor_refresh_private.metrics_never_started(null::public.scrape_jobs)'), /permission denied/);
    await rejected(() => f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'metrics']), /permission denied/);
    const before = await job(id);
    await f.identity('authenticated');
    const bootstrap = await f.rpc<{ jobs: Record<string, unknown>[] }>('get_bootstrap');
    expect(bootstrap.jobs.find(row => row.id === id)).toMatchObject({ metrics_tracked_count: 7, results_limit: 57, requested_profiles_count: 1, actual_cost_usd: null });
    for (const row of bootstrap.jobs) {
      expect(row).not.toHaveProperty('expected_provider_user_id'); expect(row).not.toHaveProperty('expected_actor_id');
      expect(row).not.toHaveProperty('dispatch_nonce'); expect(row).not.toHaveProperty('lease_token');
      expect(row).not.toHaveProperty('owner_user_id');
    }
    expect(await job(id)).toEqual(before);
    await f.identity('authenticated', fixtureStranger);
    await rejected(() => f.rpc('get_bootstrap'), /forbidden/);
    expect((await f.db.query('select id from public.competitor_refresh_runs')).rows).toEqual([]);
  });
});
