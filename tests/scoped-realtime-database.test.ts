import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>, reel: string;
const migration = '202611150003_scoped_resource_revisions.sql';
type Scope = { family: string; workspace_id: string | null; revision: number };
async function scopes() {
  return (await f.db.query<Scope>('select family,workspace_id,revision::int from public.owner_resource_revisions where owner_user_id=$1 order by family,workspace_id', [fixtureOwner])).rows;
}
function key(row: Scope) { return `${row.family}:${row.workspace_id ?? '*'}`; }
function differences(before: Scope[], after: Scope[]) {
  const base = new Map(before.map(row => [key(row), row.revision]));
  return after.filter(row => row.revision !== (base.get(key(row)) ?? 0)).map(row => ({ scope: key(row), delta: row.revision - (base.get(key(row)) ?? 0) }));
}
beforeAll(async () => {
  // Keep the scoped revision fixture at its historical migration boundary.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: ['202611150001_bounded_gallery_reads.sql', '202611150002_paged_research_reads.sql', '202611150007_creator_carousel_counts.sql', ...later] });
  reel = await f.reel(); await f.identity();
}, 60000);
afterAll(async () => { await f?.db.close(); });

describe('durable scoped resource revisions in actual local Postgres', () => {
  it('publishes minimal scopes only and preserves the legacy feed', async () => {
    const columns = (await f.db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name='owner_resource_revisions' order by ordinal_position")).rows;
    expect(columns.map(row => row.column_name)).toEqual(['owner_user_id', 'family', 'workspace_id', 'scope_key', 'revision', 'updated_at']);
    const tables = (await f.db.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows;
    expect(tables.map(row => row.tablename)).toEqual(['owner_resource_revisions', 'owner_revisions']);
    expect(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8')).not.toMatch(/cron\.schedule|net\.http_post|vault\./);
  });
  it('isolates owner/workspace reads and forbids browser/anonymous writes and trigger invocation', async () => {
    await f.identity('authenticated'); expect((await f.db.query('select * from public.owner_resource_revisions')).rows.length).toBeGreaterThan(0);
    for (const sql of ['update public.owner_resource_revisions set revision=1', 'delete from public.owner_resource_revisions',
      `insert into public.owner_resource_revisions(owner_user_id,family) values('${fixtureOwner}','reels')`, 'select public.signal_owner_resource_revision()']) {
      await expect(f.db.exec(sql)).rejects.toThrow(/permission denied/);
    }
    await f.identity('authenticated', fixtureStranger); expect((await f.db.query('select * from public.owner_resource_revisions')).rows).toEqual([]);
    await f.identity('anon'); await expect(f.db.exec('select * from public.owner_resource_revisions')).rejects.toThrow(/permission denied/);
    await f.identity();
    // Even a privileged malformed foreign-workspace scope is hidden from owner.
    const foreign = 'fc100000-0000-4000-8000-000000000001';
    await f.db.query("insert into public.owner_resource_revisions(owner_user_id,family,workspace_id,scope_key) values($1,'saved_reels',$2::uuid,($2::uuid)::text)", [fixtureOwner, foreign]);
    await f.identity('authenticated');
    expect((await f.db.query('select * from public.owner_resource_revisions where workspace_id=$1', [foreign])).rows).toEqual([]);
    await f.identity(); await f.db.query('delete from public.owner_resource_revisions where workspace_id=$1', [foreign]);
  });
  it('increments ALL affected families once for ten changes in one transaction, retaining prior families', async () => {
    const before = await scopes(), legacy = await f.value<number>('select revision::int v from public.owner_revisions');
    await f.db.exec('begin');
    for (let i = 0; i < 3; i++) await f.db.query('update public.creators set display_name=$1 where id=$2', [`Atomic ${i}`, f.creator]);
    await f.db.query('insert into public.saved_reels(workspace_id,reel_id,saved_by_user_id) values($1,$2,$3)', [f.workspace, reel, fixtureOwner]);
    await f.db.query("insert into public.reel_tags(workspace_id,reel_id,tag) values($1,$2,'atomic')", [f.workspace, reel]);
    await f.db.query('update public.workspaces set name=$1 where id=$2', ['Atomic workspace', f.workspace]);
    await f.db.exec('update public.app_settings set budget_warning_pct=82');
    await f.db.query("update public.transcript_jobs set error_message='Atomic transcript' where reel_id=$1", [reel]);
    await f.db.query("insert into public.saved_reel_filters(owner_user_id,name,config) values($1,'Atomic Reel','{\"version\":1,\"query\":{}}')", [fixtureOwner]);
    await f.db.query("insert into public.saved_carousel_filters(owner_user_id,name,config) values($1,'Atomic carousel','{\"version\":1,\"query\":{}}')", [fixtureOwner]);
    await f.db.exec('commit');
    const changed = differences(before, await scopes());
    expect(changed.every(row => row.delta === 1)).toBe(true);
    expect(changed.map(row => row.scope)).toEqual(expect.arrayContaining([
      'creators:*', 'reels:*', 'carousels:*', 'settings:*', 'jobs:*', 'transcription:*',
      `saved_reels:${f.workspace}`, 'workspaces:*', 'reel_filters:*', 'carousel_filters:*',
    ]));
    expect(await f.value<number>('select revision::int v from public.owner_revisions')).toBe(legacy + 1);
    const next = await scopes(); await f.db.query('update public.creators set display_name=$1 where id=$2', ['Future transaction', f.creator]);
    expect(differences(next, await scopes())).toEqual([{ scope: 'carousels:*', delta: 1 }, { scope: 'creators:*', delta: 1 }, { scope: 'reels:*', delta: 1 }]);
  });
  it('does not treat no-op source updates as real changes and rolls back scope dedup markers', async () => {
    const before = await scopes(); await f.db.query('update public.creators set display_name=display_name where id=$1', [f.creator]);
    expect(await scopes()).toEqual(before);
    await f.db.exec('begin');
    await f.db.query("update public.creators set display_name='Rollback' where id=$1", [f.creator]);
    expect(await scopes()).toEqual(before); // Signals flush at commit, after source/budget locks.
    await f.db.exec('rollback'); expect(await scopes()).toEqual(before);
    await f.db.query("update public.creators set display_name='Committed' where id=$1", [f.creator]);
    expect(differences(before, await scopes()).every(row => row.delta === 1)).toBe(true);
  });
  it('bookmark changes are workspace scoped; deletes and filters do not touch creator/status families', async () => {
    let before = await scopes();
    await f.db.query('delete from public.saved_reels where workspace_id=$1 and reel_id=$2', [f.workspace, reel]);
    expect(differences(before, await scopes())).toEqual([{ scope: `saved_reels:${f.workspace}`, delta: 1 }]);
    before = await scopes(); await f.db.exec("delete from public.saved_reel_filters where name='Atomic Reel'");
    expect(differences(before, await scopes())).toEqual([{ scope: 'reel_filters:*', delta: 1 }]);
  });
  it('canonical shared creator changes use a global owner-family scope, not guessed membership', async () => {
    await f.identity('authenticated'); const second = await f.rpc<{ id: string }>('create_workspace', ['Second revision scope']);
    await f.rpc('add_creator', [second.id, 'backend_fixture']); await f.identity();
    const before = await scopes(); await f.db.query("update public.creators set display_name='Shared canonical' where id=$1", [f.creator]);
    expect(differences(before, await scopes())).toEqual([{ scope: 'carousels:*', delta: 1 }, { scope: 'creators:*', delta: 1 }, { scope: 'reels:*', delta: 1 }]);
  });
  it('membership removal still emits an authorized owner-global invalidation signal', async () => {
    await f.identity('authenticated'); const third = await f.rpc<{ id: string }>('create_workspace', ['Revoked membership scope']); await f.identity();
    const before = await scopes();
    await f.db.query('delete from public.workspace_members where workspace_id=$1', [third.id]);
    const changed = differences(before, await scopes());
    expect(changed).toContainEqual({ scope: 'workspaces:*', delta: 1 });
    expect(changed.every(row => row.scope.endsWith(':*'))).toBe(true);
    await f.identity('authenticated');
    expect((await f.db.query("select * from public.owner_resource_revisions where family='workspaces' and workspace_id is null")).rows).toHaveLength(1);
    await f.identity();
  });
  it('covers provider-account jobs/settings and every new domain with scoped and legacy triggers', async () => {
    const domains = ['apify_accounts', 'carousel_metric_snapshots', 'carousel_automation_settings', 'competitor_refresh_targets', 'transcription_webhook_setup', 'transcription_media_targets', 'reel_fetch_observations'];
    for (const table of domains) {
      const triggers = (await f.db.query<{ tgname: string }>('select tgname from pg_trigger where tgrelid=to_regclass($1) and not tgisinternal', [`public.${table}`])).rows.map(row => row.tgname);
      expect(triggers).toContain('owner_resource_revision_changed'); expect(triggers).toContain('owner_revision_changed');
    }
    const before = await scopes(); await f.db.exec("update public.apify_accounts set usage_checked_at=clock_timestamp() where slot=1");
    expect(differences(before, await scopes())).toEqual([{ scope: 'jobs:*', delta: 1 }, { scope: 'settings:*', delta: 1 }]);
  });
});
