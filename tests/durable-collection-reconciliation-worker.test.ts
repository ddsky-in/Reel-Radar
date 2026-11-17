import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const webhook = await import('../supabase/functions/apify-webhook/index.ts' as string);
const reconciler = await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const owner = 'fa100000-0000-4000-8000-000000000001';
const selected = 'fa100000-0000-4000-8000-000000000002';
const nonce = 'fa100000-0000-4000-8000-000000000003';
const token = 'fa100000-0000-4000-8000-000000000004';
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let job: Record<string, unknown>;
let hint: { run_id: string; dispatch_nonce: string } | null;
let run: Record<string, unknown>;
let verified: Record<string, unknown>;
let wakeRevision: number;
let drainedRevision: number;
let completionRecorded: boolean;
let billingRecorded: boolean;
const response = (data: unknown) => new Response(JSON.stringify(data));
const callback = (query = `job_id=${selected}&dispatch_nonce=${nonce}`, secret = 'webhook', runId = 'accepted') => new Request(`https://fixture.test/apify-webhook?${query}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify({ run_id: runId }),
});
const maintenance = (payload: unknown) => new Request('https://fixture.test/reconcile-jobs', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-secret': 'internal' }, body: JSON.stringify(payload) });
const calls = (endpoint: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(endpoint));
const argument = (endpoint: string) => JSON.parse(String(calls(endpoint)[0]?.[1]?.body));

beforeEach(() => {
  values = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'account',
    APIFY_WEBHOOK_SHARED_SECRET: 'webhook', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    INTERNAL_CRON_SECRET: 'internal', REELRADAR_OWNER_USER_ID: owner, SCRAPING_ENABLED: 'false', CAROUSEL_PROVIDER_VALIDATED: 'false' };
  job = { id: selected, owner_user_id: owner, kind: 'daily', collection_source: 'ordinary', live: true, status: 'uncertain', actor_run_id: null,
    dispatch_nonce: nonce, expected_actor_id: 'actor', expected_provider_user_id: 'account', actual_cost_usd: null, reserved_usd: .1,
    dataset_cursor: 0, dataset_finished: false, provider_terminal_status: null };
  hint = { run_id: 'accepted', dispatch_nonce: nonce };
  run = { id: 'accepted', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: .001 };
  verified = { ...job, actor_run_id: 'accepted', status: 'succeeded', provider_terminal_status: 'SUCCEEDED', actual_cost_usd: .001 };
  wakeRevision = 0; drainedRevision = 0; completionRecorded = false; billingRecorded = false;
  vi.stubGlobal('Deno', { env: { get: (key: string) => values[key] }, serve: vi.fn() });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const address = String(url);
    if (address.includes('/rest/v1/scrape_jobs?')) return response([job]);
    if (address.endsWith('/worker_isolate_collection_settlement')) {
      expect(JSON.parse(String(init?.body))).toEqual({ p_owner_user_id: owner, p_job_id: selected });
      job.collection_source = 'operator_settle'; verified.collection_source = 'operator_settle'; return response(null);
    }
    if (address.endsWith('/worker_record_completion_wake')) {
      // Completion can wake while cost is unknown; later billing creates another
      // revision, never releases the hold from a callback hint or duplicate replay.
      if (job.collection_source !== 'ordinary' || !['succeeded', 'partial', 'failed'].includes(String(verified.status)) || !verified.provider_terminal_status) return response(false);
      if (!completionRecorded || verified.actual_cost_usd !== null && !billingRecorded) {
        wakeRevision++; completionRecorded = true; billingRecorded = verified.actual_cost_usd !== null;
      }
      return response(wakeRevision > drainedRevision);
    }
    if (address.endsWith('/worker_begin_account_usage')) return response({ observation_id: token, observed_at: new Date().toISOString() });
    if (address.endsWith('/worker_claim_collection_executor')) {
      expect(JSON.parse(String(init?.body))).toEqual({ p_owner_user_id: owner, p_completion_only: true });
      return response({ max_active: 3, max_starts_per_wake: 3,
      wake_revision: wakeRevision, drained_revision: drainedRevision, wake_pending: wakeRevision > drainedRevision, eligible_kinds: ['daily'],
      executor_nonce: token, executor_revision: wakeRevision, executor_expires_at: new Date(Date.now() + 90000).toISOString(),
      executor_starts: 0, executor_start_limit: 3, wake_retry_after: null, claimed_revision: wakeRevision, starts_remaining: 3 });
    }
    if (address.endsWith('/worker_release_collection_executor')) return response(true);
    if (address.endsWith('/worker_claim_next')) return response({ reason: 'no_pending_jobs' });
    if (address.endsWith('/worker_drain_completion_wake')) { drainedRevision = Number(JSON.parse(String(init?.body)).p_revision); return response(true); }
    if (address.endsWith('/worker_record_callback_receipt')) return response({ accepted: true });
    if (address.endsWith('/worker_claim_reconciliation')) return response([{ job: structuredClone(job), callback_hint: hint, reconciliation_token: token }]);
    if (address.includes('/actor-runs/')) return response({ data: run });
    if (address.endsWith('/worker_reconcile_run')) return response(verified);
    if (address.endsWith('/worker_transcription_media_reconcile')) return response({ status: 'not_linked' });
    if (address.endsWith('/worker_accounts')) return response([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account', enabled: true, authorization_confirmed: true }]);
    if (address.endsWith('/users/me')) return response({ data: { id: 'account' } });
    if (address.endsWith('/users/me/limits')) return response({ data: { monthlyUsageCycle: { startAt: new Date(Date.now() - 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000).toISOString() }, current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 50 } } });
    if (address.endsWith('/worker_get_collection_recovery_state')) return response({ input_digest: null, accepted_evidence: [], callback_hints: [] });
    if (address.endsWith('/worker_record_accepted_evidence')) return response({ recorded: true });
    if (address.endsWith('/worker_claim_missing_run_recovery')) return response([]);
    if (address.endsWith('/worker_record_usage') || address.endsWith('/worker_attach_run') || address.endsWith('/worker_complete_reconciliation') ||
      address.endsWith('/worker_expire_dispatches') || address.endsWith('/worker_competitor_maintain')) return response({});
    if (address.endsWith('/functions/v1/reconcile-jobs')) return response({ accepted: true });
    throw new Error('Unexpected synthetic transport');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable callback ACK ordering and validation', () => {
  it('persists an authorized hint before 202/background work and stamps a claim before exact provider reads', async () => {
    const background: Promise<unknown>[] = [];
    const events: string[] = [];
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => { events.push(String(url)); return original(url, init); });
    vi.stubGlobal('EdgeRuntime', { waitUntil: (work: Promise<unknown>) => { events.push('waitUntil'); background.push(work); } });
    const result = await webhook.handler(callback());
    expect(result.status).toBe(202); expect(await result.json()).toEqual({ accepted: true });
    expect(events.findIndex(value => value.endsWith('/worker_record_callback_receipt'))).toBeLessThan(events.indexOf('waitUntil'));
    await Promise.all(background);
    expect(events.findIndex(value => value.endsWith('/worker_claim_reconciliation'))).toBeLessThan(events.findIndex(value => value.includes('/actor-runs/')));
    expect(argument('/worker_record_callback_receipt')).toEqual({ p_owner_user_id: owner, p_job_id: selected,
      p_dispatch_nonce: nonce, p_run_id: 'accepted', p_actor_id: 'actor', p_provider_user_id: 'account' });
    expect(argument('/worker_complete_reconciliation')).toMatchObject({ p_callback_state: 'verified', p_callback_run_id: 'accepted' });
    expect(calls('/worker_attach_run')).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/') || String(url).endsWith('/worker_claim_next'))).toBe(false);
  });
  it('never ACKs or schedules work when durable persistence fails, and returns sanitized errors', async () => {
    const waitUntil = vi.fn(); vi.stubGlobal('EdgeRuntime', { waitUntil });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_record_callback_receipt')
      ? Promise.resolve(new Response('private upstream data', { status: 503 })) : original(url, init));
    const result = await webhook.handler(callback()); expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'verification_or_processing_failed' });
    expect(waitUntil).not.toHaveBeenCalled(); expect(calls('/worker_claim_reconciliation')).toHaveLength(0);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('api.apify.com'))).toBe(false);
  });
  it.each([
    { accepted: false, reason: 'callback_capacity_retry', status: 503 },
    { accepted: false, reason: 'unknown_callback', status: 403 },
  ])('does not claim or ACK a refused durable receipt: $reason', async ({ accepted, reason, status }) => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_record_callback_receipt') ? Promise.resolve(response({ accepted, reason })) : original(url, init));
    expect((await webhook.handler(callback())).status).toBe(status); expect(calls('/worker_claim_reconciliation')).toHaveLength(0);
  });
  it.each([
    `job_id=${selected}&job_id=${owner}&dispatch_nonce=${nonce}`, `job_id=${selected}&dispatch_nonce=${nonce}&dispatch_nonce=${owner}`,
    `job_id=invalid&dispatch_nonce=${nonce}`, `job_id=${selected}`, `dispatch_nonce=${nonce}`,
  ])('rejects ambiguous/invalid callback identifiers before transport: %s', async query => {
    expect((await webhook.handler(callback(query))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires webhook auth and durable nonce/account before persistence or reads', async () => {
    expect((await webhook.handler(callback(undefined, 'wrong'))).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
    job.dispatch_nonce = owner; expect((await webhook.handler(callback())).status).toBe(403);
    job.dispatch_nonce = nonce; job.expected_provider_user_id = 'foreign'; expect((await webhook.handler(callback())).status).toBe(403);
    expect(calls('/worker_record_callback_receipt')).toHaveLength(0);
  });
  it.each(['owner_user_id', 'id', 'kind'])('rejects a wrongly selected callback %s before any provider read', async key => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_claim_reconciliation')
      ? Promise.resolve(response([{ job: { ...job, [key]: key === 'kind' ? 'carousel' : token }, callback_hint: hint, reconciliation_token: token }])) : original(url, init));
    expect((await webhook.handler(callback())).status).toBe(503);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('api.apify.com'))).toBe(false);
    expect(calls('/worker_attach_run')).toHaveLength(0);
  });
  it.each(['succeeded', 'partial', 'failed'])('wakes an ordinary terminal %s with unknown cost, coalesces replays and wakes again for late authoritative billing', async state => {
    values.SCRAPING_ENABLED = 'true'; values.PROVIDER_VALIDATED = 'true'; values.RUN_CHARGE_CAP_VALIDATED = 'true'; values.ACCOUNT_USAGE_VALIDATED = 'true';
    job.status = state; job.actor_run_id = 'accepted'; verified.status = state; verified.actual_cost_usd = null; run.usageTotalUsd = null;
    const unknown = await webhook.handler(callback()); expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ accepted: true, processing: state, next: expect.any(Array) });
    expect(calls('/worker_record_completion_wake')).toHaveLength(1);
    expect(calls('/worker_claim_next')).toHaveLength(1); expect(wakeRevision).toBe(1); expect(drainedRevision).toBe(1);
    expect(job.actual_cost_usd).toBeNull(); expect(job.reserved_usd).toBe(.1);

    fetcher.mockClear();
    const replay = await webhook.handler(callback()); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ processing: state, next: 'not_dispatched' });
    expect(calls('/worker_claim_next')).toHaveLength(0); expect(wakeRevision).toBe(1);

    fetcher.mockClear(); verified.actual_cost_usd = .001; run.usageTotalUsd = .001;
    const settled = await webhook.handler(callback()); expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ processing: state, next: expect.any(Array) });
    expect(calls('/worker_claim_next')).toHaveLength(1); expect(wakeRevision).toBe(2); expect(drainedRevision).toBe(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('status=in.(pending,budget_paused)') || String(url).includes('/actors/'))).toBe(false);
  });
  it('keeps settled transcription-media callback isolation even when billing is authoritative', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).endsWith('/worker_transcription_media_reconcile')
      ? Promise.resolve(response({ status: 'succeeded' })) : original(url, init));
    const result = await webhook.handler(callback()); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ next: 'transcription_media_reconciled' });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('status=in.(pending,budget_paused)') || String(url).includes('/actors/'))).toBe(false);
  });
  it('keeps durable acceptance even when asynchronous provider processing fails', async () => {
    const background: Promise<unknown>[] = []; vi.stubGlobal('EdgeRuntime', { waitUntil: (work: Promise<unknown>) => background.push(work) });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).includes('/actor-runs/') ? Promise.resolve(new Response('private', { status: 403 })) : original(url, init));
    const result = await webhook.handler(callback()); expect(result.status).toBe(202); await Promise.all(background);
    expect(argument('/worker_complete_reconciliation')).toMatchObject({ p_callback_state: 'pending' });
  });
});

describe('bounded fair maintenance of callback hints and unknown billing', () => {
  it('recovers an unbound uncertain hint by exact verified attachment, without any start or owner-wide scoped expiry', async () => {
    const result = await reconciler.handler(maintenance({ settle_job_id: selected, continuation_budget: 0 }));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ outcomes: [{ job_id: selected, state: 'succeeded' }], next: 'settlement_only' });
    expect(argument('/worker_claim_reconciliation')).toEqual({ p_owner_user_id: owner, p_job_id: selected, p_kind: null, p_limit: 10 });
    expect(argument('/worker_attach_run')).toMatchObject({ p_job_id: selected, p_run_id: 'accepted', p_actor_id: 'actor', p_provider_user_id: 'account' });
    expect(calls('/worker_expire_dispatches')).toHaveLength(0); expect(calls('/worker_competitor_maintain')).toHaveLength(0);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/actors/') || String(url).endsWith('/worker_claim_next'))).toBe(false);
  });
  it.each(['id', 'actId', 'userId'])('quarantines a callback mismatched by provider %s without attachment or budget release', async key => {
    run[key] = 'foreign';
    const result = await reconciler.handler(maintenance({ settle_job_id: selected, continuation_budget: 0 }));
    expect(await result.json()).toEqual({ outcomes: [{ job_id: selected, state: 'callback_identity_rejected' }], next: 'settlement_only' });
    expect(calls('/worker_attach_run')).toHaveLength(0); expect(calls('/worker_reconcile_run')).toHaveLength(0);
    expect(argument('/worker_complete_reconciliation')).toMatchObject({ p_callback_state: 'rejected' });
  });
  it('quarantines a nonexistent hint but never infers the uncertain job did not start', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => String(url).includes('/actor-runs/') ? Promise.resolve(new Response('private', { status: 404 })) : original(url, init));
    const result = await reconciler.handler(maintenance({ settle_job_id: selected, continuation_budget: 0 }));
    expect(await result.json()).toMatchObject({ outcomes: [{ state: 'callback_identity_rejected' }] });
    expect(argument('/worker_complete_reconciliation')).toMatchObject({ p_callback_state: 'rejected' });
    expect(calls('/worker_attach_run')).toHaveLength(0); expect(calls('/worker_start_uncertain')).toHaveLength(0);
  });
  it('does not attach stale nonce or a different already-bound run', async () => {
    hint = { run_id: 'accepted', dispatch_nonce: owner };
    let result = await reconciler.handler(maintenance({ settle_job_id: selected, continuation_budget: 0 }));
    expect(await result.json()).toMatchObject({ outcomes: [{ state: 'callback_identity_rejected' }] });
    hint.dispatch_nonce = nonce; job.actor_run_id = 'bound';
    result = await reconciler.handler(maintenance({ settle_job_id: selected, continuation_budget: 0 }));
    expect(await result.json()).toMatchObject({ outcomes: [{ state: 'callback_identity_rejected' }] });
    expect(calls('/worker_attach_run')).toHaveLength(0);
  });
  it('uses one service-selected fair batch, not the old oldest-ten rows query', async () => {
    hint = null; job.actor_run_id = 'accepted';
    const result = await reconciler.handler(maintenance({ continuation_budget: 0 })); expect(result.status).toBe(200);
    expect(calls('/worker_claim_reconciliation')).toHaveLength(1);
    expect(argument('/worker_claim_reconciliation')).toMatchObject({ p_job_id: null, p_limit: 10 });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/scrape_jobs?'))).toBe(false);
    expect(fetcher.mock.calls.findIndex(([url]) => String(url).endsWith('/worker_claim_reconciliation')))
      .toBeLessThan(fetcher.mock.calls.findIndex(([url]) => String(url).includes('/actor-runs/')));
  });
  it('retains delayed unknown final-cost eligibility and bounds settlement continuation without unrelated work', async () => {
    vi.useFakeTimers();
    hint = null; job.actor_run_id = 'accepted'; verified.actual_cost_usd = null; run.usageTotalUsd = null;
    const background: Promise<unknown>[] = []; vi.stubGlobal('EdgeRuntime', { waitUntil: (work: Promise<unknown>) => background.push(work) });
    const result = await reconciler.handler(maintenance({ settle_job_id: selected, continuation_budget: 1 })); expect(result.status).toBe(202);
    await background[0];
    await vi.advanceTimersByTimeAsync(3000); await Promise.all(background);
    expect(argument('/functions/v1/reconcile-jobs')).toEqual({ continuation_budget: 0, settle_job_id: selected });
    expect(calls('/functions/v1/reconcile-jobs')).toHaveLength(1);
    expect(argument('/worker_reconcile_run')).toMatchObject({ p_usage_total_usd: null });
    expect(calls('/worker_expire_dispatches')).toHaveLength(0); expect(calls('/worker_competitor_maintain')).toHaveLength(0);
  });
  it('keeps generic carousel/media callback continuation exact even when the pilot gate is removed', async () => {
    vi.useFakeTimers(); job.kind = 'carousel'; verified.kind = 'carousel'; verified.actual_cost_usd = null;
    const background: Promise<unknown>[] = []; vi.stubGlobal('EdgeRuntime', { waitUntil: (work: Promise<unknown>) => background.push(work) });
    expect((await webhook.handler(callback())).status).toBe(202);
    await background[0]; await vi.advanceTimersByTimeAsync(3000); await Promise.all(background);
    expect(argument('/functions/v1/reconcile-jobs')).toEqual({ continuation_budget: 3, settle_job_id: selected });
    expect(calls('/worker_claim_next')).toHaveLength(0);
  });
  it.each([-1, 5, 1.5, '1'])('rejects an invalid continuation budget before transport: %s', async continuation_budget => {
    expect((await reconciler.handler(maintenance({ continuation_budget }))).status).toBe(503); expect(fetcher).not.toHaveBeenCalled();
  });
});
