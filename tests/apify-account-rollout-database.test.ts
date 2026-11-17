import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { featureDatabase, fixtureOwner } from './support/feature-database';

it('atomically migrates real-style pinned historical jobs without deferred-trigger DDL failure or hold changes', async () => {
  const migration = '202611140003_apify_multiaccount.sql';
  const directory = join(process.cwd(), 'supabase/migrations');
  // Test the schema immediately before this rollout. Later migrations depend on
  // its registry/functions and must not run before the historical atomic upgrade.
  const excludeMigrations = readdirSync(directory).filter(file => file.endsWith('.sql') && file >= migration);
  const f = await featureDatabase({ excludeMigrations });
  try {
    await f.identity('service_role');
    const job = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,live,requested_profiles_count,results_limit,
      expected_actor_id,expected_provider_user_id,dispatch_nonce,attempt_count,reserved_usd,actual_cost_usd)
      values($1,'daily','uncertain',true,1,30,'fixture-actor','fixture',gen_random_uuid(),1,.907554,null) returning id v`, [fixtureOwner]);
    await f.identity();
    // Mirror hosted atomic execution: accepted historical row updates queue the
    // existing deferred owner-revision trigger in the same transaction as DDL.
    await f.db.exec('begin');
    await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8'));
    await f.db.exec('commit');
    expect(await f.value('select jsonb_build_object(\'slot\',apify_account_slot,\'status\',status,\'hold\',reserved_usd,\'actual\',actual_cost_usd) v from public.scrape_jobs where id=$1', [job]))
      .toEqual({ slot: 1, status: 'uncertain', hold: .907554, actual: null });
    await f.identity('authenticated');
    const status = await f.rpc<{ ready_accounts: number; accounts: { slot: number; reason: string }[] }>('get_apify_account_status');
    expect(status.ready_accounts).toBe(0);
    expect(status.accounts).toMatchObject([{ slot: 1, reason: 'unreconciled_charges' }, { slot: 2, reason: 'disabled' }, { slot: 3, reason: 'disabled' }]);
  } finally { await f.db.close(); }
}, 60_000);
