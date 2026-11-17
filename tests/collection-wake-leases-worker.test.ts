import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Job } from '../supabase/functions/_shared/model.ts';
vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111', creator = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
let env: Record<string, string>, calls: { name: string; args: Record<string, unknown> }[], unexpected: string[];
let revision: number, drained: number, active: string | null, used: number, deferred: boolean, starts: number;
let claimReason: string | undefined, startFailure: boolean, renewFailure: boolean, nextFailure: boolean, drainFailure: boolean, releaseFailure: boolean;
let queue: Job[], startBarrier: (() => Promise<void>) | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const named = (name: string) => calls.filter(call => call.name === name);
const job = (sequence: number): Job => ({ id: `44444444-4444-4444-8444-00000000000${sequence}`, owner_user_id: owner,
  kind: 'daily', live: true, status: 'dispatching', collection_source: 'ordinary', apify_account_slot: 1,
  expected_actor_id: 'reel-actor', expected_provider_user_id: 'fixture', dispatch_nonce: nonce, reserved_usd: .1, results_limit: 30,
  actor_run_id: null, dataset_id: null, dataset_cursor: 0, dataset_finished: false, lease_token: nonce,
  started_at: '2026-11-15T12:00:00Z', provider_terminal_status: null, actual_cost_usd: null });
