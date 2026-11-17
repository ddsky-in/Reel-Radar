import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

const migration = '202611140004_apify_five_accounts.sql';
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8');
const nonce = 'fabc0000-0000-4000-8000-000000000005';
let f: Awaited<ReturnType<typeof featureDatabase>>;
type Claim = { reason?: string; job?: { id: string; apify_account_slot: number; expected_provider_user_id: string; dispatch_nonce: string; reserved_usd: number }; max_total_charge_usd?: number };
type Status = { ready_accounts: number; accounts: { slot: number; enabled: boolean; configured: boolean; reason: string | null; reserved_usd: number; unreconciled_jobs: number }[] };
const configure = (slot: number, user: string | null = userFor(slot), enabled = true, authorized = true, owner = fixtureOwner) =>
  f.rpc('worker_configure_apify_account', [owner, slot, user, enabled, authorized]);
const usage = (slot: number, amount = 0, limit = 50, user = userFor(slot), owner = fixtureOwner) =>
  f.rpc('worker_record_account_usage', [owner, slot, user, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 20 * 86400000).toISOString(), amount, limit]);
const claim = () => f.rpc<Claim>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'daily']);
function userFor(slot: number) { return slot === 1 ? 'fixture' : `fixture-account-${slot}`; }
async function apply() { await f.identity(); await f.db.exec(sql); await f.identity('service_role'); }
async function status() { await f.identity('authenticated'); const result = await f.rpc<Status>('get_apify_account_status'); await f.identity('service_role'); return result; }
async function pending() {
  const id = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit)
    values($1,'daily',1,30) returning id v`, [fixtureOwner]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]);
  return id;
}
async function attempted(slot: number, hold = .907554) {
  return f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,reserved_usd,
    expected_actor_id,expected_provider_user_id,apify_account_slot,dispatch_nonce,attempt_count,created_at)
    values($1,'daily','uncertain',1,30,true,$2,'fixture-actor',$3,$4,$5,1,now()-interval '1 year') returning id v`,
  [fixtureOwner, hold, userFor(slot), slot, nonce]);
}
async function rejected(query: () => Promise<unknown>, error: string) {
  await f.db.exec('savepoint rejected_call');
  try { await expect(query()).rejects.toThrow(error); }
  finally { await f.db.exec('rollback to savepoint rejected_call; release savepoint rejected_call'); }
}
async function snapshots() {
  await f.identity();
  const result = {
    settings: await f.value('select jsonb_agg(to_jsonb(s) order by owner_user_id) v from public.app_settings s'),
    accounts: await f.value('select jsonb_agg(to_jsonb(a) order by owner_id,slot) v from public.apify_accounts a where slot<=3'),
    jobs: await f.value('select jsonb_agg(to_jsonb(j) order by id) v from public.scrape_jobs j'),
    cron: await f.value('select coalesce(jsonb_agg(to_jsonb(j) order by jobid),\'[]\'::jsonb) v from cron.job j'),
    requests: await f.value('select coalesce(jsonb_agg(to_jsonb(r) order by id),\'[]\'::jsonb) v from net.requests r'),
  };
  await f.identity('service_role');
  return result;
}

beforeAll(async () => {
  // This verifies the historical three→five-slot rollout, before later worker
  // migrations replace its function contracts. Those have separate coverage.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: [migration, ...later] });
}, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0; update public.app_settings set monthly_budget_usd=50,scraping_enabled=true,initial_backfill_enabled=true,paused=false;");
  await f.identity('service_role'); await configure(1); await usage(1);
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });

