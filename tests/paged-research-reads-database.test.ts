import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Carousel, CarouselSummary, Creator, CreatorCollectionState, CreatorCollectionSummary, CreatorDirectoryEntry, JobStatus, PageResult, Reel } from '../src/lib/types';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

const migration = '202611150002_paged_research_reads.sql';
const carouselCountsMigration = '202611150007_creator_carousel_counts.sql';
let f: Awaited<ReturnType<typeof featureDatabase>>;
let sequence = 0;
beforeAll(async () => {
  // This paired historical rollout ends at creator counts, not later worker patches.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > carouselCountsMigration);
  f = await featureDatabase({ excludeMigrations: [migration, carouselCountsMigration, ...later] });
  // Keep the original query executable for semantic parity, not timing claims.
  const reference = await f.value<string>("select pg_get_functiondef('public.query_carousels(uuid,jsonb)'::regprocedure) v");
  await f.db.exec(reference.replace('public.query_carousels(', 'public.reference_query_carousels('));
  const reelReference = await f.value<string>("select pg_get_functiondef('public.query_reels(uuid,jsonb)'::regprocedure) v");
  await f.db.exec(reelReference.replace('public.query_reels(', 'public.reference_query_reels('));
  const collectionDefinition = await f.value<string>("select pg_get_functiondef('public.get_creator_collection_state(uuid,uuid[])'::regprocedure) v");
  const neighborDefinition = await f.value<string>("select pg_get_functiondef('public.get_reel_neighbors(uuid,uuid,jsonb)'::regprocedure) v");
  await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8'));
  const contracts = () => f.value(`select jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,
    'stable',p.provolatile,'definer',p.prosecdef,'config',p.proconfig,'args',pg_get_function_arguments(p.oid),
    'result',pg_get_function_result(p.oid)) order by p.oid) v from pg_proc p
    where p.oid in ('research_reads_private.creator_rows(uuid,uuid[])'::regprocedure,'public.list_creators(uuid)'::regprocedure,
      'public.query_creators(uuid,jsonb)'::regprocedure,'public.get_creator(uuid,uuid)'::regprocedure)`);
  const triggerContracts = () => f.value("select jsonb_agg(pg_get_triggerdef(oid) order by oid) v from pg_trigger where not tgisinternal");
  const beforeContracts = await contracts(), beforeTriggers = await triggerContracts();
  const legacyCreatorReference = await f.value<string>("select pg_get_functiondef('public.list_creators(uuid)'::regprocedure) v");
  await f.db.exec(legacyCreatorReference.replace('public.list_creators(', 'public.reference_list_creators('));
  await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', carouselCountsMigration), 'utf8'));
  expect(await contracts()).toEqual(beforeContracts);
  expect(await triggerContracts()).toEqual(beforeTriggers);
  expect(await f.value<string>("select pg_get_functiondef('public.get_creator_collection_state(uuid,uuid[])'::regprocedure) v")).toBe(collectionDefinition);
  expect(await f.value<string>("select pg_get_functiondef('public.get_reel_neighbors(uuid,uuid,jsonb)'::regprocedure) v")).toBe(neighborDefinition);
}, 60_000);
beforeEach(async () => { await f.identity(); await f.db.exec('begin; update public.workspace_creators set active=false'); });
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
afterAll(async () => { await f?.db.close(); });

