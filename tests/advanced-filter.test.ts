import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Reel, ReelQuery } from '../src/lib/types';
import { defaultReelFilters, readReelFilters, reelQueryString, resolveReelPeriod } from '../src/lib/reel-filters';
import { ApiError } from '../src/lib/server/errors';
import { parseReelQuery, reelFilterSchema, validate } from '../src/lib/server/validation';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { safeReel, safeReelFilter } from '../src/lib/server/public-data';

const creator = '00000002-0000-4000-8000-000000000001';
const other = '00000002-0000-4000-8000-000000000002';
const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const parse = (query: string) => parseReelQuery(new URLSearchParams(query));
const globalStore = globalThis as typeof globalThis & { __reelradarDemo?: { data: { reels: Reel[] } } };

beforeEach(() => { delete globalStore.__reelradarDemo; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete globalStore.__reelradarDemo; });

describe('advanced reel query validation', () => {
  it('preserves legacy zero thresholds and adds inclusive bounded maxima without defaulting API filters', () => {
    expect(parse('')).toEqual({ page: 1, limit: 30 });
    expect(parse('min_views=0&max_views=10000000&min_engagement=0&max_engagement=100&min_outlier=0&max_outlier=100')).toMatchObject({ min_views: 0, max_views: 10_000_000, min_engagement: 0, max_engagement: 100, min_outlier: 0, max_outlier: 100 });
    expect(parse('min_engagement=2.25&min_outlier=1.5')).toMatchObject({ min_engagement: 2.25, min_outlier: 1.5 });
    for (const query of ['min_views=10000001', 'max_views=10000001', 'min_views=0.5', 'max_views=-1', 'min_engagement=100.01', 'max_engagement=101', 'min_outlier=101', 'max_outlier=101', 'min_views=100&max_views=99', 'min_engagement=3&max_engagement=2', 'min_outlier=10&max_outlier=9', 'max_views=NaN', 'max_outlier=Infinity', 'min_views=1e3', 'max_engagement=', 'page=0', 'page=10001', 'limit=51']) expect(() => parse(query), query).toThrow(ApiError);
  });
  it('accepts creator arrays including explicit empty selection; rejects invalid or oversized IDs', () => {
    expect(parse(reelQueryString({ creator_ids: [], creator_id: creator }))).toMatchObject({ creator_ids: [], creator_id: creator });
    expect(parse(reelQueryString({ creator_ids: [creator, other] })).creator_ids).toEqual([creator, other]);
    expect(parse(reelQueryString({ creator_ids: Array(120).fill(creator) })).creator_ids).toHaveLength(120);
    for (const value of ['null', '{}', '"hello"', '[null]', '["bad"]', creator, JSON.stringify(Array(121).fill(creator))]) expect(() => parse(`creator_ids=${encodeURIComponent(value)}`)).toThrow(ApiError);
  });
  it('validates keywords, platform, unknown/repeated params and existing enum/boolean fields', () => {
    expect(parse('keywords=%25_%5Bhi%5D%20&platform=instagram&saved=false&freshness=fresh&status=active&sort=engagement')).toMatchObject({ keywords: '%_[hi] ', platform: 'instagram', saved: false, freshness: 'fresh', status: 'active', sort: 'engagement' });
    expect(parse(`keywords=${'x'.repeat(200)}`).keywords).toHaveLength(200);
    for (const query of [`keywords=${'x'.repeat(201)}`, 'platform=tiktok', 'view=grid', 'owner_user_id=secret', '__proto__=bad', 'keywords=a&keywords=b', 'creator_ids=[]&creator_ids=[]', 'posted_unit=days&posted_unit=weeks', 'saved=1', 'status=unknown', 'freshness=unknown', 'sort=invalid']) expect(() => parse(query), query).toThrow(ApiError);
  });
  it('pairs positive integer rolling descriptors and retains the ordered 366-day explicit date guard', () => {
    for (const query of ['posted_amount=1', 'posted_unit=days', 'posted_amount=0&posted_unit=months', 'posted_amount=1.5&posted_unit=days', 'posted_amount=367&posted_unit=days', 'posted_amount=53&posted_unit=weeks', 'posted_amount=13&posted_unit=months', 'posted_amount=1&posted_unit=years', 'posted_amount=1&posted_unit=days&from=2026-11-01', 'from=2026-02-30', 'to=', 'from=2026-11-08&to=2026-11-07', 'from=2024-01-01&to=2026-01-01']) expect(() => parse(query), query).toThrow(ApiError);
    for (const [posted_amount, posted_unit] of [[366, 'days'], [52, 'weeks'], [12, 'months']] as const) expect(parse(reelQueryString({ posted_amount, posted_unit }))).toMatchObject({ posted_amount, posted_unit });
    expect(parse('from=2024-01-01&to=2025-01-01')).toMatchObject({ from: '2024-01-01', to: '2025-01-01' });
    const oneSided = parse('to=2026-11-08');
    expect(Date.parse(oneSided.to!) - Date.parse(oneSided.from!)).toBe(366 * 86_400_000);
    const forward = parse('from=2026-11-08');
    expect(Date.parse(forward.to!) - Date.parse(forward.from!)).toBe(366 * 86_400_000);
  });
});