const completion = () => worker.dispatch(owner, true, new worker.CollectionSession(owner), true);
function state() {
  return { max_active: 2, max_starts_per_wake: 2, wake_revision: revision, drained_revision: drained, wake_pending: revision > drained,
    eligible_kinds: ['daily'], executor_nonce: active, executor_revision: active ? revision : null,
    executor_expires_at: active ? '2099-01-01T00:00:00Z' : null, executor_starts: used, executor_start_limit: 2,
    wake_retry_after: deferred ? '2099-01-01T00:00:00Z' : null };
}
beforeEach(() => {
  env = { PROVIDER_MODE: 'apify', APIFY_ACCOUNT_ID: 'fixture', APIFY_API_TOKEN: 'synthetic-token', APIFY_REEL_ACTOR_RESOURCE_ID: 'reel-actor',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', REELRADAR_OWNER_USER_ID: owner,
    APIFY_WEBHOOK_SHARED_SECRET: 'synthetic-webhook', INTERNAL_CRON_SECRET: 'synthetic-internal', SCRAPING_ENABLED: 'true',
    PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true' };
  calls = []; unexpected = []; revision = 1; drained = 0; active = null; used = 0; deferred = false; starts = 0;
  claimReason = undefined; startFailure = false; renewFailure = false; nextFailure = false; drainFailure = false; releaseFailure = false;
  queue = []; startBarrier = undefined;
  vi.stubGlobal('Deno', { env: { get: (name: string) => env[name] }, serve: vi.fn() });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const name = url.pathname.split('/').at(-1)!, args = JSON.parse(String(init?.body)); calls.push({ name, args });
      expect(args.p_owner_user_id ?? owner).toBe(owner);
      if (name === 'worker_claim_collection_executor') {
        if (active) return json({ reason: 'executor_busy' });
        if (args.p_completion_only && revision <= drained) return json({ reason: 'wake_not_pending' });
        if (deferred) return json({ reason: 'wake_retry_deferred' });
        if (!args.p_completion_only && revision <= drained) revision++;
        active = nonce;
        return json({ ...state(), claimed_revision: revision, starts_remaining: 2 - used });
      }
      if (name === 'worker_collection_runtime') return json(state());
      if (name === 'worker_competitor_maintain') return json(null);
      if (name === 'worker_accounts') return json([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'fixture', enabled: true, authorization_confirmed: true }]);
      if (name === 'worker_claim_next') {
        expect(args.p_executor_nonce).toBe(active); expect(args.p_claimed_revision).toBe(revision);
        if (nextFailure) return json(null, 503);
        if (claimReason) return json({ reason: claimReason });
        const selected = queue.shift();
        if (selected) { used++; return json({ job: selected, creators: [{ id: creator, username: 'fixture' }], max_total_charge_usd: .1 } satisfies Context & { max_total_charge_usd: number }); }
        return json({ reason: 'no_pending_jobs' });
      }
      if (name === 'worker_renew_collection_executor') return json(!renewFailure);
      if (name === 'worker_drain_completion_wake') {
        expect(args.p_executor_nonce).toBe(nonce); expect(args.p_revision).toBe(1);
        if (drainFailure) return json(null, 503);
        drained = Number(args.p_revision); active = null; return json(true);
      }
      if (name === 'worker_release_collection_executor') {
        if (releaseFailure) return json(null, 503);
        active = null; deferred = true; return json(true);
      }
      if (name === 'worker_get_collection_recovery_state') return json({ input_digest: null, accepted_evidence: [], callback_hints: [] });
      if (name === 'worker_record_accepted_evidence') return json({ recorded: true });
      if (name === 'worker_authorize_collection_submit') return json({ authorized: !renewFailure });
      if (name === 'worker_cancel_pre_submit') return json({ cancelled: true });
      if (name === 'worker_attach_run' || name === 'worker_dispatch_failure') return json(null);
      unexpected.push(name); throw new Error('Unexpected fake RPC');
    }
    if (url.origin === 'https://api.apify.com') {
      if (url.pathname === '/v2/users/me') return json({ data: { id: 'fixture' } });
      if (url.pathname === '/v2/actors/reel-actor/runs' && init?.method === 'POST') {
        starts++; await startBarrier?.();
        if (startFailure) return json(null, 503);
        return json({ data: { id: `run-${starts}`, actId: 'reel-actor', userId: 'fixture', status: 'RUNNING', defaultDatasetId: `dataset-${starts}` } });
      }
    }
    unexpected.push(url.origin + url.pathname); throw new Error('Unintercepted network forbidden');
  }));
});
afterEach(() => { expect(unexpected).toEqual([]); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable coalesced worker executor', () => {
  it('coalesces generic maintenance before queue scans as well as paid submissions', async () => {
    queue = [job(1)];
    let unblock!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { unblock = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    startBarrier = () => { entered(); return barrier; };
    const generic = () => worker.dispatch(owner, true, new worker.CollectionSession(owner), false, 'generic');
    const first = generic(); await ready;
    const duplicates = await Promise.all(Array.from({ length: 6 }, generic));
    expect(duplicates.every(result => result[0].reason === 'executor_busy')).toBe(true);
    expect(named('worker_competitor_maintain')).toHaveLength(1);
    expect(calls.findIndex(call => call.name === 'worker_claim_collection_executor')).toBeLessThan(calls.findIndex(call => call.name === 'worker_competitor_maintain'));
    expect(starts).toBe(1); unblock(); await first;
  });
  it('serializes simultaneous completion callbacks before account/provider work', async () => {
    queue = [job(1), job(2), job(3)];
    let unblock!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const atStart = new Promise<void>(resolve => { entered = resolve; });
    startBarrier = () => { entered(); return blocked; };
    const first = completion(); await atStart;
    const other = await Promise.all(Array.from({ length: 6 }, () => completion()));
    expect(other).toEqual(Array.from({ length: 6 }, () => [{ reason: 'executor_busy' }]));
    expect(named('worker_accounts')).toHaveLength(1); expect(starts).toBe(1);
    unblock(); await first;
    expect(starts).toBe(2); expect(named('worker_claim_next')).toHaveLength(2);
    expect(named('worker_drain_completion_wake')).toHaveLength(1); expect(named('worker_release_collection_executor')).toHaveLength(0);
    expect(await completion()).toEqual([{ reason: 'wake_not_pending' }]); expect(starts).toBe(2);
  });
  it('drains captured revision only, preserving completion arriving during a start', async () => {
    queue = [job(1)]; startBarrier = async () => { revision = 2; };
    // The fixture selector accepts the captured revision; the SQL suite tests this fence.
    const fetcher = vi.mocked(fetch), original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/worker_claim_next') && revision === 2) {
        const args = JSON.parse(String(init?.body)); calls.push({ name: 'worker_claim_next', args });
        expect(args.p_claimed_revision).toBe(1); return json({ reason: 'no_pending_jobs' });
      }
      return original(input, init);
    });
    await completion(); expect(drained).toBe(1); expect(revision).toBe(2);
  });
  it.each(['budget_paused','concurrency_limit','provider_input_invalid','unreconciled_charges','executor_lease_lost'])('retains blocked %s wake without looping', async reason => {
    claimReason = reason; await completion();
    expect(named('worker_claim_next')).toHaveLength(1); expect(starts).toBe(0);
    expect(named('worker_drain_completion_wake')).toHaveLength(0); expect(named('worker_release_collection_executor')).toHaveLength(1);
    expect(drained).toBe(0); expect(await completion()).toEqual([{ reason: 'wake_retry_deferred' }]);
    expect(named('worker_claim_next')).toHaveLength(1);
  });
  it('ambiguous start preserves wake, nonce reservation and single paid attempt', async () => {
    queue = [job(1), job(2)]; startFailure = true;
    expect(await completion()).toContainEqual({ job_id: job(1).id, status: 'uncertain' });
    expect(starts).toBe(1); expect(used).toBe(1);
    expect(named('worker_dispatch_failure')).toHaveLength(1); expect(named('worker_drain_completion_wake')).toHaveLength(0);
    expect(await completion()).toEqual([{ reason: 'wake_retry_deferred' }]); expect(starts).toBe(1);
  });
  it('lost/stale renew never starts and releases continuation for bounded recovery', async () => {
    queue = [job(1)]; renewFailure = true; await completion();
    expect(starts).toBe(0); expect(named('worker_cancel_pre_submit')).toHaveLength(1); expect(named('worker_dispatch_failure')).toHaveLength(0);
    expect(named('worker_release_collection_executor')).toHaveLength(1); expect(drained).toBe(0);
  });
  it.each(['claim','drain'])('releases without draining when %s RPC throws', async failure => {
    nextFailure = failure === 'claim'; drainFailure = failure === 'drain';
    await expect(completion()).rejects.toThrow('Database RPC');
    expect(named('worker_release_collection_executor')).toHaveLength(1); expect(drained).toBe(0);
  });
  it('a false drain result rejects and releases rather than reporting success', async () => {
    const fetcher = vi.mocked(fetch), original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/worker_drain_completion_wake')) {
        calls.push({ name: 'worker_drain_completion_wake', args: JSON.parse(String(init?.body)) });
        return json(false);
      }
      return original(input, init);
    });
    await expect(completion()).rejects.toThrow('lease lost before drain');
    expect(drained).toBe(0); expect(named('worker_release_collection_executor')).toHaveLength(1);
  });
  it('failed release does not mask the original error or fabricate a drain', async () => {
    nextFailure = true; releaseFailure = true;
    await expect(completion()).rejects.toThrow('worker_claim_next');
    expect(active).toBe(nonce); expect(drained).toBe(0); expect(starts).toBe(0);
  });
  it('usage exception releases ownership and retains wake before next-job claims', async () => {
    const session = new worker.CollectionSession(owner);
    vi.spyOn(session, 'reconcileUsage').mockRejectedValue(new Error('synthetic usage failure'));
    await expect(worker.dispatch(owner, false, session, true)).rejects.toThrow('synthetic usage failure');
    expect(named('worker_claim_next')).toHaveLength(0); expect(named('worker_release_collection_executor')).toHaveLength(1);
  });
  it('manual dispatch still runs without a completion wake while sharing the executor', async () => {
    drained = 1; queue = [job(1)];
    const fetcher = vi.mocked(fetch), original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/worker_drain_completion_wake')) {
        const args = JSON.parse(String(init?.body)); calls.push({ name: 'worker_drain_completion_wake', args });
        expect(args.p_revision).toBe(2); drained = 2; active = null; return json(true);
      }
      return original(input, init);
    });
    const outcomes = await worker.dispatch(owner, true);
    expect(outcomes).toContainEqual({ job_id: job(1).id, status: 'running' }); expect(starts).toBe(1);
    expect(named('worker_claim_collection_executor')[0].args.p_completion_only).toBe(false);
  });
});