// Isolated PGlite only: apply forward SQL to the actual three-slot fixture,
// never to Supabase, and never invoke an external provider or enable schedules.
describe('five-account forward migration from deployed three-account state', () => {
  it('preserves every existing account, job pin, legacy field and uncertain hold with deferred trigger events queued', async () => {
    await configure(2); await usage(2, 2, 7); await configure(3); await usage(3, 3, 8);
    const old = await attempted(1);
    const second = await attempted(2, .25); const third = await attempted(3, .1);
    await f.identity();
    // Real transaction ordering: revisions/FKs can be deferred when a deployment starts.
    await f.db.exec('set constraints all deferred');
    await f.db.query('update public.scrape_jobs set error_message=$1 where id=$2', ['Synthetic pre-rollout event', old]);
    const before = await snapshots();
    await apply();
    expect(await snapshots()).toEqual(before);
    expect(await f.value('select jsonb_build_object(\'status\',status,\'slot\',apify_account_slot,\'hold\',reserved_usd,\'cost\',actual_cost_usd) v from public.scrape_jobs where id=$1', [old]))
      .toEqual({ status: 'uncertain', slot: 1, hold: .907554, cost: null });
    expect(await f.value<number[]>('select array_agg(apify_account_slot::integer order by apify_account_slot) v from public.scrape_jobs where id=any($1::uuid[])', [[old, second, third]])).toEqual([1, 2, 3]);
    const accounts = await f.rpc<Record<string, unknown>[]>('worker_accounts', [fixtureOwner]);
    expect(accounts.map(row => row.account_slot)).toEqual([1, 2, 3, 4, 5]);
    expect(accounts.slice(3)).toEqual([4, 5].map(slot => ({ owner_user_id: fixtureOwner, account_slot: slot, provider_user_id: null,
      enabled: false, authorization_confirmed: false, usage_cycle_start_at: null, usage_cycle_end_at: null,
      usage_usd: null, limit_usd: null, usage_reconciled_at: null })));
  });
  it('provisions disabled/unconfigured 4/5 for a fresh singleton owner and reports five public rows without changing schema', async () => {
    await apply();
    // The production model is single-owner; do not relax its singleton constraint.
    // Savepoint-isolated truncation creates an empty synthetic installation only.
    await f.identity(); await f.db.exec('savepoint fresh_install; truncate public.app_settings cascade');
    await f.identity('service_role'); await f.rpc('provision_owner', [fixtureStranger]);
    const accounts = await f.rpc<Record<string, unknown>[]>('worker_accounts', [fixtureStranger]);
    expect(accounts.map(row => row.account_slot)).toEqual([1, 2, 3, 4, 5]);
    expect(accounts.slice(1).every(row => row.enabled === false && row.authorization_confirmed === false && row.provider_user_id === null && row.usage_usd === null)).toBe(true);
    await f.db.exec('rollback to savepoint fresh_install; release savepoint fresh_install');
    const result = await status();
    expect(result.ready_accounts).toBe(1);
    expect(result.accounts.map(row => row.reason)).toEqual([null, 'disabled', 'disabled', 'disabled', 'disabled']);
    expect(Object.keys(result.accounts[0]).sort()).toEqual(['slot', 'label', 'enabled', 'configured', 'reason', 'usage_usd', 'limit_usd', 'usage_checked_at', 'cycle_end_at', 'reserved_usd', 'unreconciled_jobs'].sort());
    expect(JSON.stringify(result)).not.toMatch(/fixture|provider_user_id|owner_id|secret|token/);
  });
  it('retains exact owners, security/search paths and grants for patched functions; leaves dynamic status/allocator unchanged', async () => {
    await f.identity();
    const definitions = () => f.value(`select jsonb_object_agg(oid::regprocedure::text,jsonb_build_object('owner',proowner,'acl',proacl,'security',prosecdef,'config',proconfig)) v
      from pg_proc where oid=any(array['public.worker_configure_apify_account(uuid,integer,text,boolean,boolean)'::regprocedure,
      'public.worker_record_account_usage(uuid,integer,text,timestamptz,timestamptz,numeric,numeric)'::regprocedure,
      'public.worker_invalidate_account_usage(uuid,integer)'::regprocedure,'apify_accounts_private.provision_slots()'::regprocedure])`);
    const loops = () => f.value(`select jsonb_agg(pg_get_functiondef(oid) order by oid) v from pg_proc where oid=any(array[
      'apify_accounts_private.status(uuid)'::regprocedure,'public.worker_accounts(uuid)'::regprocedure,
      'public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure,'public.get_apify_account_status()'::regprocedure])`);
    const before = await definitions(), loopDefs = await loops();
    await apply(); await f.identity(); expect(await definitions()).toEqual(before); expect(await loops()).toEqual(loopDefs);
    await f.identity('authenticated');
    await rejected(() => configure(4), 'permission denied');
    await rejected(() => usage(5), 'permission denied');
    await rejected(() => f.rpc('worker_invalidate_account_usage', [fixtureOwner, 5]), 'permission denied');
    await rejected(() => f.rpc('worker_accounts', [fixtureOwner]), 'permission denied');
    await rejected(() => f.db.query('select * from public.apify_accounts'), 'permission denied');
    await f.identity('authenticated', fixtureStranger); await rejected(() => f.rpc('get_apify_account_status'), 'forbidden');
  });
  it.each(['bounds', 'provision'] as const)('fails atomically on unexpected %s source drift rather than patching another contract', async drift => {
    await f.identity();
    const target = drift === 'bounds' ? 'public.worker_invalidate_account_usage(uuid,integer)' : 'apify_accounts_private.provision_slots()';
    const definition = await f.value<string>('select pg_get_functiondef($1::regprocedure) v', [target]);
    const changed = drift === 'bounds' ? definition.replace('p_account_slot not in (1,2,3)', 'p_account_slot not in (1,2)')
      : definition.replace('values(new.owner_user_id,1,true),(new.owner_user_id,2,false),(new.owner_user_id,3,false);', 'values(new.owner_user_id,1,true),(new.owner_user_id,2,false);');
    expect(changed).not.toBe(definition); await f.db.exec(changed);
    await rejected(() => f.db.exec(sql), `apify_five_account_${drift}_contract_drift`);
    expect(await f.value<number>('select count(*)::integer v from public.apify_accounts')).toBe(3);
    expect(await f.value<string>("select pg_get_constraintdef(oid) v from pg_constraint where conrelid='public.apify_accounts'::regclass and conname='apify_accounts_slot_check'")).not.toContain('4');
  });
  it('only expands fixed constraints/provisioning and contains no work, secret or hold mutation', () => {
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)|net\.http|vault\.|update\s+public\.(scrape_jobs|app_settings|apify_accounts)|reserved_usd\s*=/i);
    expect(sql.indexOf('set constraints all immediate')).toBeLessThan(sql.indexOf('alter table public.apify_accounts'));
    expect(sql.lastIndexOf('set constraints all immediate')).toBeLessThan(sql.indexOf('alter table public.scrape_jobs'));
  });
});

