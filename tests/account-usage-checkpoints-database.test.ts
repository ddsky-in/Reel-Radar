import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Observation = { observation_id: string; observed_at: string };
async function start(slot = 1, user: string | null = 'fixture', owner = fixtureOwner) {
  const observation = await f.rpc<Observation>('worker_begin_account_usage', [owner, slot, user]);
  // PGlite's millisecond clock can lag the SQL-issued monotonic microsecond stamp.
  // Wait only for genuine starts; forged/future persistence still reaches the guard.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await f.value<boolean>('select clock_timestamp()>=$1::timestamptz v', [observation.observed_at])) return observation;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Fixture clock did not reach the issued checkpoint');
}
const persist = (o: Observation | null, amount = 0, limit = 5, slot = 1, user = 'fixture', owner = fixtureOwner,
  cycle = { start: new Date(Date.now() - 86400000).toISOString(), end: new Date(Date.now() + 20 * 86400000).toISOString() }) =>
  f.rpc('worker_record_account_usage', [owner, slot, user, cycle.start, cycle.end, amount, limit, o?.observation_id ?? null, o?.observed_at ?? null]);
async function rejected(run: () => Promise<unknown>, message: string) {
  await f.db.exec('savepoint invalid_checkpoint');
  try { await expect(run()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint invalid_checkpoint; release savepoint invalid_checkpoint'); }
}
async function account() {
  return (await f.rpc<Record<string, unknown>[]>('worker_accounts', [fixtureOwner]))[0];
}
async function status() {
  await f.identity('authenticated');
  const result = await f.rpc<{ accounts: { reason: string | null }[] }>('get_apify_account_status');
  await f.identity('service_role'); return result.accounts[0];
}
async function job(hold = 5) {
  return f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,reserved_usd,
    expected_actor_id,expected_provider_user_id,apify_account_slot,dispatch_nonce,attempt_count,actor_run_id,billing_month)
    values($1,'daily','running',1,30,true,$2,'fixture-actor','fixture',1,gen_random_uuid(),1,'synthetic-run','2025-01-01') returning id v`, [fixtureOwner, hold]);
}
async function pending() {
  const id = await f.value<string>("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit) values($1,'daily',1,30) returning id v", [fixtureOwner]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]);
  return id;
}
const claim = () => f.rpc<{ reason?: string; job?: { id: string; reserved_usd: number }; max_total_charge_usd?: number }>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'daily']);
const settle = (id: string, cost: number | null = 5) => f.rpc('worker_reconcile_run', [id, 'synthetic-run', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', cost]);
beforeAll(async () => { f = await featureDatabase(); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); await f.identity('service_role'); });
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });

// Synthetic local Postgres fixtures. PGlite queues calls; interleavings are
// deterministic transaction schedules, not evidence of hosted concurrent load.
describe('DB-issued account usage observation checkpoints', () => {
  it('retains cost settled after observation start despite delayed persistence and old transaction now()', async () => {
    const id = await job();
    const observation = await start();
    await settle(id);
    await f.db.query("update public.scrape_jobs set status='succeeded' where id=$1", [id]);
    await persist(observation);
    const row = await account();
    expect(Date.parse(String(row.usage_reconciled_at))).toBe(Date.parse(observation.observed_at));
    expect(await f.value<boolean>('select billing_reconciled_at>$2::timestamptz v from public.scrape_jobs where id=$1', [id, observation.observed_at])).toBe(true);
    expect(await status()).toMatchObject({ reason: 'allowance_exhausted' });
    expect(await f.value('select jsonb_build_object(\'hold\',reserved_usd,\'cost\',actual_cost_usd) v from public.scrape_jobs where id=$1', [id])).toEqual({ hold: 0, cost: 5 });
    const pending = await f.value<string>("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit) values($1,'daily',1,30) returning id v", [fixtureOwner]);
    await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [pending, f.creator]);
    expect(await f.rpc('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'daily'])).toEqual({ reason: 'budget_paused' });
  });
  it.each([5, 6])('retains cost %s settled before a lagging usage observation at or above the provider cap', async cost => {
    const cycle = { start: new Date(Date.now() - 86400000).toISOString(), end: new Date(Date.now() + 20 * 86400000).toISOString() };
    const id = await job(); await settle(id, cost);
    await f.db.query("update public.scrape_jobs set status='succeeded' where id=$1", [id]);
    const before = await f.value("select jsonb_build_object('cost',actual_cost_usd,'hold',reserved_usd,'settled',billing_reconciled_at,'slot',apify_account_slot) v from public.scrape_jobs where id=$1", [id]);
    const observation = await start();
    expect(await f.value<boolean>('select billing_reconciled_at<$2::timestamptz v from public.scrape_jobs where id=$1', [id, observation.observed_at])).toBe(true);
    await persist(observation, 0, 5, 1, 'fixture', fixtureOwner, cycle);
    await pending();
    expect(await status()).toMatchObject({ reason: 'allowance_exhausted', reserved_usd: 0, usage_usd: 0, limit_usd: 5 });
    expect(await claim()).toEqual({ reason: 'budget_paused' });
    // Even a later request in the same cycle, with unchanged lagging usage,
    // cannot treat ordering as evidence that the provider reflected this cost.
    await persist(await start(), 0, 5, 1, 'fixture', fixtureOwner, cycle);
    expect(await status()).toMatchObject({ reason: 'allowance_exhausted' });
    expect(await claim()).toEqual({ reason: 'budget_paused' });
    expect(await f.value("select jsonb_build_object('cost',actual_cost_usd,'hold',reserved_usd,'settled',billing_reconciled_at,'slot',apify_account_slot) v from public.scrape_jobs where id=$1", [id])).toEqual(before);
    expect(await f.value<number>('select monthly_budget_usd::float8 v from public.app_settings')).toBe(50);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBe(0);
  });
  it('adds known cycle costs even when usage could already include them, without inventing reflection', async () => {
    const id = await job(); await settle(id, 2);
    await f.db.query("update public.scrape_jobs set status='succeeded' where id=$1", [id]);
    await persist(await start(), 1, 5);
    expect(await status()).toMatchObject({ reason: null });
    const next = await pending();
    expect(await claim()).toMatchObject({ job: { id: next, reserved_usd: .1 }, max_total_charge_usd: .1 });
    expect(await f.value('select jsonb_build_object(\'hold\',reserved_usd,\'cost\',actual_cost_usd) v from public.scrape_jobs where id=$1', [id])).toEqual({ hold: 0, cost: 2 });
  });
  it('does not discard known costs with missing settlement time or current-cycle start evidence', async () => {
    const id = await job(); await settle(id, 2);
    await f.db.query("update public.scrape_jobs set status='succeeded',billing_reconciled_at=null where id=$1", [id]);
    await persist(await start());
    await pending();
    expect(await claim()).toMatchObject({ max_total_charge_usd: .1 });
  });
  it.each(['started', 'created'])('retains current-cycle %s costs despite a backdated settlement timestamp', async evidence => {
    const id = await job(); await settle(id);
    await f.db.query(`update public.scrape_jobs set status='succeeded',billing_reconciled_at=now()-interval '2 days',
      started_at=case when $2='started' then now() else null end where id=$1`, [id, evidence]);
    await persist(await start());
    expect(await status()).toMatchObject({ reason: 'allowance_exhausted' });
    await pending(); expect(await claim()).toEqual({ reason: 'budget_paused' });
  });
  it('excludes only fully historical known costs across a cycle boundary, while retaining old outstanding holds', async () => {
    const historical = await job(); await settle(historical, 5);
    await f.db.query("update public.scrape_jobs set status='succeeded',actor_run_id=null,started_at=now()-interval '3 days',created_at=now()-interval '4 days',billing_reconciled_at=now()-interval '2 days' where id=$1", [historical]);
    const held = await job(1);
    await f.db.query("update public.scrape_jobs set status='pending',scheduled_for=now()+interval '1 day',started_at=now()-interval '3 days',created_at=now()-interval '4 days' where id=$1", [held]);
    await persist(await start());
    expect(await status()).toMatchObject({ reason: null, reserved_usd: 1 });
    await pending(); expect(await claim()).toMatchObject({ max_total_charge_usd: .1 });
    expect(await f.value('select jsonb_build_object(\'hold\',reserved_usd,\'cost\',actual_cost_usd) v from public.scrape_jobs where id=$1', [historical])).toEqual({ hold: 0, cost: 5 });
    expect(await f.value('select jsonb_build_object(\'hold\',reserved_usd,\'cost\',actual_cost_usd,\'slot\',apify_account_slot) v from public.scrape_jobs where id=$1', [held])).toEqual({ hold: 1, cost: null, slot: 1 });
  });
  it('never lets delayed older observation, replay or legacy caller overwrite a newer checkpoint', async () => {
    const old = await start(), latest = await start();
    expect(Date.parse(latest.observed_at)).toBeGreaterThanOrEqual(Date.parse(old.observed_at));
    await persist(latest, 4, 5);
    const before = await account();
    await persist(old, 0, 500);
    await persist(latest, 0, 500);
    await persist(null, 0, 500);
    await f.rpc('worker_record_usage', [fixtureOwner, 'fixture', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString(), 0, 500]);
    expect(await account()).toEqual(before);
  });
  it('treats a newer failed read and invalidation as barriers against an older successful response', async () => {
    const old = await start(); await start();
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]);
    await persist(old);
    expect((await account()).usage_reconciled_at).toBeNull();
  });
  it('keeps newer accepted usage when an older read later fails, but invalidates the latest failed read', async () => {
    const old = await start(), latest = await start();
    await persist(latest, 1, 5);
    const before = await account();
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1, old.observation_id]);
    expect(await account()).toEqual(before);
    expect(await status()).toMatchObject({ reason: null });
    const failed = await start();
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1, failed.observation_id]);
    expect((await account()).usage_reconciled_at).toBeNull();
    await persist(latest, 0, 500);
    expect((await account()).usage_reconciled_at).toBeNull();
    expect(await status()).toMatchObject({ reason: 'usage_unverified' });
    await persist(await start());
    expect(await status()).toMatchObject({ reason: null });
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]);
    expect((await account()).usage_reconciled_at).toBeNull();
  });
  it('rejects conditional invalidation without a token or owner and isolates foreign tokens', async () => {
    const o = await start(); await persist(o);
    await rejected(() => f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1, null]), 'invalid_usage_checkpoint');
    await rejected(() => f.rpc('worker_invalidate_account_usage', [fixtureStranger, 1, o.observation_id]), 'owner_not_provisioned');
    await f.rpc('worker_configure_apify_account', [fixtureOwner, 2, 'secondary', true, true]);
    const secondary = await start(2, 'secondary'); await persist(secondary, 0, 5, 2, 'secondary');
    const before = await account();
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1, secondary.observation_id]);
    expect(await account()).toEqual(before);
  });
  it('preserves unknown holds, owner budgets and secondary isolation', async () => {
    const id = await job(.907554), o = await start(); await settle(id, null); await persist(o);
    expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [id])).toBe(.907554);
    expect((await account()).usage_usd).toBe(0);
    expect(await status()).toMatchObject({ reason: 'unreconciled_charges' });
    expect(await f.value<number>('select monthly_budget_usd::float8 v from public.app_settings')).toBe(50);
    await f.rpc('worker_configure_apify_account', [fixtureOwner, 2, 'secondary', true, true]);
    const secondary = await start(2, 'secondary'); await persist(secondary, 3, 8, 2, 'secondary');
    expect((await account()).usage_usd).toBe(0);
  });
  it('keeps legacy-only observations from dropping settled accounting', async () => {
    const id = await job(); await settle(id);
    await f.db.query("update public.scrape_jobs set status='succeeded' where id=$1", [id]);
    await persist(null);
    expect(await status()).toMatchObject({ reason: 'allowance_exhausted' });
  });
  it('rejects forged, future, expired, foreign-owner, foreign-slot and foreign-identity checkpoints', async () => {
    const o = await start();
    await rejected(() => persist({ ...o, observed_at: new Date(Date.now() + 60000).toISOString() }), 'invalid_usage_checkpoint');
    await rejected(() => persist({ ...o, observation_id: '11111111-1111-4111-8111-111111111111' }), 'invalid_usage_checkpoint');
    await rejected(() => persist(o, 0, 5, 1, 'wrong'), 'provider_account_mismatch');
    await rejected(() => persist(o, 0, 5, 1, 'fixture', fixtureStranger), 'provider_account_mismatch');
    await f.rpc('worker_configure_apify_account', [fixtureOwner, 2, 'secondary', true, true]);
    await rejected(() => persist(o, 0, 5, 2, 'secondary'), 'invalid_usage_checkpoint');
    await f.identity();
    await f.db.query("update apify_accounts_private.usage_observations set observed_at=clock_timestamp()-interval '16 minutes' where id=$1", [o.observation_id]);
    const expired = await f.value<string>('select observed_at::text v from apify_accounts_private.usage_observations where id=$1', [o.observation_id]);
    await f.identity('service_role');
    await rejected(() => persist({ ...o, observed_at: expired }), 'invalid_usage_checkpoint');
    await rejected(() => start(6), 'invalid_apify_account');
    await rejected(() => start(1, 'fixture', fixtureStranger), 'owner_not_provisioned');
  });
  it.each(['anon', 'authenticated'])('denies checkpoint RPCs and private checkpoint tables to %s', async role => {
    const o = await start(); await f.identity(role);
    await rejected(() => start(), 'permission denied');
    await rejected(() => persist(o), 'permission denied');
    await rejected(() => f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1, o.observation_id]), 'permission denied');
    await rejected(() => f.db.query('select * from apify_accounts_private.usage_checkpoints'), 'permission denied');
  });
  it('keeps owner budget lock, row lock, service requirement and settlement clock explicit', async () => {
    const defs = await f.value<string[]>(`select array_agg(pg_get_functiondef(oid)) v from pg_proc where oid=any(array[
      'public.worker_begin_account_usage(uuid,integer,text)'::regprocedure,
      'public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric,uuid,timestamptz)'::regprocedure])`);
    for (const def of defs) { expect(def).toContain('require_service'); expect(def).toContain('pg_advisory_xact_lock'); expect(def).toContain('for update'); }
    const def = await f.value<string>("select pg_get_functiondef('public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)'::regprocedure) v");
    expect(def).toContain('then clock_timestamp() else billing_reconciled_at');
  });
});