describe('pure client helpers and IST rolling periods', () => {
  it('supplies fresh neutral UI objects and reads only explicit filters without outlier defaults', () => {
    expect(defaultReelFilters()).toEqual({});
    expect(defaultReelFilters()).not.toHaveProperty('creator_ids');
    const defaults = defaultReelFilters(); defaults.min_views = 500;
    expect(defaultReelFilters()).toEqual({});
    expect(defaultReelFilters()).not.toBe(defaultReelFilters());
    expect(readReelFilters(new URLSearchParams())).toEqual({});
    expect(readReelFilters(new URLSearchParams('view=list'))).toEqual({});
    expect(readReelFilters(new URLSearchParams('creator_ids=[]&min_outlier=0&view=list'))).toEqual({ creator_ids: [], min_outlier: 0 });
    expect(readReelFilters(new URLSearchParams('from=2026-11-01&to=2026-11-08'))).not.toHaveProperty('posted_amount');
    for (const query of ['view=list&view=grid', 'keywords=a&keywords=b', 'creator_ids=bad', 'unexpected=true', 'posted_amount=3', 'min_outlier=90&max_outlier=10']) expect(() => readReelFilters(new URLSearchParams(query))).toThrow();
  });
  it('keeps one-sided metric ranges optional and serializes cleared bounds without fabricated values', () => {
    for (const metric of ['views', 'engagement', 'outlier'] as const) {
      expect(readReelFilters(new URLSearchParams(`min_${metric}=0`))).toEqual({ [`min_${metric}`]: 0 });
      expect(readReelFilters(new URLSearchParams(`max_${metric}=0`))).toEqual({ [`max_${metric}`]: 0 });
      expect(parse(`min_${metric}=0`)).toEqual({ [`min_${metric}`]: 0, page: 1, limit: 30 });
      expect(parse(`max_${metric}=0`)).toEqual({ [`max_${metric}`]: 0, page: 1, limit: 30 });
      expect(reelQueryString({ [`min_${metric}`]: undefined, [`max_${metric}`]: undefined })).toBe('');
    }
  });
  it('serializes every field stably, preserves literal text/zeros/false, and roundtrips empty arrays', () => {
    const query: ReelQuery = { keywords: '50% _[x]+ café & "quoted"', creator_ids: [other, creator], creator_id: creator, search: 'AI', platform: 'instagram', min_views: 0, max_views: 10_000_000, min_engagement: 0, max_engagement: 100, min_outlier: 0, max_outlier: 100, posted_amount: 9, posted_unit: 'months', saved: false, freshness: 'stale', status: 'paused', sort: 'outlier', page: 2, limit: 50 };
    const serialized = reelQueryString(query);
    const reordered = Object.fromEntries(Object.entries(query).reverse()) as ReelQuery;
    expect(reelQueryString(reordered)).toBe(serialized);
    expect(serialized.startsWith('?')).toBe(false);
    const params = new URLSearchParams(serialized);
    expect([...params.keys()]).toEqual([...params.keys()].sort());
    expect(params.get('creator_ids')).toBe(JSON.stringify([other, creator]));
    expect(parseReelQuery(params)).toEqual(query);
    expect(reelQueryString({ creator_ids: [] })).toBe('creator_ids=%5B%5D');
    expect(parse(reelQueryString({ creator_ids: [] })).creator_ids).toEqual([]);
    expect(reelQueryString({ keywords: undefined })).toBe('');
  });
  it.each([
    ['2026-03-31T12:00:00Z', 1, 'months', '2026-02-28', '2026-03-31'],
    ['2024-03-31T12:00:00Z', 1, 'months', '2024-02-29', '2024-03-31'],
    ['2024-02-29T12:00:00Z', 12, 'months', '2023-02-28', '2024-02-29'],
    ['2026-01-31T12:00:00Z', 2, 'months', '2025-11-30', '2026-01-31'],
    ['2026-11-08T18:29:59Z', 1, 'days', '2026-11-07', '2026-11-08'],
    ['2026-11-08T18:30:00Z', 1, 'days', '2026-11-08', '2026-11-09'],
    ['2026-03-08T12:00:00Z', 1, 'weeks', '2026-03-01', '2026-03-08'],
    ['2026-11-01T12:00:00Z', 1, 'weeks', '2026-10-25', '2026-11-01'],
  ] as const)('resolves %s / %s %s with calendar clamps and no DST', (now, posted_amount, posted_unit, from, to) => {
    const query: ReelQuery = { posted_amount, posted_unit, creator_ids: [creator], saved: true, sort: 'views' };
    const copy = structuredClone(query);
    const resolved = resolveReelPeriod(query, new Date(now));
    expect(resolved).toEqual({ from, to, creator_ids: [creator], saved: true, sort: 'views' });
    expect(query).toEqual(copy);
    expect(resolved.creator_ids).not.toBe(query.creator_ids);
    expect(resolveReelPeriod(resolved, new Date('2027-01-01'))).toEqual(resolved);
  });
  it('returns a new unchanged legacy query and rejects invalid rolling/date input', () => {
    const legacy = { saved: false };
    expect(resolveReelPeriod(legacy)).toEqual(legacy);
    expect(resolveReelPeriod(legacy)).not.toBe(legacy);
    for (const query of [{ posted_amount: 1 }, { posted_amount: -1, posted_unit: 'days' }, { posted_amount: 13, posted_unit: 'months' }, { min_views: 5, max_views: 4 }, { from: '2026-02-30' }] as ReelQuery[]) expect(() => resolveReelPeriod(query)).toThrow();
    expect(() => resolveReelPeriod({ posted_amount: 1, posted_unit: 'days' }, new Date(NaN))).toThrow();
  });
});

