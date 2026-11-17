import { afterAll, beforeAll, expect, it } from 'vitest';
import { featureDatabase, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });

it('keeps privileged implementations private and public contracts unprivileged', async () => {
  await f.identity();
  expect(await f.value<number>("select count(*)::int v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='authenticated_rpc_private' and p.prosecdef")).toBe(41);
  expect(await f.value<number>("select count(*)::int v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('authenticated',p.oid,'execute')")).toBe(0);
  expect(await f.value<boolean>("select has_schema_privilege('anon','authenticated_rpc_private','usage') v")).toBe(false);
  expect(await f.value<boolean>("select has_function_privilege('anon','public.get_bootstrap()','execute') v")).toBe(false);
  await f.identity('authenticated');
  expect(await f.rpc('is_workspace_member', [f.workspace])).toBe(true);
  expect(await f.rpc('get_bootstrap')).toBeTruthy();
  expect(await f.rpc('query_reels', [f.workspace, {}])).toMatchObject({ items: [] });
  const filter = await f.rpc<{ id: string }>('create_reel_filter', ['Private RPC fixture', {}]);
  await f.rpc('delete_reel_filter', [filter.id]);
  await f.rpc('update_settings', [{ monthly_budget_usd: 50 }]);
  await f.identity('authenticated', fixtureStranger);
  expect(await f.rpc('is_workspace_member', [f.workspace])).toBe(false);
  await expect(f.rpc('get_bootstrap')).rejects.toThrow(/forbidden/);
  await expect(f.rpc('query_reels', [f.workspace, {}])).rejects.toThrow(/forbidden/);
  await expect(f.rpc('update_settings', [{ monthly_budget_usd: 999 }])).rejects.toThrow(/forbidden/);
});