async function creator(username = `paged_${++sequence}`, workspace = f.workspace, active = true) {
  const id = await f.value<string>('insert into public.creators(username) values($1) returning id v', [username]);
  await f.db.query('insert into public.workspace_creators(workspace_id,creator_id,active) values($1,$2,$3)', [workspace, id, active]);
  return id;
}
async function job(ids: string[], kind = 'manual', status: JobStatus = 'pending', created = '2026-01-01T00:00:00Z', live = false) {
  const id = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,created_at,scheduled_for,live,
    manual_authorized_by,apify_account_slot,expected_provider_user_id) values($1,$2,$3,$4,$5,$6,$6,$7,$1,
    case when $7 and $3 not in ('pending','budget_paused') then 1 end,case when $7 then 'fixture' end) returning id v`,
  [fixtureOwner, kind, status, Math.max(1, ids.length), kind === 'backfill' ? 100 : kind === 'profile' ? 1 : 30, created, live]);
  for (const cid of ids) await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, cid]);
  return id;
}
async function rejects(run: () => Promise<unknown>, message = 'invalid_query') {
  await f.db.exec('savepoint rejection');
  try { await expect(run()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint rejection; release savepoint rejection'); }
}
async function page(query: Record<string, unknown> = {}, workspace = f.workspace) {
  return f.rpc<PageResult<Creator>>('query_creators', [workspace, JSON.stringify(query)]);
}
async function directory(workspace = f.workspace) { return f.rpc<CreatorDirectoryEntry[]>('list_creator_directory', [workspace]); }
async function singular(id: string, workspace = f.workspace) { return f.rpc<Creator>('get_creator', [workspace, id]); }
async function summary(workspace = f.workspace) { return f.rpc<CreatorCollectionSummary>('get_creator_collection_summary', [workspace]); }

// All records and billing/provider values here are synthetic, in local PGlite.
describe('bounded authorized research reads', () => {
  it('counts complete active associations, pages 50/50/24 with stable username,id order, and preserves deep-page totals', async () => {
    const ids: string[] = [];
    for (let index = 123; index >= 0; index--) ids.push(await creator(`page_${String(index).padStart(3, '0')}`));
    await creator('page_inactive', f.workspace, false);
    await f.db.query("update public.creators set status='pending' where id=any($1::uuid[])", [ids]);
    await f.identity('authenticated');
    const first = await page(), second = await page({ page: 2, limit: 50 }), third = await page({ page: 3, limit: 50 });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 24]);
    expect([first.total, second.total, third.total]).toEqual([124, 124, 124]);
    expect(first).toMatchObject({ page: 1, limit: 50 });
    const all = [...first.items, ...second.items, ...third.items];
    expect(all.map(row => row.username)).toEqual(Array.from({ length: 124 }, (_, index) => `page_${String(index).padStart(3, '0')}`));
    expect(new Set(all.map(row => row.id)).size).toBe(124);
    expect(all.every(row => row.status === 'pending' && row.tracked_reels === 0 && row.tracked_carousels === 0 && row.latest_reel_date === null)).toBe(true);
    expect(await page({ page: 4 })).toEqual({ items: [], total: 124, page: 4, limit: 50 });
    expect(await page({ page: 10_000, limit: 1 })).toEqual({ items: [], total: 124, page: 10_000, limit: 1 });
    expect(await page({ search: 'no match' })).toEqual({ items: [], total: 0, page: 1, limit: 50 });
    const entries = await directory();
    expect(entries).toHaveLength(124);
    expect(Object.keys(entries[0]).sort()).toEqual(['avatar_url', 'display_name', 'id', 'status', 'username']);
    expect(entries.map(row => row.id)).toEqual(all.map(row => row.id));
    expect(await singular(third.items[23].id)).toEqual(third.items[23]);
  });

  it('counts all stored carousel posts beyond gallery pages while preserving legacy data, authorization and indexed per-creator reads', async () => {
    const zero = await creator('count_a_zero'), id = await creator('count_z_full'), inactive = await creator('count_inactive', f.workspace, false);
    await f.identity('authenticated');
    const other = (await f.rpc<{ id: string }>('create_workspace', ['Carousel counts other'])).id;
    await f.identity();
    const foreign = await creator('count_foreign', other);
    await f.db.query('insert into public.workspace_creators(workspace_id,creator_id,active) values($1,$2,true)', [other, id]);
    await f.db.query(`insert into public.carousel_posts(creator_id,shortcode,published_at,likes_state,comments_state,latest_fetched_at,provider)
      select $1,'FULL_COUNT_'||n,case when n=63 then null else '2026-01-01T00:00:00Z'::timestamptz end,'hidden','hidden',now(),'synthetic'
      from generate_series(1,63) n`, [id]);
    await f.db.query(`insert into public.carousel_posts(creator_id,shortcode,likes_state,comments_state,latest_fetched_at,provider)
      values($1,'FOREIGN_COUNT','unavailable','not_fetched',now(),'synthetic'),($2,'INACTIVE_COUNT','hidden','hidden',now(),'synthetic')`, [foreign, inactive]);
    const post = await f.value<string>("select id v from public.carousel_posts where shortcode='FULL_COUNT_1'");
    await f.db.query(`insert into public.carousel_metric_snapshots(carousel_id,snapshot_date,fetched_at,likes_state,comments_state)
      values($1,'2026-01-01',now(),'hidden','hidden'),($1,'2026-01-02',now(),'hidden','hidden')`, [post]);
    await f.db.query('insert into public.saved_carousels(workspace_id,carousel_id,saved_by_user_id) values($1,$2,$3)', [f.workspace, post, fixtureOwner]);
    await f.reel(false, id, '2026-02-01T00:00:00Z', false); await f.reel(false, id, '2026-03-01T00:00:00Z', false);
    await f.identity('authenticated');
    expect((await page({ limit: 1 })).items[0]).toMatchObject({ id: zero, tracked_reels: 0, tracked_carousels: 0 });
    const visible = (await page({ page: 2, limit: 1 })).items[0];
    expect(visible).toMatchObject({ id, tracked_reels: 2, tracked_carousels: 63 });
    expect(await singular(id)).toEqual(visible);
    expect(await singular(id, other)).toHaveProperty('tracked_carousels', 63);
    const legacy = await f.rpc<Creator[]>('list_creators', [f.workspace]);
    expect(legacy.map(row => row.tracked_carousels)).toEqual([0, 63]);
    expect(legacy.map(row => { const rest = { ...row }; delete rest.tracked_carousels; return rest; }))
      .toEqual(await f.rpc<Creator[]>('reference_list_creators', [f.workspace]));
    const gallery = await f.rpc<PageResult<Carousel>>('query_carousels', [f.workspace, '{"creator":"' + id + '","limit":1}']);
    expect(gallery.items).toHaveLength(1); expect(gallery.total).toBe(63);
    expect((await f.rpc<PageResult<Carousel>>('query_carousels', [f.workspace, '{"saved":true}'])).total).toBe(1);
    await rejects(() => singular(inactive), 'creator_not_found'); await rejects(() => singular(foreign), 'creator_not_found');
    expect((await directory())[0]).not.toHaveProperty('tracked_carousels');
    await f.identity();
    await f.db.exec('set local enable_seqscan=off');
    const plan = await f.db.query<{ 'QUERY PLAN': string }>('explain select count(*) from public.carousel_posts where creator_id=$1', [id]);
    expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('carousel_creator_publication');
    await f.db.exec('set local enable_seqscan=on');
    await f.db.query('insert into public.carousel_posts(creator_id,shortcode,likes_state,comments_state,latest_fetched_at,provider) values($1,$2,$3,$3,now(),$4)', [id, 'FULL_COUNT_EXTRA', 'not_fetched', 'synthetic']);
    await f.identity('authenticated'); expect(await singular(id)).toHaveProperty('tracked_carousels', 64);
    await f.identity(); await f.db.exec("delete from public.carousel_posts where shortcode='FULL_COUNT_EXTRA'");
    await f.identity('authenticated'); expect(await singular(id)).toHaveProperty('tracked_carousels', 63);
    await f.identity('authenticated', fixtureStranger);
    await rejects(() => f.rpc('list_creators', [f.workspace]), 'forbidden'); await rejects(() => page(), 'forbidden'); await rejects(() => singular(id), 'forbidden');
    for (const role of ['anon', 'service_role']) {
      await f.identity(role);
      await rejects(() => f.rpc('list_creators', [f.workspace]), 'permission denied');
      await rejects(() => f.db.query('select * from research_reads_private.creator_rows($1,$2)', [f.workspace, [id]]), 'permission denied');
    }
  });

  it('searches case-insensitive literal usernames/display names, including percent, underscore, and backslash', async () => {
    const one = await creator('literal_one'), two = await creator('literalxone');
    await f.db.query('update public.creators set display_name=$1 where id=$2', ['Name 100% \\ SPECIAL', one]);
    await f.db.query('update public.creators set display_name=$1 where id=$2', ['Name 100 percent', two]);
    await f.identity('authenticated');
    for (const search of ['literal_', '100%', '\\', 'special', '  SPECIAL  ']) {
      const result = await page({ search, limit: 1 });
      expect(result.total).toBe(1);
      expect(result.items[0].id).toBe(one);
    }
    expect((await page({ search: 'LITERAL' })).total).toBe(2);
    expect((await page({ search: 'NAME' })).total).toBe(2);
    expect((await page({ search: 'NAME', page: 3, limit: 1 })).items).toEqual([]);
  });

  it('enriches visible/singular creators with counts, nullable publication, canonical freshness, initial status, and newest owner profile status', async () => {
    const id = await creator('profile_visible'), never = await creator('profile_never');
    await f.db.query("update public.creators set last_reels_fetch_at='2026-10-01T12:34:56Z',last_profile_fetch_at='2026-10-02T12:34:56Z',last_error='secret provider blob' where id=$1", [id]);
    // Legacy unverified null rows remain legal; today's insert policy assumes IST.
    // Seed one without running that newer policy trigger, within this rollback.
    await f.db.exec('alter table public.reels disable trigger reels_apply_publication_ist');
    await f.db.query(`insert into public.reels(creator_id,shortcode,published_at,published_at_raw,published_at_basis,latest_fetched_at,provider)
      values($1,'PAGED_NULL_PUBLICATION',null,'2026-01-01T00:00:00','timezone_unverified',now(),'synthetic')`, [id]);
    // Flush queued signal events before fixture-only trigger DDL; defer again
    // afterward so ordinary release transactions keep commit-time signaling.
    await f.db.exec('set constraints all immediate; alter table public.reels enable trigger reels_apply_publication_ist; set constraints all deferred');
    await f.reel(false, id, '2026-02-01T00:00:00Z', false); await f.reel(false, id, '2026-03-01T00:00:00Z', false);
    await f.identity();
    const initial = await job([id], 'backfill', 'partial');
    await f.db.query('insert into public.creator_initializations(creator_id,initial_job_id,job_id) values($1,$2,$2)', [id, initial]);
    await job([id], 'profile', 'failed');
    const profileA = await job([id], 'profile', 'processing', '2026-02-01T00:00:00Z');
    const profileB = await job([id], 'profile', 'partial', '2026-02-01T00:00:00Z');
    await job([id], 'backfill', 'pending', '2026-03-01T00:00:00Z');
    const expectedProfile = profileA > profileB ? 'processing' : 'partial';
    await f.identity('authenticated');
    const result = (await page({ search: 'visible', limit: 1 })).items[0];
    expect(result).toMatchObject({ tracked_reels: 3, latest_reel_date: '2026-03-01T00:00:00+00:00',
      last_reels_fetch_at: '2026-10-01T12:34:56+00:00', last_profile_fetch_at: '2026-10-02T12:34:56+00:00',
      initial_backfill_job_id: initial, initial_backfill_status: 'partial', profile_job_status: expectedProfile });
    expect(result.last_error).not.toContain('secret');
    expect(result).not.toHaveProperty('profile_job_ids');
    expect(await singular(id)).toEqual(result);
    expect(await singular(never)).not.toHaveProperty('profile_job_status');
  });

  it('returns empty authorized workspaces, allows archived reads, and excludes inactive/foreign singular associations', async () => {
    await f.identity('authenticated');
    const other = (await f.rpc<{ id: string }>('create_workspace', ['Paged other'])).id;
    await f.identity();
    const foreign = await creator('foreign_only', other), inactive = await creator('inactive_only', f.workspace, false);
    const id = await creator();
    await f.db.query('update public.workspaces set archived_at=now() where id=$1', [f.workspace]);
    await f.identity('authenticated');
    expect((await page()).items.map(row => row.id)).toEqual([id]);
    expect((await directory()).map(row => row.id)).toEqual([id]);
    expect(await singular(id)).toHaveProperty('id', id);
    await rejects(() => singular(foreign), 'creator_not_found'); await rejects(() => singular(inactive), 'creator_not_found');
    await rejects(() => singular(fixtureStranger), 'creator_not_found');
    await f.identity(); await f.db.exec('update public.workspace_creators set active=false'); await f.identity('authenticated');
    expect(await page()).toEqual({ items: [], total: 0, page: 1, limit: 50 });
    expect(await directory()).toEqual([]);
    expect(await summary()).toMatchObject({ pending_jobs: 0, active_jobs: 0 });
  });

  it('counts all relevant jobs once beyond latest50, omits arrays/maps, and reconciles owner-wide old unknown blockers', async () => {
    const a = await creator(), b = await creator(), detached = await creator(undefined, f.workspace, false);
    await f.identity('authenticated');
    const other = (await f.rpc<{ id: string }>('create_workspace', ['Other ledger'])).id;
    await f.identity(); const foreign = await creator(undefined, other);
    const blocker = await job([foreign], 'carousel', 'uncertain', '2025-01-01T00:00:00Z', true);
    for (let index = 0; index < 61; index++) await job([a, b], index % 2 ? 'profile' : 'manual', 'pending', '2026-02-01T00:00:00Z');
    await job([a], 'manual', 'budget_paused');
    await job([a, b], 'profile', 'running'); await job([a], 'manual', 'processing');
    await job([a], 'carousel', 'pending'); await job([detached], 'manual', 'pending'); await job([foreign], 'manual', 'pending');
    await job([a], 'manual', 'succeeded'); await job([], 'manual', 'pending');
    await f.identity('authenticated');
    const state = await f.rpc<CreatorCollectionState>('get_creator_collection_state', [f.workspace]);
    const result = await summary();
    expect(result).toEqual({ reason: state.reason, blocking_job_id: blocker, pending_jobs: 62, active_jobs: 2 });
    expect(state.pending_job_ids).toHaveLength(62); expect(state.active_job_ids).toHaveLength(2);
    expect(Object.keys(result).sort()).toEqual(['active_jobs', 'blocking_job_id', 'pending_jobs', 'reason']);
    expect((await f.rpc<{ jobs: { id: string }[] }>('get_bootstrap')).jobs.some(row => row.id === blocker)).toBe(false);
    await f.identity(); await f.db.query('update public.scrape_jobs set actual_cost_usd=0,status=$1 where id=$2', ['succeeded', blocker]);
    await f.identity('authenticated'); expect((await summary()).blocking_job_id).toBeNull();
  });

  it('preserves every current multiaccount reason and keeps an old owner-wide unknown charge visible without fabricating costs', async () => {
    const id = await creator();
    const blocker = await job([], 'carousel', 'failed', '2025-01-01T00:00:00Z', true);
    const pending = await job([id], 'profile', 'pending');
    await f.db.query('update public.scrape_jobs set actual_cost_usd=0 where id=$1', [blocker]);
    const assertStateParity = async () => {
      const state = await f.rpc<CreatorCollectionState>('get_creator_collection_state', [f.workspace]);
      expect(await summary()).toEqual({ reason: state.reason, blocking_job_id: state.blocking_job_id,
        pending_jobs: state.pending_job_ids.length, active_jobs: state.active_job_ids.length });
      return state;
    };
    for (const setting of ['scraping_enabled=false', 'initial_backfill_enabled=false', 'monthly_budget_usd=0']) {
      await f.db.exec('savepoint guard_case'); await f.db.exec(`update public.app_settings set ${setting}`);
      await f.identity('authenticated'); await assertStateParity(); await f.identity();
      await f.db.exec('rollback to savepoint guard_case; release savepoint guard_case');
    }
    await f.db.query('update public.apify_accounts set enabled=false where owner_id=$1', [fixtureOwner]);
    await f.db.query('update public.scrape_jobs set actual_cost_usd=null where id=$1', [blocker]);
    await f.identity('authenticated');
    expect(await assertStateParity()).toMatchObject({ reason: 'unreconciled_charges', blocking_job_id: blocker, pending_job_ids: [pending] });
    expect(await summary()).toEqual({ reason: 'unreconciled_charges', blocking_job_id: blocker, pending_jobs: 1, active_jobs: 0 });
    await f.identity(); await f.db.query('update public.scrape_jobs set actual_cost_usd=0 where id=$1', [blocker]);
    await f.identity('authenticated'); expect(await assertStateParity()).toMatchObject({ reason: 'usage_unverified', blocking_job_id: null });
  });

  it.each([3, 4])('uses configured capacity %s in the lightweight collection summary', async limit => {
    const id = await creator();
    await f.db.exec('update public.app_settings set scraping_enabled=true,initial_backfill_enabled=true,monthly_budget_usd=50');
    await f.identity('service_role');
    await f.rpc('worker_configure_collection_throughput', [fixtureOwner, limit, limit]);
    for (let slot = 1; slot <= 5; slot++) {
      const providerId = slot === 1 ? 'fixture' : `summary-account-${slot}`;
      await f.rpc('worker_configure_apify_account', [fixtureOwner, slot, providerId, true, true]);
      await f.rpc('worker_record_account_usage', [fixtureOwner, slot, providerId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 20 * 86400000).toISOString(), 0, 50]);
    }
    await f.identity();
    for (let index = 0; index < limit - 1; index++) await job([id], 'manual', 'running');
    await f.identity('authenticated');
    expect((await summary()).reason).not.toBe('concurrency_limit');
    const state = await f.rpc<CreatorCollectionState>('get_creator_collection_state', [f.workspace]);
    expect((await summary()).reason).toBe(state.reason);
    await f.identity(); await job([id], 'profile', 'processing');
    await f.identity('authenticated');
    expect(await summary()).toMatchObject({ reason: 'concurrency_limit', active_jobs: limit });
  });

  it('does not leak foreign owner profile/initial jobs or count foreign owner jobs even on a malformed shared creator link', async () => {
    const id = await creator(); const foreignJob = await job([id], 'profile', 'pending');
    const initial = await job([id], 'backfill', 'pending');
    await f.db.exec('alter table public.app_settings drop constraint app_settings_singleton_key');
    await f.db.query('insert into public.app_settings(owner_user_id) values($1)', [fixtureStranger]);
    await f.db.query('update public.scrape_jobs set owner_user_id=$1 where id=any($2::uuid[])', [fixtureStranger, [foreignJob, initial]]);
    await f.db.query('insert into public.creator_initializations(creator_id,initial_job_id,job_id) values($1,$2,$2)', [id, initial]);
    await f.identity('authenticated');
    expect(await singular(id)).toMatchObject({ initial_backfill_job_id: null, initial_backfill_status: null });
    expect(await singular(id)).not.toHaveProperty('profile_job_status');
    expect(await summary()).toMatchObject({ pending_jobs: 0, active_jobs: 0 });
  });

  it('strictly validates SQL query types/bounds and independently authorizes all public read RPCs', async () => {
    const id = await creator();
    await f.identity('authenticated');
    for (const query of [{ limit: 51 }, { limit: 0 }, { page: 0 }, { page: 10001 }, { page: 1.5 }, { limit: '50' }, { search: null }, { search: 'x'.repeat(201) }, { owner_user_id: fixtureOwner }]) await rejects(() => page(query));
    for (const raw of ['null', '[]', 'true']) await rejects(() => f.rpc('query_creators', [f.workspace, raw]));
    const calls = [() => page({}, fixtureStranger), () => directory(fixtureStranger), () => singular(id, fixtureStranger), () => summary(fixtureStranger), () => f.rpc('query_carousel_summaries', [fixtureStranger, '{}'])];
    for (const call of calls) await rejects(call, 'forbidden');
    const signatures = ['query_creators(uuid,jsonb)', 'list_creator_directory(uuid)', 'get_creator(uuid,uuid)', 'get_creator_collection_summary(uuid)', 'query_carousel_summaries(uuid,jsonb)'];
    await f.identity();
    for (const signature of signatures) expect(await f.value(`select jsonb_build_object('stable',p.provolatile='s','definer',p.prosecdef,
      'path',p.proconfig,'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE')) v from pg_proc p where p.oid=$1::regprocedure`, [`public.${signature}`]))
      .toEqual({ stable: true, definer: true, path: ['search_path=pg_catalog, public'], anon: false, service: false });
    for (const role of ['anon', 'service_role']) {
      await f.identity(role);
      for (const call of [() => page(), () => directory(), () => singular(id), () => summary(), () => f.rpc('query_carousel_summaries', [f.workspace, '{}'])]) await rejects(call, 'permission denied');
    }
    await f.identity('authenticated', fixtureStranger);
    for (const call of [() => page(), () => directory(), () => singular(id), () => summary(), () => f.rpc('query_carousel_summaries', [f.workspace, '{}'])]) await rejects(call, 'forbidden');
  });

  it('supports read-only transactions without touching jobs, ledger, Cron, or network state', async () => {
    const id = await creator(); await job([id], 'profile', 'pending');
    const snapshot = () => f.value(`select jsonb_build_object('jobs',(select jsonb_agg(to_jsonb(j) order by id) from public.scrape_jobs j),
      'settings',(select jsonb_agg(to_jsonb(s)) from public.app_settings s),'requests',(select count(*) from net.requests),'cron',(select jsonb_agg(to_jsonb(c)) from cron.job c)) v`);
    const before = await snapshot(); await f.identity('authenticated');
    await page(); await directory(); await singular(id); await summary(); await f.rpc('query_carousel_summaries', [f.workspace, '{}']);
    await f.identity(); expect(await snapshot()).toEqual(before);
    await f.db.exec('rollback; begin read only'); await f.identity('authenticated');
    await page(); await directory(); await singular(f.creator); await summary(); await f.rpc('query_carousel_summaries', [f.workspace, '{}']);
  });
  it('matches established Reel JSON metrics/filter/order and neighbor positions on common pages and profile fallback', async () => {
    const id = await creator();
    await f.db.query("update public.creators set status='active',followers_count=1000,last_profile_fetch_at=now() where id=$1", [id]);
    const second = await creator();
    const ids: string[] = [];
    for (let index = 0; index < 67; index++) ids.push(await f.value<string>(`insert into public.reels(creator_id,shortcode,caption_preview,published_at,latest_views,latest_likes,latest_comments,views_state,likes_state,comments_state,latest_fetched_at,provider)
      values($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,now()-($9::integer*interval '1 hour'),'synthetic') returning id v`,
      [index % 3 === 0 ? second : id, `READ_REEL_${index}`, `Literal 100% _ \\ reel ${index}`, new Date(Date.UTC(2026, 10, 1, 0, 0, Math.floor(index / 2))).toISOString(),
        index % 7 === 0 ? null : index % 9 * 100, index % 7 === 0 ? null : index % 5 * 10, index % 7 === 0 ? null : index % 4,
        index % 7 === 0 ? 'hidden' : 'known', index]));
    await f.db.query("insert into public.saved_reels(workspace_id,reel_id,saved_by_user_id,note,completion_status,completed_at) values($1,$2,$3,'reel note','done',now())", [f.workspace, ids[60], fixtureOwner]);
    await f.db.query("insert into public.reel_tags(workspace_id,reel_id,tag) values($1,$2,'z'),($1,$2,'a')", [f.workspace, ids[60]]);
    await f.identity('authenticated');
    for (const query of [{}, { limit: 50, page: 2 }, { limit: 1, page: 10000 }, { sort: 'views' }, { sort: 'likes' }, { sort: 'comments', limit: 9, page: 3 },
      { sort: 'engagement' }, { sort: 'outlier' }, { sort: 'profile_outlier' }, { min_profile_outlier: 0 }, { max_profile_outlier: 2 },
      { min_views: 100, max_views: 400 }, { min_engagement: 0, max_engagement: 50 }, { min_outlier: 0, max_outlier: 100 },
      { creator_ids: [id], keywords: '_' }, { creator_ids: [] }, { creator_id: second }, { search: '%' }, { search: 'missing needle' },
      { saved: true }, { saved: false }, { status: 'pending' }, { freshness: 'fresh' }, { freshness: 'stale' },
      { platform: 'instagram' }, { from: '2026-11-01', to: '2026-11-02' }, { posted_amount: 31, posted_unit: 'days' }]) {
      const args = [f.workspace, JSON.stringify(query)];
      const reference = await f.rpc<PageResult<Reel>>('reference_query_reels', args);
      const result = await f.rpc<PageResult<Reel>>('query_reels', args);
      expect(result, JSON.stringify(query)).toEqual(reference);
      if (result.items.length) {
        const neighbors = await f.rpc<{ position: number; total: number }>('get_reel_neighbors', [f.workspace, result.items[0].id, JSON.stringify(query)]);
        expect(neighbors.total).toBe(result.total);
        expect(neighbors.position).toBe((result.page - 1) * result.limit + 1);
      }
    }
  }, 30_000);
});

async function seedCarousels() {
  const a = await creator('carousel_page_a'), b = await creator('carousel_page_b');
  await f.db.query(`insert into public.creator_follower_snapshots(creator_id,captured_date,followers_count,captured_at,source)
    values($1,'2026-01-01',1000,'2026-01-01T00:00:00Z','fixture'),($2,'2026-01-01',0,'2026-01-01T00:00:00Z','fixture')`, [a, b]);
  const ids: string[] = [];
  for (let index = 0; index < 74; index++) {
    const known = index % 8 !== 0;
    ids.push(await f.value<string>(`insert into public.carousel_posts(creator_id,shortcode,caption,slides,thumbnail_url,published_at,latest_likes,latest_comments,likes_state,comments_state,latest_fetched_at,provider)
      values($1,$2,$3,$4,null,$5,$6,$7,$8,$8,'2026-11-15T10:00:00Z','synthetic') returning id v`,
    [index % 3 === 0 ? b : a, `PAGED_CAROUSEL_${index}`, `Literal 100% _ \\ caption ${index} ` + 'full text '.repeat(200), JSON.stringify([{ position: 1, media_type: 'image', image_url: 'https://scontent.cdninstagram.com/cover.jpg', video_url: null }, { position: 2, media_type: 'video', image_url: null, video_url: 'https://scontent.cdninstagram.com/private.mp4' }]),
      index === 73 ? null : new Date(Date.UTC(2026, 10, 1, 0, 0, Math.floor(index / 2))).toISOString(), known ? index % 6 * 10 : null, known ? index % 4 : null, known ? 'known' : 'hidden']));
  }
  await f.db.query("insert into public.saved_carousels(workspace_id,carousel_id,saved_by_user_id,note,tags) values($1,$2,$3,'a note',array['tag'])", [f.workspace, ids[70], fixtureOwner]);
  return { a, b, ids };
}
describe('lean carousel query baseline parity', () => {
  it('matches original count/filter/order/metrics across sorts and page boundaries while leaving detail/full payload intact', async () => {
    const seeded = await seedCarousels(); await f.identity('authenticated');
    const queries = [
      {}, { page: 2, limit: 50 }, { page: 10_000, limit: 1 }, { sort: 'likes', limit: 9 }, { sort: 'comments', page: 3, limit: 11 },
      { sort: 'profile_outlier', page: 2, limit: 9 }, { sort: 'follower_engagement', limit: 17 }, { min_profile_outlier: 0 }, { max_profile_outlier: 2 },
      { min_interactions: 10, min_engagement: 0, max_engagement: 100 }, { min_outlier: 0, max_outlier: 100 }, { creator_ids: [seeded.a] },
      { creator_ids: [] }, { creator: seeded.b }, { saved: true }, { saved: false }, { search: '100%' }, { keywords: '_' }, { keywords: '\\' },
      { search: 'NO SUCH CAPTION' }, { posted_amount: 31, posted_unit: 'days', limit: 13 },
    ];
    for (const query of queries) {
      const args = [f.workspace, JSON.stringify(query)];
      const reference = await f.rpc<PageResult<Carousel>>('reference_query_carousels', args);
      const full = await f.rpc<PageResult<Carousel>>('query_carousels', args);
      expect(full, JSON.stringify(query)).toEqual(reference);
      const lean = await f.rpc<PageResult<CarouselSummary>>('query_carousel_summaries', args);
      expect({ total: lean.total, page: lean.page, limit: lean.limit }).toEqual({ total: reference.total, page: reference.page, limit: reference.limit });
      expect(lean.items).toEqual(reference.items.map(post => {
        const { caption, slides, ...rest } = post;
        return { ...rest, thumbnail_url: post.thumbnail_url ?? post.slides[0]?.image_url ?? null, caption_preview: caption.slice(0, 500), slide_count: slides.length };
      }));
      expect(JSON.stringify(lean)).not.toContain('private.mp4');
    }
    const detail = await f.rpc<{ carousel: Carousel }>('get_carousel_detail', [f.workspace, seeded.ids[70]]);
    expect(detail.carousel.slides).toHaveLength(2); expect(detail.carousel.caption.length).toBeGreaterThan(500);
  }, 30_000);
});
