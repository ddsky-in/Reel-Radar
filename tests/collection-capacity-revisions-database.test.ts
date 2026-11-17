import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Scope = { family: string; workspace_id: string | null; revision: number };
async function scopes() {
  return (await f.db.query<Scope>('select family,workspace_id,revision::int from public.owner_resource_revisions where owner_user_id=$1 order by family,workspace_id', [fixtureOwner])).rows;
}
async function legacy() { return f.value<number>('select revision::int v from public.owner_revisions where owner_user_id=$1', [fixtureOwner]); }
function differences(before: Scope[], after: Scope[]) {
  const key = (row: Scope) => `${row.family}:${row.workspace_id ?? '*'}`;
  const previous = new Map(before.map(row => [key(row), row.revision]));
  return after.filter(row => row.revision !== (previous.get(key(row)) ?? 0)).map(row => ({ scope: key(row), delta: row.revision - (previous.get(key(row)) ?? 0) }));
}
const configure = (active: number, starts: number) => f.rpc('worker_configure_collection_throughput', [fixtureOwner, active, starts]);
beforeAll(async () => { f = await featureDatabase(); await f.identity('service_role'); }, 60000);
afterAll(async () => { await f?.db.close(); });

describe('meaningful collection capacity configuration revision signals', () => {
  it('installs guarded deferred scoped and legacy signals without publishing worker settings', async () => {
    const triggers = (await f.db.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean; definition: string }>(`
      select tgname,tgdeferrable,tginitdeferred,pg_get_triggerdef(oid) definition from pg_trigger
      where tgrelid='public.collection_worker_settings'::regclass and not tgisinternal order by tgname`)).rows;
    expect(triggers.map(trigger => trigger.tgname)).toEqual(['owner_resource_revision_changed', 'owner_revision_changed']);
    for (const trigger of triggers) {
      expect(trigger.tgdeferrable).toBe(true); expect(trigger.tginitdeferred).toBe(true);
      expect(trigger.definition).toContain('AFTER UPDATE');
      expect(trigger.definition).toMatch(/old\.max_active IS DISTINCT FROM new\.max_active/i);
      expect(trigger.definition).toMatch(/old\.max_starts_per_wake IS DISTINCT FROM new\.max_starts_per_wake/i);
      expect(trigger.definition).not.toContain('INSERT'); expect(trigger.definition).not.toContain('DELETE');
    }
    expect((await f.db.query("select * from pg_publication_tables where pubname='supabase_realtime' and tablename='collection_worker_settings'")).rows).toEqual([]);
  });

  it('emits only global settings/jobs and one legacy bump for each changed control', async () => {
    for (const [active, starts] of [[3, 2], [3, 4]]) {
      const before = await scopes(), revision = await legacy();
      await configure(active, starts);
      expect(differences(before, await scopes())).toEqual([{ scope: 'jobs:*', delta: 1 }, { scope: 'settings:*', delta: 1 }]);
      expect(await legacy()).toBe(revision + 1);
    }
  });

  it('ignores identical config and executor/category/wake churn, but coalesces multiple real changes at commit', async () => {
    let before = await scopes(), revision = await legacy();
    await configure(3, 4);
    await f.identity();
    await f.db.exec(`update public.collection_worker_settings set last_category='profile',wake_revision=wake_revision+1;
      update public.collection_worker_settings set drained_revision=wake_revision,
        executor_nonce=gen_random_uuid(),executor_revision=wake_revision,
        executor_expires_at=now()+interval '2 minutes',executor_starts=0;
      update public.collection_worker_settings set executor_starts=1;
      update public.collection_worker_settings set executor_nonce=null,executor_revision=null,
        executor_expires_at=null,executor_starts=0;`);
    expect(await scopes()).toEqual(before); expect(await legacy()).toBe(revision);
    await f.identity('service_role');
    before = await scopes(); revision = await legacy();
    await f.db.exec('begin');
    try {
      await configure(4, 4); await configure(4, 3);
      expect(await scopes()).toEqual(before); expect(await legacy()).toBe(revision);
      await f.db.exec('commit');
    } catch (error) { await f.db.exec('rollback'); throw error; }
    expect(differences(before, await scopes())).toEqual([{ scope: 'jobs:*', delta: 1 }, { scope: 'settings:*', delta: 1 }]);
    expect(await legacy()).toBe(revision + 1);
  });

  it('preserves service-only configuration authorization and does not start paid work', async () => {
    const before = await scopes(), revision = await legacy();
    const jobs = await f.value('select jsonb_agg(to_jsonb(j) order by id) v from public.scrape_jobs j');
    const settings = await f.value('select to_jsonb(s) v from public.app_settings s');
    for (const [role, owner] of [['authenticated', fixtureOwner], ['authenticated', fixtureStranger], ['anon', fixtureOwner]]) {
      await f.identity(role, owner);
      await expect(configure(2, 2)).rejects.toThrow(/permission denied|service_required/);
      await expect(f.db.exec('update public.collection_worker_settings set max_active=2')).rejects.toThrow(/permission denied/);
    }
    await f.identity('service_role');
    expect(await scopes()).toEqual(before); expect(await legacy()).toBe(revision);
    await configure(2, 2);
    expect(await f.value('select jsonb_agg(to_jsonb(j) order by id) v from public.scrape_jobs j')).toEqual(jobs);
    expect(await f.value('select to_jsonb(s) v from public.app_settings s')).toEqual(settings);
    await f.identity();
    expect(await f.value('select count(*)::int v from net.requests')).toBe(0);
    expect(await f.value('select count(*)::int v from cron.job')).toBe(0);
  });
});
