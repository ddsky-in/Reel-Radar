import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApifyAccount, ApifyAccountSlot, Context, Job } from '../supabase/functions/_shared/model.ts';

vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const refresh = await import('../supabase/functions/refresh-dispatch/index.ts' as string);
const webhook = await import('../supabase/functions/apify-webhook/index.ts' as string);
const reconcile = await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const media = await import('../supabase/functions/_shared/transcription-media.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const creator = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-14T12:00:00.000Z';
const tokenNames = ['APIFY_API_TOKEN', 'APIFY_API_TOKEN_2', 'APIFY_API_TOKEN_3', 'APIFY_API_TOKEN_4', 'APIFY_API_TOKEN_5'];
const fixtureTokens = ['synthetic-account-one', 'synthetic-account-two', 'synthetic-account-three', 'synthetic-account-four', 'synthetic-account-five'];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let values: Record<string, string>;
let accounts: ApifyAccount[];
let selected: Job;
let claimed: Job[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let mismatched: number | null;
let stale: number | null;
let timedOut: boolean;
let fairBatch: Job[] | null;
let providerReads: { slot: number; path: string; method: string }[];
const rpcCalls = (name: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/rpc/${name}`));
const rpcArgs = (name: string) => rpcCalls(name).map(([, init]) => JSON.parse(String(init?.body)));
const starts = () => providerReads.filter(read => read.method === 'POST');
function job(slot: ApifyAccountSlot, patch: Partial<Job> = {}): Job {
  return { id: `44444444-4444-4444-8444-00000000000${slot}`, owner_user_id: owner, apify_account_slot: slot,
    kind: 'daily', collection_source: 'ordinary', status: 'dispatching', live: true, results_limit: 30, reserved_usd: .1,
    expected_actor_id: 'reel-actor', expected_provider_user_id: `account-${slot}`, dispatch_nonce: nonce,
    actor_run_id: `run-${slot}`, dataset_id: `dataset-${slot}`, dataset_cursor: 0, dataset_finished: false,
    lease_token: nonce, started_at: now, provider_terminal_status: null, actual_cost_usd: null, ...patch };
}
const context = (value: Job): Context => ({ job: value, creators: [{ id: creator, username: 'fixture' }] });
const internal = (input: unknown) => new Request('https://fixture.test/refresh-dispatch', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-secret': 'synthetic-internal' }, body: JSON.stringify(input) });
const callback = (value: Job) => new Request(`https://fixture.test/apify-webhook?job_id=${value.id}&dispatch_nonce=${nonce}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'synthetic-webhook' }, body: JSON.stringify({ run_id: value.actor_run_id }),
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  values = { PROVIDER_MODE: 'apify', APIFY_ACCOUNT_ID: 'account-1', APIFY_REEL_ACTOR_RESOURCE_ID: 'reel-actor',
    APIFY_PROFILE_ACTOR_RESOURCE_ID: 'profile-actor', SUPABASE_URL: 'https://fixture.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', REELRADAR_OWNER_USER_ID: owner,
    APIFY_WEBHOOK_SHARED_SECRET: 'synthetic-webhook', INTERNAL_CRON_SECRET: 'synthetic-internal',
    SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true',
    TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER_VALIDATED: 'true', ELEVENLABS_API_KEY: 'synthetic-elevenlabs' };
  tokenNames.forEach((name, index) => { values[name] = fixtureTokens[index]; });
  accounts = [1, 2, 3, 4, 5].map(slot => ({ owner_user_id: owner, account_slot: slot as ApifyAccountSlot, provider_user_id: `account-${slot}`,
    enabled: true, authorization_confirmed: true, usage_cycle_start_at: '2026-11-01T00:00:00Z',
    usage_cycle_end_at: '2026-12-01T00:00:00Z', usage_usd: 0, limit_usd: 5, usage_reconciled_at: now }));
  selected = job(1); claimed = []; mismatched = null; stale = null; timedOut = false; fairBatch = null; providerReads = [];
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  // Entire transport is synthetic and intercepted, including all Apify requests.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    if (url.origin === 'https://fixture.supabase.co') {
      expect(headers.get('authorization')).toBe('Bearer synthetic-service');
      expect(headers.get('apikey')).toBe('synthetic-service');
      if (url.pathname === '/rest/v1/scrape_jobs') {
        expect(url.searchParams.get('owner_user_id')).toBe(`eq.${owner}`);
        expect(url.searchParams.has('kind')).toBe(false); // Candidate selection belongs to worker_claim_next.
        return json([selected]);
      }
      if (url.pathname === '/rest/v1/scrape_job_creators') return json([{ creators: { id: creator, username: 'fixture' } }]);
      const name = url.pathname.split('/').at(-1), args = JSON.parse(String(init?.body));
      if (name === 'worker_accounts') { expect(args.p_owner_user_id).toBe(owner); return json(accounts); }
      if (name === 'worker_begin_account_usage') {
        expect(args.p_owner_user_id).toBe(owner); expect(args.p_provider_user_id).toBe(accounts[args.p_account_slot - 1].provider_user_id);
        return json({ observation_id: creator, observed_at: now });
      }
      if (name === 'worker_claim_collection_executor') {
        expect(args.p_owner_user_id).toBe(owner); expect(typeof args.p_completion_only).toBe('boolean');
        return json({ max_active: 3, max_starts_per_wake: 3,
        wake_revision: 1, drained_revision: 0, wake_pending: true, eligible_kinds: ['daily', 'weekly', 'backfill', 'manual', 'retry', 'discovery', 'metrics'],
        executor_nonce: nonce, executor_revision: 1, executor_expires_at: '2026-11-14T12:01:30.000Z', executor_starts: 0,
        executor_start_limit: 3, wake_retry_after: null, claimed_revision: 1, starts_remaining: 3 });
      }
      if (['worker_drain_completion_wake', 'worker_renew_collection_executor', 'worker_release_collection_executor'].includes(String(name))) {
        expect(args).toEqual({ p_owner_user_id: owner, p_executor_nonce: nonce, p_revision: 1 }); return json(true);
      }
      if (name === 'worker_record_completion_wake') return json(selected.collection_source === 'ordinary');
      if (name === 'worker_claim_next' || name === 'worker_transcription_media_claim') {
        if (name === 'worker_claim_next') {
          expect(args.p_owner_user_id).toBe(owner); expect(args.p_live).toBe(true);
          expect(args.p_actor_ids.daily).toBe('reel-actor'); expect(args.p_eligible_kinds).toContain('daily');
          expect(args.p_executor_nonce).toBe(nonce); expect(args.p_claimed_revision).toBe(1);
          expect(args).not.toHaveProperty('p_account_slot');
        }
        const value = claimed.shift(); return json(value ? { ...context(value), max_total_charge_usd: .1 } : { reason: 'no_pending_jobs' });
      }
      if (name === 'worker_claim_processing') return json(context(structuredClone(selected)));
      if (name === 'worker_claim_reconciliation') return json((fairBatch ?? [selected]).map(value => ({ job: structuredClone(value),
        callback_hint: { run_id: value.actor_run_id, dispatch_nonce: nonce }, reconciliation_token: nonce })));
      if (name === 'worker_reconcile_run') {
        const value = (fairBatch ?? [selected]).find(value => value.id === args.p_job_id)!;
        return json({ ...value, status: 'succeeded', provider_terminal_status: 'SUCCEEDED', actual_cost_usd: .01 });
      }
      if (name === 'worker_record_callback_receipt') return json({ accepted: true });
      if (name === 'worker_transcription_media_reconcile') return json({ status: 'not_linked', actual_cost_known: true });
      if (name === 'worker_transcription_media_jobs') return json({ jobs: [{ id: selected.id, creator_id: creator, actor_run_id: selected.actor_run_id, status: 'running' }] });
      if (name === 'worker_invalidate_account_usage') { accounts[Number(args.p_account_slot) - 1].usage_reconciled_at = null; return json(null); }
      if (name === 'worker_configure_apify_account') {
        const account = accounts[Number(args.p_account_slot) - 1];
        if (accounts.some(value => value.account_slot !== account.account_slot && value.provider_user_id === args.p_provider_user_id)) return json(null, 409);
        Object.assign(account, { provider_user_id: args.p_provider_user_id, enabled: args.p_enabled, authorization_confirmed: args.p_authorization_confirmed }); return json(null);
      }
      if (name === 'worker_get_collection_recovery_state') return json({ input_digest: null, accepted_evidence: [], callback_hints: [] });
      if (name === 'worker_record_accepted_evidence') return json({ recorded: true });
      if (name === 'worker_authorize_collection_submit') return json({ authorized: true });
      if (name === 'worker_cancel_pre_submit') return json({ cancelled: true });
      if (name === 'worker_claim_missing_run_recovery') return json([]);
      if (['worker_record_usage', 'worker_record_account_usage', 'worker_attach_run', 'worker_dispatch_failure', 'worker_ingest_page',
        'worker_record_output_summary', 'worker_finish_processing', 'worker_release_processing', 'worker_complete_reconciliation',
        'worker_expire_dispatches', 'worker_competitor_maintain', 'worker_drain_completion_wake'].includes(String(name))) return json(null);
      throw new Error(`Unexpected synthetic RPC ${name}`);
    }
    if (url.origin === 'https://api.apify.com') {
      const slot = fixtureTokens.findIndex(token => headers.get('authorization') === `Bearer ${token}`) + 1;
      expect(slot).toBeGreaterThan(0); providerReads.push({ slot, path: url.pathname, method: init?.method ?? 'GET' });
      if (url.pathname === '/v2/users/me') return json({ data: { id: mismatched === slot ? 'foreign-account' : `account-${slot}`, email: 'private-email', token: 'private-value' } });
      if (url.pathname === '/v2/users/me/limits') return json({ data: { monthlyUsageCycle: { startAt: '2026-11-01T00:00:00Z', endAt: stale === slot ? '2026-11-02T00:00:00Z' : '2026-12-01T00:00:00Z' },
        current: { monthlyUsageUsd: .02 }, limits: { maxMonthlyUsageUsd: 5 } } });
      const actor = /^\/v2\/actors\/([^/]+)\/runs$/.exec(url.pathname)?.[1];
      if (actor && init?.method === 'POST') {
        if (timedOut) throw new Error('Synthetic acceptance timeout');
        return json({ data: { id: `run-${slot}`, actId: actor, userId: `account-${slot}`, status: 'RUNNING', defaultDatasetId: `dataset-${slot}` } });
      }
      if (url.pathname === `/v2/actor-runs/run-${slot}`) return json({ data: { id: `run-${slot}`, actId: selected.kind === 'profile' ? 'profile-actor' : 'reel-actor', userId: `account-${slot}`, status: 'SUCCEEDED',
        defaultDatasetId: `dataset-${slot}`, defaultKeyValueStoreId: `store-${slot}`, usageTotalUsd: .01 } });
      if (url.pathname === `/v2/datasets/dataset-${slot}/items`) return json([{ ownerUsername: 'fixture', error: 'no_items' }]);
      if (url.pathname === `/v2/key-value-stores/store-${slot}/records/OUTPUT`) return json({ ok: true, total_items: 1, users: [{ user: 'fixture', count: 1 }] });
      throw new Error('Foreign-account resource request');
    }
    throw new Error('Unintercepted origin forbidden');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('fixed server account slots and immutable provider clients', () => {
  it('uses each SQL claimed account 1 through 5, not the pre-claim adapter or global primary', async () => {
    for (const slot of [1, 2, 3, 4, 5] as const) {
      const value = job(slot, { actor_run_id: null }); claimed = [value];
      expect(await worker.dispatch(owner)).toContainEqual({ job_id: value.id, status: 'running' });
    }
    expect(starts().map(read => read.slot)).toEqual([1, 2, 3, 4, 5]);
    // Invocation-local sessions reuse authoritative <=60s registry snapshots; no billing writes are needed.
    expect(rpcArgs('worker_record_account_usage')).toEqual([]); expect(rpcArgs('worker_record_usage')).toEqual([]);
    expect(rpcCalls('worker_accounts')).toHaveLength(5);
    expect(rpcArgs('worker_claim_next').every(args => !('p_account_slot' in args))).toBe(true);
  });
  it.each([1, 2, 3, 4, 5] as const)('pins start/run/dataset/OUTPUT to slot %s and verifies once per adapter', async slot => {
    selected = job(slot);
    const adapter = await worker.providerForJob(selected);
    await adapter.start(context(selected), .1, async () => true); await adapter.run(`run-${slot}`);
    await adapter.page(context(selected), 100); await adapter.summary(context(selected));
    expect(providerReads.every(read => read.slot === slot)).toBe(true);
    expect(providerReads.filter(read => read.path === '/v2/users/me')).toHaveLength(1);
    expect(starts()).toHaveLength(1);
    expect(providerReads.some(read => read.path.includes(`/store-${slot}/records/OUTPUT`))).toBe(true);
  });
  it.each([2, 4, 5] as const)('cannot swap slots on a reused slot %s adapter or substitute a token after its first operation', async slot => {
    const other = slot === 5 ? 4 : 5;
    const adapter = await worker.providerForJob(job(slot));
    await adapter.run(`run-${slot}`); values[tokenNames[slot - 1]] = fixtureTokens[other - 1];
    await adapter.page(context(job(slot)), 100);
    await expect(adapter.start(context(job(other)), .1)).rejects.toThrow('Pinned account');
    expect(providerReads.every(read => read.slot === slot)).toBe(true); expect(starts()).toHaveLength(0);
  });
  it.each(([2, 4, 5] as const).flatMap(slot => (['mismatch', 'missing', 'registry'] as const).map(failure => ({ slot, failure }))))('rejects $failure on slot $slot before paid POST and never probes another token', async ({ slot, failure }) => {
    selected = job(slot);
    if (failure === 'mismatch') mismatched = slot;
    if (failure === 'missing') delete values[tokenNames[slot - 1]];
    if (failure === 'registry') accounts[slot - 1].provider_user_id = 'different-account';
    await expect((async () => (await worker.providerForJob(selected)).start(context(selected), .1))()).rejects.toThrow();
    expect(starts()).toHaveLength(0); expect(providerReads.every(read => read.slot === slot && read.path === '/v2/users/me')).toBe(true);
  });
  it.each([2, 4, 5] as const)('performs exactly one paid POST on slot %s timeout and does not retry or rotate to another queued account', async slot => {
    selected = job(slot); claimed = [selected, job(slot === 5 ? 4 : 5)]; timedOut = true;
    expect(await worker.dispatch(owner, true)).toContainEqual({ job_id: selected.id, status: 'uncertain' });
    expect(starts().map(read => read.slot)).toEqual([slot]); expect(rpcCalls('worker_claim_next')).toHaveLength(1);
    expect(rpcArgs('worker_dispatch_failure')).toEqual([{ p_owner_user_id: owner, p_job_id: selected.id, p_dispatch_nonce: nonce,
      p_classification: 'request_unknown', p_error: 'Provider acceptance or persistence unknown' }]);
  });
  it.each(['mismatch', 'stale', 'missing'] as const)('invalidates old account usage on %s and blocks fallback claims', async failure => {
    accounts[0].usage_reconciled_at = '2026-11-14T11:58:00.000Z'; // Expired short session reuse forces authoritative revalidation.
    if (failure === 'mismatch') mismatched = 1;
    if (failure === 'stale') stale = 1;
    if (failure === 'missing') delete values.APIFY_API_TOKEN;
    claimed = [job(2)];
    await expect(worker.dispatch(owner)).rejects.toThrow('Authoritative account usage');
    if (failure === 'missing') {
      expect(rpcArgs('worker_invalidate_account_usage')).toEqual([]); // No observed token can authorize clearing another request.
      expect(accounts[0].usage_reconciled_at).toBe('2026-11-14T11:58:00.000Z');
    } else {
      expect(rpcArgs('worker_invalidate_account_usage')).toContainEqual({ p_owner_user_id: owner, p_account_slot: 1, p_observation_id: creator });
      expect(accounts[0].usage_reconciled_at).toBeNull();
    }
    expect(rpcCalls('worker_claim_next')).toHaveLength(0); expect(starts()).toHaveLength(0);
  });
  it('uses only legacy slot 1 for missing historical slot with exact legacy ID, without registry probing', async () => {
    selected = job(1); delete selected.apify_account_slot;
    await worker.verifyRun(selected);
    expect(rpcCalls('worker_accounts')).toHaveLength(0); expect(providerReads.every(read => read.slot === 1)).toBe(true);
    fetcher.mockClear(); providerReads = []; selected.expected_provider_user_id = 'account-2';
    await expect(worker.verifyRun(selected)).rejects.toThrow(); expect(providerReads).toEqual([]); expect(rpcCalls('worker_accounts')).toHaveLength(0);
    selected.expected_provider_user_id = 'account-1'; delete values.APIFY_API_TOKEN;
    await expect(worker.verifyRun(selected)).rejects.toThrow('Missing APIFY_API_TOKEN'); expect(providerReads).toEqual([]);
  });
  it.each([2, 4, 5] as const)('keeps explicit slot %s historical reads available when primary token/ID is absent and account disabled', async slot => {
    selected = job(slot); delete values.APIFY_API_TOKEN; delete values.APIFY_ACCOUNT_ID; accounts[slot - 1].enabled = false;
    await worker.verifyRun(selected); expect(providerReads.every(read => read.slot === slot)).toBe(true);
  });
  it('rejects unknown job kinds and actor mismatches before paid POST', async () => {
    expect(() => providers.provider('unsupported', true)).toThrow('Unsupported');
    selected = job(2, { expected_actor_id: 'wrong-actor' });
    await expect(worker.providerForJob(selected)).rejects.toThrow('Actor contract');
    expect(providerReads).toEqual([]);
  });
});

describe('account-aware callbacks, processing, inspection and media', () => {
  it.each([1, 2, 3, 4, 5] as const)('verifies an authenticated slot %s callback using its original account only', async slot => {
    selected = job(slot);
    const result = await webhook.handler(callback(selected)); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ accepted: true, processing: 'succeeded' });
    expect(providerReads.every(read => read.slot === slot || read.path.startsWith('/v2/users/me'))).toBe(true);
    expect(providerReads.filter(read => read.path.includes('/actor-runs/')).every(read => read.slot === slot)).toBe(true);
    expect(rpcArgs('worker_attach_run')[0].p_provider_user_id).toBe(`account-${slot}`); expect(starts()).toHaveLength(0);
  });
  it('reads mixed fair callback batches with each job factory, never primary-bound batch credentials', async () => {
    fairBatch = [job(5), job(3), job(1), job(4), job(2)]; values.SCRAPING_ENABLED = 'false';
    const result = await reconcile.handler(internal({ continuation_budget: 0 })); expect(result.status).toBe(200);
    const body = await result.json(); expect(body.outcomes.map((value: { state: string }) => value.state)).toEqual(Array(5).fill('succeeded'));
    expect(providerReads.filter(read => read.path.includes('/actor-runs/')).map(read => read.slot)).toEqual([5, 3, 1, 4, 2]);
    expect(rpcCalls('worker_accounts')).toHaveLength(1); // Hint verification feeds the same-session reconciliation read.
    expect(rpcCalls('worker_complete_reconciliation')).toHaveLength(5); expect(starts()).toHaveLength(0);
  });
  it.each([3, 4, 5] as const)('processes slot %s pages and OUTPUT, retaining centralized normalization', async slot => {
    selected = job(slot); expect(await worker.processJob(selected.id)).toBe('finished');
    expect(providerReads.every(read => read.slot === slot)).toBe(true); expect(rpcCalls('worker_ingest_page')).toHaveLength(1);
    expect(rpcArgs('worker_ingest_page')[0]).toMatchObject({ p_records: [], p_received_counts: { [creator]: 1 } });
  });
  it('inspects owned secondary run/sample/OUTPUT without primary account assumptions', async () => {
    selected = job(2); const result = await worker.inspectRun(owner, 'run-2'); expect(result.userId).toBe('account-2');
    expect(providerReads.every(read => read.slot === 2)).toBe(true); expect(starts()).toHaveLength(0);
  });
  it('maintains exact linked secondary media run even when primary token is absent', async () => {
    selected = job(3, { kind: 'manual', results_limit: 100 }); delete values.APIFY_API_TOKEN;
    expect(await media.maintainTranscriptMedia(false)).toHaveLength(1);
    expect(providerReads.every(read => read.slot === 3)).toBe(true); expect(starts()).toHaveLength(0);
  });
  it('starts only the exact media claim account, preserving existing media/STT gates', async () => {
    selected = job(2, { kind: 'manual', collection_source: 'target_media', results_limit: 100 }); claimed = [selected];
    expect(await media.dispatchMediaJob(selected.id)).toEqual({ job_id: selected.id, status: 'running' });
    expect(starts().map(read => read.slot)).toEqual([2]); expect(rpcCalls('worker_claim_next')).toHaveLength(0);
  });
});

