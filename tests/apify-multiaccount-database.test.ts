import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
const nonce = 'fabc0000-0000-4000-8000-000000000001';
type Claim = { reason?: string; job?: { id: string; apify_account_slot: number; expected_provider_user_id: string; dispatch_nonce: string; reserved_usd: number }; max_total_charge_usd?: number };
type Accounts = { accounts: { slot: number; label: string; enabled: boolean; configured: boolean; reason: string | null; reserved_usd: number; unreconciled_jobs: number }[]; ready_accounts: number };
// Retain the deployed three-slot migration contract as a historical fixture.
beforeAll(async () => { f = await featureDatabase({ excludeMigrations: ['202611140004_apify_five_accounts.sql'] }); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0; update public.app_settings set monthly_budget_usd=50,scraping_enabled=true,initial_backfill_enabled=true,paused=false;");
  await f.identity('service_role');
  await configure(1, 'fixture'); await usage(1, 'fixture');
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
const configure = (slot: number, user: string | null, enabled = true, authorized = true, owner = fixtureOwner) =>
  f.rpc('worker_configure_apify_account', [owner, slot, user, enabled, authorized]);
const usage = (slot: number, user = 'fixture', amount = 0, limit = 50, owner = fixtureOwner) =>
  f.rpc('worker_record_account_usage', [owner, slot, user, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000 * 20).toISOString(), amount, limit]);
async function authoritativeUsage(slot: number, user = 'fixture', amount = 0, limit = 50) {
  const observation = await f.rpc<{ observation_id: string; observed_at: string }>('worker_begin_account_usage', [fixtureOwner, slot, user]);
  await f.rpc('worker_record_account_usage', [fixtureOwner, slot, user, new Date(Date.now() - 86400000).toISOString(),
    new Date(Date.now() + 86400000 * 20).toISOString(), amount, limit, observation.observation_id, observation.observed_at]);
}
const claim = (kind = 'daily') => f.rpc<Claim>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', kind]);
async function pending(kind = 'daily', priority = 0, authorized = true, results = kind === 'profile' ? 1 : 30) {
  const id = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,priority,manual_authorized_by)
    values($1,$2,1,$3,$4,$5) returning id v`, [fixtureOwner, kind, results, priority, authorized ? fixtureOwner : null]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]);
  return id;
}
async function attempted(slot: number | null, status = 'uncertain', hold = .907554, user = slot === 2 ? 'secondary' : 'fixture', owner = fixtureOwner) {
  return f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,reserved_usd,
    expected_actor_id,expected_provider_user_id,apify_account_slot,dispatch_nonce,attempt_count,actor_run_id,created_at)
    values($1,'daily',$2,1,30,true,$3,'fixture-actor',$4,$5,$6,1,$7,now()-interval '1 year') returning id v`,
  [owner, status, hold, user, slot, nonce, status === 'running' || status === 'succeeded' ? 'synthetic-run' : null]);
}
async function status() { await f.identity('authenticated'); const result = await f.rpc<Accounts>('get_apify_account_status'); await f.identity('service_role'); return result; }
async function rejected(query: () => Promise<unknown>, error: string) {
  await f.db.exec('savepoint rejected_call');
  try { await expect(query()).rejects.toThrow(error); }
  finally { await f.db.exec('rollback to savepoint rejected_call; release savepoint rejected_call'); }
}

