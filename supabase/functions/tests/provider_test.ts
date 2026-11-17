// Runtime instructions: deno test supabase/functions/tests/provider_test.ts
import { metric, normalizeReel, timestampBasis, zonedTimestamp } from '../_shared/model.ts';
import { apifyRead, ApifyProfiles, ApifyReels, authoritativeUsage, liveMode, MockProfiles, MockReels, parseAccountUsage, provider, reconcileOutput, validateDispatchSetup } from '../_shared/providers.ts';
import { authenticate, continuationBudget, processJob, rows, rpc, wakeReconciliation } from '../_shared/worker.ts';
import type { Context } from '../_shared/model.ts';
function equal(actual: unknown, expected: unknown) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function rejectsSync(action: () => unknown) { let rejected = false; try { action(); } catch { rejected = true; } equal(rejected, true); }
async function withEnvironment(values: Record<string, string | undefined>, action: () => unknown | Promise<unknown>) {
  // Stub reads rather than requiring env permission or reading the operator's credentials.
  const original = Deno.env.get;
  Deno.env.get = (name: string) => values[name];
  try { await action(); } finally { Deno.env.get = original; }
}
const mockEnvironment = { PROVIDER_MODE: 'mock', ENVIRONMENT: 'test', SUPABASE_URL: 'http://127.0.0.1:54321' };
const context = { job: { id: 'job', started_at: '2026-11-08T00:00:00Z', dataset_cursor: 0 }, creators: [{ id: 'creator', username: 'example' }] } as Context;
Deno.test('negative, hidden and missing metrics never become zero', () => {
  equal(metric(-1), { value: null, state: 'hidden' }); equal(metric(-2), { value: null, state: 'unavailable' });
  equal(metric(undefined), { value: null, state: 'not_fetched' }); equal(metric(0), { value: 0, state: 'known' }); equal(metric('100'), { value: null, state: 'unavailable' });
});
Deno.test('normalize canonical URL and reject mismatched creator', () => {
  const sample = { ownerUsername: 'example', url: 'https://www.instagram.com/reel/ABC_123/', timestamp: '2026-11-01T00:00:00Z', videoPlayCount: 100, likesCount: -1, commentsCount: 0 };
  const result = normalizeReel(sample, context, 'test').record!;
  equal(result.shortcode, 'ABC_123'); equal(result.likes, null); equal(result.likes_state, 'hidden'); equal(result.comments, 0);
  let rejected = false; try { normalizeReel({ ...sample, ownerUsername: 'other' }, context, 'test'); } catch { rejected = true; } equal(rejected, true);
  equal(Boolean(normalizeReel({ ...sample, url: null }, context, 'test').error), true);
});
Deno.test('mock providers perform zero external fetches', async () => {
  await withEnvironment(mockEnvironment, async () => {
    const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('Unexpected network call'); };
    try {
      equal(liveMode(), false);
      for (const adapter of [new MockReels(), new MockProfiles()]) {
        const run = await adapter.start(context, 0); equal(run.usageTotalUsd, 0);
        const page = await adapter.page(context, 100); equal(page.finished, true); equal(page.items.length, 1);
        const record = adapter.normalize(page.items[0], context).record;
        equal(Boolean(record), true);
        if (adapter.kind === 'reel') equal(record?.reel_url, null);
      }
    } finally { globalThis.fetch = original; }
  });
});
Deno.test('missing or invalid provider mode never falls back to mocks', async () => {
  for (const PROVIDER_MODE of [undefined, '', 'typo', 'APIFY']) {
    await withEnvironment({ ...mockEnvironment, PROVIDER_MODE }, () => {
      rejectsSync(() => liveMode()); rejectsSync(() => provider('manual'));
      rejectsSync(() => provider('manual', false)); rejectsSync(() => new MockProfiles());
    });
  }
});
Deno.test('mocks reject hosted URLs, hosted markers and non-test environments', async () => {
  const overrides = [
    { ENVIRONMENT: undefined }, { ENVIRONMENT: 'production' },
    { SB_REGION: 'local-but-hosted' }, { DENO_DEPLOYMENT_ID: 'deployment' }, { SB_REGION: '' },
    { SUPABASE_URL: 'https://project.supabase.co' },
    { SUPABASE_URL: undefined }, { SUPABASE_URL: 'http://127.0.0.1.evil.invalid' },
    { SUPABASE_URL: 'http://user:password@localhost:54321' },
  ];
  for (const override of overrides) await withEnvironment({ ...mockEnvironment, ...override }, () => {
    rejectsSync(() => liveMode()); rejectsSync(() => provider('manual', false));
    rejectsSync(() => new MockReels()); rejectsSync(() => new MockProfiles());
  });
  await withEnvironment({ ...mockEnvironment, ENVIRONMENT: 'local', SUPABASE_URL: 'http://localhost:54321' }, () => equal(liveMode(), false));
  await withEnvironment({ ...mockEnvironment, SUPABASE_URL: 'http://[::1]:54321' }, () => equal(liveMode(), false));
  await withEnvironment({ PROVIDER_MODE: 'apify', SB_REGION: 'us-east-1', SUPABASE_URL: 'https://project.supabase.co' }, () => {
    equal(liveMode(), true); rejectsSync(() => provider('manual', false));
  });
});
Deno.test('hosted mock runtime is rejected before database network calls', async () => {
  await withEnvironment({ ...mockEnvironment, SUPABASE_URL: 'https://project.supabase.co' }, async () => {
    const original = globalThis.fetch;
    let calls = 0; globalThis.fetch = () => { calls++; throw new Error('Unexpected network call'); };
    try {
      for (const action of [() => rpc('worker_schedule', {}), () => rows('scrape_jobs', '')]) {
        let rejected = false; try { await action(); } catch { rejected = true; } equal(rejected, true);
      }
      equal(calls, 0);
    } finally { globalThis.fetch = original; }
  });
});
Deno.test('compound media IDs preserved and unzoned publish time retained without guessing UTC', () => {
  const sample = { ownerUsername: 'example', id: '123456_987654', url: 'https://www.instagram.com/reel/ABC_123/', timestamp: '2026-11-01T00:00:00+02:00' };
  equal(normalizeReel(sample, context, 'test').record?.instagram_media_id, '123456_987654');
  equal(normalizeReel(sample, context, 'test').record?.published_at, '2026-10-31T22:00:00.000Z');
  const accepted = normalizeReel({ ...sample, timestamp: '2026-08-10T20:06:13' }, context, 'test');
  equal(accepted.error, undefined); equal(accepted.record?.published_at, '2026-08-10T14:36:13.000Z');
  equal(accepted.record?.published_at_raw, '2026-08-10T20:06:13'); equal(accepted.record?.published_at_basis, 'assumed_Asia/Kolkata');
  equal(timestampBasis('2026-08-10T20:06:13'), 'timezone_unverified');
  equal(zonedTimestamp('2026-02-30T00:00:00Z'), null);
});
Deno.test('official account identity plus limits validates current cycle without inventing balance', async () => {
  const me = { data: { id: 'actual-user', plan: { tier: 'FREE', monthlyUsageCreditsUsd: 5 }, email: 'never-return@example.test' } };
  const limits = { data: { monthlyUsageCycle: { startAt: '2026-10-20T00:00:00Z', endAt: '2026-11-20T00:00:00Z' }, current: { monthlyUsageUsd: 0.02 }, limits: { maxMonthlyUsageUsd: 5 } } };
  await withEnvironment({ APIFY_API_TOKEN: 'fixture-token' }, async () => {
    equal(parseAccountUsage(me, limits, Date.parse('2026-11-08T00:00:00Z')), { userId: 'actual-user', cycleStart: '2026-10-20T00:00:00.000Z', cycleEnd: '2026-11-20T00:00:00.000Z', usageUsd: 0.02, limitUsd: 5, plan: { tier: 'FREE', monthlyUsageCreditsUsd: 5 } });
    rejectsSync(() => parseAccountUsage(me, limits, Date.parse('2026-11-21T00:00:00Z')));
    for (const bad of [null, '0.02', -1, Infinity]) rejectsSync(() => parseAccountUsage(me, { data: { ...limits.data, current: { monthlyUsageUsd: bad } } }, Date.parse('2026-11-08T00:00:00Z')));
    const original = globalThis.fetch, paths: string[] = [];
    globalThis.fetch = async (url) => { paths.push(String(url)); return Response.json(paths.length === 1 ? me : limits); };
    try { equal((await authoritativeUsage()).userId, 'actual-user'); equal(paths, ['https://api.apify.com/v2/users/me', 'https://api.apify.com/v2/users/me/limits']); }
    finally { globalThis.fetch = original; }
  });
  await withEnvironment({ APIFY_ACCOUNT_ID: 'actor-publisher-not-user' }, () => rejectsSync(() => parseAccountUsage(me, limits, Date.parse('2026-11-08T00:00:00Z'))));
});
Deno.test('reels accepts 10 through 100 and excludes pinned; profile minimal input matches schema', async () => {
  await withEnvironment({ APIFY_REEL_ACTOR_RESOURCE_ID: 'reels', APIFY_PROFILE_ACTOR_RESOURCE_ID: 'profiles', PROFILE_PROVIDER_VALIDATED: 'true' }, () => {
    const reels = new ApifyReels();
    for (const limit of [10, 100]) { const input = reels.input({ ...context, job: { ...context.job, results_limit: limit } }); equal(input.resultsLimit, limit); equal(input.skipPinnedPosts, true); equal(input.directUrls, ['example']); }
    for (const limit of [0, 5, 101, 10.1]) rejectsSync(() => reels.input({ ...context, job: { ...context.job, results_limit: limit } }));
    const input = new ApifyProfiles().input(context);
    equal(input.usernames, ['example']); equal(input.maxResults, 1); equal(input.includeLatestPosts, false); equal(input.includeReels, false); equal(input.includeContactDetails, false);
    equal('selectedFields' in input, false);
    equal(new ApifyProfiles().normalize({ username: 'example', followersCount: 100, fullName: 'Example' }, context).record?.followers_count, 100);
  });
});
Deno.test('OUTPUT fewer available is not failure; error row and missing summaries never false success', () => {
  const done = { ...context, job: { ...context.job, dataset_cursor: 4, results_limit: 100 } };
  equal(reconcileOutput({ ok: true, total_items: 4, users: [{ user: 'example', count: 4 }] }, done).complete, true);
  equal(reconcileOutput({ ok: true, total_items: 4, users: [{ user: 'example', count: 4, error: 'no_items' }] }, done).complete, false);
  equal(reconcileOutput({ ok: true, total_items: 4, users: [] }, done).complete, false);
  equal(reconcileOutput({ ok: true, total_items: 5, users: [{ user: 'example', count: 5 }] }, done).complete, false);
  equal(reconcileOutput({ ok: true, total_items: 4, users: [{ user: 'foreign', count: 4 }] }, done).complete, false);
  const error = normalizeReel({ ownerUsername: 'example', error: 'no_items' }, context, 'test');
  equal(Boolean(error.error), true); equal(error.record, undefined);
});
Deno.test('live flags default false and legacy cap compatibility does not bypass usage validation', async () => {
  const base = { PROVIDER_MODE: 'apify', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'actual-user', APIFY_REEL_ACTOR_RESOURCE_ID: 'reels', APIFY_WEBHOOK_SHARED_SECRET: 'fixture', SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', PAY_PER_EVENT_CAP_VALIDATED: 'true' };
  await withEnvironment(base, () => rejectsSync(validateDispatchSetup));
  await withEnvironment({ ...base, ACCOUNT_USAGE_VALIDATED: 'true' }, validateDispatchSetup);
  await withEnvironment({ ...base, ACCOUNT_USAGE_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'false' }, () => rejectsSync(validateDispatchSetup));
});
Deno.test('read retries bounded but start POST never retries uncertain acceptance', async () => {
  const original = globalThis.fetch;
  await withEnvironment({ APIFY_API_TOKEN: 'fixture' }, async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; if (calls === 1) throw new Error('transient network'); return Response.json({ data: {} }); };
    try { await apifyRead('/users/me'); equal(calls, 2); } finally { globalThis.fetch = original; }
  });
  const base = { PROVIDER_MODE: 'apify', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'actual-user', APIFY_REEL_ACTOR_RESOURCE_ID: 'reels', APIFY_WEBHOOK_SHARED_SECRET: 'fixture', SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true', SUPABASE_URL: 'http://127.0.0.1:54321' };
  await withEnvironment(base, async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/users/me')) return Response.json({ data: { id: 'actual-user' } });
      calls++; equal(init?.method, 'POST'); equal(new URL(String(url)).searchParams.get('maxTotalChargeUsd'), '0.1');
      const webhooks = JSON.parse(atob(new URL(String(url)).searchParams.get('webhooks')!));
      equal(webhooks[0].payloadTemplate, '{"run_id": {{resource.id}}}');
      return new Response('{}', { status: 500 });
    };
    try {
      let rejected = false;
      try { await new ApifyReels().start({ ...context, job: { ...context.job, results_limit: 100, reserved_usd: .1, expected_actor_id: 'reels', expected_provider_user_id: 'actual-user' } }, 0.1); } catch { rejected = true; }
      equal(rejected, true); equal(calls, 1);
    } finally { globalThis.fetch = original; }
  });
});
Deno.test('page ingestion records billable rows separately and persists OUTPUT before finish', async () => {
  await withEnvironment({ PROVIDER_MODE: 'apify', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'actual-user', APIFY_REEL_ACTOR_RESOURCE_ID: 'reels', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'fixture' }, async () => {
    const original = globalThis.fetch, calls: { name: string; args: Record<string, unknown> }[] = [];
    const job = { ...context.job, kind: 'backfill', live: true, dataset_id: 'dataset', actor_run_id: 'run', lease_token: 'lease', expected_actor_id: 'reels', expected_provider_user_id: 'actual-user' };
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/users/me') return Response.json({ data: { id: 'actual-user' } });
      if (path.includes('/rpc/')) {
        const name = path.split('/').at(-1)!; calls.push({ name, args: JSON.parse(String(init?.body)) });
        return Response.json(name === 'worker_claim_processing' ? { job, creators: context.creators } : {});
      }
      if (path.includes('/datasets/')) return Response.json([{ ownerUsername: 'example', error: 'no_items' }]);
      if (path.includes('/actor-runs/')) return Response.json({ data: { id: 'run', actId: 'reels', userId: 'actual-user', status: 'SUCCEEDED', defaultKeyValueStoreId: 'store' } });
      return Response.json({ ok: true, total_items: 1, users: [{ user: 'example', count: 1, error: 'no_items' }] });
    };
    try {
      equal(await processJob('job'), 'finished');
      equal(calls[1].args.p_received_counts, { creator: 1 }); equal(calls[1].args.p_records, []);
      equal(calls[2].name, 'worker_record_output_summary'); equal((calls[2].args.p_summary as { complete: boolean }).complete, false);
      equal(calls[3].name, 'worker_finish_processing');
    } finally { globalThis.fetch = original; }
  });
});
Deno.test('internal diagnostics requires POST secret and no continuation runs without runtime or budget', async () => {
  await withEnvironment({ INTERNAL_CRON_SECRET: 'fixture' }, async () => {
    equal(await authenticate(new Request('http://localhost', { method: 'POST', headers: { 'x-internal-secret': 'fixture' } })), true);
    equal(await authenticate(new Request('http://localhost', { method: 'POST' })), false);
    equal(await authenticate(new Request('http://localhost', { headers: { 'x-internal-secret': 'fixture' } })), false);
  });
  equal(continuationBudget({}), 4); equal(continuationBudget({ continuation_budget: 0 }), 0);
  for (const value of [5, -1, 1.5, '4']) rejectsSync(() => continuationBudget({ continuation_budget: value }));
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('No background network expected'); };
  try { wakeReconciliation(0); } finally { globalThis.fetch = original; }
});
Deno.test('diagnostics handler reads and stores safe usage with live gates disabled', async () => {
  const serve = Deno.serve; Deno.serve = (() => undefined) as unknown as typeof Deno.serve;
  let handler: (request: Request) => Promise<Response>;
  try { handler = (await import('../refresh-dispatch/index.ts')).handler; } finally { Deno.serve = serve; }
  const original = globalThis.fetch;
  const owner = 'a0000000-0000-4000-8000-000000000001';
  const values = { PROVIDER_MODE: 'apify', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', REELRADAR_OWNER_USER_ID: owner, INTERNAL_CRON_SECRET: 'fixture-internal', APIFY_API_TOKEN: 'fixture-provider', APIFY_ACCOUNT_ID: 'actual-user' };
  const request = () => new Request('http://127.0.0.1:54321/functions/v1/refresh-dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': 'fixture-internal' }, body: JSON.stringify({ action: 'diagnostics' }) });
  await withEnvironment({ ...values, APIFY_API_TOKEN: undefined }, async () => {
    globalThis.fetch = () => { throw new Error('No network allowed for missing configuration'); };
    const response = await handler(request()); equal(response.status, 503);
    equal(await response.json(), { error: 'diagnostics_configuration_missing', missingKeys: ['APIFY_API_TOKEN'] });
  });
  await withEnvironment(values, async () => {
    const calls: string[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) { equal(init?.method, 'POST'); return Response.json([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'actual-user', enabled: true, authorization_confirmed: true }]); }
      if (calls.length === 2) { equal(init?.method, 'POST'); equal(String(url).endsWith('/rpc/worker_begin_account_usage'), true); return Response.json({ observation_id: 'a0000000-0000-4000-8000-000000000002', observed_at: '2026-11-14T20:00:00.123456Z' }); }
      if (calls.length === 3) { equal(init?.method, undefined); return Response.json({ data: { id: 'actual-user', email: 'private-email', token: 'private-secret' } }); }
      if (calls.length === 4) { equal(init?.method, undefined); return Response.json({ data: { monthlyUsageCycle: { startAt: '2026-10-20T00:00:00Z', endAt: '2026-11-20T00:00:00Z' }, current: { monthlyUsageUsd: 0.01 }, limits: { maxMonthlyUsageUsd: 5 } } }); }
      equal(String(url).endsWith('/rpc/worker_record_usage'), true);
      equal(JSON.parse(String(init?.body)), { p_owner_user_id: owner, p_provider_user_id: 'actual-user', p_cycle_start_at: '2026-10-20T00:00:00.000Z', p_cycle_end_at: '2026-11-20T00:00:00.000Z', p_usage_usd: 0.01, p_limit_usd: 5, p_observation_id: 'a0000000-0000-4000-8000-000000000002', p_observed_at: '2026-11-14T20:00:00.123456Z' });
      return new Response('', { status: 200 });
    };
    const response = await handler(request()); equal(response.status, 200); const text = await response.text();
    equal(text.includes('private-email'), false); equal(text.includes('private-secret'), false); equal(text.includes('fixture-provider'), false);
    const output = JSON.parse(text).diagnostics; equal(output.userId, 'actual-user'); equal(output.balanceUsd, null); equal(output.gates.scrapingEnabled, false); equal(calls.length, 5);
  });
  globalThis.fetch = original;
});