describe('local reel repository filtering', () => {
  it('intersects singular IDs, creator lists and authorized workspace membership, including empty sets', async () => {
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0].id;
    const all = await repo.reels(workspace, { limit: 50 });
    const selected = await repo.reels(workspace, { creator_id: creator, creator_ids: [creator, other], limit: 50 });
    expect(selected.items.length).toBeGreaterThan(0);
    expect(selected.items.every(reel => reel.creator_id === creator)).toBe(true);
    for (const query of [{ creator_ids: [] }, { creator_ids: [missing] }, { creator_id: creator, creator_ids: [other] }]) expect((await repo.reels(workspace, query)).total).toBe(0);
    expect((await repo.reels(workspace, { creator_ids: [creator, other] })).total).toBeLessThan(all.total);
    const empty = await repo.createWorkspace('Empty filters');
    expect((await repo.reels(empty.id, { creator_ids: [creator] })).total).toBe(0);
    await expect(repo.reels(missing, { creator_ids: [] })).rejects.toMatchObject({ status: 404 });
  });
  it('matches stored caption/title preview literally and case-insensitively, not username or regex/SQL wildcards', async () => {
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0].id;
    const reel = globalStore.__reelradarDemo!.data.reels[0];
    reel.caption_preview = 'TITLE-derived 50% _[AI]+ special phrase';
    expect((await repo.reels(workspace, { keywords: 'title-DERIVED 50% _[ai]+' })).items.map(item => item.id)).toEqual([reel.id]);
    expect((await repo.reels(workspace, { keywords: '.*' })).total).toBe(0);
    expect((await repo.reels(workspace, { keywords: reel.username })).total).toBe(0);
    expect((await repo.reels(workspace, { search: reel.username })).total).toBeGreaterThan(0);
    expect((await repo.reels(workspace, { keywords: 'special phrase', search: 'nonmatching' })).total).toBe(0);
    expect((await repo.reels(workspace, { platform: 'instagram' })).total).toBe((await repo.reels(workspace, {})).total);
  });
  it('applies min/max equality to each metric and excludes unknown metrics even at legacy zero', async () => {
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0].id;
    const sample = (await repo.reels(workspace, { min_outlier: 1, max_outlier: 100, min_engagement: 0, limit: 1 })).items[0];
    const views = await repo.reels(workspace, { min_views: sample.latest_views!, max_views: sample.latest_views! });
    expect(views.items.some(reel => reel.id === sample.id)).toBe(true);
    expect(views.items.every(reel => reel.views_state === 'known' && reel.latest_views === sample.latest_views)).toBe(true);
    for (const [metric, field] of [['engagement', 'engagement_rate_pct'], ['outlier', 'follower_outlier_score']] as const) {
      const value = sample[field]!;
      const result = await repo.reels(workspace, { [`min_${metric}`]: value, [`max_${metric}`]: value });
      expect(result.items.some(reel => reel.id === sample.id)).toBe(true);
      expect(result.items.every(reel => reel[field] === value)).toBe(true);
      expect((await repo.reels(workspace, { [`min_${metric}`]: 0, [`max_${metric}`]: 100, limit: 50 })).items.every(reel => reel[field] !== null)).toBe(true);
    }
    expect((await repo.reels(workspace, { max_views: 0 })).items.every(reel => reel.views_state === 'known' && reel.latest_views === 0)).toBe(true);
    const unknown = globalStore.__reelradarDemo!.data.reels.find(reel => reel.views_state !== 'known')!;
    expect((await repo.reels(workspace, { min_views: 0, max_views: 10_000_000, limit: 50 })).items.some(reel => reel.id === unknown.id)).toBe(false);
  });
  it('uses inclusive IST date boundaries, excludes unpublished records, and resolves rolling read dates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-31T20:00:00Z'));
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0].id;
    const fixtures = globalStore.__reelradarDemo!.data.reels.filter(reel => reel.creator_id === creator);
    const dates = ['2026-03-01T00:00:00+05:30', '2026-04-01T23:59:59+05:30', '2026-04-02T00:00:00+05:30', '2026-02-28T23:59:59+05:30', null];
    fixtures.forEach((reel, index) => { reel.published_at = dates[index] ?? null; });
    const rolling = await repo.reels(workspace, { creator_id: creator, posted_amount: 1, posted_unit: 'months' });
    expect(rolling.items.map(reel => reel.id).sort()).toEqual(fixtures.slice(0, 2).map(reel => reel.id).sort());
    const explicit = await repo.reels(workspace, { creator_id: creator, from: '2026-03-01', to: '2026-04-01' });
    expect(explicit).toEqual(rolling);
    expect((await repo.reels(workspace, { creator_id: creator })).total).toBe(fixtures.length);
  });
});