// Synthetic SQL fixtures only. No live credentials, provider calls or migration application.
describe('fixed owner-scoped Apify registry and SQL authorization', () => {
  it('returns fixed optional slots and exact worker aliases without provider identity in public status', async () => {
    const rows = await f.rpc<Record<string, unknown>[]>('worker_accounts', [fixtureOwner]);
    expect(rows.map(row => row.account_slot)).toEqual([1, 2, 3]);
    expect(Object.keys(rows[0]).sort()).toEqual(['owner_user_id', 'account_slot', 'provider_user_id', 'enabled', 'authorization_confirmed', 'usage_cycle_start_at', 'usage_cycle_end_at', 'usage_usd', 'limit_usd', 'usage_reconciled_at'].sort());
    const publicStatus = await status();
    expect(publicStatus.ready_accounts).toBe(1);
    expect(publicStatus.accounts.map(row => row.reason)).toEqual([null, 'disabled', 'disabled']);
    expect(publicStatus.accounts.map(row => row.label)).toEqual(['Account 1', 'Account 2', 'Account 3']);
    expect(JSON.stringify(publicStatus)).not.toMatch(/fixture|provider_user_id|owner_id|secret|token/);
    expect(Object.keys(publicStatus.accounts[0]).sort()).toEqual(['slot', 'label', 'enabled', 'configured', 'reason', 'usage_usd', 'limit_usd', 'usage_checked_at', 'cycle_end_at', 'reserved_usd', 'unreconciled_jobs', 'monthly_report'].sort());
  });
  it('requires distinct configured provider users per owner and explicit authorization', async () => {
    await rejected(() => configure(2, 'fixture'), 'duplicate key');
    await rejected(() => configure(4, 'fourth'), 'invalid_apify_account');
    await rejected(() => configure(2, null), 'invalid_apify_account');
    await configure(2, 'secondary', true, false); await usage(2, 'secondary');
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]);
    expect((await status()).accounts[1].reason).toBe('setup_required');
    await pending(); expect(await claim()).toEqual({ reason: 'live_setup_or_usage_unverified' });
  });
  it('keeps primary legacy summaries primary-only, validates exact usage identity, and preserves original record-usage RPC', async () => {
    await configure(2, 'secondary'); await usage(2, 'secondary', 3, 7);
    expect(await f.value('select jsonb_build_object(\'id\',provider_account_id,\'usage\',provider_cycle_usage_usd,\'limit\',provider_cycle_limit_usd) v from public.app_settings')).toEqual({ id: 'fixture', usage: 0, limit: 50 });
    await rejected(() => usage(2, 'fixture'), 'provider_account_mismatch');
    await rejected(() => usage(2, 'secondary', -1), 'invalid_provider_usage');
    await rejected(() => usage(2, 'secondary', 1, 5, fixtureStranger), 'provider_account_mismatch');
    await f.rpc('worker_record_usage', [fixtureOwner, 'fixture', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString(), 2, 8]);
    expect((await f.rpc<Record<string, unknown>[]>('worker_accounts', [fixtureOwner]))[0]).toMatchObject({ usage_usd: 2, limit_usd: 8 });
    expect(await f.value<number>('select provider_cycle_usage_usd::float8 v from public.app_settings')).toBe(2);
  });
  it.each(['anon', 'authenticated'])('denies direct registry access and service mutations to %s', async role => {
    await f.identity(role);
    await rejected(() => configure(2, 'secondary'), 'permission denied');
    await rejected(() => usage(1), 'permission denied');
    await rejected(() => f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]), 'permission denied');
    await rejected(() => f.rpc('worker_accounts', [fixtureOwner]), 'permission denied');
    await rejected(() => f.db.query('select * from public.apify_accounts'), 'permission denied');
  });
  it('authenticates public status by allowed owner, is stable/read-only, and denies service/anon reads', async () => {
    for (const role of ['anon', 'service_role']) {
      await f.identity(role); await rejected(() => f.rpc('get_apify_account_status'), 'permission denied');
    }
    await f.identity('authenticated', fixtureStranger); await rejected(() => f.rpc('get_apify_account_status'), 'forbidden');
    await f.identity();
    expect(await f.value<boolean>("select provolatile='s' and not prosecdef v from pg_proc where oid='public.get_apify_account_status()'::regprocedure")).toBe(true);
    expect(await f.value<boolean>("select provolatile='s' and prosecdef v from pg_proc where oid='authenticated_rpc_private.get_apify_account_status()'::regprocedure")).toBe(true);
    const before = await f.value('select jsonb_agg(to_jsonb(j) order by id) v from public.scrape_jobs j');
    await status(); await status();
    expect(await f.value('select jsonb_agg(to_jsonb(j) order by id) v from public.scrape_jobs j')).toEqual(before);
  });
});

