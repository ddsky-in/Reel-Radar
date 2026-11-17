import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These are the approved handler's fixed scope, not verified provider evidence.
// All transport and Deno configuration below are inert, synthetic fixtures.
const origin = 'https://project.supabase.co';
const providerOrigin = 'https://api.apify.com';
const owner = '43292213-87a3-4000-8000-9d779fbe6659';
const workspace = 'f9471264-510a-4000-8000-7a66fb73866f';
const actor = 'synthetic_88168e63af90';
const pins = [
  { id: 'd8817ff8-10d8-4000-8000-edb3e96298f4', slot: 1, user: 'synthetic_b9f2605e24e3', kind: 'metrics', username: 'synthetic_f05877d0f3cd', nonce: '9ff6f18c-bcae-4000-8000-8449f68cb1a5', started: '2026-11-13T14:23:48.972496Z' },
  { id: 'e02b7054-ffda-4000-8000-b3b4f090c045', slot: 2, user: 'synthetic_68f159e063d2', kind: 'metrics', username: 'synthetic_af88aff3e4b6', nonce: '34c98f8f-5262-4000-8000-b1deb10fa28f', started: '2026-11-15T08:17:38.568660Z' },
  { id: 'e5adbea1-2892-4000-8000-53937ec86da7', slot: 3, user: 'synthetic_9a8eef2b755b', kind: 'carousel', username: 'synthetic_fa5187f9f1bb', nonce: '3233b414-86ea-4000-8000-1d6ff2734f1b', started: '2026-11-15T07:31:00.818521Z' },
] as const;
type Pin = typeof pins[number];
type Row = Record<string, unknown>;
type Mode = 'runs' | 'webhooks' | 'receipts' | 'callbacks';
type Candidate = {
  run_id: string; status: string; started_at: string; finished_at: string | null;
  exact_job_nonce_webhook: boolean; usage_total_usd: number | null; terminal: boolean;
  starts_before_dispatch: boolean; start_delta_ms: number; input: Row;
};
type AuditResult = {
  job_id: string; account_slot: number; account_identity_verified: boolean; mode: Mode;
  offset: number; read_only: boolean; no_start_proven: boolean; complete: boolean;
  scanned_count: number; total: number; next_offset: number | null; bound_reached: boolean;
  candidates: Candidate[]; exact_matches_in_page: number;
};
const tokens = ['synthetic-private-token-1', 'synthetic-private-token-2', 'synthetic-private-token-3'];
const serviceKey = 'synthetic-private-service-key';
const internalSecret = 'synthetic-private-internal-secret';
const webhookSecret = 'synthetic-private-webhook-secret';
const rawPayload = 'synthetic-private-raw-payload';
const arbitraryError = 'synthetic-arbitrary-error-do-not-echo';
const forbiddenValues = [...tokens, serviceKey, internalSecret, webhookSecret, rawPayload, arbitraryError, ...pins.map(pin => pin.nonce)];
let handler: (request: Request) => Promise<Response>;
let pin: Pin;
let values: Record<string, string>;
let memberships: unknown;
let workspaces: unknown;
let jobs: unknown;
let accounts: unknown;
let callbacks: unknown;
let identity: unknown;
let listings: Record<Exclude<Mode, 'callbacks'>, Row>;
let runDetails: Record<string, Row>;
let hookDetails: Record<string, Row>;
let receiptDetails: Record<string, Row>;
let storedInput: unknown;
let failure: { path: string; status?: number; body?: unknown; error?: string } | null;
let violations: string[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

function job(patch: Row = {}): Row {
  return { id: pin.id, owner_user_id: owner, live: true, status: 'uncertain', kind: pin.kind,
    actor_run_id: null, dispatch_nonce: pin.nonce, started_at: pin.started, expected_actor_id: actor,
    expected_provider_user_id: pin.user, apify_account_slot: pin.slot, results_limit: 20, ...patch };
}
function run(id = 'fixture-run', patch: Row = {}): Row {
  return { id, actId: actor, userId: pin.user, status: 'SUCCEEDED', startedAt: pin.started,
    finishedAt: new Date(Date.parse(pin.started) + 1000).toISOString(), usageTotalUsd: .00005,
    defaultKeyValueStoreId: 'fixture-store', defaultWebhooks: [], ...patch };
}
function hook(patch: Row = {}): Row {
  return { id: 'fixture-hook', userId: pin.user, actionType: 'HTTP_REQUEST',
    condition: { actorRunId: 'fixture-run', actorId: actor },
    requestUrl: `${origin}/functions/v1/apify-webhook?job_id=${pin.id}&dispatch_nonce=${pin.nonce}`,
    headersTemplate: webhookSecret, payloadTemplate: rawPayload, ...patch };
}
function receipt(patch: Row = {}): Row {
  return { id: 'fixture-receipt', userId: pin.user, createdAt: pin.started,
    eventType: 'ACTOR.RUN.SUCCEEDED', eventData: { actorId: actor, actorRunId: 'fixture-run' },
    webhook: hook(), ...patch };
}
function page(items: Row[], limit = 10, patch: Row = {}): Row {
  return { items, offset: 0, limit, count: items.length, total: items.length, desc: false, ...patch };
}
function selectPin(selected: Pin) {
  pin = selected;
  jobs = [job()];
  accounts = [{ slot: pin.slot, provider_user_id: pin.user, authorization_confirmed: true }];
  identity = { data: { id: pin.user } };
  listings = { runs: page([run()]), webhooks: page([hook()], 100), receipts: page([receipt()], 100) };
  runDetails = { 'fixture-run': run() };
  hookDetails = { 'fixture-hook': hook() };
  receiptDetails = { 'fixture-receipt': receipt() };
  storedInput = { directUrls: [`https://www.instagram.com/${pin.username}/`],
    resultsType: pin.kind === 'carousel' ? 'photos' : 'reels', resultsLimit: 20,
    privatePayload: rawPayload, environment: { APIFY_API_TOKEN: tokens[pin.slot - 1] } };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function request(body: unknown = { job_id: pin.id, mode: 'runs' }, secret = internalSecret, options: RequestInit = {}): Request {
  return new Request(`${origin}/functions/v1/uncertain-job-audit`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(body), ...options,
  });
}
function calls(targetOrigin: string, path?: string) {
  return fetcher.mock.calls.filter(([input]) => {
    const url = new URL(String(input));
    return url.origin === targetOrigin && (!path || url.pathname === path);
  });
}
async function result(response: Response): Promise<Row> {
  const text = await response.text();
  for (const value of forbiddenValues) expect(text).not.toContain(value);
  for (const key of ['headersTemplate', 'payloadTemplate', 'requestUrl', 'authorization', 'apikey', 'privatePayload', 'environment']) {
    expect(text.toLowerCase()).not.toContain(`"${key.toLowerCase()}"`);
  }
  expect(response.headers.get('cache-control')).toBe('no-store');
  return JSON.parse(text) as Row;
}
async function audit(mode: Mode = 'runs', offset = 0): Promise<AuditResult> {
  const response = await handler(request({ job_id: pin.id, mode, offset }));
  expect(response.status).toBe(200);
  const body = await result(response) as unknown as AuditResult;
  expect(body).toMatchObject({ job_id: pin.id, account_slot: pin.slot, mode, offset,
    account_identity_verified: true, read_only: true, no_start_proven: false });
  return body;
}
async function unavailable(stage: string, body: unknown = { job_id: pin.id, mode: 'runs' }) {
  const response = await handler(request(body));
  expect(response.status).toBe(503);
  expect(await result(response)).toMatchObject({ error: 'audit_unavailable', stage,
    read_only: true, no_start_proven: false });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T07:00:00Z'));
  values = { INTERNAL_CRON_SECRET: internalSecret, SUPABASE_URL: origin,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey, REELRADAR_OWNER_USER_ID: owner, PROVIDER_MODE: 'apify',
    APIFY_API_TOKEN: tokens[0], APIFY_API_TOKEN_2: tokens[1], APIFY_API_TOKEN_3: tokens[2] };
  memberships = [{ role: 'owner' }]; workspaces = [{ id: workspace }]; callbacks = [];
  failure = null; violations = [];
  selectPin(pins[0]);
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  vi.stubGlobal('crypto', webcrypto);
  // No real-fetch fallback. Record violations so swallowed handler errors cannot hide a mutation.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const reject = (message: string): never => { violations.push(message); throw new Error(message); };
    if (init?.method !== 'GET' || init.body != null) return reject('Audit attempted non-GET transport or a mutation');
    if (init.redirect !== 'error' || !init.signal) return reject('Audit omitted redirect blocking or timeout');
    if (url.username || url.password || url.searchParams.has('token')) return reject('Credentials in URL');
    const headers = new Headers(init.headers);
    if (url.origin === origin) {
      if (headers.get('apikey') !== serviceKey || headers.get('authorization') !== `Bearer ${serviceKey}`) return reject('Missing database authorization');
      if (url.pathname === '/rest/v1/workspace_members') {
        if (url.searchParams.get('workspace_id') !== `eq.${workspace}` || url.searchParams.get('user_id') !== `eq.${owner}` || url.searchParams.get('role') !== 'eq.owner') return reject('Unscoped membership read');
        return json(memberships);
      }
      if (url.pathname === '/rest/v1/workspaces') {
        if (url.searchParams.get('id') !== `eq.${workspace}` || url.searchParams.get('owner_user_id') !== `eq.${owner}` || url.searchParams.get('archived_at') !== 'is.null') return reject('Unscoped workspace read');
        return json(workspaces);
      }
      if (url.pathname === '/rest/v1/scrape_jobs') {
        if (url.searchParams.get('id') !== `eq.${pin.id}` || url.searchParams.get('owner_user_id') !== `eq.${owner}` || url.searchParams.get('select') === '*') return reject('Unscoped job read');
        return json(jobs);
      }
      if (url.pathname === '/rest/v1/apify_accounts') {
        if (url.searchParams.get('slot') !== `eq.${pin.slot}` || url.searchParams.get('owner_id') !== `eq.${owner}` || url.searchParams.get('select') !== 'slot,provider_user_id,authorization_confirmed') return reject('Unscoped account read');
        return json(accounts);
      }
      if (url.pathname === '/rest/v1/scrape_callback_receipts') {
        if (url.searchParams.get('job_id') !== `eq.${pin.id}` || url.searchParams.get('owner_user_id') !== `eq.${owner}` || url.searchParams.get('limit') !== '100') return reject('Unscoped callback read');
        return json(callbacks);
      }
      return reject('Unexpected database endpoint; RPCs and mutations forbidden');
    }
    if (url.origin !== providerOrigin) return reject('Unexpected network origin');
    if (headers.get('authorization') !== `Bearer ${tokens[pin.slot - 1]}` || headers.has('apikey')) return reject('Incorrect selected-account token');
    if (failure && url.pathname === failure.path) {
      if (failure.error) throw new Error(failure.error);
      return json(failure.body ?? { message: rawPayload }, failure.status ?? 403);
    }
    if (url.pathname === '/v2/users/me') return json(identity);
    const mode = url.pathname === '/v2/actor-runs' ? 'runs' : url.pathname === '/v2/webhooks' ? 'webhooks' : url.pathname === '/v2/webhook-dispatches' ? 'receipts' : null;
    if (mode) {
      const limit = mode === 'runs' ? 10 : 100;
      const offset = Number(url.searchParams.get('offset'));
      if (url.searchParams.get('desc') !== '0' || url.searchParams.get('limit') !== String(limit) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || offset % limit !== 0) return reject('Unbounded provider listing');
      const expectedKeys = mode === 'runs' ? ['startedAfter', 'startedBefore', 'desc', 'limit', 'offset'] : ['desc', 'limit', 'offset'];
      if ([...url.searchParams.keys()].some(key => !expectedKeys.includes(key))) return reject('Unexpected listing parameter');
      if (mode === 'runs' && (url.searchParams.get('startedAfter') !== new Date(Date.parse(pin.started) - 900000).toISOString() || url.searchParams.get('startedBefore') !== new Date(Date.parse(pin.started) + 900000).toISOString())) return reject('Incorrect pinned run window');
      return json({ data: listings[mode] });
    }
    const runId = /^\/v2\/actor-runs\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (runId && runDetails[runId]) return json({ data: runDetails[runId] });
    const hookId = /^\/v2\/webhooks\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (hookId && hookDetails[hookId]) return json({ data: hookDetails[hookId] });
    const receiptId = /^\/v2\/webhook-dispatches\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (receiptId && receiptDetails[receiptId]) return json({ data: receiptDetails[receiptId] });
    if (url.pathname === '/v2/key-value-stores/fixture-store/records/INPUT') return json(storedInput);
    return reject('Unexpected provider endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  ({ handler } = await import('../supabase/functions/uncertain-job-audit/index.ts' as string));
});
afterEach(() => {
  try {
    expect(violations).toEqual([]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    }
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('fixed-scope temporary uncertain-job audit authorization', () => {
  it.each(['', 'wrong-secret', serviceKey, webhookSecret, 'x'.repeat(1025)])('rejects invalid internal authentication before transport: %s', async supplied => {
    const response = await handler(request(undefined, supplied));
    expect(response.status).toBe(401); expect(await result(response)).toEqual({ error: 'unauthorized' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed without the configured secret and rejects bearer/webhook substitutes', async () => {
    delete values.INTERNAL_CRON_SECRET;
    expect((await handler(request())).status).toBe(401);
    values.INTERNAL_CRON_SECRET = internalSecret;
    const response = await handler(request(undefined, '', { headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}`, 'x-webhook-secret': webhookSecret } }));
    expect(response.status).toBe(401); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('requires incoming POST, never accepting %s', async method => {
    const response = await handler(request(undefined, internalSecret, { method, body: undefined }));
    expect(response.status).toBe(401); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['2026-11-16T07:30:00Z', '2026-11-16T07:30:00.001Z'])('expires before all reads at %s', async now => {
    vi.setSystemTime(new Date(now));
    const response = await handler(request());
    expect(response.status).toBe(410); expect(await result(response)).toEqual({ error: 'audit_expired', read_only: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{}, { job_id: 'foreign-job', mode: 'runs' }, { job_id: pins[0].id, mode: 'start' },
    { job_id: pins[0].id, mode: 'runs', owner_user_id: owner }, { job_id: pins[0].id, mode: ['runs'] }, null, []].map(body => ({ body })))('rejects invalid request scope before reads: %j', async ({ body }) => {
    const response = await handler(request(body));
    expect(response.status).toBeGreaterThanOrEqual(400); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { body: '{' }, { body: 'x'.repeat(2049) },
    { headers: { 'content-type': 'text/plain', 'x-internal-secret': internalSecret } },
  ])('rejects malformed, oversized, or non-JSON input: %j', async options => {
    const response = await handler(request(undefined, internalSecret, options));
    expect(response.status).toBeGreaterThanOrEqual(400); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([-1, 1, 10001, 10.5, '10', null])('rejects invalid explicit runs offsets: %j', async offset => {
    const response = await handler(request({ job_id: pin.id, mode: 'runs', offset }));
    expect(response.status).toBe(400); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['webhooks', 'receipts', 'callbacks'])('requires 100-aligned offsets for %s', async mode => {
    const response = await handler(request({ job_id: pin.id, mode, offset: 10 }));
    expect(response.status).toBe(400); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['SUPABASE_URL', 'https://foreign.supabase.co'], ['SUPABASE_URL', `${origin}/`],
    ['REELRADAR_OWNER_USER_ID', 'foreign-owner'], ['PROVIDER_MODE', 'demo'], ['SUPABASE_SERVICE_ROLE_KEY', ''],
  ])('fails closed for incorrect %s configuration', async (key, value) => {
    values[key] = value; await unavailable('configuration'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['missing-membership', 'foreign-role', 'duplicate-membership', 'missing-workspace', 'foreign-workspace'])('requires exactly the approved owner/workspace: %s', async scenario => {
    if (scenario === 'missing-membership') memberships = [];
    if (scenario === 'foreign-role') memberships = [{ role: 'member' }];
    if (scenario === 'duplicate-membership') memberships = [{ role: 'owner' }, { role: 'owner' }];
    if (scenario === 'missing-workspace') workspaces = [];
    if (scenario === 'foreign-workspace') workspaces = [{ id: 'foreign-workspace' }];
    await unavailable('owner_authorization'); expect(calls(providerOrigin)).toHaveLength(0);
    expect(calls(origin, '/rest/v1/scrape_jobs')).toHaveLength(0);
  });
  it.each([
    { id: 'foreign-job' }, { owner_user_id: 'foreign-owner' }, { live: false }, { status: 'pending' },
    { actor_run_id: 'already-started' }, { kind: 'discovery' }, { dispatch_nonce: pins[1].nonce },
    { started_at: null }, { started_at: 'invalid' }, { started_at: pins[1].started },
    { expected_actor_id: 'foreign-actor' }, { expected_provider_user_id: pins[1].user }, { apify_account_slot: 2 },
  ])('rejects changed saved-job pins before provider reads: %j', async patch => {
    jobs = [job(patch)]; await unavailable('job_pin_changed'); expect(calls(providerOrigin)).toHaveLength(0);
  });
  it.each([0, 2])('requires one saved job, not absence or duplicates: %i', async count => {
    jobs = Array.from({ length: count }, () => job()); await unavailable('job_scope'); expect(calls(providerOrigin)).toHaveLength(0);
  });
  it.each([{ slot: 2 }, { provider_user_id: pins[1].user }, { authorization_confirmed: false }])('rejects foreign/unconfirmed account rows before provider reads: %j', async patch => {
    accounts = [{ slot: pin.slot, provider_user_id: pin.user, authorization_confirmed: true, ...patch }];
    await unavailable('account_pin_changed'); expect(calls(providerOrigin)).toHaveLength(0);
  });
  it.each(pins)('fails closed without the selected slot $slot token, without fallback', async selected => {
    selectPin(selected); delete values[pin.slot === 1 ? 'APIFY_API_TOKEN' : `APIFY_API_TOKEN_${pin.slot}`];
    await unavailable('account_token_missing'); expect(calls(providerOrigin)).toHaveLength(0);
  });
  it.each(pins)('verifies /users/me with slot $slot token before evidence reads', async selected => {
    selectPin(selected); identity = { data: { id: pins[(pin.slot % 3)].user } };
    await unavailable('account_identity_mismatch');
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual(['/v2/users/me']);
  });
});

describe('bounded read-only evidence and projected input', () => {
  it.each(pins)('supports approved pin $slot with selected-token identity and only GETs', async selected => {
    selectPin(selected); const body = await audit();
    expect(body).toMatchObject({ complete: true, total: 1, scanned_count: 1, next_offset: null,
      bound_reached: false, exact_matches_in_page: 0,
      candidates: [{ run_id: 'fixture-run', exact_job_nonce_webhook: false, starts_before_dispatch: false,
        start_delta_ms: 0, terminal: true, input: { available: true, username_matches: true,
          results_type_matches: true, results_limit_matches: true, matches_requested_input: true } }] });
    expect(calls(origin)).toHaveLength(4);
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v2/users/me', '/v2/actor-runs', '/v2/actor-runs/fixture-run', '/v2/key-value-stores/fixture-store/records/INPUT',
    ]);
  });
  it('reports incomplete runs pages and one explicit continuation, never automatic pagination', async () => {
    listings.runs = page([], 10, { offset: 10, total: 10 });
    let body = await audit('runs', 10);
    expect(body).toMatchObject({ complete: true, scanned_count: 0, next_offset: null, no_start_proven: false });
    listings.runs = page([run()], 10, { offset: 20, total: 42 });
    body = await audit('runs', 20);
    expect(body).toMatchObject({ complete: false, total: 42, scanned_count: 1, next_offset: 30, bound_reached: false });
    expect(calls(providerOrigin, '/v2/actor-runs')).toHaveLength(2);
  });
  it('reports the offset bound without asserting completeness or no-start proof', async () => {
    listings.runs = page([run()], 10, { offset: 10000, total: 10020 });
    expect(await audit('runs', 10000)).toMatchObject({ complete: false, next_offset: null, bound_reached: true, no_start_proven: false });
  });
  it.each([
    { items: {} }, { items: Array.from({ length: 11 }, () => ({ id: 'fixture-run' })) }, { offset: 10 }, { count: 2 },
    { limit: 100 }, { desc: true }, { total: '1' }, { total: .5 }, { total: 0 },
    { items: [], count: 0, total: 1 }, { items: [], count: 0, total: -1 },
  ])('rejects invalid provider pagination metadata: %j', async patch => {
    listings.runs = page([run()], 10, patch); await unavailable('pagination_metadata');
    expect(calls(providerOrigin, '/v2/actor-runs/fixture-run')).toHaveLength(0);
  });
  it.each([
    { id: 'foreign-run' }, { actId: 'foreign-actor' }, { userId: pins[1].user }, { status: arbitraryError },
    { startedAt: 'invalid' }, { startedAt: '2026-11-13T14:23:48' },
    { startedAt: new Date(Date.parse(pins[0].started) + 900001).toISOString() },
  ])('fails closed on run detail identity/schema mismatch: %j', async patch => {
    runDetails['fixture-run'] = run('fixture-run', patch); await unavailable('run_identity_mismatch');
    expect(calls(providerOrigin, '/v2/key-value-stores/fixture-store/records/INPUT')).toHaveLength(0);
  });
  it('filters foreign Actors, unsafe IDs, invalid times, and out-of-window list rows before details', async () => {
    listings.runs = page([run('../private'), run('foreign', { actId: 'foreign' }),
      run('invalid', { startedAt: 'invalid' }), run('late', { startedAt: new Date(Date.parse(pin.started) + 900001).toISOString() })]);
    expect(await audit()).toMatchObject({ candidates: [], exact_matches_in_page: 0, no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(2);
  });
  it.each([undefined, null, -1, '0.1', { total: .1 }, Number.NaN, Number.POSITIVE_INFINITY])('keeps missing/invalid authoritative charges unknown: %j', async usageTotalUsd => {
    runDetails['fixture-run'] = run('fixture-run', { usageTotalUsd, usageUsd: { total: 20 },
      pricingInfo: { pricePerUnit: 1 }, chargedEventCounts: { item: 20 } });
    expect((await audit()).candidates[0].usage_total_usd).toBeNull();
  });
  it('preserves zero charge, sanitizes finish time, and reports nonterminal state without recommendations', async () => {
    runDetails['fixture-run'] = run('fixture-run', { usageTotalUsd: 0, finishedAt: arbitraryError, status: 'RUNNING',
      errorMessage: arbitraryError, env: { key: serviceKey }, payloadTemplate: rawPayload });
    expect((await audit()).candidates[0]).toMatchObject({ usage_total_usd: 0, finished_at: null, terminal: false });
  });
  it.each([
    { directUrls: ['foreign_user'] }, { directUrls: [pins[0].username, 'extra_user'] },
    { directUrls: [`https://evil.test/${pins[0].username}`] }, { resultsType: 'posts' }, { resultsLimit: '20' },
  ])('projects mismatched INPUT to booleans, never raw values: %j', async patch => {
    storedInput = { ...(storedInput as Row), ...patch };
    const input = (await audit()).candidates[0].input;
    expect(input.available).toBe(true); expect(input.matches_requested_input).toBe(false);
    expect(Object.keys(input).sort()).toEqual(['available', 'matches_requested_input', 'results_limit_matches', 'results_type_matches', 'username_matches']);
  });
  it.each([null, [], 'private-input'].map(input => ({ input })))('marks nonobject INPUT unavailable: %j', async ({ input }) => {
    storedInput = input;
    expect((await audit()).candidates[0].input).toEqual({ available: false, matches_requested_input: false });
  });
  it('treats a missing INPUT record as unavailable, not a failed run or no-start proof', async () => {
    failure = { path: '/v2/key-value-stores/fixture-store/records/INPUT', status: 404 };
    expect((await audit()).candidates[0].input).toEqual({ available: false, matches_requested_input: false });
  });
});

describe('exact callback correlation versus approximate run/input matching', () => {
  it('requires exact manifest job+nonce webhook evidence even when time and input match', async () => {
    runDetails['fixture-run'] = run('fixture-run', { defaultWebhooks: ['fixture-hook'] });
    const body = await audit();
    expect(body).toMatchObject({ exact_matches_in_page: 1, candidates: [{ exact_job_nonce_webhook: true }] });
    expect(calls(providerOrigin, '/v2/webhooks/fixture-hook')).toHaveLength(1);
  });
  it.each([
    { userId: pins[1].user }, { actionType: 'SLACK_MESSAGE' },
    { condition: { actorRunId: 'fixture-run', actorId: 'foreign-actor' } },
    { condition: { actorRunId: 'fixture-run', actorTaskId: 'foreign-task' } },
    { condition: { actorRunId: '../private' } },
    { requestUrl: `${origin}/functions/v1/apify-webhook?job_id=${pins[1].id}&dispatch_nonce=${pins[0].nonce}` },
    { requestUrl: `${origin}/functions/v1/apify-webhook?job_id=${pins[0].id}&dispatch_nonce=${pins[1].nonce}` },
    { requestUrl: `https://project.supabase.co.evil.test/functions/v1/apify-webhook?job_id=${pins[0].id}&dispatch_nonce=${pins[0].nonce}` },
    { requestUrl: `${origin}/functions/v1/apify-webhook?job_id=${pins[0].id}&dispatch_nonce=${pins[0].nonce}#fragment` },
    { requestUrl: `${origin}/functions/v1/apify-webhook?job_id=${pins[0].id}&dispatch_nonce=${pins[0].nonce}&dispatch_nonce=${pins[0].nonce}` },
    { requestUrl: `${origin}/functions/v1/apify-webhook?job_id=${pins[0].id}&dispatch_nonce=${pins[0].nonce}&extra=private` },
  ])('rejects nonexact webhook evidence without run detail reads: %j', async patch => {
    listings.webhooks = page([hook(patch)], 100);
    expect(await audit('webhooks')).toMatchObject({ candidates: [], exact_matches_in_page: 0, no_start_proven: false });
    expect(calls(providerOrigin, '/v2/actor-runs/fixture-run')).toHaveLength(0);
  });
  it('can scan a later webhook page and correlate it without approximate run listing', async () => {
    listings.webhooks = page([hook()], 100, { offset: 100, total: 101 });
    expect(await audit('webhooks', 100)).toMatchObject({ complete: true, exact_matches_in_page: 1,
      candidates: [{ run_id: 'fixture-run', exact_job_nonce_webhook: true }] });
    expect(calls(providerOrigin, '/v2/actor-runs')).toHaveLength(0);
  });
  it('requires the exact dispatch list item and detail to agree before correlation', async () => {
    expect(await audit('receipts')).toMatchObject({ exact_matches_in_page: 1, candidates: [{ exact_job_nonce_webhook: true }] });
    expect(calls(providerOrigin, '/v2/webhook-dispatches/fixture-receipt')).toHaveLength(1);
  });
  it.each([{ id: 'foreign-receipt' }, { userId: pins[1].user }, { eventType: 'ACTOR.RUN.FAILED' },
    { createdAt: '2026-11-13T14:24:00Z' }, { eventData: { actorId: actor, actorRunId: 'foreign-run' } }])('does not promote mismatched receipt detail: %j', async patch => {
    receiptDetails['fixture-receipt'] = receipt(patch);
    expect(await audit('receipts')).toMatchObject({ candidates: [], exact_matches_in_page: 0 });
    expect(calls(providerOrigin, '/v2/actor-runs/fixture-run')).toHaveLength(0);
  });
  it('bounds oversized exact candidate sets before any run detail GETs', async () => {
    listings.webhooks = page(Array.from({ length: 11 }, (_, index) => hook({ condition: { actorId: actor, actorRunId: `fixture-${index}` } })), 100);
    expect(await audit('webhooks')).toMatchObject({ candidates: [], candidate_bound_reached: true, no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(2);
  });
  it('projects only nonce/Actor/account-matching DB callback receipts, sanitizing state', async () => {
    callbacks = [
      { run_id: 'fixture-run', state: rawPayload, dispatch_nonce: pin.nonce, expected_actor_id: actor, expected_provider_user_id: pin.user, privatePayload: rawPayload },
      { run_id: 'foreign-run', state: 'verified', dispatch_nonce: pins[1].nonce, expected_actor_id: actor, expected_provider_user_id: pin.user },
    ];
    const response = await handler(request({ job_id: pin.id, mode: 'callbacks' }));
    expect(response.status).toBe(200);
    expect(await result(response)).toMatchObject({ complete: true, scanned_count: 2, matching_callbacks: [{ run_id: 'fixture-run', state: null }], no_start_proven: false });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual(['/v2/users/me']);
  });
  it('does not report a callback offset that was never applied to the database query', async () => {
    const response = await handler(request({ job_id: pin.id, mode: 'callbacks', offset: 100 }));
    if (response.status === 400) {
      await result(response); expect(fetcher).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200); expect(await result(response)).toMatchObject({ offset: 100 });
      const [url] = calls(origin, '/rest/v1/scrape_callback_receipts')[0];
      expect(new URL(String(url)).searchParams.get('offset')).toBe('100');
    }
  });
});

describe('redacted errors and retired audit', () => {
  it.each([
    { path: '/v2/users/me', status: 403, body: { message: tokens[0], requestUrl: pins[0].nonce, headersTemplate: webhookSecret } },
    { path: '/v2/actor-runs', error: `${arbitraryError} ${serviceKey} ${pins[0].nonce}` },
    { path: '/v2/actor-runs/fixture-run', body: { data: rawPayload }, status: 200 },
  ])('redacts upstream bodies and arbitrary thrown errors: %j', async injected => {
    failure = injected;
    const response = await handler(request()); expect(response.status).toBe(503);
    expect(await result(response)).toMatchObject({ error: 'audit_unavailable', read_only: true, no_start_proven: false });
  });
  async function retired() {
    return (await import('../supabase/functions/uncertain-job-audit/retired.ts' as string)).handler as (request: Request) => Promise<Response>;
  }
  it('returns authenticated retirement without any reads, mutations, or no-start proof', async () => {
    const retiredHandler = await retired();
    const response = await retiredHandler(request()); expect(response.status).toBe(410);
    expect(await result(response)).toEqual({ error: 'audit_retired', read_only: true, no_start_proven: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'DELETE'])('keeps the retired handler POST-only: %s', async method => {
    const retiredHandler = await retired();
    const response = await retiredHandler(request(undefined, internalSecret, { method, body: undefined }));
    expect(response.status).toBe(401); await result(response); expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed when retired authentication is missing, wrong, or unconfigured', async () => {
    const retiredHandler = await retired();
    for (const supplied of ['', 'wrong-secret']) {
      const response = await retiredHandler(request(undefined, supplied)); expect(response.status).toBe(401); await result(response);
    }
    delete values.INTERNAL_CRON_SECRET;
    const response = await retiredHandler(request()); expect(response.status).toBe(401); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
