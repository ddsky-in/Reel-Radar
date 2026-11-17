import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const stranger = '99999999-9999-4999-8999-999999999999';
const creator = '22222222-2222-4222-8222-222222222222';
const otherCreator = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-13T12:00:00.000Z';
const kinds = ['daily', 'weekly', 'backfill', 'profile', 'manual', 'retry', 'discovery', 'metrics', 'carousel'];
const categories = ['profile', 'reels', 'carousels'];
const categoryFor = (kind: string) => kind === 'profile' ? 'profile' : kind === 'carousel' ? 'carousels' : 'reels';

type FixtureJob = {
  id: string; owner_user_id: string; kind: string; collection_source: string; status: string; live: boolean;
  priority: number; scheduled_for: string; created_at: string; results_limit: number;
  reserved_usd: number; dispatch_nonce: string; lease_token: string;
  expected_actor_id: string; expected_provider_user_id: string;
  actor_run_id: string | null; dataset_id: string | null; dataset_cursor: number; dataset_finished: boolean;
  started_at: string; result_fetched_at: string; provider_terminal_status: string | null;
  actual_cost_usd: number | null; competitor_run_id: string | null; collection_since: string | null; discovery_bounded?: boolean;
};
type FixtureContext = { job: FixtureJob; creators: { id: string; username: string }[] };
type StartFailure = 'timeout' | 'http-429' | 'http-503' | 'invalid-run' | null;

