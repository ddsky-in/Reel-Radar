import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { featureDatabase, fixtureOwner } from './support/feature-database';

const migration = '202611150003_scoped_resource_revisions.sql';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Signal = { feed: string; family: string | null };
async function signals() {
  return (await f.db.query<Signal>('select feed,family from pg_temp.revision_lock_order order by sequence')).rows;
}
async function revisions() {
  return (await f.db.query<{ family: string; scope_key: string; revision: number }>(
    'select family,scope_key,revision::int from public.owner_resource_revisions where owner_user_id=$1 order by family,scope_key', [fixtureOwner],
  )).rows;
}
async function legacy() { return f.value<number>('select revision::int v from public.owner_revisions'); }

beforeAll(async () => {
  // Keep the scoped revision fixture at its historical migration boundary.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: ['202611150001_bounded_gallery_reads.sql', '202611150002_paged_research_reads.sql', '202611150007_creator_carousel_counts.sql', ...later] });
  await f.identity();
  await f.db.exec(`
    create temporary table revision_lock_order(sequence bigint generated always as identity,feed text,family text);
    create function pg_temp.audit_revision_lock_order() returns trigger language plpgsql as $$
    begin
      insert into pg_temp.revision_lock_order(feed,family)
        values(tg_table_name,case when tg_table_name='owner_resource_revisions' then to_jsonb(new)->>'family' end);
      return new;
    end $$;
    create trigger audit_global_order after insert or update on public.owner_revisions
      for each row execute function pg_temp.audit_revision_lock_order();
    create trigger audit_family_order after insert or update on public.owner_resource_revisions
      for each row execute function pg_temp.audit_revision_lock_order();
    insert into public.budget_envelopes(owner_user_id,limit_usd) values('${fixtureOwner}',1)
      on conflict(owner_user_id) where active do nothing;
  `);
}, 60000);
afterAll(async () => { await f?.db.close(); });

describe('deferred owner revision lock ordering (single-session PGlite regression, not contention proof)', () => {
  it('defers every scoped and legacy signal, including budget/app-settings and guarded config triggers', async () => {
    const triggers = (await f.db.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(`
      select tgname,tgdeferrable,tginitdeferred from pg_trigger
      where tgfoid in ('public.signal_owner_revision()'::regprocedure,'public.signal_owner_resource_revision()'::regprocedure)
        and not tgisinternal
    `)).rows;
    expect(triggers.length).toBeGreaterThan(40);
    expect(triggers.every(trigger => trigger.tgdeferrable && trigger.tginitdeferred)).toBe(true);
  });

  it('acquires no revision locks during creator/job/budget mutations, then serializes global before ALL families', async () => {
    await f.db.exec('truncate pg_temp.revision_lock_order');
    const before = await revisions(), ownerBefore = await legacy();
    await f.db.exec('begin');
    try {
      await f.db.query("update public.creators set display_name='Deferred creator' where id=$1", [f.creator]);
      await f.db.exec("update public.scrape_jobs set error_message='Deferred job'");
      await f.db.query('update public.scrape_job_creators set received_count=received_count+1 where creator_id=$1', [f.creator]);
      await f.db.query("select pg_advisory_xact_lock(hashtextextended('budget:'||$1::text,0))", [fixtureOwner]);
      await f.db.exec('update public.app_settings set budget_warning_pct=83');
      await f.db.exec('update public.budget_envelopes set limit_usd=2 where active');
      expect(await signals()).toEqual([]);
      expect(await revisions()).toEqual(before);
      expect(await legacy()).toBe(ownerBefore);
      await f.db.exec('commit');
    } catch (error) { await f.db.exec('rollback'); throw error; }
    const emitted = await signals();
    expect(emitted[0]).toEqual({ feed: 'owner_revisions', family: null });
    expect(emitted.filter(row => row.feed === 'owner_revisions')).toHaveLength(1);
    expect(emitted.slice(1).every(row => row.feed === 'owner_resource_revisions')).toBe(true);
    expect(emitted.slice(1).map(row => row.family).sort()).toEqual(['carousels', 'creators', 'jobs', 'reels', 'settings', 'transcription']);
    expect(await legacy()).toBe(ownerBefore + 1);
  });

  it('unions later scopes after an explicit constraint flush without incrementing prior families twice', async () => {
    await f.db.exec('truncate pg_temp.revision_lock_order');
    const ownerBefore = await legacy();
    await f.db.exec('begin');
    try {
      await f.db.query("update public.creators set display_name='First explicit flush' where id=$1", [f.creator]);
      await f.db.exec('set constraints all immediate');
      expect((await signals())[0]).toEqual({ feed: 'owner_revisions', family: null });
      await f.db.exec('set constraints all deferred');
      await f.db.query("update public.creators set display_name='Second explicit flush' where id=$1", [f.creator]);
      await f.db.query("insert into public.saved_reel_filters(owner_user_id,name,config) values($1,'Deferred union','{\"version\":1,\"query\":{}}')", [fixtureOwner]);
      await f.db.exec('commit');
    } catch (error) { await f.db.exec('rollback'); throw error; }
    const emitted = await signals();
    expect(emitted.filter(row => row.feed === 'owner_revisions')).toHaveLength(1);
    expect(emitted.slice(1).map(row => row.family).sort()).toEqual(['carousels', 'creators', 'reel_filters', 'reels']);
    expect(await legacy()).toBe(ownerBefore + 1);
  });

  it('discards rolled-back pending events and restores flushed dedup markers across a savepoint', async () => {
    await f.db.exec('truncate pg_temp.revision_lock_order');
    const before = await revisions(), ownerBefore = await legacy();
    await f.db.exec('begin');
    try {
      await f.db.exec('savepoint discarded');
      await f.db.query("update public.creators set display_name='Discarded flush' where id=$1", [f.creator]);
      await f.db.exec('set constraints all immediate');
      expect((await signals())[0]).toEqual({ feed: 'owner_revisions', family: null });
      await f.db.exec('rollback to savepoint discarded');
      expect(await signals()).toEqual([]);
      expect(await revisions()).toEqual(before);
      expect(await legacy()).toBe(ownerBefore);
      await f.db.query("update public.creators set display_name='Retained deferred flush' where id=$1", [f.creator]);
      expect(await signals()).toEqual([]);
      await f.db.exec('commit');
    } catch (error) { await f.db.exec('rollback'); throw error; }
    expect((await signals()).map(row => row.feed)).toEqual(['owner_revisions', 'owner_resource_revisions', 'owner_resource_revisions', 'owner_resource_revisions']);
    expect(await legacy()).toBe(ownerBefore + 1);
  });
});
