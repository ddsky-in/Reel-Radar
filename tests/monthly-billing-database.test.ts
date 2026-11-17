import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';
let f: Awaited<ReturnType<typeof featureDatabase>>;
let observation: { observation_id: string; observed_at: string }, cycle: { start: string; end: string };
beforeAll(async () => { f = await featureDatabase(); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin'); await f.identity('service_role');
  cycle = { start: new Date(Date.now() - 86400000).toISOString(), end: new Date(Date.now() + 86400000).toISOString() };
  observation = await f.rpc('worker_begin_account_usage', [fixtureOwner, 1, 'fixture']);
  await new Promise(resolve => setTimeout(resolve, 2));
  await f.rpc('worker_record_account_usage', [fixtureOwner, 1, 'fixture', cycle.start, cycle.end, .2, 5, observation.observation_id, observation.observed_at]);
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
const save = (overrides: Record<number, unknown> = {}) => f.rpc<boolean>('worker_record_monthly_billing_report',
  [fixtureOwner, 1, 'fixture', observation.observation_id, observation.observed_at, cycle.start, cycle.end, .3, .2, JSON.stringify({ ACTOR_COMPUTE_UNITS: .2, STORAGE: null })].map((v, i) => i in overrides ? overrides[i] : v));
describe('owner-scoped provider monthly report persistence', () => {
  it('exposes only the matching account and cycle, preserving capacity and budget state', async () => {
    const before = await f.rpc('worker_accounts', [fixtureOwner]);
    expect(await save()).toBe(true);
    expect(await f.rpc('worker_accounts', [fixtureOwner])).toEqual(before);
    await f.identity('authenticated');
    const status = await f.rpc<{ accounts: { monthly_report: unknown }[]; capacity: unknown }>('get_apify_account_status');
    expect(status.accounts[0].monthly_report).toMatchObject({ source: 'apify_monthly_usage', after_discount_usd: .2, service_amounts: { STORAGE: null } });
    expect(status.capacity).toBeDefined();
  });
  it('rejects a different account identity', async () => { await expect(save({ 2: 'foreign' })).rejects.toThrow('provider_account_mismatch'); });
  it('rejects a mismatched billing cycle', async () => { await expect(save({ 5: '2020-01-01T00:00:00Z' })).rejects.toThrow('invalid_monthly_report'); });
  it('rejects an invalid service amount', async () => { await expect(save({ 9: '{"STORAGE":-1}' })).rejects.toThrow('invalid_monthly_services'); });
  it('does not accept a stale observation after a newer check has begun', async () => {
    await f.rpc('worker_begin_account_usage', [fixtureOwner, 1, 'fixture']);
    expect(await save()).toBe(false);
  });
  it('denies browser writes', async () => {
    await f.identity('authenticated'); await expect(save()).rejects.toThrow('permission denied');
  });
  it('denies direct browser access to the private billing table', async () => {
    await f.identity('authenticated');
    await expect(f.db.query('select * from apify_accounts_private.monthly_reports')).rejects.toThrow('permission denied');
  });
  it('denies another owner access to reports', async () => {
    await f.identity('authenticated', fixtureStranger);
    await expect(f.rpc('get_apify_account_status')).rejects.toThrow('forbidden');
  });
});