describe('transactional ordered allocator and immutable pins', () => {
  it('leaves the old .907554 primary uncertain hold untouched while selecting ready secondary', async () => {
    const old = await attempted(1); await configure(2, 'secondary'); await usage(2, 'secondary');
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]); // Known uncertainty permits alternate despite stale primary usage.
    const id = await pending(); const result = await claim();
    expect(result.job).toMatchObject({ id, apify_account_slot: 2, expected_provider_user_id: 'secondary' });
    expect(result.max_total_charge_usd).toBe(.1);
    expect(await f.value('select jsonb_build_object(\'status\',status,\'cost\',actual_cost_usd,\'hold\',reserved_usd,\'slot\',apify_account_slot) v from public.scrape_jobs where id=$1', [old])).toEqual({ status: 'uncertain', cost: null, hold: .907554, slot: 1 });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBe(1.007554);
  });
  it('reports a primary blocker as warning only when alternate has headroom and global checks allow collection', async () => {
    const old = await attempted(1); await configure(2, 'secondary'); await usage(2, 'secondary');
    expect((await status()).accounts[0]).toMatchObject({ reason: 'unreconciled_charges', reserved_usd: .907554, unreconciled_jobs: 1 });
    await f.identity('authenticated');
    expect(await f.rpc('get_creator_collection_state', [f.workspace])).toMatchObject({ reason: null, blocking_job_id: old });
    await f.identity('service_role');
    await f.db.exec('update public.app_settings set monthly_budget_usd=.907554');
    await pending(); expect(await claim()).toEqual({ reason: 'unreconciled_charges' });
    expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [old])).toBe(.907554);
  });
  it('rotates 1 then 2 then 3 only on verified exhausted allowances', async () => {
    await configure(2, 'secondary'); await usage(2, 'secondary', 5, 5);
    await configure(3, 'third'); await usage(3, 'third'); await usage(1, 'fixture', 5, 5);
    expect((await status()).accounts.map(a => a.reason)).toEqual(['allowance_exhausted', 'allowance_exhausted', null]);
    await pending(); expect((await claim()).job).toMatchObject({ apify_account_slot: 3, expected_provider_user_id: 'third' });
  });
  it('does not rotate past stale/null/error usage of an otherwise enabled preceding account', async () => {
    await configure(2, 'secondary'); await usage(2, 'secondary');
    await f.rpc('worker_invalidate_account_usage', [fixtureOwner, 1]);
    await pending(); expect(await claim()).toEqual({ reason: 'live_setup_or_usage_unverified' });
    expect((await status()).ready_accounts).toBe(0);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs')).toBe(0);
    await usage(1); await f.identity();
    await f.db.exec("update public.apify_accounts set usage_checked_at=now()-interval '16 minutes' where slot=1");
    await f.identity('service_role'); expect(await claim()).toEqual({ reason: 'live_setup_or_usage_unverified' });
  });
  it('fails closed for an unmapped legacy attempted job instead of guessing or releasing its hold', async () => {
    await configure(2, 'secondary'); await usage(2, 'secondary');
    const unknown = await attempted(null, 'uncertain', .907554, 'unmapped-provider');
    await pending();
    expect(await claim()).toEqual({ reason: 'unreconciled_charges' });
    expect((await status()).ready_accounts).toBe(0);
    expect(await f.value('select jsonb_build_object(\'slot\',apify_account_slot,\'hold\',reserved_usd) v from public.scrape_jobs where id=$1', [unknown])).toEqual({ slot: null, hold: .907554 });
  });
  it('includes all potentially current-cycle account costs without assuming usage reflection, but all owner holds globally', async () => {
    const primary = await attempted(1, 'succeeded', 0);
    await f.db.query("update public.scrape_jobs set actual_cost_usd=5,billing_reconciled_at=now(),billing_month='2025-01-01' where id=$1", [primary]);
    await f.identity(); await f.db.exec("update public.apify_accounts set usage_checked_at=now()-interval '1 minute',usage_usd=5,limit_usd=10 where slot=1");
    await f.identity('service_role'); await configure(2, 'secondary'); await usage(2, 'secondary', 1, 4);
    await pending(); const result = await claim();
    expect(result.job?.apify_account_slot).toBe(2); expect(result.max_total_charge_usd).toBe(.1);
    await usage(1, 'fixture', 5, 10);
    expect((await status()).accounts[0].reason).toBe('allowance_exhausted'); // A legacy refresh cannot discard known local charges.
    await authoritativeUsage(1, 'fixture', 5, 10);
    expect((await status()).accounts[0].reason).toBe('allowance_exhausted'); // A request-start checkpoint cannot prove provider reflection.
  });
  it('serializes concurrent contenders, pins once, and never oversubscribes the owner or account ceiling', async () => {
    await usage(1, 'fixture', 0, .50);
    await configure(2, 'secondary'); await usage(2, 'secondary', 0, .25);
    await f.db.exec('update public.app_settings set monthly_budget_usd=.50');
    await Promise.all([pending(), pending(), pending()]);
    const results = await Promise.all([claim(), claim(), claim()]);
    const jobs = results.flatMap(row => row.job ? [row.job] : []);
    expect(jobs).toHaveLength(2);
    expect(results.find(row => !row.job)).toEqual({ reason: 'concurrency_limit' });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBe(.20);
    expect(new Set(jobs.map(job => job.id)).size).toBe(2);
    expect(jobs.map(job => job.apify_account_slot)).toEqual([1, 2]);
    expect(jobs.map(job => job.reserved_usd)).toEqual([.1, .1]);
    const def = await f.value<string>("select pg_get_functiondef('public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure) v");
    expect(def).toContain('pg_advisory_xact_lock'); expect(def).toContain('for update skip locked');
    expect(def.indexOf('owner_headroom<=0')).toBeLessThan(def.indexOf('registry:=apify_accounts_private.status'));
  });
  it('does not share one verified account between concurrent contenders even with allowance and owner capacity left', async () => {
    await usage(1, 'fixture', 0, .50);
    await Promise.all([pending(), pending(), pending()]);
    const results = await Promise.all([claim(), claim(), claim()]);
    const jobs = results.flatMap(row => row.job ? [row.job] : []);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ apify_account_slot: 1, reserved_usd: .1 });
    expect(results.filter(row => !row.job)).toEqual([{ reason: 'account_capacity_full' }, { reason: 'account_capacity_full' }]);
    expect((await status()).accounts[0]).toMatchObject({ reason: 'account_capacity_full', reserved_usd: .1 });
    expect(await f.value<number>("select count(*)::int v from public.scrape_jobs where status='pending'")).toBe(2);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBe(.1);
  });
  it('rejects pin changes and credential-user swaps even after authoritative settlement', async () => {
    await pending(); const { job } = await claim();
    expect(job!.apify_account_slot).toBe(1);
    await rejected(() => f.db.query('update public.scrape_jobs set apify_account_slot=null where id=$1', [job!.id]), 'apify_account_pin_immutable');
    await rejected(() => f.db.query("update public.scrape_jobs set expected_provider_user_id='secondary' where id=$1", [job!.id]), 'immutable_collection_claim');
    await rejected(() => configure(1, 'different'), 'apify_account_has_pinned_jobs');
    await f.rpc('worker_attach_run', [job!.id, job!.dispatch_nonce, 'settled-run', 'fixture-actor', 'fixture', 'dataset']);
    await f.rpc('worker_reconcile_run', [job!.id, 'settled-run', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', .01]);
    await rejected(() => configure(1, 'different'), 'apify_account_has_pinned_jobs');
    await configure(1, 'fixture', false); // Same credential identity may be disabled; settlement still works.
  });
});

