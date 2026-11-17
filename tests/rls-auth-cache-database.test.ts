import { afterAll, beforeAll, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
const tables = ['app_settings', 'workspace_members', 'scrape_jobs', 'budget_envelopes', 'owner_revisions', 'saved_reel_filters', 'owner_resource_revisions'];
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });

it('retains owner isolation and caches statement-constant identity checks', async () => {
  await f.identity('authenticated', fixtureOwner);
  expect(await f.value<number>('select count(*)::int v from public.app_settings')).toBe(1);
  expect(await f.value<number>('select count(*)::int v from public.workspace_members')).toBe(1);
  const ownerCounts = await Promise.all(tables.map(table => f.value<number>(`select count(*)::int v from public.${table}`)));
  expect(ownerCounts.some(count => count > 0)).toBe(true);
  await f.identity('authenticated', fixtureStranger);
  for (const table of tables) expect(await f.value<number>(`select count(*)::int v from public.${table}`)).toBe(0);
  await f.identity();
  const policies = (await f.db.query<{ qual: string }>("select qual from pg_policies where schemaname='public' and tablename=any($1)", [tables])).rows;
  expect(policies).toHaveLength(7);
  for (const policy of policies) expect(policy.qual).toMatch(/SELECT auth.uid\(\)/i);
  expect(await f.value<boolean>("select relrowsecurity v from pg_class where oid='public.owner_resource_revisions'::regclass")).toBe(true);
});
