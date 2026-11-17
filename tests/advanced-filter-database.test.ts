import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = 'c1000000-0000-4000-8000-000000000001';
const stranger = 'c1000000-0000-4000-8000-000000000002';
let workspace: string, secondWorkspace: string, creatorA: string, creatorB: string, foreignCreator: string;
let exact: string, exactSecond: string, missing: string;
let beforeItems: string[], beforeView: string, beforeWorkers: unknown[];
const migrationDirectory = join(process.cwd(), 'supabase/migrations');
type Query = Record<string, unknown>;
type Page = { items: Record<string, unknown>[]; total: number; page: number; limit: number };
type Preset = { id: string; name: string; config: { version: number; query: Query }; created_at: string };

async function identity(role: 'postgres' | 'anon' | 'authenticated' | 'service_role' = 'postgres', user: string | null = owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: user })]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  return value<T>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`, args);
}
async function query(q: Query = {}, scope = workspace) {
  return rpc<Page>('query_reels', [scope, JSON.stringify(q)]);
}
async function create(name: string, q: Query = {}) {
  return rpc<Preset>('create_reel_filter', [name, JSON.stringify(q)]);
}
async function revision() {
  return value<number>('select revision::int as value from public.owner_revisions where owner_user_id=$1', [owner]);
}
async function workers() {
  return (await db.query("select proname,prosrc,proargnames,proacl::text from pg_proc where pronamespace='public'::regnamespace and (proname like 'worker_%' or proname like 'transcription_%') order by proname,oid")).rows;
}
async function insertReel(shortcode: string, creator: string, caption: string, views: number | null, likes: number | null, comments: number | null, date = '2026-11-08T10:00:00+05:30', stale = false) {
  return value<string>(`insert into public.reels(creator_id,shortcode,caption_preview,published_at,latest_fetched_at,provider,
    latest_views,latest_likes,latest_comments,views_state,likes_state,comments_state)
    values($1,$2,$3,$4,now() - case when $8 then interval '49 hours' else interval '0 hours' end,'fixture',
      $5,$6,$7,case when $5::bigint is null then 'hidden' else 'known' end,
      case when $6::bigint is null then 'hidden' else 'known' end,case when $7::bigint is null then 'hidden' else 'known' end)
    returning id as value`, [creator, shortcode, caption, date, views, likes, comments, stale]);
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    -- PGlite has no hosted extensions. Only migration008's external facilities are stand-ins;
    -- its actual SQL functions still run, and no schedule/provider request is installed.
    create schema vault; create schema cron; create schema net;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(label text,schedule text,command text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(label,schedule,command) returning jobid $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;
  `);
  for (const file of [
    '202611080001_schema.sql', '202611080002_queue.sql', '202611080003_initial_backfill_and_usage.sql',
    '202611080004_nullable_provider_timestamps.sql', '202611080005_assumed_ist_publication.sql',
    '202611080006_owner_realtime_revision.sql', '202611080007_transcription.sql',
    '202611080008_transcription_maintenance.sql',
  ]) {
    const sql = readFileSync(join(migrationDirectory, file), 'utf8');
    await db.exec(file.includes('008_') ? sql.replace(/^create extension[^;]+;\s*/gm, '') : sql);
  }
  await db.query('insert into auth.users values($1),($2)', [owner, stranger]);
  await identity('service_role'); await rpc('provision_owner', [owner]);
  await identity('authenticated');
  workspace = (await rpc<{ id: string }>('create_workspace', ['Advanced fixture'])).id;
  secondWorkspace = (await rpc<{ id: string }>('create_workspace', ['Second fixture'])).id;
  await identity();
  creatorA = await value<string>("insert into public.creators(username,status,followers_count) values('advanced_alpha','active',100) returning id as value");
  creatorB = await value<string>("insert into public.creators(username,status,followers_count) values('advanced_beta','active',200) returning id as value");
  foreignCreator = await value<string>("insert into public.creators(username,status,followers_count) values('advanced_foreign','active',100) returning id as value");
  await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2),($1,$3),($4,$2)', [workspace, creatorA, creatorB, secondWorkspace]);
  // A: views1000, engagement10%, outlier11 exactly. B: views2000, engagement10%, outlier11.
  exact = await insertReel('EXACT', creatorA, 'Launch 100%_\\ [Hook]', 1000, 80, 20);
  exactSecond = await insertReel('EXACT_SECOND', creatorA, 'LAUNCH 100%_\\ [hook] again', 1000, 100, 0);
  await insertReel('BETA', creatorB, 'Launch beta', 2000, 160, 40);
  await insertReel('LOW', creatorA, 'Launch lower', 999, 80, 19);
  await insertReel('HIGH', creatorA, 'Launch higher', 1001, 80, 21);
  await insertReel('STALE', creatorA, 'Other caption', 1000, 80, 20, '2026-11-08T10:00:00+05:30', true);
  await insertReel('OLD', creatorA, 'Launch old', 1000, 80, 20, '2020-01-01T00:00:00Z');
  missing = await insertReel('MISSING', creatorA, 'Unknown views', null, 80, 20);
  await insertReel('MISSING_LIKES', creatorA, 'Unknown likes', 1000, null, 20);
  await insertReel('ZERO', creatorA, 'Zero views', 0, 0, 0);
  await insertReel('FOREIGN', foreignCreator, 'Launch 100%_\\ [Hook]', 1000, 80, 20);
  await identity('authenticated');
  await rpc('set_bookmark', [workspace, exact, true, 'Bookmark note', ['hook']]);
  beforeItems = Object.keys((await query()).items[0]).sort();
  await identity();
  beforeView = await value<string>("select pg_get_viewdef('public.reels_summary'::regclass,true) as value");
  beforeWorkers = await workers();
  await db.exec(readFileSync(join(migrationDirectory, '202611080009_advanced_reel_filters.sql'), 'utf8'));
}, 60000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await identity(); await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); await identity(); });