describe('account-specific durable callbacks, reconciliation and preserved wrappers', () => {
  it('requires pinned owner/slot/provider mapping and still reconciles a disabled secondary', async () => {
    await configure(2, 'secondary'); await usage(2, 'secondary');
    const id = await attempted(2);
    const receipt = (owner = fixtureOwner, provider = 'secondary') => f.rpc('worker_record_callback_receipt', [owner, id, nonce, 'secondary-run', 'fixture-actor', provider]);
    expect(await receipt(fixtureStranger)).toEqual({ accepted: false, reason: 'unknown_callback' });
    expect(await receipt(fixtureOwner, 'fixture')).toEqual({ accepted: false, reason: 'unknown_callback' });
    expect(await receipt()).toEqual({ accepted: true });
    await configure(2, 'secondary', false);
    const selected = await f.rpc<{ job: { id: string; apify_account_slot: number } }[]>('worker_claim_reconciliation', [fixtureOwner, id, null, 10]);
    expect(selected[0].job).toMatchObject({ id, apify_account_slot: 2 });
    await rejected(() => f.rpc('worker_attach_run', [id, nonce, 'secondary-run', 'fixture-actor', 'fixture', 'dataset']), 'run_identity_mismatch');
    await f.rpc('worker_attach_run', [id, nonce, 'secondary-run', 'fixture-actor', 'secondary', 'dataset']);
    await rejected(() => f.rpc('worker_reconcile_run', [id, 'secondary-run', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', .01]), 'run_identity_mismatch');
    await f.rpc('worker_reconcile_run', [id, 'secondary-run', 'fixture-actor', 'secondary', 'SUCCEEDED', 'dataset', null]);
    expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [id])).toBe(.907554);
    await f.rpc('worker_reconcile_run', [id, 'secondary-run', 'fixture-actor', 'secondary', 'SUCCEEDED', 'dataset', .01]);
    expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [id])).toBe(0);
  });
  it('does not accept an unpinned legacy callback or reconcile against a changed registry identity', async () => {
    const id = await attempted(null);
    expect(await f.rpc('worker_record_callback_receipt', [fixtureOwner, id, nonce, 'run', 'fixture-actor', 'fixture'])).toEqual({ accepted: false, reason: 'unknown_callback' });
    await rejected(() => f.rpc('worker_attach_run', [id, nonce, 'run', 'fixture-actor', 'fixture', 'dataset']), 'run_identity_mismatch');
    expect(await f.rpc('worker_claim_reconciliation', [fixtureOwner, id, null, 10])).toEqual([]);
  });
  it('retains exact-target carousel pilot caps, manual authorization and media paid-policy gates with alternate accounts', async () => {
    await attempted(1); await configure(2, 'secondary'); await usage(2, 'secondary');
    const selected = await pending('carousel', 0); const other = await pending('carousel', 100);
    const pilot = await f.rpc<Claim>('worker_claim_carousel_pilot', [fixtureOwner, selected, 'fixture-actor']);
    expect(pilot).toMatchObject({ job: { id: selected, apify_account_slot: 2, reserved_usd: .10 }, max_total_charge_usd: .10 });
    expect(await f.value<string>('select status v from public.scrape_jobs where id=$1', [other])).toBe('pending');
    expect(await f.rpc('worker_claim_carousel_pilot', [fixtureOwner, other, 'fixture-actor'])).toEqual({ reason: 'concurrency_limit' });
  });
  it('rejects unauthorized carousel and media without active recovery links before account allocation', async () => {
    await pending('carousel', 0, false);
    expect(await claim('carousel')).toEqual({ reason: 'manual_authorization_required' });
    await pending('manual', 0, true, 100);
    expect(await claim('manual')).toEqual({ reason: 'media_job_link_required' });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs')).toBe(0);
  });
  it('contains no schedule, external request, credential or primary-hold release operation', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/202611140003_apify_multiaccount.sql'), 'utf8');
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)|net\.http|vault\.|reserved_usd\s*=\s*0|deploy/i);
    expect(sql).toMatch(/j\.expected_provider_user_id=a\.provider_user_id/);
    expect(sql).toMatch(/j\.live and \(j\.attempt_count>0/);
  });
});
