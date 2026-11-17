import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeReel, timestampBasis, zonedTimestamp, type Context } from '../supabase/functions/_shared/model';
import type { Reel } from '../src/lib/types';
import { safeReel } from '../src/lib/server/public-data';
import { DemoRepository } from '../src/lib/server/demo-repository';

const owner = 'c0000000-0000-4000-8000-000000000001';
const stranger = 'c0000000-0000-4000-8000-000000000002';
const context = { job: { started_at: '2026-11-08T00:00:00Z' }, creators: [{ id: 'creator', username: 'example' }] } as Context;
const sample = { ownerUsername: 'example', id: '123456_987654', url: 'https://www.instagram.com/reel/ABC_123/', videoPlayCount: 100, likesCount: -1, commentsCount: 0 };

describe('provider publication timestamps never gain an invented timezone', () => {
  it('retains the full caption independently of the provider title and bounds malformed fields', () => {
    const caption = 'Complete caption.\n\n' + 'More words '.repeat(100);
    const row = { ...sample, timestamp: '2026-11-01T00:00:00Z', title: 'Shortened title…', caption };
    expect(normalizeReel(row, context, 'test').record).toMatchObject({ caption_full: caption, caption_preview: row.title });
    for (const caption of [null, { text: 'bad' }, 'x'.repeat(20001)]) expect(normalizeReel({ ...row, caption }, context, 'test').record?.caption_full).toBeNull();
  });
  it('interprets valid naive upload dates as user-approved IST while retaining source text', () => {
    for (const timestamp of ['2026-08-10T20:06:13', '2024-02-29T23:59:59.123456789']) {
      const result = normalizeReel({ ...sample, timestamp }, context, 'test');
      expect(result.error).toBeUndefined();
      expect(result.record).toMatchObject({ published_at: new Date(`${timestamp}+05:30`).toISOString(), published_at_raw: timestamp, published_at_basis: 'assumed_Asia/Kolkata', instagram_media_id: sample.id, views: 100, likes: null, likes_state: 'hidden', comments: 0 });
      expect(zonedTimestamp(timestamp)).toBeNull();
    }
    expect(normalizeReel({ ...sample, timestamp: '2030-01-01T00:00:00' }, context, 'test').record).toBeUndefined();
  });
  it('retains explicit offsets and rejects invalid, missing and future verified dates', () => {
    const timestamp = '2026-11-01T00:00:00+02:00';
    expect(normalizeReel({ ...sample, timestamp }, context, 'test').record).toMatchObject({ published_at: '2026-10-31T22:00:00.000Z', published_at_raw: timestamp, published_at_basis: 'explicit_offset' });
    for (const timestamp of [null, undefined, '', '2026-02-30T00:00:00', '2026-02-29T00:00:00', '2026-13-01T00:00:00', '2026-01-01T24:00:00', '2026-01-01T00:60:00', '2026-01-01T00:00:60', '0000-01-01T00:00:00', '2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00+25:00']) {
      expect(timestampBasis(timestamp)).toBe('invalid_or_missing');
      expect(normalizeReel({ ...sample, timestamp }, context, 'test').error?.message).toContain('publish_timestamp_invalid');
    }
    expect(normalizeReel({ ...sample, timestamp: new Date(Date.now() + 86400000).toISOString() }, context, 'test').record).toBeUndefined();
  });
  it('allowlists raw timestamp provenance and keeps nullable demo dates last and out of date filters', async () => {
    delete (globalThis as typeof globalThis & { __reelradarDemo?: unknown }).__reelradarDemo;
    const repo = new DemoRepository(), workspace = (await repo.bootstrap()).workspaces[0];
    const store = (globalThis as typeof globalThis & { __reelradarDemo: { data: { reels: Reel[] } } }).__reelradarDemo;
    const id = (await repo.reels(workspace.id, { limit: 1 })).items[0].id;
    const reel = store.data.reels.find(reel => reel.id === id)!;
    const original = { ...reel };
    Object.assign(reel, { published_at: null, published_at_raw: '2026-08-10T20:06:13', published_at_basis: 'timezone_unverified' });
    try {
      expect(safeReel({ ...reel, secret: 'private' } as Reel)).toMatchObject({ published_at: null, published_at_raw: '2026-08-10T20:06:13', published_at_basis: 'timezone_unverified' });
      expect(JSON.stringify(safeReel(reel))).not.toContain('private');
      const page = await repo.reels(workspace.id, { limit: 50 });
      if (page.items.some(item => item.id === reel.id)) expect(page.items.at(-1)?.published_at).toBeNull();
      expect((await repo.reels(workspace.id, { from: '2026-08-01', to: '2026-11-08', limit: 50 })).items.some(item => item.id === reel.id)).toBe(false);
      await expect(repo.overview(workspace.id)).resolves.toBeDefined();
      await expect(repo.creators(workspace.id)).resolves.toBeDefined();
    } finally { Object.assign(reel, original); }
  });
});

