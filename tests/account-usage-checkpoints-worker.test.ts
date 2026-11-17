import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountUsage } from '../supabase/functions/_shared/model.ts';

vi.stubGlobal('Deno', { env: { get: () => undefined } });
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const start = '2026-11-15T12:00:00.123456+00:00';
const usage: AccountUsage = { userId: 'fixture', cycleStart: '2026-11-01T00:00:00Z', cycleEnd: '2026-12-01T00:00:00Z', usageUsd: 0, limitUsd: 5 };
const json = (value: unknown) => new Response(JSON.stringify(value));
let calls: { name: string; args: Record<string, unknown> }[];
let releaseLimits: () => void;
let limitsReached: Promise<void>;
let reached: () => void;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  calls = []; limitsReached = new Promise(resolve => { reached = resolve; });
  const values: Record<string, string> = { PROVIDER_MODE: 'apify', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', APIFY_API_TOKEN: 'synthetic-primary', APIFY_API_TOKEN_2: 'synthetic-secondary', APIFY_ACCOUNT_ID: 'fixture' };
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] } });
  // All transport is intercepted synthetic data, including provider reads.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'fixture.supabase.co') {
      const name = url.pathname.split('/').at(-1)!;
      const args = JSON.parse(String(init?.body)); calls.push({ name, args });
      if (name === 'worker_begin_account_usage') return json({ observation_id: id, observed_at: start });
      if (['worker_record_usage', 'worker_record_account_usage'].includes(name)) return json(null);
      throw new Error('Unexpected RPC');
    }
    if (url.hostname === 'api.apify.com') {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-primary');
      calls.push({ name: url.pathname, args: {} });
      if (url.pathname === '/v2/users/me') return json({ data: { id: 'fixture' } });
      if (url.pathname === '/v2/users/me/limits') {
        reached(); await new Promise<void>(resolve => { releaseLimits = resolve; });
        return json({ data: { monthlyUsageCycle: { startAt: usage.cycleStart, endAt: usage.cycleEnd }, current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 5 } } });
      }
    }
    throw new Error('Unintercepted transport forbidden');
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('worker account usage request-start checkpoint plumbing', () => {
  it('starts DB observation before provider reads and preserves its exact precision through delayed persistence', async () => {
    const pending = worker.checkedAccountUsage(owner, 1, 'fixture');
    await limitsReached; vi.setSystemTime(new Date('2026-11-15T12:01:00Z')); releaseLimits();
    const observed = await pending; await worker.recordUsage(owner, observed);
    expect(calls.map(call => call.name)).toEqual(['worker_begin_account_usage', '/v2/users/me', '/v2/users/me/limits', 'worker_record_usage']);
    expect(calls[0].args).toEqual({ p_owner_user_id: owner, p_account_slot: 1, p_provider_user_id: 'fixture' });
    expect(observed).toMatchObject({ observationId: id, observedAt: start });
    expect(calls[3].args).toMatchObject({ p_owner_user_id: owner, p_observation_id: id, p_observed_at: start });
    expect(JSON.stringify(calls[3].args)).not.toMatch(/synthetic-primary|synthetic-service/);
  });
  it('pins observation metadata before provider awaits rather than allowing caller mutation to advance time', async () => {
    const observation = { observationId: id, observedAt: start };
    const pending = providers.authoritativeUsage(1, 'fixture', observation);
    await limitsReached; observation.observedAt = '2026-11-15T12:05:00Z'; releaseLimits();
    expect((await pending).observedAt).toBe(start);
  });
  it('passes optional checkpoints to secondary overload and retains old legacy RPC arguments without guessing time', async () => {
    await worker.recordUsage(owner, { ...usage, observationId: id, observedAt: start }, 2);
    expect(calls[0]).toMatchObject({ name: 'worker_record_account_usage', args: { p_account_slot: 2, p_observation_id: id, p_observed_at: start } });
    await worker.recordUsage(owner, usage);
    expect(calls[1].name).toBe('worker_record_usage');
    expect(calls[1].args).not.toHaveProperty('p_observed_at');
  });
  it.each([
    ['reconcile', 'provider'], ['configure', 'provider'], ['diagnostics', 'provider'],
    ['reconcile', 'persistence'], ['configure', 'persistence'], ['diagnostics', 'persistence'],
  ])('keeps a newer success when an older %s %s request fails', async (operation, stage) => {
    const latestId = '33333333-3333-4333-8333-333333333333';
    let observations = 0, limits = 0, currentId: string | null = null, storedId: string | null = null;
    let failOld!: () => void, oldReached!: () => void;
    const waiting = new Promise<void>(resolve => { oldReached = resolve; });
    const delayFailure = async () => {
      oldReached(); await new Promise<void>(resolve => { failOld = resolve; });
      return new Response('{}', { status: 401 });
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'fixture.supabase.co') {
        const name = url.pathname.split('/').at(-1)!, args = JSON.parse(String(init?.body)); calls.push({ name, args });
        if (name === 'worker_accounts') return json([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'fixture', enabled: true,
          authorization_confirmed: true, usage_reconciled_at: null, usage_cycle_start_at: null, usage_cycle_end_at: null, usage_usd: null, limit_usd: null }]);
        if (name === 'worker_begin_account_usage') {
          currentId = ++observations === 1 ? id : latestId;
          return json({ observation_id: currentId, observed_at: start });
        }
        if (name === 'worker_configure_apify_account') return json(null);
        if (name === 'worker_record_usage') {
          if (stage === 'persistence' && args.p_observation_id === id) return delayFailure();
          if (args.p_observation_id === currentId) storedId = currentId;
          return json(null);
        }
        if (name === 'worker_invalidate_account_usage') {
          if (args.p_observation_id === currentId) { currentId = null; storedId = null; }
          return json(null);
        }
        throw new Error('Unexpected RPC');
      }
      if (url.hostname === 'api.apify.com') {
        if (url.pathname === '/v2/users/me') return json({ data: { id: 'fixture' } });
        if (url.pathname === '/v2/users/me/limits') {
          if (++limits === 1 && stage === 'provider') return delayFailure();
          return json({ data: { monthlyUsageCycle: { startAt: usage.cycleStart, endAt: usage.cycleEnd }, current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 5 } } });
        }
      }
      throw new Error('Unintercepted transport forbidden');
    }));
    const run = () => operation === 'reconcile' ? worker.reconcileUsage(owner) : operation === 'configure'
      ? worker.configureAccounts(owner, { account_slots: [1], authorization_confirmed: true }) : worker.accountDiagnostics(owner);
    const old = run().then(() => null, (error: unknown) => error);
    await waiting; await run();
    expect(storedId).toBe(latestId);
    failOld(); expect(await old).toBeInstanceOf(Error);
    expect(calls.filter(call => call.name === 'worker_invalidate_account_usage')).toEqual([
      { name: 'worker_invalidate_account_usage', args: { p_owner_user_id: owner, p_account_slot: 1, p_observation_id: id } },
    ]);
    expect(storedId).toBe(latestId);
  });
  it('fails the invoking worker without unscoped invalidation when no checkpoint token was obtained', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const name = new URL(String(input)).pathname.split('/').at(-1)!, args = JSON.parse(String(init?.body)); calls.push({ name, args });
      if (name === 'worker_accounts') return json([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'fixture', enabled: true, authorization_confirmed: true }]);
      if (name === 'worker_begin_account_usage') return new Response('{}', { status: 503 });
      throw new Error('Unintercepted transport forbidden');
    }));
    await expect(worker.reconcileUsage(owner)).rejects.toThrow('Authoritative account usage unavailable');
    expect(calls.map(call => call.name)).toEqual(['worker_accounts', 'worker_begin_account_usage']);
  });
  it('rejects partial checkpoints, invalid owner/slot and missing checkpoint response before provider reads', async () => {
    await expect(worker.recordUsage(owner, { ...usage, observationId: id })).rejects.toThrow('Invalid account usage checkpoint');
    await expect(worker.checkedAccountUsage('foreign', 1, 'fixture')).rejects.toThrow('Owner setup invalid');
    await expect(worker.checkedAccountUsage(owner, 6, 'fixture')).rejects.toThrow('Invalid Apify account slot');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ observation_id: id })));
    await expect(worker.checkedAccountUsage(owner, 1, 'fixture')).rejects.toThrow('Account usage checkpoint unavailable');
    expect(calls).toEqual([]);
  });
});