function job(kind: string, index: number, patch: Partial<FixtureJob> = {}): FixtureJob {
  return {
    id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    owner_user_id: owner, kind, collection_source: 'ordinary', status: 'pending', live: true,
    priority: 50, scheduled_for: '2026-11-13T10:00:00.000Z', created_at: '2026-11-12T10:00:00.000Z',
    results_limit: kind === 'profile' ? 1 : kind === 'discovery' ? 50 : 30, discovery_bounded: kind === 'discovery', reserved_usd: .1,
    dispatch_nonce: '44444444-4444-4444-8444-444444444444', lease_token: owner,
    expected_actor_id: kind === 'profile' ? 'profile-actor' : 'reel-actor', expected_provider_user_id: 'account',
    actor_run_id: null, dataset_id: null, dataset_cursor: 0, dataset_finished: false,
    started_at: now, result_fetched_at: '2026-11-13T12:05:00.000Z', provider_terminal_status: null,
    actual_cost_usd: null, competitor_run_id: ['discovery', 'metrics'].includes(kind) ? owner : null,
    collection_since: null, ...patch,
  };
}
function context(value: FixtureJob): FixtureContext {
  return { job: value, creators: [{ id: creator, username: 'fixture_creator' }] };
}
function ordered(left: FixtureJob, right: FixtureJob): number {
  return right.priority - left.priority || left.scheduled_for.localeCompare(right.scheduled_for)
    || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

let values: Record<string, string>;
let pending: FixtureJob[];
let claimRejections: Record<string, string[]>;
let unavailable: Set<string>;
let processing: FixtureContext | undefined;
let dataset: unknown[];
let output: unknown;
let startFailure: StartFailure;
let attachFailure: boolean;
let usageFailure: 'identity' | 'persistence' | null;
let transportViolations: string[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let lastCategory: string | null;
let selectedKinds: string[];
let runtimeKinds: string[];
let maxStarts: number;

function rpcCalls(name: string) {
  return fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === `/rest/v1/rpc/${name}`);
}
function args(name: string) {
  return rpcCalls(name).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}
function queries() {
  return fetcher.mock.calls.map(([url]) => new URL(String(url))).filter(url => url.pathname === '/rest/v1/scrape_jobs');
}
function starts() {
  return fetcher.mock.calls.filter(([url, init]) => new URL(String(url)).pathname.match(/^\/v2\/actors\/[^/]+\/runs$/) && init?.method === 'POST');
}
function jobOutcomes(outcomes: unknown[]) {
  return outcomes.filter(value => value && typeof value === 'object' && 'status' in value);
}
function expectClaimContract(expectedKinds: string[]) {
  // SQL owns category fairness, scheduling, priority ordering, capacity and reservations.
  // The worker only submits its owner, runtime-supported kinds and validated Actor map.
  expect(queries()).toEqual([]);
  expect(args('worker_collection_runtime')).toEqual([]); // Executor acquisition atomically returns runtime.
  expect(args('worker_claim_collection_executor')).toEqual([{ p_owner_user_id: owner, p_completion_only: false }]);
  const claims = args('worker_claim_next');
  expect(claims.length).toBeGreaterThan(0);
  for (const claim of claims) {
    expect(claim).toEqual({ p_owner_user_id: owner, p_live: true, p_eligible_kinds: expectedKinds,
      p_actor_ids: Object.fromEntries(expectedKinds.map(kind => [kind, kind === 'profile' ? 'profile-actor' : 'reel-actor'])),
      p_executor_nonce: owner, p_claimed_revision: 1 });
  }
  expect(args('worker_claim_dispatch')).toEqual([]);
  // Invalid mappings retain the wake instead of falsely draining blocked work.
  const mappingsValid = expectedKinds.length === runtimeKinds.length;
  expect(args(mappingsValid ? 'worker_drain_completion_wake' : 'worker_release_collection_executor'))
    .toEqual([{ p_owner_user_id: owner, p_executor_nonce: owner, p_revision: 1 }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  values = {
    PROVIDER_MODE: 'apify', APIFY_REEL_ACTOR_RESOURCE_ID: 'reel-actor', APIFY_PROFILE_ACTOR_RESOURCE_ID: 'profile-actor',
    APIFY_API_TOKEN: 'synthetic-token', APIFY_ACCOUNT_ID: 'account', APIFY_WEBHOOK_SHARED_SECRET: 'synthetic-webhook',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    REELRADAR_OWNER_USER_ID: owner, SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true',
    RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true',
    PROFILE_PROVIDER_VALIDATED: 'false', CAROUSEL_PROVIDER_VALIDATED: 'false',
  };
  pending = []; claimRejections = {}; unavailable = new Set(); processing = undefined;
  lastCategory = null; selectedKinds = []; runtimeKinds = [...kinds]; maxStarts = 2;
  dataset = []; output = { ok: true, total_items: 0, users: [] };
  startFailure = null; attachFailure = false; usageFailure = null; transportViolations = [];
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  // Every transport, including nominal Apify/Supabase URLs, is an inert synthetic fixture.
  // Unexpected calls are rejected rather than falling through to the real fetch implementation.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const reject = (message: string): never => { transportViolations.push(message); throw new Error(message); };
    if (url.origin === 'https://fixture.supabase.co') {
      const headers = new Headers(init?.headers);
      if (headers.get('apikey') !== 'synthetic-service' || headers.get('authorization') !== 'Bearer synthetic-service') return reject('Missing fixture database authorization');
      if (url.pathname === '/rest/v1/scrape_jobs') {
        if (attachFailure && url.searchParams.has('actor_run_id')) {
          expect(url.searchParams.get('id')).toBe(`eq.${pending[0].id}`);
          expect(url.searchParams.get('owner_user_id')).toBe(`eq.${owner}`);
          expect(url.searchParams.get('dispatch_nonce')).toBe(`eq.${pending[0].dispatch_nonce}`);
          expect(url.searchParams.get('actor_run_id')).toBe('eq.run');
          expect(url.searchParams.get('expected_actor_id')).toBe(`eq.${pending[0].expected_actor_id}`);
          expect(url.searchParams.get('expected_provider_user_id')).toBe('eq.account');
          return response([]); // This failed attachment never committed.
        }
        return reject('Client-side candidate query forbidden');
      }
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      if (init?.method !== 'POST' || !url.pathname.startsWith('/rest/v1/rpc/')) return reject('Unexpected fixture database transport');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (name === 'worker_accounts') return response([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account', enabled: true, authorization_confirmed: true }]);
      if (name === 'worker_invalidate_account_usage') return response(null);
      if (name === 'worker_begin_account_usage') {
        expect(body).toEqual({ p_owner_user_id: owner, p_account_slot: 1, p_provider_user_id: 'account' });
        return response({ observation_id: creator, observed_at: now });
      }
      if (name === 'worker_claim_collection_executor') {
        expect(body).toEqual({ p_owner_user_id: owner, p_completion_only: false });
        return response({ max_active: maxStarts, max_starts_per_wake: maxStarts, wake_revision: 1, drained_revision: 0,
          wake_pending: true, eligible_kinds: runtimeKinds, executor_nonce: owner, executor_revision: 1,
          executor_expires_at: '2026-11-13T12:01:30.000Z', executor_starts: 0, executor_start_limit: maxStarts,
          wake_retry_after: null, claimed_revision: 1, starts_remaining: maxStarts });
      }
      if (['worker_drain_completion_wake', 'worker_renew_collection_executor', 'worker_release_collection_executor'].includes(name)) {
        expect(body).toEqual({ p_owner_user_id: owner, p_executor_nonce: owner, p_revision: 1 }); return response(true);
      }
      if (name === 'worker_claim_next') {
        const eligible = body.p_eligible_kinds as string[], actors = body.p_actor_ids as Record<string, string>;
        if (body.p_owner_user_id !== owner || body.p_live !== true || !Array.isArray(eligible) || eligible.some(kind => !runtimeKinds.includes(kind))) return reject('Invalid fixture owner/kind claim');
        expect(Object.keys(actors)).toEqual(eligible);
        expect(body.p_executor_nonce).toBe(owner); expect(body.p_claimed_revision).toBe(1);
        for (const kind of eligible) expect(actors[kind]).toBe(kind === 'profile' ? 'profile-actor' : 'reel-actor');
        // Model the RPC result contract, not a worker-side candidate window. SQL
        // rotates categories; scheduling and priority ties are category-local.
        const attemptedKinds = new Set<string>();
        const startIndex = lastCategory === null ? -1 : categories.indexOf(lastCategory);
        for (let offset = 1; offset <= categories.length; offset++) {
          const category = categories[(startIndex + offset) % categories.length];
          while (true) {
            const candidate = pending.filter(value => categoryFor(value.kind) === category && eligible.includes(value.kind)
              && !attemptedKinds.has(value.kind) && value.owner_user_id === owner && ['pending', 'budget_paused'].includes(value.status)
              && value.collection_source === 'ordinary' && Date.parse(value.scheduled_for) <= Date.now() && !unavailable.has(value.id)).sort(ordered)[0];
            if (!candidate) break;
            const reason = claimRejections[candidate.kind]?.shift();
            if (reason) {
              if (['budget_paused', 'unreconciled_charges', 'live_setup_or_usage_unverified', 'concurrency_limit', 'account_capacity_full'].includes(reason)) return response({ reason });
              // Empty/stale heads are skipped within this RPC, never retried by the worker.
              unavailable.add(candidate.id); attemptedKinds.add(candidate.kind); continue;
            }
            unavailable.add(candidate.id); lastCategory = category; selectedKinds.push(candidate.kind);
            return response({ ...context(candidate), max_total_charge_usd: candidate.reserved_usd });
          }
        }
        return response({ reason: 'no_pending_jobs' });
      }
      if (name === 'worker_claim_processing') {
        if (!processing || body.p_job_id !== processing.job.id) return reject('Unexpected fixture processing claim');
        return response(structuredClone(processing));
      }
      if (name === 'worker_attach_run' && attachFailure) return response({}, 503);
      if (name === 'worker_record_usage') {
        if (body.p_owner_user_id !== owner) return reject('Invalid fixture usage owner');
        if (usageFailure === 'persistence') return response({}, 403);
      }
      if (name === 'worker_get_collection_recovery_state') return response({ input_digest: null, accepted_evidence: [], callback_hints: [] });
      if (name === 'worker_record_accepted_evidence') return response({ recorded: true });
      if (name === 'worker_authorize_collection_submit') return response({ authorized: true });
      if (name === 'worker_cancel_pre_submit') return response({ cancelled: true });
      if (['worker_record_usage', 'worker_attach_run', 'worker_dispatch_failure', 'worker_ingest_page',
        'worker_record_output_summary', 'worker_finish_processing', 'worker_release_processing'].includes(name)) return response({});
      return reject(`Unexpected fixture RPC ${name}`);
    }
    if (url.origin === 'https://api.apify.com') {
      if (new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-token') return reject('Missing fixture provider authorization');
      if (url.pathname === '/v2/users/me') return response({ data: { id: usageFailure === 'identity' ? 'foreign-account' : 'account' } });
      if (url.pathname === '/v2/users/me/limits') return response({ data: {
        monthlyUsageCycle: { startAt: '2026-11-01T00:00:00Z', endAt: '2026-12-01T00:00:00Z' },
        current: { monthlyUsageUsd: .02 }, limits: { maxMonthlyUsageUsd: 5 },
      } });
      const actor = /^\/v2\/actors\/([^/]+)\/runs$/.exec(url.pathname)?.[1];
      if (actor && init?.method === 'POST') {
        if (startFailure === 'timeout') throw new Error('Synthetic provider acceptance timeout');
        if (startFailure === 'http-429') return response({}, 429);
        if (startFailure === 'http-503') return response({}, 503);
        if (startFailure === 'invalid-run') return response({ data: { id: 'run' } });
        return response({ data: { id: 'run', actId: actor, userId: 'account', status: 'RUNNING', defaultDatasetId: 'dataset' } });
      }
      if (url.pathname === '/v2/datasets/dataset/items') return response(dataset);
      if (url.pathname === '/v2/actor-runs/run') return response({ data: { id: 'run', actId: processing?.job.expected_actor_id,
        userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset', defaultKeyValueStoreId: 'store' } });
      if (url.pathname === '/v2/key-value-stores/store/records/OUTPUT') return response(output);
    }
    return reject(`Unexpected fixture transport ${url.origin}${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  try { expect(transportViolations).toEqual([]); }
  finally { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('bounded owner-scoped competitor dispatch', () => {
  it('submits validated supported kinds through one owner-scoped fair claim RPC, with no candidate query', async () => {
    values.PROFILE_PROVIDER_VALIDATED = 'true'; values.CAROUSEL_PROVIDER_VALIDATED = 'true';
    expect(await worker.dispatch(owner, true)).toEqual([{ reason: 'no_pending_jobs' }]);
    expectClaimContract(kinds);
    expect(rpcCalls('worker_claim_next')).toHaveLength(1);
    expect(starts()).toHaveLength(0);
  });

  it('honors SQL category fairness, putting the profile head ahead of older Reel imports and stopping after two starts', async () => {
    values.PROFILE_PROVIDER_VALIDATED = 'true';
    const profile = job('profile', 1, { priority: 100 });
    const daily = job('daily', 2, { priority: 70, scheduled_for: '2026-11-13T08:00:00.000Z' });
    pending = [job('backfill', 3, { scheduled_for: '2026-11-13T07:00:00.000Z' }), daily, profile];
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: profile.id, status: 'running' }, { job_id: daily.id, status: 'running' }]);
    expect(selectedKinds).toEqual(['profile', 'daily']);
    expect(starts().map(([url]) => new URL(String(url)).pathname)).toEqual(['/v2/actors/profile-actor/runs', '/v2/actors/reel-actor/runs']);
    expect(starts()).toHaveLength(2); expect(rpcCalls('worker_attach_run')).toHaveLength(2);
    for (const [url] of starts()) expect(new URL(String(url)).searchParams.get('maxTotalChargeUsd')).toBe('0.1');
    expectClaimContract(kinds.filter(kind => kind !== 'carousel'));
  });

  it.each(['scheduled_for', 'created_at', 'id'] as const)('honors within-category SQL priority ties by %s before selecting the first two', async field => {
    const first = job('weekly', 1);
    const second = job('backfill', 2);
    const third = job('daily', 3);
    if (field !== 'id') {
      first[field] = '2026-11-12T07:00:00.000Z'; second[field] = '2026-11-12T08:00:00.000Z'; third[field] = '2026-11-12T09:00:00.000Z';
    }
    pending = [third, second, first];
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: first.id, status: 'running' }, { job_id: second.id, status: 'running' }]);
    expect(selectedKinds).toEqual(['weekly', 'backfill']);
  });

  it('does not let more than twenty disabled profiles/carousels hide eligible Reels or foreign owners override ordering', async () => {
    const disabled = Array.from({ length: 28 }, (_, index) => job(index % 2 ? 'profile' : 'carousel', index + 10, { priority: 200 }));
    const backfill = job('backfill', 1, { priority: 70, status: 'budget_paused' });
    const manual = job('manual', 2);
    pending = [...disabled, job('daily', 3, { owner_user_id: stranger, priority: 999 }), backfill, manual];
    const result = await worker.dispatch(owner, true);
    expect(result).toContainEqual({ job_id: backfill.id, status: 'running' });
    expect(result).toContainEqual({ job_id: manual.id, status: 'running' });
    expect(selectedKinds).toEqual(['backfill', 'manual']);
    expectClaimContract(kinds.filter(kind => !['profile', 'carousel'].includes(kind)));
    expect(starts()).toHaveLength(2); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it.each(['budget_paused', 'unreconciled_charges', 'live_setup_or_usage_unverified', 'concurrency_limit', 'account_capacity_full'])(
    'stops the whole wake on a transactional reservation/capacity gate without trying another kind: %s', async reason => {
      pending = [job('daily', 1, { priority: 100 }), job('daily', 2, { priority: 90 }), job('manual', 3, { priority: 80 }), job('backfill', 4)];
      claimRejections.daily = [reason];
      // Fail-closed RPC rejection is owner-wide, no longer client-side kind skipping.
      expect(await worker.dispatch(owner, true)).toEqual([
        { reason: 'profile_mapping_unverified', kind: 'profile' }, { reason: 'carousel_mapping_unverified', kind: 'carousel' }, { reason },
      ]);
      expect(rpcCalls('worker_drain_completion_wake')).toHaveLength(0);
      expect(args('worker_release_collection_executor')).toEqual([{ p_owner_user_id: owner, p_executor_nonce: owner, p_revision: 1 }]);
      expect(rpcCalls('worker_claim_next')).toHaveLength(1); expect(selectedKinds).toEqual([]);
      expect(starts()).toHaveLength(0); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
    },
  );

  it('keeps stale-head handling inside SQL and bounds subsequent same-kind claims without client retries', async () => {
    pending = [job('daily', 1, { priority: 100 }), job('daily', 2, { priority: 90 }), job('backfill', 3, { priority: 80 }), job('weekly', 4)];
    claimRejections.daily = ['empty_job'];
    const result = await worker.dispatch(owner, true);
    // SQL skips this kind within the first RPC; the next fair RPC may select its next head.
    expect(selectedKinds).toEqual(['backfill', 'daily']);
    expect(result).toContainEqual({ job_id: pending[2].id, status: 'running' });
    expect(result).toContainEqual({ job_id: pending[1].id, status: 'running' });
    expect(rpcCalls('worker_claim_next')).toHaveLength(2); expect(starts()).toHaveLength(2);
  });

  it('never claims a third same-kind candidate or another kind after two successful starts', async () => {
    pending = [job('daily', 4, { priority: 60 }), job('daily', 3, { priority: 70 }), job('daily', 2, { priority: 80 }),
      job('daily', 1, { priority: 90 }), job('weekly', 5)];
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: pending[3].id, status: 'running' }, { job_id: pending[2].id, status: 'running' }]);
    expect(selectedKinds).toEqual(['daily', 'daily']);
    expect(starts()).toHaveLength(2);
    expectClaimContract(kinds.filter(kind => !['profile', 'carousel'].includes(kind)));
  });

  it('reconciles authoritative account usage before any reservation or start', async () => {
    pending = [job('discovery', 1)];
    expect(jobOutcomes(await worker.dispatch(owner))).toEqual([{ job_id: pending[0].id, status: 'running' }]);
    expect(args('worker_record_usage')).toEqual([{ p_owner_user_id: owner, p_provider_user_id: 'account',
      p_cycle_start_at: '2026-11-01T00:00:00.000Z', p_cycle_end_at: '2026-12-01T00:00:00.000Z', p_usage_usd: .02, p_limit_usd: 5,
      p_observation_id: creator, p_observed_at: now }]);
    const paths = fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.indexOf('/rest/v1/rpc/worker_record_usage')).toBeLessThan(paths.indexOf('/rest/v1/rpc/worker_claim_next'));
    expect(JSON.parse(String(starts()[0][1]?.body))).toMatchObject({ directUrls: ['fixture_creator'], resultsType: 'reels', resultsLimit: 50, skipPinnedPosts: false });
  });
});

describe('fail-closed dispatch guards and non-idempotent starts', () => {
  it.each([
    ...['SCRAPING_ENABLED', 'PROVIDER_VALIDATED', 'RUN_CHARGE_CAP_VALIDATED', 'ACCOUNT_USAGE_VALIDATED'].map(key => ({ key, value: 'false' })),
    ...['APIFY_API_TOKEN', 'APIFY_ACCOUNT_ID', 'APIFY_REEL_ACTOR_RESOURCE_ID', 'APIFY_WEBHOOK_SHARED_SECRET', 'PROVIDER_MODE'].map(key => ({ key, value: undefined })),
    { key: 'PROVIDER_MODE', value: 'unsupported' }, { key: 'PROVIDER_MODE', value: 'mock' },
  ])('rejects $key=$value before claims or provider transport', async ({ key, value }) => {
    pending = [job('daily', 1)];
    if (value === undefined) delete values[key]; else values[key] = value;
    await expect(worker.dispatch(owner)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(0); expect(rpcCalls('worker_claim_next')).toHaveLength(0);
  });

  it.each(['identity', 'persistence'] as const)('makes no claims/starts when authoritative usage fails at %s', async failure => {
    usageFailure = failure; pending = [job('metrics', 1)];
    await expect(worker.dispatch(owner)).rejects.toThrow();
    expect(starts()).toHaveLength(0); expect(rpcCalls('worker_claim_next')).toHaveLength(0);
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it.each(['timeout', 'http-429', 'http-503', 'invalid-run'] as const)('stops after one genuine uncertain start with no POST replay: %s', async failure => {
    pending = [job('daily', 1, { priority: 100 }), job('backfill', 2, { priority: 90 }), job('manual', 3)];
    startFailure = failure;
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: pending[0].id, status: 'uncertain' }]);
    expect(selectedKinds).toEqual(['daily']);
    expect(starts()).toHaveLength(1);
    expect(JSON.parse(String(starts()[0][1]?.body))).toMatchObject({ directUrls: ['fixture_creator'], resultsType: 'reels', resultsLimit: 30 });
    expect(args('worker_dispatch_failure')).toEqual([{ p_owner_user_id: owner, p_job_id: pending[0].id, p_dispatch_nonce: pending[0].dispatch_nonce,
      p_classification: 'request_unknown', p_error: 'Provider acceptance or persistence unknown' }]);
    expect(rpcCalls('worker_attach_run')).toHaveLength(0);
  });

  it('does not start another job after an accepted provider start cannot be durably attached', async () => {
    pending = [job('daily', 1, { priority: 100 }), job('backfill', 2)]; attachFailure = true;
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: pending[0].id, status: 'uncertain' }]);
    expect(starts()).toHaveLength(1); expect(rpcCalls('worker_claim_next')).toHaveLength(1);
    expect(rpcCalls('worker_attach_run')).toHaveLength(3); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(1);
  });
});

describe('profile configuration and partial ingestion regression coverage', () => {
  it.each([
    { key: 'PROFILE_INPUT_BASE_JSON', value: '{' }, { key: 'PROFILE_INPUT_BASE_JSON', value: '[]' }, { key: 'PROFILE_INPUT_BASE_JSON', value: 'null' },
    { key: 'PROFILE_INPUT_USERNAMES_KEY', value: 'directUrls' }, { key: 'PROFILE_INPUT_FORMAT', value: 'urls' },
    { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{' }, { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '[]' }, { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: 'null' },
    { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{}' }, { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{"username":"username"}' },
    { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{"username":42,"followers":"followersCount"}' },
    ...['profile[0].username', 'profile..username', 'profile.__proto__.username', 'constructor.username', 'profile.prototype.username'].map(path => ({
      key: 'PROFILE_OUTPUT_MAPPING_JSON', value: JSON.stringify({ username: path, followers: 'followersCount' }),
    })),
    { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{"username":"username","followers":"stats[0]"}' },
    { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{"username":"username","followers":"followersCount","display_name":false}' },
    { key: 'PROFILE_OUTPUT_MAPPING_JSON', value: '{"username":"username","followers":"followersCount","avatar_url":"profile..avatar"}' },
    { key: 'APIFY_PROFILE_ACTOR_RESOURCE_ID', value: '' },
  ])('excludes malformed static $key=$value from the Actor map before any profile reservation or start', async ({ key, value }) => {
    values.PROFILE_PROVIDER_VALIDATED = 'true'; values[key] = value;
    pending = [job('profile', 1, { priority: 100 })];
    await worker.dispatch(owner, true);
    expectClaimContract(kinds.filter(kind => !['profile', 'carousel'].includes(kind)));
    expect(rpcCalls('worker_claim_next')).toHaveLength(1); expect(selectedKinds).toEqual([]); expect(starts()).toHaveLength(0);
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it('keeps Reels eligible when a higher-priority validated profile has malformed configuration', async () => {
    values.PROFILE_PROVIDER_VALIDATED = 'true'; values.PROFILE_INPUT_BASE_JSON = '{';
    pending = [job('profile', 1, { priority: 100 }), job('backfill', 2)];
    expect(await worker.dispatch(owner, true)).toContainEqual({ job_id: pending[1].id, status: 'running' });
    expect(selectedKinds).toEqual(['backfill']);
    expect(starts()).toHaveLength(1); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it.each(['', ' \t '])('accepts empty optional input/output settings as documented defaults: %j', async empty => {
    values.PROFILE_PROVIDER_VALIDATED = 'true';
    for (const key of ['PROFILE_INPUT_USERNAMES_KEY', 'PROFILE_INPUT_FORMAT', 'PROFILE_INPUT_BASE_JSON', 'PROFILE_OUTPUT_MAPPING_JSON']) values[key] = empty;
    const profile = job('profile', 1); pending = [profile];
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: profile.id, status: 'running' }]);
    expect(JSON.parse(String(starts()[0][1]?.body))).toMatchObject({ usernames: ['fixture_creator'], mode: 'profiles', maxResults: 1,
      includeLatestPosts: false, includeReels: false, includeContactDetails: false });
    processing = context({ ...profile, actor_run_id: 'run', dataset_id: 'dataset' });
    dataset = [{ username: 'fixture_creator', followersCount: 0, fullName: 'Synthetic profile name', profilePicUrl: 'https://scontent.cdninstagram.com/avatar.jpg' }];
    output = { ok: true, total_items: 1, users: [{ user: 'fixture_creator', count: 1 }] };
    expect(await worker.processJob(profile.id)).toBe('finished');
    expect(args('worker_ingest_page')[0]).toMatchObject({ p_received_counts: { [creator]: 1 }, p_errors: [], p_next_cursor: 1, p_finished: true,
      p_records: [{ creator_id: creator, followers_count: 0, display_name: 'Synthetic profile name', avatar_url: 'https://scontent.cdninstagram.com/avatar.jpg' }] });
    expect(args('worker_record_output_summary')[0].p_summary).toMatchObject({ complete: false, reason: 'profile_output_contract_unverified' });
    expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
  });

  it('accepts custom nested profile identity end-to-end and preserves valid metadata when partial OUTPUT remains unverified', async () => {
    values.PROFILE_PROVIDER_VALIDATED = 'true';
    values.PROFILE_OUTPUT_MAPPING_JSON = JSON.stringify({ username: 'profile.handle', followers: 'stats.followers',
      display_name: 'profile.displayName', avatar_url: 'profile.avatar.url' });
    const profile = job('profile', 1); pending = [profile];
    expect(jobOutcomes(await worker.dispatch(owner, true))).toEqual([{ job_id: profile.id, status: 'running' }]);
    processing = { ...context({ ...profile, actor_run_id: 'run', dataset_id: 'dataset' }), creators: [
      { id: creator, username: 'fixture_creator' }, { id: otherCreator, username: 'missing_followers' },
    ] };
    dataset = [
      { username: 'foreign_top_level', profile: { handle: '@FIXTURE_CREATOR', displayName: 'Synthetic nested profile', avatar: { url: 'https://scontent.cdninstagram.com/nested.jpg' } }, stats: { followers: 1200 } },
      { profile: { handle: 'missing_followers', displayName: 'No denominator invented' }, stats: { followers: -1 } },
    ];
    output = { ok: true, total_items: 2, users: [{ user: 'fixture_creator', count: 1 }, { user: 'missing_followers', count: 1 }] };
    expect(await worker.processJob(profile.id)).toBe('finished');
    const ingest = args('worker_ingest_page')[0];
    expect(ingest.p_records).toEqual([{ creator_id: creator, username: 'fixture_creator', followers_count: 1200,
      fetched_at: profile.result_fetched_at, provider: 'apify:profile-actor', display_name: 'Synthetic nested profile',
      avatar_url: 'https://scontent.cdninstagram.com/nested.jpg' }]);
    expect(ingest.p_errors).toEqual([{ creator_id: otherCreator, status: 'failed', message: 'Follower count missing/invalid; no invented denominator' }]);
    expect(ingest).toMatchObject({ p_received_counts: { [creator]: 1, [otherCreator]: 1 }, p_next_cursor: 2, p_finished: true });
    expect(args('worker_record_output_summary')[0].p_summary).toEqual({ ok: false, total_items: null, complete: false,
      reason: 'profile_output_contract_unverified', users: [
        { creator_id: creator, username: 'fixture_creator', count: null, error: 'profile_output_contract_unverified' },
        { creator_id: otherCreator, username: 'missing_followers', count: null, error: 'profile_output_contract_unverified' },
      ] });
    expect(rpcCalls('worker_ingest_page')).toHaveLength(1); expect(rpcCalls('worker_finish_processing')).toHaveLength(1);
    expect(rpcCalls('worker_release_processing')).toHaveLength(0); expect(rpcCalls('worker_dispatch_failure')).toHaveLength(0);
    expect(starts()).toHaveLength(1);
  });
});
