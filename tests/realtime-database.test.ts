import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = 'a0000000-0000-4000-8000-000000000001';
const stranger = 'a0000000-0000-4000-8000-000000000002';
let workspace: string, creator: string, reel: string;
async function identity(role = 'postgres', user = owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: user })]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function revision() {
  return (await db.query<{ revision: number }>('select revision::int from public.owner_revisions')).rows[0].revision;
}
beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
  `);
  for (const file of ['202611080001_schema.sql','202611080002_queue.sql','202611080003_initial_backfill_and_usage.sql']) await db.exec(readFileSync(join(process.cwd(),'supabase/migrations',file),'utf8'));
  await db.query('insert into auth.users values($1),($2)', [owner,stranger]);
  await db.query('insert into public.app_settings(owner_user_id) values($1)',[owner]);
  await db.exec(readFileSync(join(process.cwd(),'supabase/migrations/202611080006_owner_realtime_revision.sql'),'utf8'));
  workspace = (await db.query<{ id: string }>("insert into public.workspaces(owner_user_id,name,slug) values($1,'Research','research') returning id",[owner])).rows[0].id;
  creator = (await db.query<{ id: string }>("insert into public.creators(username) values('real_contract_fixture') returning id")).rows[0].id;
  await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2)',[workspace,creator]);
  reel = (await db.query<{ id: string }>("insert into public.reels(creator_id,shortcode,published_at,latest_fetched_at,provider) values($1,'Fixture',now(),now(),'test') returning id",[creator])).rows[0].id;
},60000);
afterAll(async () => { await db.close(); });

describe('private owner revision feed in actual Postgres', () => {
  it('publishes only the minimal signal table', async () => {
    const rows = (await db.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname='supabase_realtime'")).rows;
    expect(rows.map(row=>row.tablename)).toEqual(['owner_revisions']);
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name='owner_revisions' order by ordinal_position")).rows;
    expect(columns.map(row=>row.column_name)).toEqual(['owner_user_id','revision','updated_at']);
  });
  it('isolates owner reads and denies anonymous reads, browser writes and trigger calls', async () => {
    await identity('authenticated');
    expect((await db.query('select * from public.owner_revisions')).rows).toHaveLength(1);
    await expect(db.exec('update public.owner_revisions set revision=0')).rejects.toThrow(/permission denied/);
    await expect(db.exec('delete from public.owner_revisions')).rejects.toThrow(/permission denied/);
    await expect(db.exec('select public.signal_owner_revision()')).rejects.toThrow(/permission denied/);
    await identity('authenticated',stranger);
    expect((await db.query('select * from public.owner_revisions')).rows).toHaveLength(0);
    await identity('anon');
    await expect(db.exec('select * from public.owner_revisions')).rejects.toThrow(/permission denied/);
    await identity();
  });
  it('coalesces multiple source updates in a transaction, not future transactions', async () => {
    const before = await revision();
    await db.exec('begin');
    await db.query('update public.creators set display_name=$1 where id=$2',['Updated',creator]);
    await db.query('update public.workspaces set name=$1 where id=$2',['Updated',workspace]);
    await db.exec('commit');
    expect(await revision()).toBe(before+1);
    await db.query('update public.creators set display_name=$1 where id=$2',['Again',creator]);
    expect(await revision()).toBe(before+2);
  });
  it('signals saved deletion and membership unlink without deleting the feed or adding scrape jobs', async () => {
    const jobs = (await db.query('select id from public.scrape_jobs')).rows.length;
    await db.query('insert into public.saved_reels(workspace_id,reel_id,saved_by_user_id) values($1,$2,$3)',[workspace,reel,owner]);
    const saved = await revision();
    await db.query('delete from public.saved_reels where workspace_id=$1 and reel_id=$2',[workspace,reel]);
    expect(await revision()).toBe(saved+1);
    await db.query('delete from public.workspace_creators where workspace_id=$1 and creator_id=$2',[workspace,creator]);
    expect(await revision()).toBe(saved+2);
    expect((await db.query('select * from public.owner_revisions')).rows).toHaveLength(1);
    expect((await db.query('select id from public.scrape_jobs')).rows).toHaveLength(jobs);
    expect((await db.query('select id from public.reels')).rows).toHaveLength(1);
  });
  it('rollbacks also rollback the signal and coalescing marker', async () => {
    const before = await revision();
    await db.exec('begin');
    await db.query('update public.creators set display_name=$1 where id=$2',['Rollback',creator]);
    expect(await revision()).toBe(before+1);
    await db.exec('rollback');
    expect(await revision()).toBe(before);
    await db.query('update public.creators set display_name=$1 where id=$2',['Committed',creator]);
    expect(await revision()).toBe(before+1);
  });
  it('signals settings without changing scraping limits or adding schedules', async () => {
    const before = await revision();
    await db.query('update public.app_settings set budget_warning_pct=81 where owner_user_id=$1',[owner]);
    expect(await revision()).toBe(before+1);
    const settings = (await db.query('select daily_limit,weekly_limit,paused,scraping_enabled from public.app_settings')).rows[0];
    expect(settings).toEqual({daily_limit:10,weekly_limit:30,paused:true,scraping_enabled:false});
  });
});
