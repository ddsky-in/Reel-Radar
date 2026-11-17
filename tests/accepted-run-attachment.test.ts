import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const media = await import('../supabase/functions/_shared/transcription-media.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
const foreign = '44444444-4444-4444-8444-444444444444';
const now = '2026-11-14T12:00:00.000Z';
const run = { id: 'run_123', actorId: 'actor_123', userId: 'account_123', status: 'RUNNING', defaultDatasetId: 'dataset_123', usageTotalUsd: null };
const job = {
  id: jobId, owner_user_id: owner, kind: 'daily', collection_source: 'ordinary', status: 'dispatching', live: true, results_limit: 30,
  actor_run_id: null as string | null, dispatch_nonce: nonce, expected_actor_id: 'actor_123', expected_provider_user_id: 'account_123',
  dataset_id: null as string | null, dataset_cursor: 0, dataset_finished: false, lease_token: nonce,
  started_at: now, provider_terminal_status: null, actual_cost_usd: null, reserved_usd: .1,
  priority: 50, scheduled_for: now, created_at: now,
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let attachAttempts: number;
let attachFailures: number;
let lostResponse: boolean;
let persisted: unknown[];
let rawRun: Record<string, unknown>;
let startFailure: 'timeout' | '429' | '503' | null;
let claimedJob: typeof job;
let ordinaryClaimed: boolean;
const rpcCalls = (name: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/rpc/${name}`));
const starts = () => fetcher.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === '/v2/actors/actor_123/runs' && init?.method === 'POST');
const attachmentReads = () => fetcher.mock.calls.filter(([url]) => new URL(String(url)).searchParams.has('actor_run_id'));
const invoke = (path: string) => path === 'normal' ? worker.dispatch(owner, true) : path === 'pilot' ? worker.dispatchCarouselPilot(owner, jobId) : media.dispatchMediaJob(jobId);
async function bounded<T>(task: Promise<T>): Promise<T> {
  let settled = false;
  const observed = task.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  // SHA256 uses the native crypto pool, not the fake clock. Keep draining newly
  // scheduled bounded retries until the task settles instead of racing one pass.
  for (let pass = 0; pass < 200 && !settled; pass++) {
    await vi.runAllTimersAsync();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(now));
  values = { PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor_123', APIFY_ACCOUNT_ID: 'account_123',
    APIFY_API_TOKEN: 'synthetic-token', APIFY_WEBHOOK_SHARED_SECRET: 'synthetic-webhook', SUPABASE_URL: 'https://fixture.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', REELRADAR_OWNER_USER_ID: owner, SCRAPING_ENABLED: 'true',
    PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true',
    CAROUSEL_PROVIDER_VALIDATED: 'false', CAROUSEL_PILOT_JOB_ID: jobId, INTERNAL_CRON_SECRET: 'synthetic-internal',
    TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER_VALIDATED: 'true', ELEVENLABS_API_KEY: 'synthetic-elevenlabs' };
  vi.stubGlobal('Deno', { env: { get: (key: string) => values[key] } });
  attachAttempts = 0; attachFailures = 0; lostResponse = false; persisted = []; startFailure = null;
  claimedJob = { ...job }; ordinaryClaimed = false;
  rawRun = { id: run.id, actId: run.actorId, userId: run.userId, status: run.status, defaultDatasetId: run.defaultDatasetId };
  // Every request is intercepted. No real provider, database, or media calls are allowed.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe('synthetic-service');
      expect(headers.get('authorization')).toBe('Bearer synthetic-service');
      if (url.pathname === '/rest/v1/scrape_jobs') {
        if (url.searchParams.has('actor_run_id')) return json(persisted);
        expect(url.searchParams.has('kind')).toBe(false); // Only exact accepted-identity persistence reads are allowed.
        throw new Error('Client-side candidate query forbidden');
      }
      if (url.pathname.endsWith('/worker_claim_collection_executor')) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_owner_user_id: owner, p_completion_only: false });
        return json({ max_active: 3, max_starts_per_wake: 3, wake_revision: 1, drained_revision: 0, wake_pending: true,
          eligible_kinds: ['daily'], executor_nonce: foreign, executor_revision: 1, executor_expires_at: '2026-11-14T12:01:30.000Z',
          executor_starts: 0, executor_start_limit: 3, wake_retry_after: null, claimed_revision: 1, starts_remaining: 3 });
      }
      if (['worker_drain_completion_wake', 'worker_renew_collection_executor', 'worker_release_collection_executor'].some(name => url.pathname.endsWith(`/${name}`))) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_owner_user_id: owner, p_executor_nonce: foreign, p_revision: 1 }); return json(true);
      }
      if (url.pathname.endsWith('/worker_begin_account_usage')) return json({ observation_id: nonce, observed_at: now });
      if (url.pathname.endsWith('/worker_claim_next')) {
        const args = JSON.parse(String(init?.body));
        expect(args).toEqual({ p_owner_user_id: owner, p_live: true, p_actor_ids: { daily: 'actor_123' }, p_eligible_kinds: ['daily'],
          p_executor_nonce: foreign, p_claimed_revision: 1 });
        if (ordinaryClaimed) return json({ reason: 'no_pending_jobs' });
        ordinaryClaimed = true;
        return json({ job: claimedJob, creators: [{ id: foreign, username: 'synthetic.creator' }], max_total_charge_usd: .1 });
      }
      if (url.pathname.endsWith('/worker_claim_carousel_pilot') || url.pathname.endsWith('/worker_transcription_media_claim')) {
        return json({ job: claimedJob, creators: [{ id: foreign, username: 'synthetic.creator' }], max_total_charge_usd: .1 });
      }
      if (url.pathname.endsWith('/worker_attach_run')) {
        attachAttempts++;
        if (lostResponse) {
          persisted = [{ ...claimedJob, actor_run_id: run.id, dataset_id: run.defaultDatasetId, status: 'running' }];
          throw new Error('Synthetic attachment response lost after commit');
        }
        if (attachAttempts <= attachFailures) return json({}, 503);
        return json(null); // SQL returns void, not a fabricated success row.
      }
      if (url.pathname.endsWith('/worker_accounts')) return json([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account_123', enabled: true, authorization_confirmed: true }]);
      if (url.pathname.endsWith('/worker_get_collection_recovery_state')) return json({ input_digest: null, accepted_evidence: [], callback_hints: [] });
      if (url.pathname.endsWith('/worker_record_accepted_evidence')) return json({ recorded: true });
      if (url.pathname.endsWith('/worker_authorize_collection_submit')) return json({ authorized: true });
      if (url.pathname.endsWith('/worker_cancel_pre_submit')) return json({ cancelled: true });
      if (url.pathname.endsWith('/worker_record_usage') || url.pathname.endsWith('/worker_dispatch_failure')) return json(null);
    }
    if (url.origin === 'https://api.apify.com') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
      if (url.pathname === '/v2/users/me') return json({ data: { id: 'account_123' } });
      if (url.pathname === '/v2/users/me/limits') return json({ data: { monthlyUsageCycle: {
        startAt: '2026-11-01T00:00:00Z', endAt: '2026-12-01T00:00:00Z',
      }, current: { monthlyUsageUsd: .1 }, limits: { maxMonthlyUsageUsd: 5 } } });
      if (url.pathname === '/v2/actors/actor_123/runs' && init?.method === 'POST') {
        if (startFailure === 'timeout') throw new Error('Synthetic start response lost');
        if (startFailure) return json({}, Number(startFailure));
        return json({ data: rawRun });
      }
    }
    throw new Error(`Unexpected synthetic transport ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function configurePath(path: string) {
  if (path === 'pilot') claimedJob = { ...claimedJob, kind: 'carousel', collection_source: 'carousel_pilot' };
  if (path === 'media') claimedJob = { ...claimedJob, kind: 'manual', collection_source: 'target_media', results_limit: 100 };
}
function expectExactAttach(count: number) {
  const calls = rpcCalls('worker_attach_run');
  expect(calls).toHaveLength(count);
  expect(new Set(calls.map(([, init]) => String(init?.body))).size).toBe(1);
  for (const [, init] of calls) expect(JSON.parse(String(init?.body))).toEqual({ p_job_id: jobId, p_dispatch_nonce: nonce,
    p_run_id: run.id, p_actor_id: run.actorId, p_provider_user_id: run.userId, p_dataset_id: run.defaultDatasetId });
}
function expectExactRead() {
  const reads = attachmentReads();
  expect(reads.length).toBeGreaterThan(0);
  for (const [address] of reads) {
    const query = new URL(String(address)).searchParams;
    expect(query.get('id')).toBe(`eq.${jobId}`); expect(query.get('owner_user_id')).toBe(`eq.${owner}`);
    expect(query.get('dispatch_nonce')).toBe(`eq.${nonce}`); expect(query.get('actor_run_id')).toBe(`eq.${run.id}`);
    expect(query.get('expected_actor_id')).toBe(`eq.${run.actorId}`); expect(query.get('expected_provider_user_id')).toBe(`eq.${run.userId}`);
    expect(query.get('limit')).toBe('2');
  }
}

describe('bounded durable accepted-run attachment', () => {
  it.each(['normal', 'pilot', 'media'])('makes only one start POST with three identical attachment attempts: %s', async path => {
    configurePath(path); attachFailures = 2;
    const result = await bounded(invoke(path));
    if (path === 'normal') expect(result).toContainEqual({ job_id: jobId, status: 'running' });
    else expect(result).toEqual({ job_id: jobId, status: 'running' });
    expect(starts()).toHaveLength(1); expectExactAttach(3); expectExactRead();
    expect(Date.now() - Date.parse(now)).toBe(750);
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it('recognizes a committed attachment after a lost response without retrying the start or the attach', async () => {
    lostResponse = true;
    expect(await bounded(worker.dispatch(owner, true))).toContainEqual({ job_id: jobId, status: 'running' });
    expect(starts()).toHaveLength(1); expectExactAttach(1); expectExactRead();
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it.each(['normal', 'pilot', 'media'])('preserves the uncertain hold when all three attachment attempts fail: %s', async path => {
    configurePath(path); attachFailures = 3;
    const result = await bounded(invoke(path));
    if (path === 'normal') expect(result).toContainEqual({ job_id: jobId, status: 'uncertain' });
    else expect(result).toEqual({ job_id: jobId, status: 'uncertain' });
    expect(starts()).toHaveLength(1); expectExactAttach(3); expectExactRead();
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(1);
    expect(JSON.parse(String(rpcCalls('worker_dispatch_failure')[0][1]?.body))).toEqual({ p_owner_user_id: owner, p_job_id: jobId, p_dispatch_nonce: nonce,
      p_classification: 'request_unknown', p_error: 'Provider acceptance or persistence unknown' });
    expect(claimedJob.reserved_usd).toBe(.1);
    // Releasing the executor lease does not release a monetary reservation or
    // finish the job. It must retain the dirty revision for bounded recovery.
    expect(fetcher.mock.calls.some(([url]) => /cancel|finish/.test(String(url))
      || /release/.test(String(url)) && !String(url).endsWith('/worker_release_collection_executor'))).toBe(false);
    expect(rpcCalls('worker_drain_completion_wake')).toHaveLength(0);
    if (path === 'normal') expect(rpcCalls('worker_release_collection_executor')).toHaveLength(1);
  });

  it.each([
    { id: foreign }, { owner_user_id: foreign }, { dispatch_nonce: foreign }, { actor_run_id: 'foreign-run' },
    { expected_actor_id: 'foreign-actor' }, { expected_provider_user_id: 'foreign-account' }, { live: false },
  ])('rejects a foreign or stale persisted result after response loss: %j', async patch => {
    attachFailures = 3; persisted = [{ ...job, actor_run_id: run.id, ...patch }];
    expect(await bounded(worker.dispatch(owner, true))).toContainEqual({ job_id: jobId, status: 'uncertain' });
    expect(starts()).toHaveLength(1); expectExactAttach(3); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(1);
  });

  it.each([{ rows: [] }, { rows: [null] }, { rows: [{ id: jobId }] }, { rows: [{ ...job, actor_run_id: run.id }, { ...job, actor_run_id: run.id }] }])(
    'does not infer persistence from a missing, malformed, or ambiguous row: %j', async result => {
      attachFailures = 3; persisted = result.rows;
      expect(await bounded(worker.dispatch(owner, true))).toContainEqual({ job_id: jobId, status: 'uncertain' });
      expect(starts()).toHaveLength(1); expectExactAttach(3);
    },
  );

  it('can retry an identical attachment when the verification read is itself unavailable', async () => {
    attachFailures = 1;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, init) => new URL(String(input)).searchParams.has('actor_run_id')
      ? Promise.resolve(json({}, 503)) : original(input, init));
    await bounded(worker.attachAcceptedRun(job, run));
    expectExactAttach(2); expect(starts()).toHaveLength(0);
  });

  it.each([
    { id: '' }, { id: 'run/foreign' }, { id: 'mock:' + jobId }, { actId: 'foreign-actor' }, { userId: 'foreign-account' },
    { status: 'UNKNOWN' }, { defaultDatasetId: 123 }, { defaultDatasetId: '' }, { defaultKeyValueStoreId: {} },
  ])('rejects malformed/foreign returned runs with no attach or start replay: %j', async patch => {
    Object.assign(rawRun, patch);
    expect(await bounded(worker.dispatch(owner, true))).toContainEqual({ job_id: jobId, status: 'uncertain' });
    expect(starts()).toHaveLength(1); expect(rpcCalls('worker_attach_run')).toHaveLength(0); expect(attachmentReads()).toHaveLength(0);
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(1);
  });

  it.each([{ id: 'invalid' }, { owner_user_id: 'invalid' }, { dispatch_nonce: 'nonce' }, { expected_actor_id: '' }, { expected_provider_user_id: '' }])(
    'validates frozen job identity before any attachment RPC: %j', async patch => {
      await expect(worker.attachAcceptedRun({ ...job, ...patch }, run)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([{ defaultDatasetId: undefined }, { usageTotalUsd: undefined }, { usageTotalUsd: -1 }, { usageTotalUsd: NaN }, { usageTotalUsd: '0' }])(
    'validates all returned Run fields before any attachment RPC: %j', async patch => {
      await expect(worker.attachAcceptedRun(job, { ...run, ...patch })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['normal', 'pilot', 'media'])('does not retry a start POST when no accepted run is returned: %s', async path => {
    configurePath(path); startFailure = 'timeout';
    await bounded(invoke(path));
    expect(starts()).toHaveLength(1); expect(rpcCalls('worker_attach_run')).toHaveLength(0); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(1);
  });
  it.each(['429', '503'] as const)('does not retry a rejected/uncertain start HTTP %s', async failure => {
    startFailure = failure; await bounded(worker.dispatch(owner, true));
    expect(starts()).toHaveLength(1); expect(rpcCalls('worker_attach_run')).toHaveLength(0); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(1);
  });

  it('keeps early CREATED and every terminal event in the same authenticated webhook with its valid template', async () => {
    await bounded(worker.dispatch(owner, true));
    const endpoint = new URL(String(starts()[0][0]));
    const webhooks = JSON.parse(atob(endpoint.searchParams.get('webhooks')!));
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].eventTypes).toEqual(['ACTOR.RUN.CREATED', 'ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT']);
    expect(webhooks[0].payloadTemplate).toBe('{"run_id": {{resource.id}}}');
    expect(JSON.parse(webhooks[0].payloadTemplate.replace('{{resource.id}}', JSON.stringify(run.id)))).toEqual({ run_id: run.id });
    expect(JSON.parse(webhooks[0].headersTemplate)).toEqual({ 'x-webhook-secret': 'synthetic-webhook' });
    const requestUrl = new URL(webhooks[0].requestUrl);
    expect(requestUrl.searchParams.get('job_id')).toBe(jobId); expect(requestUrl.searchParams.get('dispatch_nonce')).toBe(nonce);
    expect(requestUrl.href).not.toContain('synthetic-webhook');
  });
});

describe('processing release and scoped reconciliation wakes', () => {
  it('releases the exact processing lease when provider construction throws', async () => {
    delete values.APIFY_REEL_ACTOR_RESOURCE_ID;
    fetcher.mockImplementation(async (input) => {
      if (String(input).endsWith('/worker_claim_processing')) return json({ job: { ...job, status: 'processing' }, creators: [] });
      if (String(input).endsWith('/worker_release_processing')) return json(null);
      throw new Error('No transport is allowed after constructor failure');
    });
    expect(await worker.processJob(jobId)).toBe('processing_retry_required');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(rpcCalls('worker_release_processing')[0][1]?.body))).toEqual({ p_job_id: jobId, p_lease_token: nonce,
      p_error: 'Bounded processing failed; cursor preserved for reconciliation' });
  });

  it('wakes only exact settlement with a bounded continuation budget and no generic fallback', async () => {
    let work: Promise<unknown> | undefined;
    vi.stubGlobal('EdgeRuntime', { waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    fetcher.mockResolvedValue(json({}));
    worker.wakeReconciliation(2, undefined, jobId);
    await vi.runAllTimersAsync(); await work;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://fixture.supabase.co/functions/v1/reconcile-jobs');
    expect(JSON.parse(String(init?.body))).toEqual({ continuation_budget: 1, settle_job_id: jobId });
    expect(new Headers(init?.headers).get('x-internal-secret')).toBe('synthetic-internal');
  });

  it.each([[jobId, foreign], [undefined, 'invalid'], ['invalid', undefined], ['', undefined], [undefined, '']])(
    'rejects conflicting or invalid wake scopes instead of falling through to generic dispatch: %j', (pilot, settle) => {
      const waitUntil = vi.fn(); vi.stubGlobal('EdgeRuntime', { waitUntil });
      expect(() => worker.wakeReconciliation(2, pilot, settle)).toThrow('scope');
      expect(waitUntil).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