describe('saved preset contracts and public API guards', () => {
  it('strictly validates names and filter+sort JSON objects while retaining rolling descriptors', () => {
    const query = { posted_amount: 9, posted_unit: 'months' as const, creator_ids: [], sort: 'outlier' as const };
    expect(validate(reelFilterSchema, { name: '  Research  ', query })).toEqual({ name: 'Research', query });
    expect(validate(reelFilterSchema, { name: 'All time', query: defaultReelFilters() })).toEqual({ name: 'All time', query: {} });
    for (const body of [{ name: '', query: {} }, { name: '   ', query: {} }, { name: 'x'.repeat(81), query: {} }, { name: 'X', query: { page: 1 } }, { name: 'X', query: { limit: 50 } }, { name: 'X', query: { view: 'grid' } }, { name: 'X', query: { owner_user_id: missing } }, { name: 'X', query: { min_views: 10, max_views: 9 } }, { name: 'X', query: { posted_unit: 'months' } }, { name: 'X', query: {}, owner_user_id: missing }, { name: 'X', query: null }]) expect(() => validate(reelFilterSchema, body)).toThrow(ApiError);
  });
  it('persists only server-side demo presets, clones output, rejects duplicates and caps at 50', async () => {
    const repo = new DemoRepository(), before = await repo.bootstrap();
    const query = { posted_amount: 9, posted_unit: 'months' as const, creator_ids: [] };
    const saved = await repo.createReelFilter('Research', query);
    expect(Object.keys(saved).sort()).toEqual(['config', 'created_at', 'id', 'name']);
    expect(saved.config).toEqual({ version: 1, query });
    expect(saved.config.query).not.toHaveProperty('from');
    saved.config.query.creator_ids!.push(creator);
    const persisted = await new DemoRepository().reelFilters();
    expect(persisted[0].config.query.creator_ids).toEqual([]);
    expect((await repo.bootstrap()).jobs).toEqual(before.jobs);
    await expect(repo.createReelFilter(' research ', {})).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_FILTER' });
    for (let index = 1; index < 50; index++) await repo.createReelFilter(`Filter ${index}`, {});
    await expect(repo.createReelFilter('Overflow', {})).rejects.toMatchObject({ code: 'REEL_FILTER_LIMIT' });
    expect(await repo.reelFilters()).toHaveLength(50);
    await repo.deleteReelFilter(persisted[0].id);
    expect(await repo.reelFilters()).toHaveLength(49);
    await expect(repo.deleteReelFilter(persisted[0].id)).rejects.toMatchObject({ status: 404 });
    await expect(repo.deleteReelFilter('bad')).rejects.toMatchObject({ status: 400 });
    await expect(repo.createReelFilter('Bad', { page: 1 })).rejects.toMatchObject({ status: 400 });
  });
  it('allowlists public preset objects and optional platform, with no owner or nested internal payload leakage', async () => {
    const saved = await new DemoRepository().createReelFilter('Public', { ...defaultReelFilters(), creator_ids: [] });
    const polluted = { ...saved, owner_user_id: missing, internal_payload: 'secret', config: { ...saved.config, token: 'secret', query: { ...saved.config.query, page: 2, limit: 50, view: 'list', raw_payload: 'secret' } } };
    expect(safeReelFilter(polluted)).toEqual(saved);
    expect(JSON.stringify(safeReelFilter(polluted))).not.toMatch(/secret|"(?:owner_user_id|raw_payload|page|limit|view)":/);
    expect(() => safeReelFilter({ ...saved, config: { version: 2, query: {} } })).toThrow(ApiError);
    expect(() => safeReelFilter({ ...saved, config: { version: 1, query: { creator_ids: ['bad'] } } })).toThrow(ApiError);
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0].id;
    const reel = (await repo.reels(workspace, { limit: 1 })).items[0];
    expect(safeReel({ ...reel, platform: 'instagram' }).platform).toBe('instagram');
    expect(safeReel(reel)).not.toHaveProperty('platform');
    expect(safeReel({ ...reel, platform: 'secret' } as unknown as Reel)).not.toHaveProperty('platform');
  });
  it('uses exactly owner-only preset RPC contracts; rolling dates resolve for reels but not saved presets', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2024-03-31T12:00:00Z'));
    const saved = await new DemoRepository().createReelFilter('Stored', { posted_amount: 1, posted_unit: 'months' });
    const rpc = vi.fn().mockResolvedValue({ data: [saved], error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, creator, 'owner@example.test');
    expect(await repo.reelFilters()).toEqual([saved]);
    expect(rpc).toHaveBeenCalledWith('list_reel_filters', undefined);
    rpc.mockResolvedValue({ data: saved, error: null });
    await repo.createReelFilter(' Stored ', saved.config.query);
    expect(rpc).toHaveBeenLastCalledWith('create_reel_filter', { p_name: 'Stored', p_query: { posted_amount: 1, posted_unit: 'months' } });
    await repo.deleteReelFilter(saved.id);
    expect(rpc).toHaveBeenLastCalledWith('delete_reel_filter', { p_filter_id: saved.id });
    const workspace = { id: creator, name: 'Test', slug: 'test', created_at: '2026-11-08T12:00:00Z', archived_at: null };
    vi.spyOn(repo, 'workspace').mockResolvedValue(workspace);
    await repo.reels(workspace.id, { ...saved.config.query, creator_id: creator, creator_ids: [], page: 1 });
    expect(rpc).toHaveBeenLastCalledWith('query_reels', { p_workspace_id: workspace.id, p_query: { creator_id: creator, creator_ids: [], page: 1, from: '2024-02-29', to: '2024-03-31' } });
    const calls = rpc.mock.calls.length;
    await expect(repo.createReelFilter('Invalid', { page: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(repo.deleteReelFilter('bad')).rejects.toMatchObject({ status: 400 });
    expect(rpc.mock.calls).toHaveLength(calls);
  });
  it('maps expected preset errors safely while preserving forbidden failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rpc = vi.fn(), repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, creator, 'owner@example.test');
    for (const [code, message, expected] of [['23505', 'private SQL secret', 'DUPLICATE_FILTER'], ['22023', 'reel_filter_limit_reached', 'REEL_FILTER_LIMIT'], ['42501', 'forbidden secret', 'FORBIDDEN']] as const) {
      rpc.mockResolvedValue({ data: null, error: { code, message } });
      await expect(repo.createReelFilter('Safe', {})).rejects.toMatchObject({ code: expected });
    }
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'reel_filter_not_found' } });
    await expect(repo.deleteReelFilter(missing)).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
  it('adds guarded API list/create/delete routes and resolves export periods outside the pagination loop', () => {
    const route = readFileSync(join(import.meta.dirname, '../src/app/api/[...path]/route.ts'), 'utf8');
    const firstFilterRoute = route.indexOf("path[0] === 'reel-filters'");
    expect(route.indexOf('assertMutationOrigin(request)')).toBeLessThan(firstFilterRoute);
    expect(route.indexOf('await authenticatedClient()', route.indexOf('let repo: Repository'))).toBeLessThan(firstFilterRoute);
    expect(route).toContain('(await repo.reelFilters()).map(safeReelFilter)');
    expect(route).toContain('validate(reelFilterSchema, await readJson(request))');
    expect(route).toContain('json(safeReelFilter(await repo.createReelFilter(body.name, body.query)), 201)');
    expect(route).toContain('await repo.deleteReelFilter(validate(idSchema, path[1]))');
    const exportRoute = route.slice(route.indexOf("path[2] === 'export'"), route.indexOf("path[2] === 'saved'"));
    expect(exportRoute.indexOf('resolveReelPeriod(parseReelQuery(')).toBeLessThan(exportRoute.indexOf('for (let page'));
    expect(exportRoute.slice(exportRoute.indexOf('for (let page'))).not.toContain('resolveReelPeriod');
    expect(exportRoute).toContain('repo.reels(id, { ...query, page, limit: 50 })');
    expect(route).toContain('safeTranscript(await repo.transcript(id, validate(idSchema, path[3])))');
  });
});
