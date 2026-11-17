import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH, POST } from '../src/app/api/[...path]/route';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { safeCollectionHolds, safeCollectionJobRecovery, safeBillingSync } from '../src/lib/server/public-data';
import { collectionSettlementSchema, settingsSchema, validate } from '../src/lib/server/validation';
import { syncProviderBilling } from '../src/lib/server/billing-sync';
import { collectionBudgetMetrics } from '../src/lib/metrics';
import { mutationResourceDependencies, resourceMatchesFamilies } from '../src/lib/resource-dependencies';
import type { BillingSyncResult, CollectionJobRecovery } from '../src/lib/types';

const session = vi.hoisted(() => ({ authenticated: true }));
vi.mock('@/lib/supabase/server', () => ({ authenticatedClient: async () => {
  if (!session.authenticated) throw new Error('Denied');
  return { client: {}, user: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.invalid' } };
}, createSupabaseServerClient: vi.fn() }));
const wakes = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock('@/lib/server/dispatcher', () => ({ scheduleDispatcherWake: wakes.schedule }));
const origin = 'http://127.0.0.1:3100';
const jobId = '22222222-2222-4222-8222-222222222222';
const recovery: CollectionJobRecovery = { id: jobId, kind: 'carousel', status: 'uncertain', account_slot: 2,
  reserved_usd: .31, claimed_cap_usd: .1, reservation_started_at: '2026-11-01T00:00:00Z', uncertain_since: null,
  dispatch_phase: 'legacy', operational_disposition: 'protected', actual_cost_usd: null,
  recovery_reason: null, recovery_attempts: 3, expected_version: 5,
  creators: [{ id: '33333333-3333-4333-8333-333333333333', username: 'synthetic_fixture' }], audit: [] };
const capacity = { occupied_slots: 5, uncertain_slots: 3, max_active: 5, paid_starts_gated: true };
const holds = { items: [recovery], total: 1, page: 1, limit: 25, capacity, usage: { reconciled_month_spend_usd: .02, risk_released_exposure_usd: .4 } };
const billing: BillingSyncResult = { sync: { accounts: [{ accountSlot: 2, enabled: true, success: true, syncedAt: '2026-11-16T00:00:00Z', error: null }],
  runs: { checked: 3, reconciled: 1, unknown: 2, failed: 0 }, paidStarts: 0, syncedAt: '2026-11-16T00:00:00Z' } };
function call(method: typeof GET, parts: string[], body?: unknown, search = '') {
  return method(new Request(`${origin}/api/${parts.join('/')}${search}`, { method: method === GET ? 'GET' : method === PATCH ? 'PATCH' : 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ path: parts }) });
}
// Exports share dispatch identity: use explicit HTTP method for mutation requests.
function mutation(parts: string[], body: unknown, method = 'POST') {
  return (method === 'PATCH' ? PATCH : POST)(new Request(`${origin}/api/${parts.join('/')}`, { method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: parts }) });
}
beforeEach(() => { session.authenticated = true; vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('DEMO_MODE', 'false'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co'); vi.stubEnv('REELRADAR_DISPATCH_SECRET', 'server-only-fixture'); wakes.schedule.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('collection safety owner API and contracts', () => {
  it('pages all holds independently from bootstrap and strips nonce, identities and evidence', async () => {
    const read = vi.spyOn(SupabaseRepository.prototype, 'collectionHolds').mockResolvedValue({ ...holds, items: [{ ...recovery, dispatch_nonce: 'private', service_token: 'private' }] } as unknown as typeof holds);
    vi.spyOn(SupabaseRepository.prototype, 'bootstrap').mockRejectedValue(new Error('Must not read latest jobs'));
    const response = await call(GET, ['jobs', 'holds']);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(read).toHaveBeenCalledWith(1, 25); expect(await response.json()).toEqual(safeCollectionHolds(holds));
    expect(wakes.schedule).not.toHaveBeenCalled();
    for (const query of ['?owner=foreign', '?page=1&page=2', '?limit=51', '?page=0', '?page=-1']) expect((await call(GET, ['jobs', 'holds'], undefined, query)).status).toBe(400);
  });
  it('lazy recovery handles historical null uncertainty timestamp and never exposes secret audit data', async () => {
    const raw = { ...recovery, nonce: 'private', audit: [{ outcome: 'risk_release', created_at: '2026-11-16T00:00:00Z', released_usd: .31, reason: 'Explicit fixture decision', evidence_reference: 'private', service_secret: 'private' }] };
    const sanitized = safeCollectionJobRecovery(raw);
    expect(sanitized.uncertain_since).toBeNull(); expect(JSON.stringify(sanitized)).not.toContain('private');
    vi.spyOn(SupabaseRepository.prototype, 'collectionJobRecovery').mockResolvedValue(sanitized);
    const response = await call(GET, ['jobs', jobId, 'recovery']); expect(response.status).toBe(200); expect(await response.json()).toEqual(sanitized);
    expect((await call(GET, ['jobs', jobId, 'recovery'], undefined, '?owner=foreign')).status).toBe(400);
    expect(() => safeCollectionHolds({ ...holds, capacity: { ...capacity, uncertain_slots: 6 } })).toThrow();
    expect(() => safeCollectionJobRecovery({ ...raw, expected_version: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
  it('rejects forged verified decisions, owner/evidence fields and missing acknowledgements', async () => {
    const body = { outcome: 'risk_release', reason: 'Explicit fixture risk decision', expected_version: 5, idempotency_key: '44444444-4444-4444-8444-444444444444', acknowledge_unknown: true };
    const settled = vi.spyOn(SupabaseRepository.prototype, 'settleCollectionJob').mockResolvedValue({ ...recovery, reserved_usd: 0, operational_disposition: 'risk_released' });
    for (const patch of [{ outcome: 'verified_no_start' }, { outcome: 'risk_released' }, { acknowledge_unknown: false }, { owner_id: 'foreign' }, { evidence_reference: 'https://private.invalid' }, { reason: 'short' }]) {
      expect((await mutation(['jobs', jobId, 'settlement'], { ...body, ...patch })).status).toBe(400);
    }
    expect(settled).not.toHaveBeenCalled();
    const response = await mutation(['jobs', jobId, 'settlement'], body); expect(response.status).toBe(200);
    const result = await response.json(); expect(result.actual_cost_usd).toBeNull(); expect(result.operational_disposition).toBe('risk_released'); expect(settled).toHaveBeenCalledWith(jobId, body);
    expect(wakes.schedule).not.toHaveBeenCalled();
    expect(() => validate(collectionSettlementSchema, { ...body, expected_version: -1 })).toThrow();
  });
  it('binds exact settlement RPC args with server-only evidence and reads authoritative postcommit state', async () => {
    const calls: [string, unknown][] = [];
    const rpc = vi.fn(async (name: string, args: unknown) => { calls.push([name, args]); return { data: name === 'get_collection_job_recovery' ? { ...recovery, operational_disposition: 'risk_released', reserved_usd: 0 } : {}, error: null }; });
    const repo = new SupabaseRepository({ rpc } as never, 'owner', 'owner@example.invalid');
    const body = { outcome: 'risk_release' as const, reason: 'Explicit fixture risk decision', expected_version: 5, idempotency_key: '44444444-4444-4444-8444-444444444444', acknowledge_unknown: true as const };
    const result = await repo.settleCollectionJob(jobId, body);
    expect(calls).toEqual([['collection_settle_job', { p_job_id: jobId, p_outcome: 'risk_release', p_reason: body.reason, p_evidence_reference: 'owner_ui_explicit_decision', p_idempotency_key: body.idempotency_key, p_expected_version: 5, p_acknowledge_unknown: true }], ['get_collection_job_recovery', { p_job_id: jobId }]]);
    expect(result.actual_cost_usd).toBeNull();
  });
  it('validates zero and six-decimal independent caps and never wakes on saving caps or budgets', async () => {
    for (const value of [0, .1, .000001, 10000, .907554]) expect(validate(settingsSchema, { collection_job_cap_usd: value })).toEqual({ collection_job_cap_usd: value });
    for (const value of [-1, .0000001, .1234567, 10000.1, Infinity]) expect(() => validate(settingsSchema, { collection_job_cap_usd: value })).toThrow();
    const settings = (await new DemoRepository().bootstrap()).settings;
    vi.spyOn(SupabaseRepository.prototype, 'settings').mockResolvedValue(settings);
    expect((await mutation(['settings'], { collection_job_cap_usd: 0 }, 'PATCH')).status).toBe(200);
    expect((await mutation(['settings'], { monthly_budget_usd: 5, collection_job_cap_usd: .1 }, 'PATCH')).status).toBe(200);
    expect(wakes.schedule).not.toHaveBeenCalled();
    const usage = { estimated_month_spend: .3, actual_month_spend: null, reserved_usd: 0, unreconciled_jobs: 1, remaining_allowance: 10, provider_balance_usd: null, reconciled_month_spend_usd: .02, risk_released_exposure_usd: .4 };
    expect(collectionBudgetMetrics({ ...settings, scraping_enabled: true, collection_job_cap_usd: 0 }, usage, capacity)).toMatchObject({ subtotal: .02, reserved: 0, exposure: .4, remaining_guaranteed: false, paid_starts_gated: true });
  });
  it('limits billing to explicit owner action and exact billing-only service payload', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...billing, internal_secret: 'private', sync: { ...billing.sync, service_nonce: 'private' } }));
    const result = await syncProviderBilling({ NODE_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co', REELRADAR_DISPATCH_SECRET: 'private' }, fetcher as typeof fetch);
    expect(result).toEqual(billing); expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fixture.supabase.co/functions/v1/reconcile-jobs'); expect(JSON.parse(String(options.body))).toEqual({ action: 'billing_sync', continuation_budget: 0 }); expect(options.redirect).toBe('error');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(billing)));
    expect((await mutation(['billing', 'sync'], {})).status).toBe(200); expect(wakes.schedule).not.toHaveBeenCalled();
    expect((await mutation(['billing', 'sync'], { continuation_budget: 1 })).status).toBe(400);
    session.authenticated = false; expect((await mutation(['billing', 'sync'], {})).status).not.toBe(200);
    expect(() => safeBillingSync({ sync: { ...billing.sync, paidStarts: 1 } })).toThrow();
  });
  it('fails closed before service fetch and keeps demo provider-free', async () => {
    const fetcher = vi.fn();
    for (const env of [{}, { NEXT_PUBLIC_SUPABASE_URL: 'https://evil.invalid', REELRADAR_DISPATCH_SECRET: 'private' }, { NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co/path', REELRADAR_DISPATCH_SECRET: 'private' }]) await expect(syncProviderBilling(env, fetcher)).rejects.toThrow('secure server configuration');
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv('DEMO_MODE', 'true'); vi.stubGlobal('fetch', fetcher);
    expect((await mutation(['billing', 'sync'], {})).status).toBe(409); expect(fetcher).not.toHaveBeenCalled();
  });
  it('invalidates account, paged hold, lazy recovery and global capacities together', () => {
    for (const path of ['/api/jobs/holds?page=3&limit=25', `/api/jobs/${jobId}/recovery`, '/api/apify-accounts', '/api/bootstrap']) expect(resourceMatchesFamilies(path, ['jobs', 'settings', 'creators'])).toBe(true);
    expect(mutationResourceDependencies('/api/billing/sync', 'POST')).toEqual({ families: ['jobs', 'settings', 'creators'] });
    expect(mutationResourceDependencies(`/api/jobs/${jobId}/settlement`, 'POST')?.families).toContain('jobs');
  });
});