describe('five-account authorization, ordered allocation and immutable history', () => {
  beforeEach(async () => { await apply(); });
  it.each([4, 5])('selects slot %s only after all earlier enabled slots have verified exhausted allowances', async slot => {
    for (let prior = 1; prior < slot; prior++) { await configure(prior); await usage(prior, 5, 5); }
    await configure(slot); await usage(slot, 1, 4);
    const id = await pending(); const result = await claim();
    expect(result).toMatchObject({ job: { id, apify_account_slot: slot, expected_provider_user_id: userFor(slot), reserved_usd: 3 }, max_total_charge_usd: 3 });
    expect((await status()).accounts.slice(0, slot - 1).every(row => row.reason === 'allowance_exhausted')).toBe(true);
  });
  it('retains the primary .907554 uncertain hold and owner ceiling when selecting slot 5', async () => {
    const old = await attempted(1); await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]);
    for (const prior of [2, 3, 4]) { await configure(prior); await usage(prior, 5, 5); }
    await configure(5); await usage(5);
    const id = await pending(); expect(await claim()).toMatchObject({ job: { id, apify_account_slot: 5 }, max_total_charge_usd: 49.092446 });
    expect(await f.value('select jsonb_build_object(\'status\',status,\'hold\',reserved_usd,\'cost\',actual_cost_usd,\'slot\',apify_account_slot) v from public.scrape_jobs where id=$1', [old]))
      .toEqual({ status: 'uncertain', hold: .907554, cost: null, slot: 1 });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBe(50);
  });
  it('cannot bypass unknown usage on slot 4 or an unmapped old attempt using configured slot 5', async () => {
    for (const prior of [1, 2, 3]) { await configure(prior); await usage(prior, 5, 5); }
    await configure(4); await configure(5); await usage(5); await pending();
    expect(await claim()).toEqual({ reason: 'live_setup_or_usage_unverified' });
    expect((await status()).ready_accounts).toBe(0);
    await usage(4, 5, 5);
    await f.db.query(`insert into public.scrape_jobs(owner_user_id,kind,status,live,requested_profiles_count,results_limit,reserved_usd,
      expected_actor_id,expected_provider_user_id,dispatch_nonce,attempt_count) values($1,'daily','uncertain',true,1,30,.907554,'fixture-actor','unmapped',gen_random_uuid(),1)`, [fixtureOwner]);
    expect(await claim()).toEqual({ reason: 'unreconciled_charges' });
    expect((await status()).ready_accounts).toBe(0);
  });
  it('accepts configure/record/invalidate bounds 4/5, rejects 0/6, and keeps legacy primary summaries unchanged', async () => {
    const before = await f.value('select to_jsonb(s) v from public.app_settings s where owner_user_id=$1', [fixtureOwner]);
    for (const slot of [4, 5]) {
      await configure(slot); await usage(slot, slot, 9); await f.rpc('worker_invalidate_account_usage', [fixtureOwner, slot]);
      expect((await f.rpc<Record<string, unknown>[]>('worker_accounts', [fixtureOwner]))[slot - 1]).toMatchObject({ provider_user_id: userFor(slot), usage_usd: slot, limit_usd: 9, usage_reconciled_at: null });
    }
    expect(await f.value('select to_jsonb(s) v from public.app_settings s where owner_user_id=$1', [fixtureOwner])).toEqual(before);
    for (const slot of [0, 6]) {
      await rejected(() => configure(slot), 'invalid_apify_account');
      await rejected(() => usage(slot), 'invalid_provider_usage');
      await rejected(() => f.rpc('worker_invalidate_account_usage', [fixtureOwner, slot]), 'invalid_apify_account');
    }
    await rejected(() => configure(5, userFor(4)), 'duplicate key');
    await rejected(() => usage(5, 0, 50, userFor(4)), 'provider_account_mismatch');
    await rejected(() => usage(5, 0, 50, userFor(5), fixtureStranger), 'provider_account_mismatch');
    await f.identity();
    await rejected(() => f.db.query('insert into public.apify_accounts(owner_id,slot) values($1,6)', [fixtureOwner]), 'apify_accounts_slot_check');
    await rejected(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,apify_account_slot) values($1,'daily',1,30,6)", [fixtureOwner]), 'scrape_jobs_apify_account_slot_check');
  });
  it.each([4, 5])('makes slot %s job pins and credential identities immutable even after authoritative settlement', async slot => {
    for (let prior = 1; prior < slot; prior++) { await configure(prior); await usage(prior, 5, 5); }
    await configure(slot); await usage(slot); await pending(); const result = await claim(); const job = result.job!;
    await rejected(() => f.db.query('update public.scrape_jobs set apify_account_slot=1 where id=$1', [job.id]), 'apify_account_pin_immutable');
    await rejected(() => f.db.query("update public.scrape_jobs set expected_provider_user_id='fixture' where id=$1", [job.id]), 'apify_account_pin_immutable');
    await rejected(() => f.db.query('update public.scrape_jobs set owner_user_id=$1 where id=$2', [fixtureStranger, job.id]), 'apify_account_pin_immutable');
    await f.rpc('worker_attach_run', [job.id, job.dispatch_nonce, `run-${slot}`, 'fixture-actor', userFor(slot), `dataset-${slot}`]);
    await f.rpc('worker_reconcile_run', [job.id, `run-${slot}`, 'fixture-actor', userFor(slot), 'SUCCEEDED', `dataset-${slot}`, .01]);
    await rejected(() => configure(slot, 'replacement-account'), 'apify_account_has_pinned_jobs');
    expect(await f.value<number>('select apify_account_slot::integer v from public.scrape_jobs where id=$1', [job.id])).toBe(slot);
  });
  it('keeps mixed-account callback receipts and disabled 4/5 reconciliation bound to their original identities, not primary', async () => {
    await configure(4); await usage(4); await configure(5); await usage(5);
    const jobs = [{ id: await attempted(1), slot: 1 }, { id: await attempted(5), slot: 5 }, { id: await attempted(4), slot: 4 }];
    for (const { id, slot } of jobs) {
      expect(await f.rpc('worker_record_callback_receipt', [fixtureOwner, id, nonce, `run-${slot}`, 'fixture-actor', userFor(slot)])).toEqual({ accepted: true });
      expect(await f.rpc('worker_record_callback_receipt', [fixtureOwner, id, nonce, `run-${slot}`, 'fixture-actor', userFor(slot === 5 ? 4 : 5)])).toEqual({ accepted: false, reason: 'unknown_callback' });
    }
    await configure(4, userFor(4), false); await configure(5, userFor(5), false);
    const selected = await f.rpc<{ job: { id: string; apify_account_slot: number } }[]>('worker_claim_reconciliation', [fixtureOwner, null, null, 10]);
    expect(selected.map(row => row.job.id).sort()).toEqual(jobs.map(row => row.id).sort());
    for (const { id, slot } of jobs.filter(row => row.slot !== 1)) {
      await rejected(() => f.rpc('worker_attach_run', [id, nonce, `run-${slot}`, 'fixture-actor', 'fixture', `dataset-${slot}`]), 'run_identity_mismatch');
      await f.rpc('worker_attach_run', [id, nonce, `run-${slot}`, 'fixture-actor', userFor(slot), `dataset-${slot}`]);
      await f.rpc('worker_reconcile_run', [id, `run-${slot}`, 'fixture-actor', userFor(slot), 'SUCCEEDED', `dataset-${slot}`, null]);
      expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [id])).toBe(.907554);
      await f.rpc('worker_reconcile_run', [id, `run-${slot}`, 'fixture-actor', userFor(slot), 'SUCCEEDED', `dataset-${slot}`, .01]);
      expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [id])).toBe(0);
    }
    expect(await f.value('select jsonb_build_object(\'status\',status,\'cost\',actual_cost_usd,\'hold\',reserved_usd) v from public.scrape_jobs where id=$1', [jobs[0].id])).toEqual({ status: 'uncertain', cost: null, hold: .907554 });
  });
});
