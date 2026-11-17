import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertDemoRequest, assertMutationOrigin, consumeLimit, demoEnabled, isLoopbackHost, supabaseConfig } from '../src/lib/server/security';
import { ApiError, publicError } from '../src/lib/server/errors';
import { parseReelQuery, readJson, settingsSchema, validate } from '../src/lib/server/validation';
import { csvCell, exportReelsCsv, parseCreatorCsv, previewCsv } from '../src/lib/server/csv';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { safeBootstrap, safeCreator, safeJob, safeReel, safeUsage } from '../src/lib/server/public-data';
import { scheduleDispatcherWake } from '../src/lib/server/dispatcher';

const env = { DEMO_MODE: 'true', NODE_ENV: 'development' };
const url = 'http://127.0.0.1:3000';

describe('backend request security', () => {
  it('requires explicit demo opt-in and production local opt-in', () => {
    expect(demoEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(demoEnabled({ DEMO_MODE: 'TRUE', NODE_ENV: 'development' })).toBe(false);
    expect(demoEnabled({ DEMO_MODE: 'true', NODE_ENV: 'test' })).toBe(false);
    expect(demoEnabled({ DEMO_MODE: 'true', NODE_ENV: 'production' })).toBe(false);
    expect(demoEnabled({ DEMO_MODE: 'true', ALLOW_LOCAL_DEMO: 'true', NODE_ENV: 'production' })).toBe(true);
  });
  it('accepts exact loopback hosts and refuses forwarding or remote hosts', () => {
    for (const host of ['localhost:3000', '127.0.0.1', '[::1]:3000']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['localhost.example.com', '127.0.0.2', '0.0.0.0', 'user@localhost', 'localhost/path', 'localhost?evil', 'localhost#evil', 'localhost:99999', 'localhost:3000,evil.test']) expect(isLoopbackHost(host)).toBe(false);
    expect(assertDemoRequest(new Request(`${url}/api/bootstrap`), env)).toBe(true);
    expect(() => assertDemoRequest(new Request('https://example.com/api/bootstrap'), env)).toThrow(ApiError);
    expect(() => assertDemoRequest(new Request(`${url}/api/bootstrap`, { headers: { 'x-forwarded-host': 'example.com' } }), env)).toThrow(ApiError);
  });
  it('rejects missing and foreign Origin for mutations', () => {
    expect(() => assertMutationOrigin(new Request(`${url}/api/settings`, { method: 'PATCH' }), env)).toThrow(ApiError);
    expect(() => assertMutationOrigin(new Request(`${url}/api/settings`, { method: 'PATCH', headers: { origin: 'https://evil.test' } }), env)).toThrow(ApiError);
    expect(() => assertMutationOrigin(new Request(`${url}/api/settings`, { method: 'PATCH', headers: { origin: url } }), env)).not.toThrow();
  });
  it('normalizes actual loopback Host instead of Next internal localhost URL', () => {
    const productionDemo = { DEMO_MODE: 'true', NODE_ENV: 'production', ALLOW_LOCAL_DEMO: 'true' };
    const request = (headers: Record<string, string>) => new Request('http://localhost:3000/api/workspaces/demo/saved', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: url, ...headers } });
    expect(() => assertMutationOrigin(request({}), productionDemo)).not.toThrow();
    expect(() => assertMutationOrigin(request({ 'x-forwarded-host': '127.0.0.1:3000' }), productionDemo)).not.toThrow();
    for (const headers of [
      { origin: 'http://localhost:3000' }, { origin: 'http://127.0.0.1:3001' }, { origin: 'https://evil.test' },
      { origin: 'http://127.0.0.1:3000/' }, { host: 'evil.test' }, { host: '127.0.0.1:3000?evil' },
      { 'x-forwarded-host': 'evil.test' }, { forwarded: 'host=127.0.0.1:3000' }, { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[]) expect(() => assertMutationOrigin(request(headers), productionDemo)).toThrow(ApiError);
  });
  it('uses only configured production origin and validated actual Host behind internal localhost', () => {
    const production = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.test' };
    const request = (headers: Record<string, string>) => new Request('http://localhost:3000/api/settings', { method: 'PATCH', headers: { host: 'app.test', origin: 'https://app.test', ...headers } });
    expect(() => assertMutationOrigin(request({}), production)).not.toThrow();
    expect(() => assertMutationOrigin(request({ 'x-forwarded-host': 'app.test', 'x-forwarded-proto': 'https' }), production)).not.toThrow();
    for (const headers of [
      { origin: 'http://app.test' }, { origin: 'https://evil.test' }, { host: 'evil.test' }, { host: 'app.test:444' },
      { host: 'app.test@evil.test' }, { host: 'app.test?evil' }, { host: 'localhost:3000', 'x-forwarded-host': 'app.test' },
      { 'x-forwarded-host': 'evil.test' }, { 'x-forwarded-host': 'app.test,evil.test' }, { 'x-forwarded-proto': 'http' },
      { forwarded: 'host=app.test' }, { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[]) expect(() => assertMutationOrigin(request(headers), production)).toThrow(ApiError);
    expect(() => assertMutationOrigin(request({}), { NODE_ENV: 'production' })).toThrow(ApiError);
    expect(() => assertMutationOrigin(request({}), { ...production, NEXT_PUBLIC_APP_URL: 'http://app.test' })).toThrow(ApiError);
  });
  it('accepts a single proxy hop only when all origin headers match the configured host', () => {
    const production = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.test' };
    for (const forwarded of ['for=192.0.2.1;host=app.test;proto=https', 'for="[2001:db8::1]:443"; host="app.test"; proto="https"']) {
      const headers = { host: 'app.test', origin: 'https://app.test', 'x-forwarded-host': 'app.test', 'x-forwarded-proto': 'https', forwarded };
      const request = new Request('http://localhost:3000/api/auth/login', { method: 'POST', headers });
      expect(() => assertMutationOrigin(request, production)).not.toThrow();
      for (const mismatch of [{ origin: 'https://evil.test' }, { host: 'evil.test' }, { 'x-forwarded-host': 'evil.test' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
        expect(() => assertMutationOrigin(new Request(request.url, { method: 'POST', headers: { ...headers, ...mismatch } }), production)).toThrow(ApiError);
      }
    }
  });
  it('rejects conflicting, incomplete, duplicated and chained Forwarded metadata', () => {
    const production = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.test' };
    for (const forwarded of ['', 'host=evil.test;proto=https', 'host=app.test;proto=http', 'for=192.0.2.1', 'host=app.test', 'host=app.test;host=evil.test;proto=https', 'host=app.test;proto=https;proto=http', 'host=app.test;proto=https,host=evil.test;proto=https', 'host="app.test;proto=https', 'host=app.test@evil.test;proto=https']) {
      const request = new Request('https://app.test/api/auth/login', { method: 'POST', headers: { host: 'app.test', origin: 'https://app.test', forwarded } });
      expect(() => assertMutationOrigin(request, production)).toThrow(ApiError);
    }
  });
  it('fails closed for missing owner and privileged Supabase key config', () => {
    expect(() => supabaseConfig({})).toThrow(ApiError);
    const config = { NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_secret_bad', OWNER_EMAIL: 'owner@example.com', OWNER_USER_ID: '11111111-1111-4111-8111-111111111111' };
    expect(() => supabaseConfig(config)).toThrow(ApiError);
    expect(supabaseConfig({ ...config, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_example' }).ownerEmail).toBe('owner@example.com');
  });
  it('throttles and resets request windows', () => {
    consumeLimit('test:throttle', 2, 1000, 100);
    consumeLimit('test:throttle', 2, 1000, 100);
    expect(() => consumeLimit('test:throttle', 2, 1000, 100)).toThrow(ApiError);
    expect(() => consumeLimit('test:throttle', 2, 1000, 1100)).not.toThrow();
  });
  it('never exposes unknown errors', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(JSON.stringify(publicError(new Error('secret-token')))).not.toContain('secret-token');
    log.mockRestore();
  });
});

describe('backend strict validation and safe CSV', () => {
  it('rejects unknown, repeated, negative and excessive query parameters', () => {
    for (const query of ['limit=51', 'page=10001', 'min_views=-1', 'min_views=1e3', 'saved=yes', 'sort=sql', 'secret=true', 'limit=2&limit=3', 'creator_id=not-a-uuid']) expect(() => parseReelQuery(new URLSearchParams(query))).toThrow(ApiError);
    expect(parseReelQuery(new URLSearchParams('saved=false&min_outlier=10&limit=50'))).toMatchObject({ saved: false, min_outlier: 10, limit: 50 });
  });
  it('validates date ranges and bounds one-sided ranges', () => {
    for (const query of ['from=2026-02-30', 'from=2024-01-01&to=2026-01-01', 'from=2026-11-01&to=2026-01-01', 'from=&to=2026-11-08']) expect(() => parseReelQuery(new URLSearchParams(query))).toThrow(ApiError);
    const query = parseReelQuery(new URLSearchParams('to=2026-11-08'));
    expect(Date.parse(query.to!) - Date.parse(query.from!)).toBe(366 * 86_400_000);
  });
  it('allows only fixed PRD timezone and rejects browser scraping enablement', () => {
    expect(() => validate(settingsSchema, { scraping_enabled: true })).toThrow(ApiError);
    expect(() => validate(settingsSchema, { timezone: 'UTC' })).toThrow(ApiError);
    expect(validate(settingsSchema, { timezone: 'Asia/Kolkata', paused: true })).toEqual({ timezone: 'Asia/Kolkata', paused: true });
  });
  it('keeps initial import server-managed and enforces Actor recurring minimum 10', () => {
    for (const input of [{ initial_backfill_enabled: true }, { initial_backfill_limit: 100 }, { daily_limit: 1 }, { weekly_limit: 9 }, { daily_limit: 31 }]) expect(() => validate(settingsSchema, input)).toThrow(ApiError);
    expect(validate(settingsSchema, { daily_limit: 10, weekly_limit: 30 })).toEqual({ daily_limit: 10, weekly_limit: 30 });
  });
  it('bounds JSON bodies and rejects invalid content types', async () => {
    await expect(readJson(new Request(url, { method: 'POST', body: '{}' }))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(new Request(url, { method: 'POST', body: JSON.stringify({ x: 'x'.repeat(100) }), headers: { 'content-type': 'application/json' } }), 20)).rejects.toMatchObject({ status: 413 });
  });
  it('parses quoted username CSV and detects case-insensitive destinations and duplicates', () => {
    const parsed = parseCreatorCsv('username,workspace\r\n@Example,"AI, Tools"\r\nexample,"AI, Tools"\r\nhttps://evil.test/u,Default', 'Default');
    const rows = previewCsv(parsed, new Map());
    expect(rows.map(row => row.status)).toEqual(['ready', 'duplicate', 'invalid']);
    expect(rows[0].workspace).toBe('AI, Tools');
    expect(() => parseCreatorCsv('name\nexample', 'Default')).toThrow(ApiError);
  });
  it('escapes spreadsheet formulas, embedded quotes, and untrusted reel URLs', async () => {
    expect(csvCell(' =HYPERLINK("evil")')).toBe('"\' =HYPERLINK(""evil"")"');
    const repo = new DemoRepository();
    const bootstrap = await repo.bootstrap();
    const page = await repo.reels(bootstrap.workspaces[0].id, { limit: 1 });
    const csv = exportReelsCsv([{ ...page.items[0], note: '=1+1', reel_url: 'javascript:alert(1)' }]);
    expect(csv).toContain("'=1+1");
    expect(csv).not.toContain('javascript:');
  });
});

describe('backend demo repository', () => {
  beforeEach(() => { delete (globalThis as typeof globalThis & { __reelradarDemo?: unknown }).__reelradarDemo; });
  it('persists server singleton mutations across repository instances', async () => {
    const first = new DemoRepository();
    const created = await first.createWorkspace('New Research');
    expect((await new DemoRepository().bootstrap()).workspaces.some(workspace => workspace.id === created.id)).toBe(true);
  });
  it('preview does not mutate and commit creates optional workspaces atomically', async () => {
    const repo = new DemoRepository();
    const before = await repo.bootstrap();
    const csv = 'username,workspace\n@new_creator,New Research\nnew_creator,New Research\n/bad,New Research';
    const preview = await repo.importCreators(before.workspaces[0].id, csv, true);
    expect(preview).toMatchObject({ added: 0, duplicates: 1, invalid: 1 });
    expect((await repo.bootstrap()).workspaces).toEqual(before.workspaces);
    const committed = await repo.importCreators(before.workspaces[0].id, csv, false);
    expect(committed.added).toBe(1);
    expect((await repo.bootstrap()).workspaces.length).toBe(before.workspaces.length + 1);
  });
  it('imports 120 canonical usernames atomically into a clean research set', async () => {
    const repo = new DemoRepository();
    const before = await repo.bootstrap();
    await repo.settings({ capacity: 132 });
    const csv = 'username\n' + Array.from({ length: 120 }, (_, i) => `test_creator_${i}`).join('\n');
    const preview = await repo.importCreators(before.workspaces[0].id, csv, true);
    expect(preview.rows.filter(row => row.status === 'ready')).toHaveLength(120);
    expect((await repo.importCreators(before.workspaces[0].id, csv, false)).added).toBe(120);
    expect((await repo.importCreators(before.workspaces[0].id, csv, false)).duplicates).toBe(120);
  });
  it('rejects capacity overflow without partially creating workspaces or creators', async () => {
    const repo = new DemoRepository();
    const before = await repo.bootstrap();
    const ids = new Set<string>();
    for (const workspace of before.workspaces) for (const creator of await repo.creators(workspace.id)) ids.add(creator.id);
    await repo.settings({ capacity: ids.size });
    await expect(repo.importCreators(before.workspaces[0].id, 'username,workspace\ncapacity_creator,Must Not Exist', false)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect((await repo.bootstrap()).workspaces.length).toBe(before.workspaces.length);
  });
  it('shares one global creator and existing reels across workspaces; unlink preserves records', async () => {
    const repo = new DemoRepository();
    const before = await repo.bootstrap();
    const creator = (await repo.creators(before.workspaces[0].id))[0];
    const target = await repo.createWorkspace('Shared');
    expect((await repo.addCreator(target.id, creator.username)).id).toBe(creator.id);
    const reels = await repo.reels(target.id, {});
    expect(reels.total).toBeGreaterThan(0);
    await repo.removeCreator(target.id, creator.id);
    expect((await repo.reels(target.id, {})).total).toBe(0);
    expect((await repo.reels(before.workspaces[0].id, { creator_id: creator.id })).total).toBe(reels.total);
  });
  it('scopes bookmarks and rejects workspace foreign Reel IDs', async () => {
    const repo = new DemoRepository();
    const bootstrap = await repo.bootstrap();
    const reel = (await repo.reels(bootstrap.workspaces[0].id, {})).items[0];
    const empty = await repo.createWorkspace('Empty');
    await expect(repo.save(empty.id, reel.id, '', [])).rejects.toMatchObject({ status: 404 });
    await repo.save(bootstrap.workspaces[0].id, reel.id, 'Research note', ['hook']);
    expect((await repo.reels(bootstrap.workspaces[0].id, { saved: true })).items.some(item => item.id === reel.id && item.note === 'Research note')).toBe(true);
    await repo.unsave(bootstrap.workspaces[0].id, reel.id);
    expect((await repo.reels(bootstrap.workspaces[0].id, { saved: true })).items.some(item => item.id === reel.id)).toBe(false);
  });
  it('filters threshold equality, paginates and preserves missing metric scores', async () => {
    const repo = new DemoRepository();
    const workspace = (await repo.bootstrap()).workspaces[0];
    const outliers = await repo.reels(workspace.id, { min_outlier: 10, limit: 50, sort: 'outlier' });
    expect(outliers.items.every(reel => reel.follower_outlier_score !== null && reel.follower_outlier_score >= 10)).toBe(true);
    const first = await repo.reels(workspace.id, { limit: 2, page: 1 });
    const second = await repo.reels(workspace.id, { limit: 2, page: 2 });
    expect(new Set([...first.items, ...second.items].map(reel => reel.id)).size).toBe(4);
  });
  it('simulates refresh without costs and prevents browser scraping setup', async () => {
    const repo = new DemoRepository();
    const before = await repo.bootstrap();
    await repo.settings({ paused: true });
    const result = await repo.refresh(before.workspaces[0].id);
    const { jobs, usage } = await repo.jobs();
    expect(jobs[0]).toMatchObject({ id: result.job_id, status: 'succeeded', estimated_cost_usd: 0, actual_cost_usd: null });
    expect(usage.actual_month_spend).toBeNull();
    await expect(repo.settings({ scraping_enabled: true })).rejects.toMatchObject({ status: 403 });
    await expect(repo.settings({ initial_backfill_enabled: true })).rejects.toMatchObject({ status: 403 });
  });
  it('allowlists public bootstrap fields even if DB payload contains secrets', async () => {
    const value = await new DemoRepository().bootstrap();
    const settings = { ...value.settings, apify_api_token: 'secret' };
    const safe = safeBootstrap({ ...value, settings });
    expect(JSON.stringify(safe)).not.toContain('apify_api_token');
  });
});

describe('postcommit dispatcher wake', () => {
  const configured = { NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co', REELRADAR_DISPATCH_SECRET: 'unit-test-only-secret' };
  it('defers one ordinary authenticated POST and never accepts a caller URL', async () => {
    const callbacks: (() => Promise<void>)[] = [];
    const afterResponse = vi.fn((callback: () => Promise<void>) => { callbacks.push(callback); });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(scheduleDispatcherWake(afterResponse, configured, fetcher)).toBe('queued');
      expect(afterResponse).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
      await callbacks[0]();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toBe('https://project.supabase.co/functions/v1/refresh-dispatch');
      expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-internal-secret': configured.REELRADAR_DISPATCH_SECRET } });
      expect(timeout).toHaveBeenCalledWith(8_000);
      expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
    } finally { timeout.mockRestore(); }
  });
  it('preserves queued work without scheduling when processing configuration is absent or unsafe', () => {
    const afterResponse = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    for (const base of ['https://evil.test', 'https://project.supabase.co.evil.test', 'http://project.supabase.co', 'https://user@project.supabase.co', 'https://project.supabase.co/evil', 'https://project.supabase.co?redirect=evil', 'https://project.supabase.co#evil', 'https://project.supabase.co:444', 'http://localhost:54321']) {
      expect(scheduleDispatcherWake(afterResponse, { ...configured, NEXT_PUBLIC_SUPABASE_URL: base }, fetcher)).toBe('configuration_required');
    }
    expect(scheduleDispatcherWake(afterResponse, { ...configured, REELRADAR_DISPATCH_SECRET: undefined }, fetcher)).toBe('configuration_required');
    expect(afterResponse).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows explicit loopback test configuration without external requests', async () => {
    let callback: (() => Promise<void>) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    expect(scheduleDispatcherWake(value => { callback = value; }, { ...configured, NODE_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }, fetcher)).toBe('queued');
    await callback!();
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:54321/functions/v1/refresh-dispatch');
  });
  it('logs only generic failures for timeout, network, HTTP, and after scheduling errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const outcome of [new Error('secret-provider-payload'), new Response('secret-provider-payload', { status: 503 })]) {
        let callback: (() => Promise<void>) | undefined;
        const fetcher = vi.fn<typeof fetch>();
        if (outcome instanceof Error) fetcher.mockRejectedValue(outcome); else fetcher.mockResolvedValue(outcome);
        expect(scheduleDispatcherWake(value => { callback = value; }, configured, fetcher)).toBe('queued');
        await expect(callback!()).resolves.toBeUndefined();
      }
      expect(scheduleDispatcherWake(() => { throw new Error('secret-after-payload'); }, configured, vi.fn<typeof fetch>())).toBe('queued');
      expect(log).toHaveBeenCalledTimes(3);
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain('secret');
      expect(output).not.toContain(configured.REELRADAR_DISPATCH_SECRET);
    } finally { log.mockRestore(); }
  });
});

describe('safe initial import contracts', () => {
  it.each([
    ['failed', 'This collection failed.'], ['partial', 'Only part of this collection completed.'],
    ['budget_paused', 'This collection is on a budget hold.'], ['uncertain', 'Submission may have been accepted and billed.'],
  ] as const)('allowlists %s status details without exposing raw provider metadata', async (status, message) => {
    const data = await new DemoRepository().bootstrap();
    const raw = { ...data.jobs[0], status, actual_cost_usd: null, error_message: 'Authorization: Bearer secret-token token=private', provider_payload: 'private', apify_api_token: 'secret-token' };
    const safe = safeJob(raw);
    expect(safe.error_message).toContain(message);
    expect(safe.actual_cost_usd).toBeNull();
    expect(safe).not.toHaveProperty('apify_account_slot');
    expect(safeJob({ ...raw, error_message: null }).error_message).toBeNull();
    const output = JSON.stringify(safeBootstrap({ ...data, jobs: [raw] }));
    for (const secret of ['Authorization', 'secret-token', 'token=private', 'provider_payload', 'apify_api_token']) expect(output).not.toContain(secret);
  });

  it.each([
    [true, 50], [false, 10_000], [undefined, 10_000],
  ] as const)('allowlists discovery flag %s and retains original request limit %i without private metadata', async (bounded, limit) => {
    const data = await new DemoRepository().bootstrap();
    const raw = { ...data.jobs[0], kind: 'discovery' as const, discovery_bounded: bounded, results_limit: limit, actual_cost_usd: null,
      provider_payload: 'private', apify_api_token: 'secret-token', discovery_scan_internal: 'private' };
    const safe = safeJob(raw);
    expect(safe.discovery_bounded).toBe(bounded);
    expect(safe).toMatchObject({ kind: 'discovery', results_limit: limit, actual_cost_usd: null });
    const output = JSON.parse(JSON.stringify(safeBootstrap({ ...data, jobs: [raw] })));
    if (bounded === undefined) expect(output.jobs[0]).not.toHaveProperty('discovery_bounded');
    else expect(output.jobs[0]).toHaveProperty('discovery_bounded', bounded);
    expect(output.jobs[0].results_limit).toBe(limit);
    for (const secret of ['provider_payload', 'private', 'apify_api_token', 'secret-token', 'discovery_scan_internal']) expect(JSON.stringify(output)).not.toContain(secret);
  });

  it.each([1, 73, 10_000, null, undefined])('allowlists nullable frozen metrics count %s without exposing private job payloads', async tracked => {
    const data = await new DemoRepository().bootstrap();
    const raw = { ...data.jobs[0], kind: 'metrics' as const, metrics_tracked_count: tracked, requested_profiles_count: 1,
      results_limit: tracked == null ? 10_000 : Math.min(tracked + 50, 10_000), actual_cost_usd: null,
      provider_payload: 'private', apify_api_token: 'secret-token' };
    const safe = safeJob(raw);
    expect(safe.metrics_tracked_count).toBe(tracked);
    expect(safe).toMatchObject({ kind: 'metrics', requested_profiles_count: 1, results_limit: raw.results_limit, actual_cost_usd: null });
    const output = JSON.parse(JSON.stringify(safeBootstrap({ ...data, jobs: [raw] })));
    if (tracked === undefined) expect(output.jobs[0]).not.toHaveProperty('metrics_tracked_count');
    else expect(output.jobs[0]).toHaveProperty('metrics_tracked_count', tracked);
    for (const secret of ['provider_payload', 'private', 'apify_api_token', 'secret-token']) expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('retains initialization and billing summaries without allowing privileged payloads', async () => {
    const repo = new DemoRepository();
    const data = await repo.bootstrap();
    const creator = (await repo.creators(data.workspaces[0].id))[0];
    const initializer = { ...creator, initial_backfill_job_id: '11111111-1111-4111-8111-111111111111', initial_backfill_status: 'pending' as const, profile_job_ids: ['22222222-2222-4222-8222-222222222222', 'https://invalid.test/private'], REELRADAR_DISPATCH_SECRET: 'secret' };
    expect(safeCreator(initializer)).toMatchObject({ initial_backfill_job_id: initializer.initial_backfill_job_id, initial_backfill_status: 'pending', profile_job_ids: ['22222222-2222-4222-8222-222222222222'] });
    expect(JSON.stringify(safeCreator(initializer))).not.toContain('secret');
    expect(safeJob({ ...data.jobs[0], results_limit: 100 })).toMatchObject({ results_limit: 100 });
    const usage = safeUsage({ ...data.usage, provider_balance_usd: 5, provider_usage_usd: 0.04, provider_limit_usd: 5, provider_cycle_start_at: '2026-11-01T00:00:00Z', provider_cycle_end_at: '2026-12-01T00:00:00Z', provider_usage_checked_at: '2026-11-08T00:00:00Z' });
    expect(usage).toMatchObject({ provider_balance_usd: null, provider_usage_usd: 0.04, provider_limit_usd: 5 });
    expect(safeBootstrap(data).settings.initial_backfill_limit).toBe(100);
    const reel = (await repo.reels(data.workspaces[0].id, { limit: 1 })).items[0];
    expect(safeReel({ ...reel, followers_count: null, follower_outlier_score: 100 }).follower_outlier_score).toBeNull();
  });
});

describe('backend Supabase repository authorization', () => {
  it('retains initial Reel and profile jobs and leaves preview read-only', async () => {
    const data = await new DemoRepository().bootstrap();
    const workspace = { ...data.workspaces[0], archived_at: null };
    const jobIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const rpc = vi.fn().mockResolvedValue({ data: { added: 1, duplicates: 0, workspaces_created: 0, job_ids: jobIds, profile_job_ids: [jobIds[1]] }, error: null });
    const committedRepo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, 'owner', 'owner@example.com');
    vi.spyOn(committedRepo, 'workspace').mockResolvedValue(workspace);
    vi.spyOn(committedRepo, 'bootstrap').mockResolvedValue({ ...data, workspaces: [workspace] });
    vi.spyOn(committedRepo, 'creators').mockResolvedValue([]);
    expect(await committedRepo.importCreators(workspace.id, 'username\nnew_profile', true)).toMatchObject({ added: 0 });
    expect(rpc).not.toHaveBeenCalled();
    const result = await committedRepo.importCreators(workspace.id, 'username\nnew_profile', false);
    expect(result.job_ids).toEqual(jobIds);
    expect(result.profile_job_ids).toEqual([jobIds[1]]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('import_creators', { p_workspace_id: workspace.id, p_rows: [{ username: 'new_profile', workspace: workspace.name }] });
    await expect(committedRepo.settings({ initial_backfill_enabled: true })).rejects.toMatchObject({ status: 403 });
  });
  it('does not invoke data RPC when workspace membership is absent', async () => {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    const client = { from: vi.fn().mockReturnValue(chain), rpc: vi.fn() };
    const repo = new SupabaseRepository(client as unknown as SupabaseClient, 'owner', 'owner@example.com');
    await expect(repo.reels('11111111-1111-4111-8111-111111111111', {})).rejects.toMatchObject({ status: 404 });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