describe('advanced criteria on actual latest PostgreSQL migrations', () => {
  it('preserves named arguments, default legacy shape, view, transcription and worker contracts', async () => {
    expect(await value<string[]>("select proargnames as value from pg_proc where oid='public.query_reels(uuid,jsonb)'::regprocedure")).toEqual(['p_workspace_id', 'p_query']);
    expect(await value<string>("select pg_get_viewdef('public.reels_summary'::regclass,true) as value")).toBe(beforeView);
    expect(await workers()).toEqual(beforeWorkers);
    await identity('authenticated');
    const page = await value<Page>('select public.query_reels(p_workspace_id => $1) as value', [workspace]);
    expect(Object.keys(page).sort()).toEqual(['items', 'limit', 'page', 'total']);
    expect(page).toMatchObject({ page: 1, limit: 30, total: 10 });
    expect(Object.keys(page.items[0]).sort()).toEqual(beforeItems);
    expect(page.items.some(item => item.id === missing)).toBe(true); // No UI default thresholds.
    expect(page.items[0]).toHaveProperty('published_at_basis');
    expect(await rpc('get_reel_transcript', [workspace, exact])).toMatchObject({ status: 'not_requested' });
  });

  it('adds only the constrained default platform and keeps payloads unpublished', async () => {
    expect(await value<string>('select platform as value from public.reels where id=$1', [exact])).toBe('instagram');
    await db.exec('savepoint invalid_platform');
    await expect(db.query("update public.reels set platform='youtube' where id=$1", [exact])).rejects.toThrow(/reels_platform_check/);
    await db.exec('rollback to invalid_platform');
    await expect(db.query('update public.reels set platform=null where id=$1', [exact])).rejects.toThrow(/not-null/);
    await db.exec('rollback to invalid_platform');
    expect((await db.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname='supabase_realtime'")).rows.map(x => x.tablename)).toEqual(['owner_revisions']);
    await identity('authenticated');
    expect((await query({ platform: 'instagram' })).total).toBe(10);
  });

  it('combines every criterion with AND before totals and pagination, including saved/status/freshness', async () => {
    await identity('authenticated');
    const all = { creator_ids: [creatorA, creatorB], creator_id: creatorA, min_views: 1000, max_views: 1000,
      min_engagement: 10, max_engagement: 10, min_outlier: 11, max_outlier: 11, keywords: '100%_\\ [hOoK]',
      search: 'advanced_alpha', from: '2026-11-08', to: '2026-11-08', platform: 'instagram', status: 'active', freshness: 'fresh', sort: 'views', limit: 1 };
    const page1 = await query(all), page2 = await query({ ...all, page: 2 }), page3 = await query({ ...all, page: 3 });
    expect(page1.total).toBe(2); expect(page2.total).toBe(2);
    expect(new Set([...page1.items, ...page2.items].map(x => x.id))).toEqual(new Set([exact, exactSecond]));
    expect(page3.items).toEqual([]); expect(page3.total).toBe(2);
    expect((await query({ ...all, saved: true })).items.map(x => x.id)).toEqual([exact]);
    expect((await query({ ...all, saved: false })).items.map(x => x.id)).toEqual([exactSecond]);
    expect((await query({ ...all, freshness: 'stale' })).total).toBe(0);
    expect((await query({ ...all, status: 'private' })).total).toBe(0);
    expect((await query({ ...all, creator_ids: [creatorB] })).total).toBe(0);
    expect((await query({ saved: true }, secondWorkspace)).total).toBe(0);
  });

  it('uses UUID arrays as intersections, accepts120 entries and duplicates but empty never means all', async () => {
    await identity('authenticated');
    expect((await query({ creator_ids: [] })).total).toBe(0);
    expect((await query({ creator_ids: [], creator_id: creatorA })).total).toBe(0);
    expect((await query({ creator_ids: [foreignCreator] })).total).toBe(0);
    expect((await query({ creator_id: foreignCreator })).total).toBe(0);
    expect((await query({ creator_ids: Array(120).fill(creatorB.toUpperCase()) })).total).toBe(1);
    expect((await query({ creator_ids: [creatorA, creatorA] })).total).toBe(9);
    expect((await query({ creator_ids: [creatorB], creator_id: creatorA })).total).toBe(0);
  });

  it('includes exact endpoints, excludes unknown metrics rather than treating null as zero', async () => {
    await identity('authenticated');
    expect((await query({ creator_ids: [creatorB], min_views: 2000, max_views: 2000, min_engagement: 10, max_engagement: 10, min_outlier: 11, max_outlier: 11 })).total).toBe(1);
    expect((await query({ creator_ids: [creatorB], min_engagement: 10.01 })).total).toBe(0);
    expect((await query({ creator_ids: [creatorB], max_engagement: 9.99 })).total).toBe(0);
    expect((await query({ creator_ids: [creatorB], min_outlier: 11.01 })).total).toBe(0);
    expect((await query({ creator_ids: [creatorB], max_outlier: 10.99 })).total).toBe(0);
    expect((await query({ max_views: 0 })).items.map(x => x.shortcode)).toEqual(['ZERO']);
    expect((await query({ max_engagement: 0 })).items).toEqual([]); // Zero-view rate is null.
    expect((await query({ max_outlier: 0 })).items.map(x => x.shortcode)).toEqual(['ZERO']);
    expect((await query({ min_views: 0 })).total).toBe(9);
    expect((await query({ min_engagement: 0 })).total).toBe(7);
    expect((await query({ min_outlier: 0 })).total).toBe(8);
    expect((await query({ keywords: 'Unknown' })).total).toBe(2);
    expect((await query({ keywords: 'Unknown', max_views: 10000000 })).items.map(x => x.shortcode)).toEqual(['MISSING_LIKES']);
    expect((await query({ keywords: 'Unknown', max_outlier: 100 })).total).toBe(0);
    expect((await query({ keywords: 'Unknown', max_engagement: 100 })).total).toBe(0);
  });

  it('accepts exact UI maxima10m/100/100 without rounding thresholds', async () => {
    const highCreator = await value<string>("insert into public.creators(username,status,followers_count) values('maxima_fixture','active',200000) returning id as value");
    await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2)', [workspace, highCreator]);
    const high = await insertReel('MAXIMA', highCreator, 'maximum boundary', 10000000, 10000000, 0);
    await identity('authenticated');
    const q = { creator_ids: [highCreator], min_views: 10000000, max_views: 10000000, min_engagement: 100, max_engagement: 100, min_outlier: 100, max_outlier: 100 };
    expect((await query(q)).items.map(x => x.id)).toEqual([high]);
    expect((await query({ ...q, min_views: 0, max_views: 9999999 })).total).toBe(0);
    expect((await query({ ...q, min_engagement: 0, max_engagement: 99.999 })).total).toBe(0);
    expect((await query({ ...q, min_outlier: 0, max_outlier: 99.999 })).total).toBe(0);
  });

  it('treats new keywords literally and caption-only while preserving legacy search behavior', async () => {
    await identity('authenticated');
    expect((await query({ keywords: '%' })).total).toBe(2);
    expect((await query({ keywords: '_' })).total).toBe(2);
    expect((await query({ keywords: '\\' })).total).toBe(2);
    expect((await query({ keywords: '[HOOK]' })).total).toBe(2);
    expect((await query({ keywords: 'advanced_alpha' })).total).toBe(0);
    expect((await query({ search: 'advanced_alpha' })).total).toBe(9);
    expect((await query({ search: '%' })).total).toBe(10);
    expect((await query({ search: 'beta', keywords: '100%' })).total).toBe(0);
    expect((await query({ keywords: '' })).total).toBe(10);
  });

  it('uses inclusive IST calendar bounds including subsecond end-of-day edges', async () => {
    const ids = [
      await insertReel('DATE_BEFORE', creatorA, 'date edge', 1, 0, 0, '2026-01-30T18:29:59.999Z'),
      await insertReel('DATE_START', creatorA, 'date edge', 1, 0, 0, '2026-01-30T18:30:00Z'),
      await insertReel('DATE_END', creatorA, 'date edge', 1, 0, 0, '2026-01-31T18:29:59.999Z'),
      await insertReel('DATE_AFTER', creatorA, 'date edge', 1, 0, 0, '2026-01-31T18:30:00Z'),
    ];
    await db.exec("set local timezone='America/Los_Angeles'");
    await identity('authenticated');
    const result = await query({ keywords: 'date edge', from: '2026-01-31', to: '2026-01-31' });
    expect(new Set(result.items.map(x => x.id))).toEqual(new Set(ids.slice(1, 3)));
    expect((await query({ from: '2020-01-01', to: '2021-01-01' })).total).toBe(1); // Exactly366 days (leap year).
  });

  it('resolves rolling IST days/weeks/months with month-end clamp and no session-timezone dependence', async () => {
    // PostgreSQL's builtin now() cannot be faked by JavaScript timers. Replace only
    // the validator's clock expression inside this rollback-only transaction; every
    // validation/calendar/filter statement remains the actual migration definition.
    const definition = await value<string>("select pg_get_functiondef('public.validate_reel_query(jsonb)'::regprocedure) as value");
    const freeze = (iso: string) => db.exec(definition.replace('now()', `'${iso}'::timestamptz`));
    await freeze('2026-03-31T18:00:00Z');
    await db.exec("set local timezone='Pacific/Honolulu'");
    const normalize = (q: Query) => rpc<Query>('validate_reel_query', [JSON.stringify(q)]);
    expect(await normalize({ posted_amount: 1, posted_unit: 'months' })).toEqual({ from: '2026-02-28', to: '2026-03-31' });
    expect(await normalize({ posted_amount: 9, posted_unit: 'months' })).toEqual({ from: '2025-06-30', to: '2026-03-31' });
    expect(await normalize({ posted_amount: 1, posted_unit: 'weeks' })).toEqual({ from: '2026-03-24', to: '2026-03-31' });
    expect(await normalize({ posted_amount: 366, posted_unit: 'days' })).toEqual({ from: '2025-03-30', to: '2026-03-31' });
    expect(await normalize({ from: '2026-01-01' })).toEqual({ from: '2026-01-01', to: '2027-01-02' });
    expect(await normalize({ to: '2026-01-01' })).toEqual({ from: '2024-12-31', to: '2026-01-01' });
    await insertReel('ROLLING', creatorA, 'rolling boundary', 1, 0, 0, '2026-02-27T18:30:00Z');
    await insertReel('ROLLING_BEFORE', creatorA, 'rolling boundary', 1, 0, 0, '2026-02-27T18:29:59Z');
    await identity('authenticated');
    const rolling = await query({ keywords: 'rolling boundary', posted_amount: 1, posted_unit: 'months' });
    expect(rolling.items.map(x => x.shortcode)).toEqual(['ROLLING']);
    expect(rolling).toEqual(await query({ keywords: 'rolling boundary', from: '2026-02-28', to: '2026-03-31' }));
    const preset = await create('Rolling', { posted_amount: 1, posted_unit: 'months', sort: 'outlier' });
    expect(preset.config.query).toEqual({ posted_amount: 1, posted_unit: 'months', sort: 'outlier' });
    await identity();
    await freeze('2024-03-31T18:30:00Z');
    expect(await normalize({ posted_amount: 1, posted_unit: 'months' })).toEqual({ from: '2024-03-01', to: '2024-04-01' }); // IST has crossed midnight.
    await freeze('2024-03-31T00:00:00Z');
    expect(await normalize({ posted_amount: 1, posted_unit: 'months' })).toEqual({ from: '2024-02-29', to: '2024-03-31' });
    expect(await normalize({ posted_amount: 12, posted_unit: 'months' })).toEqual({ from: '2023-03-31', to: '2024-03-31' });
  });

  it('validates allowed keys, JSON types, UUID lists, bounds and date orders inside direct RPCs and presets', async () => {
    const invalid: unknown[] = [
      null, [], 'string', { unknown: true }, { view: 'grid' },
      ...['search', 'keywords', 'sort', 'freshness', 'status', 'platform', 'creator_id', 'from', 'to', 'posted_unit'].flatMap(k => [{ [k]: null }, { [k]: 1 }, { [k]: {} }]),
      { search: 'a'.repeat(201) }, { keywords: 'a'.repeat(201) }, { saved: 'false' }, { saved: null },
      { creator_id: 'not-uuid' }, { creator_id: owner.replaceAll('-', '') },
      { creator_ids: '[]' }, { creator_ids: null }, { creator_ids: [null] }, { creator_ids: [1] },
      { creator_ids: [creatorA, 'invalid'] }, { creator_ids: [[], creatorA] }, { creator_ids: Array(121).fill(creatorA) },
      { platform: 'youtube' }, { sort: 'random' }, { freshness: 'recent' }, { status: 'everything' },
      ...['min_views', 'max_views', 'min_engagement', 'max_engagement', 'min_outlier', 'max_outlier'].flatMap(k => [
        { [k]: -0.01 }, { [k]: null }, { [k]: '0' }, { [k]: false }, { [k]: k.includes('views') ? 10000001 : 100.001 },
      ]),
      { min_views: 0.5 }, { max_views: 1.5 }, { min_views: 2, max_views: 1 },
      { min_engagement: 10, max_engagement: 9 }, { min_outlier: 3, max_outlier: 2 },
      { from: '2026-02-30' }, { from: '2026-13-01' }, { from: '2026-1-01' }, { to: '' }, { to: '0000-01-01' },
      { from: '2026-02-01', to: '2026-01-01' }, { from: '2020-01-01', to: '2021-01-02' },
      { posted_amount: 1 }, { posted_unit: 'days' }, { posted_amount: 0, posted_unit: 'days' },
      { posted_amount: -1, posted_unit: 'days' }, { posted_amount: 1.5, posted_unit: 'days' },
      { posted_amount: '1', posted_unit: 'days' }, { posted_amount: null, posted_unit: 'days' },
      { posted_amount: 367, posted_unit: 'days' }, { posted_amount: 53, posted_unit: 'weeks' },
      { posted_amount: 13, posted_unit: 'months' }, { posted_amount: 1e20, posted_unit: 'months' },
      { posted_amount: 1, posted_unit: 'years' }, { posted_amount: 1, posted_unit: 'days', from: '2026-01-01' },
      { posted_amount: 1, posted_unit: 'days', to: '2026-01-01' },
    ];
    await identity('authenticated');
    // Savepoints recover actual PostgreSQL aborted transactions after each rejected statement.
    for (const q of invalid) {
      await db.exec('savepoint bad_query');
      await expect(rpc('query_reels', [workspace, JSON.stringify(q)])).rejects.toMatchObject({ code: '22023' });
      await db.exec('rollback to bad_query');
      await expect(rpc('create_reel_filter', ['Invalid', JSON.stringify(q)])).rejects.toMatchObject({ code: '22023' });
      await db.exec('rollback to bad_query'); await db.exec('release bad_query');
    }
    for (const q of [{ page: 0 }, { page: 10001 }, { page: 1.5 }, { limit: 0 }, { limit: 51 }, { limit: '30' }, { page: null }]) {
      await db.exec('savepoint bad_page');
      await expect(query(q)).rejects.toMatchObject({ code: '22023', message: 'invalid_pagination' });
      await db.exec('rollback to bad_page'); await db.exec('release bad_page');
    }
    expect((await query({ min_views: 0, max_views: 10000000, min_engagement: 0, max_engagement: 100, min_outlier: 0, max_outlier: 100, search: 'a'.repeat(200), keywords: 'b'.repeat(200) })).total).toBe(0);
    expect((await query({ page: 1.0, limit: 1.0 })).items).toHaveLength(1);
  }, 30000);
});

describe('account-level saved filter authorization and transactional persistence', () => {
  it('also installs after006 without any transcription schema or worker changes', async () => {
    const baseline = new PGlite();
    try {
      await baseline.exec(`
        create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; create table auth.users(id uuid primary key);
        create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
        create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
        create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
        grant usage on schema auth,public to anon,authenticated,service_role;
        grant execute on all functions in schema auth to anon,authenticated,service_role;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
      `);
      for (const file of [
        '202611080001_schema.sql','202611080002_queue.sql','202611080003_initial_backfill_and_usage.sql',
        '202611080004_nullable_provider_timestamps.sql','202611080005_assumed_ist_publication.sql',
        '202611080006_owner_realtime_revision.sql',
      ]) await baseline.exec(readFileSync(join(migrationDirectory, file), 'utf8'));
      await baseline.query('insert into auth.users values($1)', [owner]);
      await baseline.query('insert into public.app_settings(owner_user_id) values($1)', [owner]);
      const oldWorker = (await baseline.query("select pg_get_functiondef('public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure) definition")).rows;
      await baseline.exec(readFileSync(join(migrationDirectory, '202611080009_advanced_reel_filters.sql'), 'utf8'));
      expect((await baseline.query("select pg_get_functiondef('public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure) definition")).rows).toEqual(oldWorker);
      expect((await baseline.query("select to_regclass('public.transcript_jobs') table_name")).rows[0]).toEqual({ table_name: null });
      await baseline.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'authenticated', sub: owner })]);
      await baseline.exec('set role authenticated');
      const wid = (await baseline.query<{ value: { id: string } }>("select public.create_workspace('Baseline') value")).rows[0].value.id;
      const page = (await baseline.query<{ value: Page }>('select public.query_reels(p_workspace_id => $1,p_query => $2) value', [wid, '{"creator_ids":[],"posted_amount":12,"posted_unit":"months","platform":"instagram"}'])).rows[0].value;
      expect(page).toEqual({ items: [], total: 0, page: 1, limit: 30 });
      const preset = (await baseline.query<{ value: Preset }>("select public.create_reel_filter('Baseline','{\"sort\":\"outlier\"}') value")).rows[0].value;
      expect(preset.config).toEqual({ version: 1, query: { sort: 'outlier' } });
      expect((await baseline.query<{ value: Preset[] }>('select public.list_reel_filters() value')).rows[0].value).toEqual([preset]);
      await baseline.query('select public.delete_reel_filter($1)', [preset.id]);
      expect((await baseline.query<{ value: Preset[] }>('select public.list_reel_filters() value')).rows[0].value).toEqual([]);
      expect((await baseline.query('select id from public.scrape_jobs')).rows).toEqual([]);
      await baseline.exec('reset role');
      expect((await baseline.query("select tablename from pg_publication_tables where pubname='supabase_realtime'")).rows).toEqual([{ tablename: 'owner_revisions' }]);
    } finally { await baseline.close(); }
  }, 60000);

  it('revokes broad default ACLs and exposes only owner-read tables and authenticated RPCs', async () => {
    expect(await value<boolean>("select relrowsecurity as value from pg_class where oid='public.saved_reel_filters'::regclass")).toBe(true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
        expect(await value<boolean>('select has_table_privilege($1,$2,$3) as value', [role, 'public.saved_reel_filters', privilege])).toBe(false);
      }
      expect(await value<boolean>('select has_table_privilege($1,$2,\'select\') as value', [role, 'public.saved_reel_filters'])).toBe(role === 'authenticated');
      expect(await value<boolean>('select has_function_privilege($1,$2,\'execute\') as value', [role, 'public.validate_reel_query(jsonb)'])).toBe(false);
      for (const signature of ['list_reel_filters()', 'create_reel_filter(text,jsonb)', 'delete_reel_filter(uuid)', 'query_reels(uuid,jsonb)']) {
        expect(await value<boolean>('select has_function_privilege($1,$2,\'execute\') as value', [role, `public.${signature}`])).toBe(role === 'authenticated');
      }
    }
    const functions = (await db.query<{ proname: string; proconfig: string[] }>("select proname,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('validate_reel_query','query_reels','list_reel_filters','create_reel_filter','delete_reel_filter')")).rows;
    expect(functions).toHaveLength(5);
    for (const f of functions) expect(f.proconfig).toEqual(['search_path=pg_catalog, public']);
    const publicGrants = await db.query("select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.pronamespace='public'::regnamespace and p.proname in ('validate_reel_query','query_reels','list_reel_filters','create_reel_filter','delete_reel_filter') and a.grantee=0");
    expect(publicGrants.rows).toEqual([]);
  });

  it('stores exact version1 criteria and survives transactions and workspace changes', async () => {
    await identity('authenticated');
    const criteria = { creator_ids: [creatorA], keywords: '100%', min_outlier: 0, max_outlier: 100, posted_amount: 9, posted_unit: 'months', platform: 'instagram', sort: 'engagement' };
    const preset = await create('  My saved filter  ', criteria);
    expect(Object.keys(preset).sort()).toEqual(['config', 'created_at', 'id', 'name']);
    expect(preset).toMatchObject({ name: 'My saved filter', config: { version: 1, query: criteria } });
    await db.exec('commit'); // A real committed row, not browser state.
    await db.exec('begin');
    await identity(); await db.query('update public.workspaces set archived_at=now() where id=$1', [workspace]);
    await identity('authenticated');
    expect(await rpc<Preset[]>('list_reel_filters')).toEqual([preset]);
    expect((await db.query('select config from public.saved_reel_filters')).rows[0]).toEqual({ config: preset.config });
    await db.exec('rollback'); // Restore workspace before committing cleanup of the persisted row.
    await db.exec('begin'); await rpc('delete_reel_filter', [preset.id]); await db.exec('commit'); await db.exec('begin');
  });

  it('denies stranger/anonymous/null-user operations, foreign deletes, helper calls and direct writes', async () => {
    await identity('authenticated'); const preset = await create('Private');
    for (const statement of [
      "insert into public.saved_reel_filters(owner_user_id,name,config) values(auth.uid(),'Bypass','{\"version\":1,\"query\":{}}')",
      "update public.saved_reel_filters set name='Overwrite'", 'delete from public.saved_reel_filters',
      "select public.validate_reel_query('{}')",
    ]) {
      await db.exec('savepoint denied'); await expect(db.exec(statement)).rejects.toThrow(/permission denied/);
      await db.exec('rollback to denied'); await db.exec('release denied');
    }
    // A foreign ownership row is only possible for the migration owner in this singleton MVP.
    await identity();
    await db.query('alter table public.saved_reel_filters drop constraint saved_reel_filters_owner_user_id_fkey');
    const foreign = await value<string>("insert into public.saved_reel_filters(owner_user_id,name,config) values($1,'Foreign','{\"version\":1,\"query\":{}}') returning id as value", [stranger]);
    await identity('authenticated');
    expect((await db.query('select id from public.saved_reel_filters')).rows).toEqual([{ id: preset.id }]);
    await db.exec('savepoint foreign_delete');
    await expect(rpc('delete_reel_filter', [foreign])).rejects.toMatchObject({ code: '42501', message: 'reel_filter_not_found' });
    await db.exec('rollback to foreign_delete'); await db.exec('release foreign_delete');
    for (const [role, user] of [['authenticated', stranger], ['authenticated', null], ['anon', null], ['service_role', owner]] as const) {
      await identity(role, user);
      if (role === 'authenticated') expect((await db.query('select * from public.saved_reel_filters')).rows).toEqual([]);
      for (const [name, args] of [['list_reel_filters', []], ['create_reel_filter', ['Blocked', '{}']], ['delete_reel_filter', [preset.id]], ['query_reels', [workspace, '{}']]] as [string, unknown[]][]) {
        await db.exec('savepoint forbidden');
        await expect(rpc(name, args)).rejects.toMatchObject({ code: '42501' });
        await db.exec('rollback to forbidden'); await db.exec('release forbidden');
      }
    }
  });

  it('validates names, rejects duplicate names explicitly without overwriting, excludes UI pagination fields', async () => {
    await identity('authenticated'); const preset = await create('Unique', { sort: 'views' });
    for (const name of ['', '   ', 'a'.repeat(81), null]) {
      await db.exec('savepoint bad_name');
      await expect(rpc('create_reel_filter', [name, '{}'])).rejects.toMatchObject({ code: '22023', message: 'invalid_reel_filter_name' });
      await db.exec('rollback to bad_name'); await db.exec('release bad_name');
    }
    for (const name of ['Unique', 'unique', '  UNIQUE  ']) {
      await db.exec('savepoint duplicate');
      await expect(create(name, { sort: 'outlier' })).rejects.toMatchObject({ code: '23505', message: 'reel_filter_name_exists' });
      await db.exec('rollback to duplicate'); await db.exec('release duplicate');
    }
    for (const key of ['page', 'limit', 'view']) {
      await db.exec('savepoint bad_config');
      await expect(create('Bad config', { [key]: key === 'view' ? 'grid' : 1 })).rejects.toMatchObject({ code: '22023', message: 'invalid_reel_filter_config' });
      await db.exec('rollback to bad_config'); await db.exec('release bad_config');
    }
    expect(await rpc('list_reel_filters')).toEqual([preset]);
    expect((await create('a'.repeat(80))).name).toHaveLength(80);
    expect((await create('Empty creators', { creator_ids: [] })).config.query).toEqual({ creator_ids: [] });
  });

  it('limits owners to50 presets and releases capacity only on an authorized deletion', async () => {
    await identity('authenticated');
    let first: Preset | undefined;
    for (let i = 0; i < 50; i++) { const p = await create(`Preset ${i}`); if (i === 0) first = p; }
    expect(await rpc<Preset[]>('list_reel_filters')).toHaveLength(50);
    await db.exec('savepoint cap');
    await expect(create('Overflow')).rejects.toMatchObject({ code: '22023', message: 'reel_filter_limit_reached' });
    await db.exec('rollback to cap');
    await expect(create('PRESET 0')).rejects.toMatchObject({ code: '23505', message: 'reel_filter_name_exists' });
    await db.exec('rollback to cap'); await db.exec('release cap');
    await rpc('delete_reel_filter', [first!.id]);
    await create('Replacement'); expect(await rpc<Preset[]>('list_reel_filters')).toHaveLength(50);
  });

  it('rolls back config/revisions atomically, coalesces multiple changes, and never creates provider work', async () => {
    const start = await revision();
    const jobs = await value<number>('select count(*)::int as value from public.scrape_jobs');
    const transcripts = await value<number>('select count(*)::int as value from public.transcript_jobs');
    await db.exec('savepoint mutation');
    await identity('authenticated');
    const temporary = await create('Rollback'); expect(await revision()).toBe(start + 1);
    await db.exec('rollback to mutation'); expect(await revision()).toBe(start);
    expect(await rpc('list_reel_filters')).toEqual([]);
    const p1 = await create('Commit one'), p2 = await create('Commit two');
    await rpc('delete_reel_filter', [p1.id]);
    expect(await revision()).toBe(start + 1);
    await db.exec('commit'); await db.exec('begin');
    expect(await rpc('list_reel_filters')).toEqual([p2]);
    const beforeDelete = await revision();
    await rpc('delete_reel_filter', [p2.id]); expect(await revision()).toBe(beforeDelete + 1);
    await db.exec('savepoint missing_delete');
    await expect(rpc('delete_reel_filter', [temporary.id])).rejects.toMatchObject({ code: '42501' });
    await db.exec('rollback to missing_delete'); await db.exec('release missing_delete');
    await db.exec('commit'); await db.exec('begin');
    expect(await rpc('list_reel_filters')).toEqual([]);
    await identity();
    expect(await value<number>('select count(*)::int as value from public.scrape_jobs')).toBe(jobs);
    expect(await value<number>('select count(*)::int as value from public.transcript_jobs')).toBe(transcripts);
    expect(await value<number>('select count(*)::int as value from cron.job')).toBe(0);
    expect(await value<number>('select count(*)::int as value from net.requests')).toBe(0);
    expect(await value<number>('select count(*)::int as value from vault.secrets')).toBe(0);
    expect(await workers()).toEqual(beforeWorkers);
  });
});