const db = new PGlite();
let workspace: string, creator: string, job: string, lease: string, fetched: string;
let oldColumns: string[], oldPublished: string;
async function role(name: 'postgres' | 'anon' | 'authenticated' | 'service_role', user = owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role: name })]);
  if (name !== 'postgres') await db.exec(`set role ${name}`);
}
async function value<T>(sql: string, args: unknown[] = []): Promise<T> { return (await db.query<{ value: T }>(sql, args)).rows[0].value; }
beforeAll(async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  for (const file of ['202611080001_schema.sql', '202611080002_queue.sql', '202611080003_initial_backfill_and_usage.sql']) await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8'));
  await db.query('insert into auth.users values ($1),($2)', [owner, stranger]);
  await role('service_role'); await db.query('select public.provision_owner($1)', [owner]);
  await role('authenticated'); workspace = (await value<{ id: string }>('select public.create_workspace($1) as value', ['Timestamp tests'])).id;
  const added = await value<{ id: string; initial_backfill_job_id: string }>('select public.add_creator($1,$2) as value', [workspace, 'example']);
  creator = added.id; job = added.initial_backfill_job_id;
  await role('postgres');
  oldColumns = await value<string[]>("select jsonb_agg(column_name order by ordinal_position) as value from information_schema.columns where table_schema='public' and table_name='reels_summary'");
  oldPublished = await value<string>("insert into public.reels(creator_id,shortcode,published_at,latest_fetched_at,provider) values ($1,'OLD_DATE','2026-08-11T00:00:00Z',now(),'test') returning published_at::text as value", [creator]);
  await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/202611080004_nullable_provider_timestamps.sql'), 'utf8'));
  const processing = await db.query<{ lease: string; fetched: string }>("update public.scrape_jobs set status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',result_fetched_at=now() where id=$1 returning lease_token as lease,result_fetched_at::text as fetched", [job]);
  lease = processing.rows[0].lease; fetched = processing.rows[0].fetched;
}, 60000);
afterAll(async () => { await db.close(); });

describe('migration 004 preserves view positions, dates, ACLs and ingestion contract', () => {
  it('appends fields without changing old dates or anonymous/service boundaries', async () => {
    const columns = await value<string[]>("select jsonb_agg(column_name order by ordinal_position) as value from information_schema.columns where table_schema='public' and table_name='reels_summary'");
    expect(columns).toEqual([...oldColumns, 'published_at_raw', 'published_at_basis']);
    expect(await value<string>("select published_at::text as value from public.reels where shortcode='OLD_DATE'")).toBe(oldPublished);
    expect(await value<boolean>("select has_table_privilege('anon','public.reels_summary','select') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('authenticated','public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)','execute') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('service_role','public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)','execute') as value")).toBe(true);
    expect(await value<boolean>("select 'security_invoker=true'=any(reloptions) as value from pg_class where oid='public.reels_summary'::regclass")).toBe(true);
  });
  it('ingests and replays a raw date without losing metrics, counts or timezone provenance', async () => {
    await role('service_role');
    const record = { ...normalizeReel({ ...sample, timestamp: '2026-08-10T20:06:13' }, context, 'test').record!, published_at: null, published_at_basis: 'timezone_unverified', creator_id: creator, fetched_at: fetched };
    const args = [job, lease, 0, [record], [], 1, true, { [creator]: 1 }];
    expect(await value<{ accepted: number }>('select public.worker_ingest_page($1,$2,$3,$4,$5,$6,$7,$8) as value', args)).toMatchObject({ accepted: 1 });
    expect(await value<{ duplicate: boolean }>('select public.worker_ingest_page($1,$2,$3,$4,$5,$6,$7,$8) as value', args)).toMatchObject({ duplicate: true });
    expect(await value<number>('select received_count as value from public.scrape_job_creators where job_id=$1', [job])).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.reel_metric_snapshots')).toBe(1);
    await role('authenticated');
    const page = await value<{ items: Reel[] }>('select public.query_reels($1) as value', [workspace]);
    expect(page.items.map(reel => reel.shortcode)).toEqual(['OLD_DATE', 'ABC_123']);
    expect(page.items[1]).toMatchObject({ published_at: null, published_at_raw: '2026-08-10T20:06:13', published_at_basis: 'timezone_unverified', latest_views: 100, latest_comments: 0, latest_likes: null, likes_state: 'hidden' });
    expect((await value<{ total: number }>('select public.query_reels($1,$2) as value', [workspace, { from: '2026-08-01', to: '2026-08-31' }])).total).toBe(1);
    await role('authenticated', stranger); expect(await value<number>('select count(*)::int as value from public.reels_summary')).toBe(0);
    await role('anon'); await expect(db.query('select * from public.reels_summary')).rejects.toThrow(/permission denied/);
  });
  it('rejects invalid raw calendars or mismatched null/basis states', async () => {
    await role('postgres');
    for (const [published, raw, basis] of [[null, null, 'explicit_offset'], [null, '2026-02-30T00:00:00', 'timezone_unverified'], [null, '2026-08-10T20:06:13Z', 'timezone_unverified'], ['2026-08-10T20:06:13Z', '2026-08-10T20:06:13', 'timezone_unverified'], [null, '2026-08-10T20:06:13', 'unavailable']]) {
      await expect(db.query("insert into public.reels(creator_id,shortcode,published_at,published_at_raw,published_at_basis,latest_fetched_at,provider) values ($1,'INVALID_DATE',$2,$3,$4,now(),'test')", [creator, published, raw, basis])).rejects.toThrow();
    }
  });
  it('migration005 applies IST to raw dates while preserving explicit dates and grants', async () => {
    await role('postgres');
    await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/202611080005_assumed_ist_publication.sql'), 'utf8'));
    expect(await value<string>("select published_at::text as value from public.reels where shortcode='ABC_123'")).toContain('2026-08-10 14:36:13');
    expect(await value<string>("select published_at_basis as value from public.reels where shortcode='ABC_123'")).toBe('assumed_Asia/Kolkata');
    expect(await value<string>("select published_at::text as value from public.reels where shortcode='OLD_DATE'")).toBe(oldPublished);
    expect(await value<boolean>("select has_table_privilege('anon','public.reels_summary','select') as value")).toBe(false);
    await role('authenticated');
    expect((await value<{ total: number }>('select public.query_reels($1,$2) as value', [workspace, { from: '2026-08-10', to: '2026-08-10' }])).total).toBe(1);
  });
});
