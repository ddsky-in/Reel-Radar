import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = '43292213-87a3-4000-8000-9d779fbe6659';
const jobId = 'd8817ff8-10d8-4000-8000-edb3e96298f4';
const stranger = '99999999-9999-4999-8999-999999999999';
const creatorId = '22222222-2222-4222-8222-222222222222';
const nonce = '44444444-4444-4444-8444-444444444444';
const actorId = 'fixture-actor';
const accountId = 'fixture-account';
const databaseOrigin = 'https://fixture.supabase.co';
const providerOrigin = 'https://api.apify.com';
const now = '2026-11-13T12:10:00.000Z';
const startedAt = '2026-11-13T12:00:00.000Z';
const secrets = ['synthetic-private-provider-token', 'synthetic-private-service-key',
  'synthetic-private-internal-secret', 'synthetic-private-webhook-secret', 'synthetic-private-raw-payload'];

type RecordValue = Record<string, unknown>;
type AuditCandidate = {
  run_id: string; status: string | null; started_at: string | null; finished_at: string | null;
  usage_total_usd: number | null; exact_webhook_match: boolean;
};
type AuditResult = {
  job_id: string; read_only: boolean; run_list_complete: boolean; webhook_list_complete: boolean;
  candidates: AuditCandidate[]; reason: string; no_start_proven: boolean;
  receipt_offset?: number; receipt_scanned_count?: number; receipt_list_complete?: boolean;
  receipt_window?: { oldest_at: string | null; newest_at: string | null }; next_receipt_offset?: number | null;
};
let handler: (request: Request) => Promise<Response>;
let values: Record<string, string>;
let jobs: RecordValue[];
let links: RecordValue[];
let runPages: RecordValue[][];
let webhookPages: RecordValue[][];
let receiptPages: Record<number, RecordValue[]>;
let receiptDetails: Record<string, RecordValue>;
let details: Record<string, RecordValue>;
let violations: string[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let providerFailure: { path: string; status?: number; body?: unknown; error?: string } | null;

function job(patch: RecordValue = {}): RecordValue {
  return { id: jobId, owner_user_id: owner, kind: 'discovery', status: 'uncertain', live: true,
    actor_run_id: null, dispatch_nonce: nonce, expected_actor_id: actorId,
    expected_provider_user_id: accountId, started_at: startedAt, competitor_run_id: creatorId,
    results_limit: 10000, ...patch };
}
function run(id = 'fixture-run', patch: RecordValue = {}): RecordValue {
  return { id, actId: actorId, userId: accountId, status: 'SUCCEEDED', startedAt,
    finishedAt: '2026-11-13T12:03:00.000Z', usageTotalUsd: .00005,
    defaultKeyValueStoreId: 'fixture-store', defaultDatasetId: 'fixture-dataset', ...patch };
}
function webhook(patch: RecordValue = {}): RecordValue {
  return { id: 'fixture-webhook', userId: accountId, condition: { actorRunId: 'fixture-run' },
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
    requestUrl: `${databaseOrigin}/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}`,
    headersTemplate: JSON.stringify({ 'x-webhook-secret': secrets[3] }),
    payloadTemplate: secrets[4], actionType: 'HTTP_REQUEST', ...patch };
}
function receipt(patch: RecordValue = {}): RecordValue {
  return { id: 'fixture-receipt', userId: accountId, createdAt: '2026-11-13T12:03:01.000Z',
    eventType: 'ACTOR.RUN.SUCCEEDED', eventData: { actorId, actorRunId: 'fixture-run' },
    webhook: webhook({ actionType: 'HTTP_REQUEST' }), ...patch };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function request(body: unknown = { job_id: jobId }, secret = secrets[2], options: RequestInit = {}): Request {
  return new Request(`${databaseOrigin}/functions/v1/competitor-run-audit`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(body), ...options,
  });
}
function calls(origin: string, path?: string) {
  return fetcher.mock.calls.filter(([url]) => {
    const parsed = new URL(String(url));
    return parsed.origin === origin && (!path || parsed.pathname === path);
  });
}
async function result(response: Response): Promise<RecordValue> {
  const text = await response.text();
  for (const secret of [...secrets, nonce]) expect(text).not.toContain(secret);
  for (const key of ['headersTemplate', 'payloadTemplate', 'requestUrl', 'authorization', 'apikey']) {
    expect(text.toLowerCase()).not.toContain(key.toLowerCase());
  }
  expect(response.headers.get('cache-control')).toBe('no-store');
  return JSON.parse(text) as RecordValue;
}
async function audit(receiptOffset?: number): Promise<AuditResult> {
  const response = await handler(request(receiptOffset === undefined ? { job_id: jobId } : { job_id: jobId, receipt_offset: receiptOffset }));
  expect(response.status).toBe(200);
  const body = await result(response) as unknown as AuditResult;
  expect(body).toMatchObject({ job_id: jobId, read_only: true, no_start_proven: false });
  return body;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  values = { PROVIDER_MODE: 'apify', ENVIRONMENT: 'test', SUPABASE_URL: databaseOrigin,
    SUPABASE_SERVICE_ROLE_KEY: secrets[1], INTERNAL_CRON_SECRET: secrets[2],
    REELRADAR_OWNER_USER_ID: owner, APIFY_API_TOKEN: secrets[0], APIFY_ACCOUNT_ID: accountId,
    APIFY_REEL_ACTOR_RESOURCE_ID: actorId, APIFY_WEBHOOK_SHARED_SECRET: secrets[3],
    SCRAPING_ENABLED: 'false', PROVIDER_VALIDATED: 'false', ACCOUNT_USAGE_VALIDATED: 'false',
    RUN_CHARGE_CAP_VALIDATED: 'false', PROFILE_PROVIDER_VALIDATED: 'false', CAROUSEL_PROVIDER_VALIDATED: 'false' };
  jobs = [job()];
  links = [{ job_id: jobId, creator_id: creatorId,
    creators: { id: creatorId, username: 'fixture_creator', owner_user_id: owner } }];
  runPages = [[run()]];
  webhookPages = [[webhook()]];
  receiptPages = { 0: [receipt()] };
  receiptDetails = { 'fixture-receipt': receipt() };
  details = { 'fixture-run': run() };
  providerFailure = null; violations = [];
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  vi.stubGlobal('crypto', webcrypto);
  // Every request is handled by an inert fixture. There is no fallback to real networking,
  // and violations remain observable even if the production handler catches the error.
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const reject = (message: string): never => { violations.push(message); throw new Error(message); };
    if ((init?.method ?? 'GET') !== 'GET' || init?.body != null) return reject('Audit attempted a mutation');
    if (url.username || url.password || url.searchParams.has('token')) return reject('Credentials in fixture URL');
    const headers = new Headers(init?.headers);
    if (url.origin === databaseOrigin) {
      if (headers.get('apikey') !== secrets[1] || headers.get('authorization') !== `Bearer ${secrets[1]}`) {
        return reject('Missing fixture database authorization');
      }
      if (url.pathname === '/rest/v1/scrape_jobs') {
        if (url.searchParams.get('owner_user_id') !== `eq.${owner}` || url.searchParams.get('id') !== `eq.${jobId}`
          || url.searchParams.get('live') !== 'eq.true') return reject('Unscoped audit job query');
        return json(jobs);
      }
      if (url.pathname === '/rest/v1/scrape_job_creators') {
        if (url.searchParams.get('job_id') !== `eq.${jobId}`) return reject('Unscoped creator-link query');
        return json(links);
      }
      return reject('Unexpected database endpoint; RPCs and mutations are forbidden');
    }
    if (url.origin !== providerOrigin) return reject('Unexpected fixture origin');
    if (init?.redirect !== 'error') return reject('Provider redirects are not blocked');
    if (headers.get('authorization') !== `Bearer ${secrets[0]}`) return reject('Missing fixture provider authorization');
    if (providerFailure && url.pathname === providerFailure.path) {
      if (providerFailure.error) throw new Error(providerFailure.error);
      return json(providerFailure.body ?? { message: secrets[0], headersTemplate: secrets[3] }, providerFailure.status ?? 403);
    }
    if (url.pathname === `/v2/acts/${actorId}/runs`) {
      if (url.searchParams.get('desc') !== '1' || url.searchParams.get('limit') !== '100'
        || url.searchParams.get('startedAfter') !== '2026-11-13T11:55:00.000Z'
        || url.searchParams.get('startedBefore') !== '2026-11-13T12:05:00.000Z') {
        return reject('Unbounded run listing');
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (![0, 100, 200].includes(offset)) return reject('Run listing exceeded three pages');
      const items = runPages[offset / 100] ?? [];
      return json({ data: { items, offset, limit: 100, count: items.length,
        total: runPages.reduce((total, page) => total + page.length, 0), desc: true } });
    }
    if (url.pathname === '/v2/webhooks') {
      if (url.searchParams.get('desc') !== '1' || url.searchParams.get('limit') !== '100') return reject('Unbounded webhook listing');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 10200 || offset % 100 !== 0) return reject('Webhook listing exceeded explicit bounds');
      const items = webhookPages[offset / 100] ?? [];
      return json({ data: { items, offset, limit: 100, count: items.length,
        total: webhookPages.reduce((total, page) => total + page.length, 0) } });
    }
    if (url.pathname === '/v2/webhook-dispatches') {
      if (url.searchParams.get('desc') !== '1' || url.searchParams.get('limit') !== '100' ||
          [...url.searchParams.keys()].some(key => !['desc', 'limit', 'offset'].includes(key))) return reject('Unbounded receipt listing');
      const offset = Number(url.searchParams.get('offset'));
      if (!Number.isInteger(offset) || offset < 0 || offset > 10200 || offset % 100 !== 0 ||
          calls(providerOrigin, '/v2/webhook-dispatches').length > 3) return reject('Receipt listing exceeded three bounded pages');
      const items = receiptPages[offset] ?? [];
      return json({ data: { items, offset, limit: 100, count: items.length } });
    }
    const receiptId = /^\/v2\/webhook-dispatches\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (receiptId && receiptDetails[receiptId]) return json({ data: receiptDetails[receiptId] });
    const id = /^\/v2\/actor-runs\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (id && details[id]) return json({ data: details[id] });
    return reject(`Unexpected provider endpoint ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetcher);
  ({ handler } = await import('../supabase/functions/competitor-run-audit/index.ts' as string));
});
afterEach(() => {
  try {
    expect(violations).toEqual([]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.body).toBeUndefined();
    }
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('explicit historical webhook audit', () => {
  it('finds only an exact owner/Actor/nonce run match beyond the first pages without listing approximate runs', async () => {
    webhookPages = [[], [], [], [webhook()]];
    const response = await handler(request({ job_id: jobId, webhook_offset: 300 }));
    expect(response.status).toBe(200);
    const body = await result(response);
    expect(body).toMatchObject({ webhook_offset: 300, webhook_scanned_count: 1, webhook_list_complete: true,
      next_webhook_offset: null, reason: 'exact_run_match', no_start_proven: false,
      candidates: [{ run_id: 'fixture-run', exact_webhook_match: true }] });
    expect(calls(providerOrigin, `/v2/acts/${actorId}/runs`)).toHaveLength(0);
    expect(calls(providerOrigin, '/v2/webhook-dispatches')).toHaveLength(0);
    expect(calls(providerOrigin, '/v2/webhooks')).toHaveLength(1);
  });
  it.each([{ userId: stranger }, { actionType: 'SLACK_MESSAGE' }, { condition: { actorRunId: 'fixture-run', actorId: 'other' } },
    { requestUrl: `${databaseOrigin}/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${stranger}` }])('rejects nonexact webhook evidence: %j', async patch => {
      webhookPages = [[webhook(patch)]];
      const response = await handler(request({ job_id: jobId, webhook_offset: 0 }));
      expect(await result(response)).toMatchObject({ candidates: [], reason: 'no_exact_run_match', no_start_proven: false });
      expect(calls(providerOrigin, '/v2/actor-runs/fixture-run')).toHaveLength(0);
    });
  it.each([-1, 1, 10001, '300', null])('rejects invalid webhook offsets before reads: %j', async webhook_offset => {
    expect((await handler(request({ job_id: jobId, webhook_offset }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects mixed historical modes and bounds continuation without a no-start claim', async () => {
    expect((await handler(request({ job_id: jobId, webhook_offset: 0, receipt_offset: 0 }))).status).toBe(400);
    webhookPages = Array.from({ length: 6 }, () => Array.from({ length: 100 }, (_, i) => webhook({ id: `other-${i}`, requestUrl: 'https://unrelated.test' })));
    const response = await handler(request({ job_id: jobId, webhook_offset: 300 }));
    expect(await result(response)).toMatchObject({ webhook_scanned_count: 300, webhook_list_complete: false, next_webhook_offset: 600, candidates: [], no_start_proven: false });
    expect(calls(providerOrigin, '/v2/webhooks')).toHaveLength(3);
  });
});

describe('temporary owner/job-scoped read-only competitor run audit', () => {
  it.each(['', 'arbitrary', secrets[0], secrets[1], secrets[3]])(
    'rejects an invalid internal secret before all transport: %s', async supplied => {
      const response = await handler(request({ job_id: jobId }, supplied));
      expect(response.status).toBe(401);
      await result(response);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('does not accept a bearer/service key or webhook header in place of internal authentication', async () => {
    const response = await handler(request({ job_id: jobId }, '', { headers: {
      'content-type': 'application/json', authorization: `Bearer ${secrets[1]}`, 'x-webhook-secret': secrets[3],
    } }));
    expect(response.status).toBe(401); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT', 'DELETE'])('rejects %s even with valid authentication without transport', async method => {
    const response = await handler(request(undefined, secrets[2], { method, body: undefined }));
    expect(response.status).toBeGreaterThanOrEqual(400); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when the internal secret is not configured', async () => {
    delete values.INTERNAL_CRON_SECRET;
    const response = await handler(request());
    expect(response.status).toBe(401); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { job_id: stranger }, { job_id: jobId.toUpperCase() }, { job_id: [jobId] },
    { job_id: jobId, owner_user_id: owner }, { job_id: jobId, action: 'start' }, null, []])(
    'requires exactly the fixed job_id JSON body: %j', async body => {
      const response = await handler(request(body));
      expect(response.status).toBeGreaterThanOrEqual(400); await result(response);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { body: '{', headers: { 'content-type': 'application/json', 'x-internal-secret': secrets[2] } },
    { body: JSON.stringify({ job_id: jobId }), headers: { 'content-type': 'text/plain', 'x-internal-secret': secrets[2] } },
    { body: JSON.stringify({ job_id: jobId, padding: 'x'.repeat(16384) }),
      headers: { 'content-type': 'application/json', 'x-internal-secret': secrets[2] } },
  ])('rejects malformed, non-JSON or oversized input before transport', async options => {
    const response = await handler(request(undefined, secrets[2], options));
    expect(response.status).toBeGreaterThanOrEqual(400); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, stranger])('fails closed when the configured owner is not the approved owner: %s', async configured => {
    if (configured) values.REELRADAR_OWNER_USER_ID = configured;
    else delete values.REELRADAR_OWNER_USER_ID;
    const response = await handler(request());
    expect(response.status).toBeGreaterThanOrEqual(400); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.001Z'])(
    'refuses the temporary diagnostic at or after expiry: %s', async time => {
      vi.setSystemTime(new Date(time));
      const response = await handler(request());
      expect(response.status).toBeGreaterThanOrEqual(400); await result(response);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { owner_user_id: stranger }, { id: stranger }, { live: false }, { status: 'pending' },
    { status: 'running' }, { status: 'completed' }, { actor_run_id: 'already-attached' },
    { dispatch_nonce: null }, { dispatch_nonce: '' }, { started_at: null }, { started_at: 'invalid' },
    { expected_actor_id: '../foreign-actor' }, { expected_provider_user_id: 'foreign-account' },
  ])('refuses an ineligible saved job without any provider reads: %j', async patch => {
    jobs = [job(patch)];
    const response = await handler(request());
    expect(response.status).toBeGreaterThanOrEqual(400); await result(response);
    expect(calls(providerOrigin)).toHaveLength(0);
  });

  it('does not treat a missing job as proof that a provider start never happened', async () => {
    jobs = [];
    const response = await handler(request());
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await result(response);
    expect(body.no_start_proven).not.toBe(true);
    expect(calls(providerOrigin)).toHaveLength(0);
  });

  it('queries the exact approved live job and creator associations without reserving, attaching or mutating', async () => {
    await audit();
    expect(calls(databaseOrigin, '/rest/v1/scrape_jobs')).toHaveLength(1);
    expect(calls(databaseOrigin, '/rest/v1/scrape_job_creators')).toHaveLength(1);
    expect(calls(databaseOrigin)).toHaveLength(2);
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname.includes('/rpc/'))).toBe(false);
    expect(values.SCRAPING_ENABLED).toBe('false');
  });

  it.each<{ associations: RecordValue[] }>([
    { associations: [] },
    { associations: [{ creators: null }] },
    { associations: [{ creators: { id: 'invalid', username: 'fixture_creator' } }] },
    { associations: [{ creators: { id: creatorId, username: 'bad username' } }] },
    { associations: [{ creators: { id: creatorId, username: 'fixture_creator' } },
      { creators: { id: stranger, username: 'other_creator' } }] },
  ])(
    'requires one readable valid creator association before provider transport: %j', async ({ associations }) => {
      links = associations;
      const response = await handler(request());
      expect(response.status).toBe(503); await result(response);
      expect(calls(providerOrigin)).toHaveLength(0);
    },
  );

  it.each(['APIFY_API_TOKEN', 'APIFY_ACCOUNT_ID', 'SUPABASE_SERVICE_ROLE_KEY'])('fails closed without %s', async name => {
    delete values[name];
    const response = await handler(request());
    expect(response.status).toBe(503); await result(response);
    expect(calls(providerOrigin)).toHaveLength(0);
  });

  it.each(['http://fixture.supabase.co', 'https://other.test', 'https://fixture.supabase.co:8443',
    'https://user:password@fixture.supabase.co', 'https://fixture.supabase.co/path',
    'https://fixture.supabase.co?token=private', 'https://fixture.supabase.co#fragment']) (
    'rejects an untrusted database/callback base before transport: %s', async base => {
      values.SUPABASE_URL = base;
      const response = await handler(request());
      expect(response.status).toBe(503); await result(response);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('returns only allowlisted evidence from an exact callback nonce and run condition', async () => {
    details['fixture-run'] = run('fixture-run', { headersTemplate: secrets[3], payloadTemplate: secrets[4],
      env: { APIFY_API_TOKEN: secrets[0] }, errorMessage: secrets[0], requestUrl: 'https://private.test' });
    const body = await audit();
    expect(body).toEqual({ job_id: jobId, read_only: true, run_list_complete: true, webhook_list_complete: true,
      candidates: [{ run_id: 'fixture-run', status: 'SUCCEEDED', started_at: startedAt,
        finished_at: '2026-11-13T12:03:00.000Z', usage_total_usd: .00005, exact_webhook_match: true }],
      reason: 'exact_run_match', no_start_proven: false });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v2/acts/${actorId}/runs`, '/v2/webhooks', '/v2/actor-runs/fixture-run',
    ]);
  });

  it.each([
    `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${stranger}`,
    `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${stranger}&dispatch_nonce=${nonce}`,
    `https://fixture.supabase.co.evil.test/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}`,
    `https://foreign.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}`,
    `http://fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}`,
    `https://user:password@fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}`,
    `https://fixture.supabase.co/functions/v1/apify-webhook/extra?job_id=${jobId}&dispatch_nonce=${nonce}`,
    `https://fixture.supabase.co/functions/v1/other-webhook?job_id=${jobId}&dispatch_nonce=${nonce}`,
    `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}#fragment`,
    `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&job_id=${stranger}&dispatch_nonce=${nonce}`,
    `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${nonce}&dispatch_nonce=${stranger}`,
    `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${jobId}`,
  ])('does not correlate a callback with mismatched host/path/job/nonce: %s', async requestUrl => {
    webhookPages = [[webhook({ requestUrl })]];
    const body = await audit();
    expect(body.reason).toBe('no_exact_run_match');
    expect(body.candidates).toMatchObject([{ run_id: 'fixture-run', exact_webhook_match: false }]);
  });

  it.each([undefined, null, [], 'fixture-run', {}, { actorId }].map(condition => ({ condition })))(
    'requires the verified condition.actorRunId rather than inferring from timing: %j', async ({ condition }) => {
      webhookPages = [[webhook({ condition, eventData: { actorRunId: 'fixture-run' } })]];
      const body = await audit();
      expect(body.reason).toBe('no_exact_run_match');
      expect(body.candidates[0].exact_webhook_match).toBe(false);
    },
  );

  it('does not fetch a time-window run when the exact callback condition references a different run', async () => {
    webhookPages = [[webhook({ condition: { actorRunId: 'foreign-run' }, eventData: { actorRunId: 'fixture-run' } })]];
    const body = await audit();
    expect(body).toMatchObject({ reason: 'no_exact_run_match', candidates: [], no_start_proven: false });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v2/acts/${actorId}/runs`, '/v2/webhooks',
    ]);
  });

  it.each([
    { id: 'foreign-run' }, { actId: 'foreign-actor' }, { userId: 'foreign-account' },
    { status: secrets[0] }, { startedAt: 'invalid' }, { startedAt: '2026-11-13T12:05:00.001Z' },
    { startedAt: '2026-11-13T11:54:59.999Z' },
  ])('does not accept run detail identity/schema mismatches even with the exact callback: %j', async patch => {
    details['fixture-run'] = run('fixture-run', patch);
    const body = await audit();
    expect(body.reason).toBe('no_exact_run_match');
    expect(body.candidates).toEqual([]);
  });

  it.each(['2026-11-13T11:55:00.000Z', '2026-11-13T12:05:00.000Z'])(
    'accepts candidates on the inclusive five-minute boundary: %s', async time => {
      runPages = [[run('fixture-run', { startedAt: time })]];
      details['fixture-run'] = run('fixture-run', { startedAt: time });
      const body = await audit();
      expect(body.reason).toBe('exact_run_match');
      expect(body.candidates[0].started_at).toBe(time);
    },
  );

  it('filters invalid IDs, invalid timestamps and out-of-window runs before detail GETs', async () => {
    runPages = [[run('../private'), run('invalid-time', { startedAt: 'invalid' }),
      run('too-early', { startedAt: '2026-11-13T11:54:59.999Z' }),
      run('too-late', { startedAt: '2026-11-13T12:05:00.001Z' }), run()]];
    const body = await audit();
    expect(body.candidates).toHaveLength(1);
    expect(calls(providerOrigin).filter(([url]) => new URL(String(url)).pathname.startsWith('/v2/actor-runs/'))).toHaveLength(1);
  });

  it.each([undefined, null, -1, '0.1', { price: .1 }])(
    'keeps authoritative cost unknown instead of inferring usage from other billing fields: %j', async usage => {
      details['fixture-run'] = run('fixture-run', { usageTotalUsd: usage, usageUsd: { total: .25 },
        pricingInfo: { pricePerUnit: .01 }, chargedEventCounts: { item: 100 } });
      const body = await audit();
      expect(body.candidates[0].usage_total_usd).toBeNull();
    },
  );

  it('preserves a verified zero charge and sanitizes invalid finishedAt instead of returning arbitrary data', async () => {
    details['fixture-run'] = run('fixture-run', { usageTotalUsd: 0, finishedAt: secrets[0] });
    const body = await audit();
    expect(body.candidates[0]).toMatchObject({ usage_total_usd: 0, finished_at: null, exact_webhook_match: true });
  });

  it('never claims a no-start proof when both bounded lists are empty', async () => {
    runPages = [[]]; webhookPages = [[]];
    const body = await audit();
    expect(body).toMatchObject({ candidates: [], reason: 'no_exact_run_match',
      run_list_complete: true, webhook_list_complete: true, no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(2);
  });

  it('rejects an overfull candidate window after bounded webhook reads when no exact callback exists', async () => {
    runPages = [Array.from({ length: 7 }, (_, index) => run(`fixture-run-${index}`))];
    webhookPages = [[webhook({ requestUrl: 'https://unrelated.test' })]];
    const body = await audit();
    expect(body).toMatchObject({ candidates: [], reason: 'candidate_window_exceeded',
      webhook_list_complete: true, no_start_proven: false });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v2/acts/${actorId}/runs`, '/v2/webhooks',
    ]);
  });

  it('narrows more than six time-window candidates to the exact webhook condition before any detail reads', async () => {
    const unrelated = Array.from({ length: 7 }, (_, index) => run(`fixture-run-${index}`));
    runPages = [[...unrelated.slice(0, 3), run(), ...unrelated.slice(3)]];
    webhookPages = [[webhook(), ...unrelated.map(candidate => webhook({
      id: `unrelated-webhook-${String(candidate.id)}`, condition: { actorRunId: candidate.id },
      requestUrl: `${databaseOrigin}/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${stranger}`,
    }))]];
    const body = await audit();
    expect(body).toMatchObject({ reason: 'exact_run_match', run_list_complete: true,
      webhook_list_complete: true, no_start_proven: false });
    expect(body.candidates).toEqual([{ run_id: 'fixture-run', status: 'SUCCEEDED', started_at: startedAt,
      finished_at: '2026-11-13T12:03:00.000Z', usage_total_usd: .00005, exact_webhook_match: true }]);
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v2/acts/${actorId}/runs`, '/v2/webhooks', '/v2/actor-runs/fixture-run',
    ]);
  });

  it('does not collapse multiple exact-correlated runs into a single recovery recommendation', async () => {
    runPages = [[run(), run('second-run')]];
    details['second-run'] = run('second-run');
    webhookPages = [[webhook(), webhook({ id: 'second-webhook', condition: { actorRunId: 'second-run' } })]];
    const body = await audit();
    expect(body.reason).toBe('no_exact_run_match');
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates.every(candidate => candidate.exact_webhook_match)).toBe(true);
  });

  it('reads a second bounded page at offset 100 and stops at the short page', async () => {
    runPages = [Array.from({ length: 100 }, (_, index) => run(`old-${index}`, { startedAt: '2026-11-13T11:00:00.000Z' })), [run()]];
    webhookPages = [Array.from({ length: 100 }, (_, index) => webhook({ id: `other-${index}`, requestUrl: 'https://unrelated.test' })), [webhook()]];
    const body = await audit();
    expect(body).toMatchObject({ run_list_complete: true, webhook_list_complete: true, reason: 'exact_run_match' });
    for (const path of [`/v2/acts/${actorId}/runs`, '/v2/webhooks']) {
      expect(calls(providerOrigin, path).map(([url]) => new URL(String(url)).searchParams.get('offset'))).toEqual(['0', '100']);
    }
  });

  it('caps both provider listings at three hundred records and reports incomplete evidence without a no-start proof', async () => {
    runPages = Array.from({ length: 3 }, (_, page) => Array.from({ length: 100 }, (_, index) =>
      run(`old-${page}-${index}`, { startedAt: '2026-11-13T11:00:00.000Z' })));
    webhookPages = Array.from({ length: 3 }, (_, page) => Array.from({ length: 100 }, (_, index) =>
      webhook({ id: `unrelated-${page}-${index}`, requestUrl: 'https://unrelated.test' })));
    const body = await audit();
    expect(body).toMatchObject({ candidates: [], reason: 'no_exact_run_match',
      run_list_complete: false, webhook_list_complete: false, no_start_proven: false });
    for (const path of [`/v2/acts/${actorId}/runs`, '/v2/webhooks']) {
      expect(calls(providerOrigin, path).map(([url]) => new URL(String(url)).searchParams.get('offset'))).toEqual(['0', '100', '200']);
    }
    expect(calls(providerOrigin)).toHaveLength(6);
  });

  it.each([`/v2/acts/${actorId}/runs`, '/v2/webhooks', '/v2/actor-runs/fixture-run'])(
    'returns sanitized unknown evidence for an inaccessible endpoint: %s', async path => {
      providerFailure = { path, status: 403 };
      const response = await handler(request());
      expect(response.status).toBe(503);
      expect(await result(response)).toEqual({ error: 'audit_unavailable', read_only: true, no_start_proven: false });
    },
  );

  it('never returns or logs tokens from a raw provider transport failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    providerFailure = { path: '/v2/webhooks', error: `${secrets[0]} ${secrets[3]} ${secrets[4]}` };
    const response = await handler(request());
    expect(response.status).toBe(503); await result(response);
    expect(log).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  });

  it('allows the renewed diagnostic until the new expiry without opting into receipt reads', async () => {
    vi.setSystemTime(new Date('2026-11-14T23:59:59.999Z'));
    const body = await audit();
    expect(body.reason).toBe('exact_run_match');
    expect(body).not.toHaveProperty('receipt_offset');
    expect(calls(providerOrigin, '/v2/webhook-dispatches')).toHaveLength(0);
  });

  it.each([-100, 1, 99, 10001, 10100, 100.5, '100', null, true, [], {}])(
    'rejects invalid explicit receipt offsets before any transport: %j', async receipt_offset => {
      const response = await handler(request({ job_id: jobId, receipt_offset }));
      expect(response.status).toBe(400); await result(response);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([{ job_id: stranger, receipt_offset: 300 }, { job_id: jobId, receipt_offset: 300, owner_user_id: owner },
    { job_id: jobId, receipt_offset: 300, action: 'start' }])('retains the fixed job and body allowlist in receipt mode: %j', async input => {
    const response = await handler(request(input));
    expect(response.status).toBe(400); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('authenticates receipt mode before every database/provider read', async () => {
    const response = await handler(request({ job_id: jobId, receipt_offset: 300 }, secrets[0]));
    expect(response.status).toBe(401); await result(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ owner_user_id: stranger }, { expected_provider_user_id: 'foreign-account' }, { actor_run_id: 'attached-run' }])(
    'retains saved job authorization and eligibility in receipt mode: %j', async patch => {
      jobs = [job(patch)];
      const response = await handler(request({ job_id: jobId, receipt_offset: 300 }));
      expect(response.status).toBe(409); await result(response);
      expect(calls(providerOrigin)).toHaveLength(0);
    },
  );

  it('confirms an exact historical receipt and authoritative run directly without approximate/global listings', async () => {
    runPages = [[]]; webhookPages = [[]];
    receiptPages = { 300: [receipt({ raw: secrets[4] })] };
    receiptDetails['fixture-receipt'] = receipt({ headersTemplate: secrets[3], raw: secrets[4] });
    details['fixture-run'] = run('fixture-run', { env: { APIFY_API_TOKEN: secrets[0] } });
    const body = await audit(300);
    expect(body).toEqual({ job_id: jobId, read_only: true, run_list_complete: false, webhook_list_complete: false,
      receipt_offset: 300, receipt_scanned_count: 1, receipt_list_complete: true,
      receipt_window: { oldest_at: '2026-11-13T12:03:01.000Z', newest_at: '2026-11-13T12:03:01.000Z' }, next_receipt_offset: null,
      candidates: [{ run_id: 'fixture-run', status: 'SUCCEEDED', started_at: startedAt,
        finished_at: '2026-11-13T12:03:00.000Z', usage_total_usd: .00005, exact_webhook_match: true }],
      reason: 'exact_run_match', no_start_proven: false });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v2/webhook-dispatches', '/v2/webhook-dispatches/fixture-receipt', '/v2/actor-runs/fixture-run',
    ]);
    expect(calls(databaseOrigin)).toHaveLength(2);
  });

  it.each([
    { id: '../private' }, { userId: 'foreign-account' }, { createdAt: secrets[4] },
    { eventType: 'TEST' }, { eventType: 'ACTOR.RUN.TEST' }, { eventType: 'ACTOR.RUN.CREATED' },
    { eventData: null }, { eventData: [] }, { eventData: { actorRunId: 'fixture-run' } },
    { eventData: { actorId: 'foreign-actor', actorRunId: 'fixture-run' } },
    { eventData: { actorId, actorRunId: '../private' } }, { webhook: null }, { webhook: [] },
    { webhook: webhook({ actionType: 'EMAIL' }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorRunId: 'foreign-run' } }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorId: 'foreign-actor', actorRunId: 'fixture-run' } }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', requestUrl: 'https://foreign.test' }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', requestUrl: `${databaseOrigin}/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${stranger}` }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', requestUrl: `${databaseOrigin}/functions/v1/apify-webhook?job_id=${stranger}&dispatch_nonce=${nonce}` }) },
  ])('rejects a mismatched or TEST receipt before receipt/run detail reads: %j', async patch => {
    receiptPages = { 0: [receipt(patch)] };
    const body = await audit(0);
    expect(body).toMatchObject({ reason: 'no_exact_run_match', candidates: [], no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(1);
  });

  it('never combines a callback nonce from one receipt with another receipt run identity', async () => {
    receiptPages = { 0: [receipt({ eventData: { actorId: 'foreign-actor', actorRunId: 'foreign-run' } }),
      receipt({ id: 'other-receipt', webhook: webhook({ actionType: 'HTTP_REQUEST', requestUrl: 'https://foreign.test' }) })] };
    const body = await audit(0);
    expect(body).toMatchObject({ reason: 'no_exact_run_match', candidates: [] });
    expect(calls(providerOrigin)).toHaveLength(1);
  });

  it.each([
    { id: 'foreign-receipt' }, { userId: 'foreign-account' }, { eventType: 'TEST' },
    { eventType: 'ACTOR.RUN.FAILED' }, { createdAt: '2026-11-13T12:04:00.000Z' },
    { eventData: { actorId: 'foreign-actor', actorRunId: 'fixture-run' } },
    { eventData: { actorId, actorRunId: 'foreign-run' }, webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorRunId: 'foreign-run' } }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorRunId: 'foreign-run' } }) },
    { webhook: webhook({ actionType: 'HTTP_REQUEST', requestUrl: `${databaseOrigin}/functions/v1/apify-webhook?job_id=${jobId}&dispatch_nonce=${stranger}` }) },
  ])('requires the matching dispatch detail to re-confirm exact receipt identity and correlation: %j', async patch => {
    receiptDetails['fixture-receipt'] = receipt(patch);
    const body = await audit(0);
    expect(body).toMatchObject({ reason: 'no_exact_run_match', candidates: [] });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v2/webhook-dispatches', '/v2/webhook-dispatches/fixture-receipt',
    ]);
  });

  it.each([
    { id: 'foreign-run' }, { actId: 'foreign-actor' }, { userId: 'foreign-account' },
    { status: secrets[0] }, { startedAt: 'invalid' }, { startedAt: '2026-11-13T12:05:00.001Z' },
    { startedAt: '2026-11-13T11:54:59.999Z' },
  ])('requires authoritative saved run actor/account/status/time despite an exact receipt: %j', async patch => {
    details['fixture-run'] = run('fixture-run', patch);
    const body = await audit(0);
    expect(body).toMatchObject({ reason: 'no_exact_run_match', candidates: [], no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(3);
  });

  it.each(['2026-11-13T11:55:00.000Z', '2026-11-13T12:05:00.000Z'])(
    'retains the inclusive saved-job five-minute boundary in receipt mode: %s', async time => {
      details['fixture-run'] = run('fixture-run', { startedAt: time });
      const body = await audit(0);
      expect(body.reason).toBe('exact_run_match');
      expect(body.candidates[0].started_at).toBe(time);
    },
  );

  it('allows an actor-level webhook condition only when it does not contradict the receipt actor/run', async () => {
    const matching = receipt({ webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorId } }) });
    receiptPages = { 0: [matching] }; receiptDetails['fixture-receipt'] = matching;
    expect((await audit(0)).reason).toBe('exact_run_match');
  });

  it('accepts nullable condition IDs while requiring exact eventData actor/run and authoritative details', async () => {
    const matching = receipt({ webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorId: null, actorRunId: null } }) });
    receiptPages = { 0: [matching] }; receiptDetails['fixture-receipt'] = matching;
    const body = await audit(0);
    expect(body).toMatchObject({ reason: 'exact_run_match', no_start_proven: false,
      candidates: [{ run_id: 'fixture-run', exact_webhook_match: true }] });
    expect(calls(providerOrigin).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v2/webhook-dispatches', '/v2/webhook-dispatches/fixture-receipt', '/v2/actor-runs/fixture-run',
    ]);
  });

  it.each([{ actorId: null, actorRunId: null }, { actorId: 'foreign-actor', actorRunId: 'fixture-run' }])(
    'rejects non-exact eventData even when both condition IDs are null: %j', async eventData => {
      receiptPages = { 0: [receipt({ eventData, webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorId: null, actorRunId: null } }) })] };
      const body = await audit(0);
      expect(body).toMatchObject({ reason: 'no_exact_run_match', candidates: [] });
      expect(calls(providerOrigin)).toHaveLength(1);
    },
  );

  it.each([undefined, null, -1, '0', { price: .1 }])(
    'keeps receipt-recovered cost unknown without authoritative usageTotalUsd: %j', async usageTotalUsd => {
      details['fixture-run'] = run('fixture-run', { usageTotalUsd, chargedEventCounts: { item: 100 }, usageUsd: { total: .25 } });
      const body = await audit(0);
      expect(body.candidates[0].usage_total_usd).toBeNull();
    },
  );

  it('preserves authoritative zero cost without treating the receipt as a no-start proof', async () => {
    details['fixture-run'] = run('fixture-run', { usageTotalUsd: 0, finishedAt: secrets[4] });
    const body = await audit(0);
    expect(body.candidates[0]).toMatchObject({ usage_total_usd: 0, finished_at: null });
    expect(body.no_start_proven).toBe(false);
  });

  it('requires each matching receipt detail and deduplicates repeated receipts for one authoritative run', async () => {
    const other = receipt({ id: 'second-receipt', eventType: 'ACTOR.RUN.FAILED' });
    receiptPages = { 0: [receipt(), other] }; receiptDetails['second-receipt'] = other;
    const body = await audit(0);
    expect(body.reason).toBe('exact_run_match');
    expect(body.candidates).toHaveLength(1);
    expect(calls(providerOrigin, '/v2/webhook-dispatches/second-receipt')).toHaveLength(1);
    expect(calls(providerOrigin, '/v2/actor-runs/fixture-run')).toHaveLength(1);
  });

  it('does not recommend one run when multiple distinct exact receipts confirm different runs', async () => {
    const second = receipt({ id: 'second-receipt', eventData: { actorId, actorRunId: 'second-run' },
      webhook: webhook({ actionType: 'HTTP_REQUEST', condition: { actorRunId: 'second-run' } }) });
    receiptPages = { 0: [receipt(), second] }; receiptDetails['second-receipt'] = second;
    details['second-run'] = run('second-run');
    const body = await audit(0);
    expect(body.reason).toBe('no_exact_run_match'); expect(body.candidates).toHaveLength(2);
  });

  it('refuses more than six matching receipts before any detail GETs', async () => {
    receiptPages = { 0: Array.from({ length: 7 }, (_, index) => receipt({ id: `matching-${index}` })) };
    const body = await audit(0);
    expect(body).toMatchObject({ candidates: [], reason: 'candidate_window_exceeded', receipt_scanned_count: 7, no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(1);
  });

  it('scans from an explicit historical offset and stops on a short second page', async () => {
    receiptPages = { 700: Array.from({ length: 100 }, (_, index) => receipt({ id: `unrelated-${index}`, eventType: 'TEST' })), 800: [receipt()] };
    const body = await audit(700);
    expect(body).toMatchObject({ receipt_scanned_count: 101, receipt_list_complete: true, next_receipt_offset: null, reason: 'exact_run_match' });
    expect(calls(providerOrigin, '/v2/webhook-dispatches').map(([url]) => new URL(String(url)).searchParams.get('offset'))).toEqual(['700', '800']);
  });

  it('returns only sanitized oldest/newest receipt timestamps, three-page count and an explicit continuation', async () => {
    receiptPages = Object.fromEntries([300, 400, 500].map((offset, page) => [offset,
      Array.from({ length: 100 }, (_, index) => receipt({ id: `unrelated-${offset}-${index}`, eventType: 'TEST',
        createdAt: index === 0 ? secrets[4] : ['2026-11-13T15:00:00+01:00', '2026-11-13T12:00:00Z', '2026-11-13T11:00:00Z'][page] }))]));
    const body = await audit(300);
    expect(body).toMatchObject({ candidates: [], receipt_offset: 300, receipt_scanned_count: 300,
      receipt_list_complete: false, next_receipt_offset: 600,
      receipt_window: { oldest_at: '2026-11-13T11:00:00.000Z', newest_at: '2026-11-13T14:00:00.000Z' }, no_start_proven: false });
    expect(calls(providerOrigin, '/v2/webhook-dispatches').map(([url]) => new URL(String(url)).searchParams.get('offset'))).toEqual(['300', '400', '500']);
    expect(calls(providerOrigin)).toHaveLength(3);
  });

  it('allows the maximum supplied offset but never returns an out-of-range continuation', async () => {
    receiptPages = Object.fromEntries([10000, 10100, 10200].map(offset => [offset,
      Array.from({ length: 100 }, (_, index) => receipt({ id: `unrelated-${offset}-${index}`, eventType: 'TEST' }))]));
    const body = await audit(10000);
    expect(body).toMatchObject({ receipt_offset: 10000, receipt_scanned_count: 300, receipt_list_complete: false, next_receipt_offset: null, no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(3);
  });

  it('never treats an empty historical window as a no-start proof or falls back to approximate listings', async () => {
    receiptPages = {};
    const body = await audit(300);
    expect(body).toMatchObject({ candidates: [], receipt_scanned_count: 0, receipt_list_complete: true,
      next_receipt_offset: null, receipt_window: { oldest_at: null, newest_at: null }, no_start_proven: false });
    expect(calls(providerOrigin)).toHaveLength(1);
  });

  it.each(['/v2/webhook-dispatches', '/v2/webhook-dispatches/fixture-receipt', '/v2/actor-runs/fixture-run'])(
    'returns sanitized unknown evidence for unavailable receipt/run reads: %s', async path => {
      providerFailure = { path, status: 403 };
      const response = await handler(request({ job_id: jobId, receipt_offset: 0 }));
      expect(response.status).toBe(503);
      expect(await result(response)).toEqual({ error: 'audit_unavailable', read_only: true, no_start_proven: false });
    },
  );

  it.each([{ data: { items: {} } }, { data: { items: Array(101).fill({}) } }, { data: { items: [null] } }])(
    'rejects malformed/oversized receipt list pages rather than interpreting them as absence: %j', async payload => {
      providerFailure = { path: '/v2/webhook-dispatches', status: 200, body: payload };
      const response = await handler(request({ job_id: jobId, receipt_offset: 0 }));
      expect(response.status).toBe(503);
      expect(await result(response)).toMatchObject({ read_only: true, no_start_proven: false });
    },
  );

  it('enforces the provider response byte cap in receipt mode without leaking raw content', async () => {
    providerFailure = { path: '/v2/webhook-dispatches', status: 200, body: { data: { items: [] }, raw: secrets[4] + 'x'.repeat(1024 * 1024) } };
    const response = await handler(request({ job_id: jobId, receipt_offset: 0 }));
    expect(response.status).toBe(503);
    expect(await result(response)).toEqual({ error: 'audit_unavailable', read_only: true, no_start_proven: false });
  });

  it.each([`/v2/acts/${actorId}/runs`, '/v2/webhooks'])(
    'rejects a malformed list page rather than interpreting it as absence: %s', async path => {
      providerFailure = { path, status: 200, body: { data: { items: { hidden: secrets[0] } } } };
      const response = await handler(request());
      expect(response.status).toBe(503);
      expect(await result(response)).toMatchObject({ read_only: true, no_start_proven: false });
    },
  );
});