describe('secure account initialization and read-only diagnostics', () => {
  it('uses exactly the five fixed token names and accepts a legacy three-slot registry during rolling upgrades', async () => {
    expect([1, 2, 3, 4, 5].map(slot => providers.accountTokenName(slot))).toEqual(tokenNames);
    for (const slot of [0, 6, '4', 4.5, null]) expect(() => providers.accountSlot(slot)).toThrow('Invalid Apify account slot');
    expect((await worker.workerAccounts(owner)).map((account: ApifyAccount) => account.account_slot)).toEqual([1, 2, 3, 4, 5]);
    accounts = accounts.slice(0, 3);
    expect((await worker.workerAccounts(owner)).map((account: ApifyAccount) => account.account_slot)).toEqual([1, 2, 3]);
    expect(providerReads).toEqual([]);
  });
  it.each(['too_many', 'duplicate_slot', 'slot_six', 'foreign_owner', 'duplicate_identity'] as const)('rejects malformed five-slot registry %s before provider IO', async failure => {
    if (failure === 'too_many') accounts.push({ ...accounts[4], account_slot: 6 } as unknown as ApifyAccount);
    if (failure === 'duplicate_slot') accounts[4] = { ...accounts[4], account_slot: 4 };
    if (failure === 'slot_six') accounts[4] = { ...accounts[4], account_slot: 6 } as unknown as ApifyAccount;
    if (failure === 'foreign_owner') accounts[4].owner_user_id = creator;
    if (failure === 'duplicate_identity') accounts[4].provider_user_id = 'account-4';
    await expect(worker.workerAccounts(owner)).rejects.toThrow(); expect(providerReads).toEqual([]);
  });
  it('authorizes all five fixed slots in one request without paid starts, raw tokens or changed singleton identity', async () => {
    for (const account of accounts.slice(1)) Object.assign(account, { provider_user_id: null, enabled: false, authorization_confirmed: false });
    values.SCRAPING_ENABLED = 'false'; values.PROVIDER_VALIDATED = 'false';
    const result = await worker.configureAccounts(owner, { action: 'configure_accounts', account_slots: [1, 2, 3, 4, 5], authorization_confirmed: true });
    expect(result.configured.map((account: { accountSlot: number; tokenEnvName: string }) => [account.accountSlot, account.tokenEnvName])).toEqual([1, 2, 3, 4, 5].map((slot, index) => [slot, tokenNames[index]]));
    expect(result.paidStarts).toBe(0); expect(rpcCalls('worker_configure_apify_account')).toHaveLength(5);
    expect(providerReads.map(read => [read.slot, read.path])).toEqual([1, 2, 3, 4, 5].flatMap(slot => [[slot, '/v2/users/me'], [slot, '/v2/users/me/limits']]));
    fixtureTokens.forEach(token => expect(JSON.stringify(result)).not.toContain(token));
    expect(JSON.stringify(result)).not.toContain('private'); expect(starts()).toHaveLength(0);
  });
  it.each([4, 5] as const)('missing token for unconfigured slot %s never probes another credential or enables any requested slot', async slot => {
    for (const account of accounts.slice(3)) Object.assign(account, { provider_user_id: null, enabled: false, authorization_confirmed: false });
    delete values[tokenNames[slot - 1]];
    await expect(worker.configureAccounts(owner, { action: 'configure_accounts', account_slots: [slot, slot === 4 ? 5 : 4], authorization_confirmed: true })).rejects.toThrow(`Missing ${tokenNames[slot - 1]}`);
    expect(providerReads).toEqual([]); expect(rpcCalls('worker_configure_apify_account')).toHaveLength(0); expect(starts()).toHaveLength(0);
  });
  it('does not probe disabled unconfigured 4/5 during usage reconciliation or diagnostics', async () => {
    for (const account of accounts.slice(3)) Object.assign(account, { provider_user_id: null, enabled: false, authorization_confirmed: false });
    delete values.APIFY_API_TOKEN_4; delete values.APIFY_API_TOKEN_5;
    await worker.reconcileUsage(owner); const result = await worker.accountDiagnostics(owner);
    expect(result.accounts.slice(3)).toEqual([4, 5].map(slot => ({ accountSlot: slot, tokenEnvName: tokenNames[slot - 1], enabled: false, stored: false, reason: 'disabled' })));
    expect(providerReads.every(read => read.slot <= 3)).toBe(true); expect(starts()).toHaveLength(0);
  });
  it.each([4, 5] as const)('recognizes slot %s as the only configured token for gates and diagnostics without requiring legacy primary', async slot => {
    tokenNames.forEach((name, index) => { if (index !== slot - 1) delete values[name]; }); delete values.APIFY_ACCOUNT_ID;
    accounts.forEach(account => { if (account.account_slot !== slot) account.enabled = false; });
    expect(worker.diagnosticsMissingKeys()).toEqual([]); expect(() => providers.validateDispatchSetup()).not.toThrow();
    selected = job(slot); const adapter = await worker.providerForJob(selected);
    await adapter.start(context(selected), .1, async () => true);
    expect(starts().map(read => read.slot)).toEqual([slot]); expect(providerReads.every(read => read.slot === slot)).toBe(true);
  });
  it('bootstraps 2/3 identities from their own users/me with gates disabled, then persists authorized usage without paid work', async () => {
    for (const account of accounts.slice(1)) Object.assign(account, { provider_user_id: null, enabled: false, authorization_confirmed: false });
    values.SCRAPING_ENABLED = 'false'; values.PROVIDER_VALIDATED = 'false';
    const result = await refresh.handler(internal({ action: 'configure_accounts', account_slots: [2, 3], authorization_confirmed: true }));
    expect(result.status).toBe(200); const text = await result.text();
    fixtureTokens.forEach(token => expect(text).not.toContain(token)); expect(text).not.toContain('private-email'); expect(text).not.toContain('private-value');
    expect(rpcArgs('worker_configure_apify_account')).toEqual([2, 3].map(slot => ({ p_owner_user_id: owner, p_account_slot: slot, p_provider_user_id: `account-${slot}`, p_enabled: true, p_authorization_confirmed: true })));
    expect(providerReads.map(read => [read.slot, read.path])).toEqual([[2, '/v2/users/me'], [2, '/v2/users/me/limits'], [3, '/v2/users/me'], [3, '/v2/users/me/limits']]);
    expect(starts()).toHaveLength(0); expect(rpcCalls('worker_claim_next')).toHaveLength(0);
  });
  it.each([
    { account_slots: [2], authorization_confirmed: false }, { account_slots: [2, 2], authorization_confirmed: true },
    { account_slots: [6], authorization_confirmed: true }, { account_slots: ['2'], authorization_confirmed: true },
    { account_slots: [1, 2, 3, 4, 5, 1], authorization_confirmed: true },
    { account_slots: [2], authorization_confirmed: true, token: 'never-accepted' },
  ])('rejects unauthorized or non-slot bootstrap input without provider IO: %j', async payload => {
    const result = await refresh.handler(internal({ action: 'configure_accounts', ...payload })); expect(result.status).toBe(503);
    expect(providerReads).toEqual([]); expect(rpcCalls('worker_configure_apify_account')).toHaveLength(0);
  });
  it('rejects duplicate verified provider identities before any slot is enabled', async () => {
    accounts[1].provider_user_id = null; accounts[1].enabled = false;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/v2/users/me') && new Headers(init?.headers).get('authorization') === `Bearer ${fixtureTokens[1]}`
      ? Promise.resolve(json({ data: { id: 'account-1' } })) : original(url, init));
    await expect(worker.configureAccounts(owner, { action: 'configure_accounts', account_slots: [2], authorization_confirmed: true })).rejects.toThrow('Duplicate provider');
    expect(rpcCalls('worker_configure_apify_account')).toHaveLength(0); expect(starts()).toHaveLength(0);
  });
  it('diagnoses every enabled registry slot explicitly without inventing balances or leaking profile/secrets', async () => {
    values.SCRAPING_ENABLED = 'false'; const result = await worker.accountDiagnostics(owner);
    expect(result.accounts.map((account: { userId: string }) => account.userId)).toEqual(['account-1', 'account-2', 'account-3', 'account-4', 'account-5']);
    expect(result.accounts.every((account: { balanceUsd: unknown; stored: boolean }) => account.balanceUsd === null && account.stored)).toBe(true);
    expect(result.gates.scrapingEnabled).toBe(false); expect(JSON.stringify(result)).not.toContain('private');
    fixtureTokens.forEach(token => expect(JSON.stringify(result)).not.toContain(token)); expect(starts()).toHaveLength(0);
  });
  it('marks mismatched diagnostics usage unknown and invalidates only that stale snapshot', async () => {
    mismatched = 2; const result = await worker.accountDiagnostics(owner);
    expect(result.accounts[1]).toMatchObject({ accountSlot: 2, stored: false, reason: 'usage_unverified', balanceUsd: null });
    expect(rpcArgs('worker_invalidate_account_usage')).toEqual([{ p_owner_user_id: owner, p_account_slot: 2, p_observation_id: creator }]);
    expect(starts()).toHaveLength(0);
  });
  it('leaves unexposed credits unknown and requires explicit expected user identity for secondary usage', async () => {
    expect(await providers.authoritativeUsage(2, 'account-2')).not.toHaveProperty('plan');
    await expect(providers.authoritativeUsage(2, 'account-1')).rejects.toThrow('Account identity');
    expect(providerReads.every(read => read.slot === 2)).toBe(true);
  });
});
