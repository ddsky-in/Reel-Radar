import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
const nonce = 'fa100000-0000-4000-8000-000000000003';
const wrongNonce = 'fa100000-0000-4000-8000-000000000004';
type Claim = { job: { id: string; reconciliation_attempts: number; actor_run_id: string | null }; callback_hint: { run_id: string; dispatch_nonce: string } | null; reconciliation_token: string };
beforeAll(async () => { f = await featureDatabase(); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity();
  await f.db.exec("delete from public.scrape_callback_receipts; update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0,actor_run_id=null,reconciliation_token=null,reconciliation_expires_at=null;");
  await f.identity('service_role');
});
async function job(status = 'uncertain', run: string | null = null, owner = fixtureOwner) {
  return f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,live,requested_profiles_count,results_limit,dispatch_nonce,
    expected_actor_id,expected_provider_user_id,apify_account_slot,actor_run_id,reserved_usd,scheduled_for)
    values($1,'daily',$2,true,1,30,$3,'fixture-actor','fixture',1,$4,.10,now()-interval '1 day') returning id v`, [owner, status, nonce, run]);
}
const receipt = (id: string, run = 'hint', owner = fixtureOwner, n = nonce, actor = 'fixture-actor', account = 'fixture') =>
  f.rpc<{ accepted: boolean; reason?: string }>('worker_record_callback_receipt', [owner, id, n, run, actor, account]);
const claim = (id: string | null = null, owner = fixtureOwner, limit = 10, kind: string | null = null) =>
  f.rpc<Claim[]>('worker_claim_reconciliation', [owner, id, kind, limit]);
const complete = (row: Claim, run: string | null = row.callback_hint?.run_id ?? null, state = 'pending', owner = fixtureOwner, token = row.reconciliation_token) =>
  f.rpc('worker_complete_reconciliation', [owner, row.job.id, token, run, state]);

describe('durable service-only callback receipts', () => {
  it('persists a replay-safe unbound hint without attaching a run or releasing its unknown charge hold', async () => {
    const id = await job();
    expect(await receipt(id)).toEqual({ accepted: true });
    expect(await receipt(id)).toEqual({ accepted: true });
    expect(await f.value<number>('select count(*)::integer v from public.scrape_callback_receipts where job_id=$1', [id])).toBe(1);
    expect(await f.value('select jsonb_build_object(\'run\',actor_run_id,\'status\',status,\'cost\',actual_cost_usd,\'hold\',reserved_usd) v from public.scrape_jobs where id=$1', [id]))
      .toEqual({ run: null, status: 'uncertain', cost: null, hold: .1 });
    expect((await claim())[0]).toMatchObject({ job: { id, actor_run_id: null }, callback_hint: { run_id: 'hint', dispatch_nonce: nonce } });
  });
  it('requires exact owner, nonce, expected actor and configured account before persistence', async () => {
    const id = await job();
    for (const args of [
      [fixtureStranger, nonce, 'fixture-actor', 'fixture'], [fixtureOwner, wrongNonce, 'fixture-actor', 'fixture'],
      [fixtureOwner, nonce, 'wrong-actor', 'fixture'], [fixtureOwner, nonce, 'fixture-actor', 'wrong-account'],
    ]) expect(await receipt(id, 'hint', args[0], args[1], args[2], args[3])).toEqual({ accepted: false, reason: 'unknown_callback' });
    expect(await receipt(id, 'https://private.test/run')).toEqual({ accepted: false, reason: 'unknown_callback' });
    await f.identity(); await f.db.query("update public.app_settings set provider_account_id='changed' where owner_user_id=$1", [fixtureOwner]);
    await f.identity('service_role'); expect(await receipt(id)).toEqual({ accepted: false, reason: 'unknown_callback' });
    await f.identity(); await f.db.query("update public.app_settings set provider_account_id='fixture' where owner_user_id=$1", [fixtureOwner]);
    expect(await f.value<number>('select count(*)::integer v from public.scrape_callback_receipts')).toBe(0);
  });
  it('rejects fake callbacks for nonlive, nondispatched and differently bound jobs', async () => {
    const id = await job('running', 'bound');
    expect(await receipt(id, 'other')).toEqual({ accepted: false, reason: 'unknown_callback' });
    expect(await receipt(id, 'bound')).toEqual({ accepted: true });
    const pending = await job('pending'); expect((await receipt(pending)).accepted).toBe(false);
    await f.db.query('update public.scrape_jobs set live=false where id=$1', [id]);
    expect((await receipt(id, 'bound')).accepted).toBe(false);
  });
  it('caps pending hints, quarantines mismatches, then admits the true hint without altering acceptance or budgets', async () => {
    const id = await job();
    for (const run of ['fake1', 'fake2', 'fake3']) expect(await receipt(id, run)).toEqual({ accepted: true });
    expect(await receipt(id, 'true')).toEqual({ accepted: false, reason: 'callback_capacity_retry' });
    const [selected] = await claim(id);
    await complete(selected, selected.callback_hint!.run_id, 'rejected');
    expect(await receipt(id, 'true')).toEqual({ accepted: true });
    expect(await f.value('select jsonb_build_object(\'status\',status,\'cost\',actual_cost_usd,\'hold\',reserved_usd) v from public.scrape_jobs where id=$1', [id]))
      .toEqual({ status: 'uncertain', cost: null, hold: .1 });
    expect(await f.value<number>('select count(*)::integer v from public.scrape_callback_receipts where job_id=$1', [id])).toBe(3);
  });
  it('rotates pending hints so an unavailable or malformed oldest hint cannot starve the true callback', async () => {
    const id = await job();
    await receipt(id, 'unavailable'); await receipt(id, 'true');
    const [first] = await claim(id); expect(first.callback_hint?.run_id).toBe('unavailable');
    await complete(first);
    const [second] = await claim(id); expect(second.callback_hint?.run_id).toBe('true');
    expect(await f.value<number>('select count(*)::integer v from public.scrape_callback_receipts where job_id=$1 and selected_at is not null', [id])).toBe(2);
  });
  it('never marks an unbound hint verified; existing attach RPC still checks actor/account/nonce', async () => {
    const id = await job(); await receipt(id); const [selected] = await claim(id);
    await expect(complete(selected, 'hint', 'verified')).rejects.toThrow('callback_not_attached');
    for (const args of [[wrongNonce, 'fixture-actor', 'fixture'], [nonce, 'wrong', 'fixture'], [nonce, 'fixture-actor', 'wrong']]) {
      await expect(f.rpc('worker_attach_run', [id, args[0], 'hint', args[1], args[2], 'dataset'])).rejects.toThrow('run_identity_mismatch');
    }
    await f.rpc('worker_attach_run', [id, nonce, 'hint', 'fixture-actor', 'fixture', 'dataset']);
    await complete(selected, 'hint', 'verified');
    expect(await f.value<string>('select state v from public.scrape_callback_receipts where job_id=$1', [id])).toBe('verified');
  });
  it('makes a verified replay eligible after final billing without resetting due, leases or attempts', async () => {
    const id = await job(); await receipt(id); const [selected] = await claim(id);
    await f.rpc('worker_attach_run', [id, nonce, 'hint', 'fixture-actor', 'fixture', 'dataset']);
    await complete(selected, 'hint', 'verified');
    await f.db.query("update public.scrape_jobs set status='succeeded',actual_cost_usd=.001,reserved_usd=0,reconciliation_next_at=now()+interval '1 day' where id=$1", [id]);
    expect(await claim(id)).toEqual([]);
    const due = await f.value<string>('select reconciliation_next_at::text v from public.scrape_jobs where id=$1', [id]);
    expect(await receipt(id)).toEqual({ accepted: true });
    expect(await f.value<string>('select reconciliation_next_at::text v from public.scrape_jobs where id=$1', [id])).toBe(due);
    expect((await claim(id))[0]).toMatchObject({ job: { id, reconciliation_attempts: 2 }, callback_hint: { run_id: 'hint' } });
  });
  it.each(['anon', 'authenticated'])('denies receipt table and every new service RPC to %s', async role => {
    const id = await job(); await f.identity(role);
    await expect(receipt(id)).rejects.toThrow('permission denied');
    await expect(claim()).rejects.toThrow('permission denied');
    await expect(f.rpc('worker_complete_reconciliation', [fixtureOwner, id, nonce, null, 'pending'])).rejects.toThrow('permission denied');
    await expect(f.db.query('select * from public.scrape_callback_receipts')).rejects.toThrow('permission denied');
  });
});

describe('fair bounded reconciliation claims', () => {
  it('stamps ten before reads and selects newer work next instead of starving behind old running jobs', async () => {
    const ids = await Promise.all(Array.from({ length: 13 }, (_, i) => job('running', `fair${i}`)));
    const first = await claim(); expect(first).toHaveLength(10);
    expect(first.every(row => row.job.reconciliation_attempts === 1 && row.reconciliation_token)).toBe(true);
    const second = await claim(); expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map(row => row.job.id))).toEqual(new Set(ids));
    expect(await claim()).toEqual([]);
    for (const row of [...first, ...second]) await complete(row);
    // Force all due: least-recently selected still wins, regardless of scheduled age.
    await f.db.exec("update public.scrape_jobs set reconciliation_next_at=now()-interval '1 second',reconciliation_selected_at=reconciliation_selected_at-interval '1 hour';");
    expect((await claim()).map(row => row.job.id)).toEqual(first.map(row => row.job.id));
  });
  it('includes terminal unknown costs after processing ends and retains reservations until authoritative cost arrives', async () => {
    const id = await job('succeeded', 'billing');
    await f.db.query("update public.scrape_jobs set provider_terminal_status='SUCCEEDED',dataset_finished=true where id=$1", [id]);
    const [selected] = await claim(); expect(selected.job.id).toBe(id); await complete(selected);
    await f.rpc('worker_reconcile_run', [id, 'billing', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', null]);
    expect(await f.value('select jsonb_build_object(\'cost\',actual_cost_usd,\'hold\',reserved_usd) v from public.scrape_jobs where id=$1', [id]))
      .toEqual({ cost: null, hold: .1 });
    expect((await claim(id))[0].job.id).toBe(id);
    await f.rpc('worker_reconcile_run', [id, 'billing', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', .007]);
    await f.db.query('update public.scrape_jobs set reconciliation_token=null,reconciliation_expires_at=null where id=$1', [id]);
    expect(await claim(id)).toEqual([]);
    expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [id])).toBe(0);
  });
  it('does not infer non-start for uncertain jobs with no callback and excludes pending starts', async () => {
    await job(); await job('pending'); expect(await claim()).toEqual([]);
    expect(await f.value<number>("select sum(reserved_usd)::float8 v from public.scrape_jobs where status='uncertain'")).toBe(.1);
  });
  it('exact scopes bypass due throttle without bypassing owner, kind or in-flight lease', async () => {
    const id = await job('running', 'scoped');
    await f.db.query("update public.scrape_jobs set reconciliation_next_at=now()+interval '1 day' where id=$1", [id]);
    expect(await claim()).toEqual([]); expect(await claim(id, fixtureStranger)).toEqual([]);
    expect(await claim(id, fixtureOwner, 10, 'carousel')).toEqual([]);
    const [selected] = await claim(id); expect(selected.job.id).toBe(id); expect(await claim(id)).toEqual([]);
    await complete(selected); expect((await claim(id))[0].job.id).toBe(id);
  });
  it('checks current provider account and persisted hint identity again before selection', async () => {
    const id = await job(); await receipt(id);
    await f.db.query("update public.scrape_callback_receipts set expected_actor_id='wrong' where job_id=$1", [id]);
    expect(await claim(id)).toEqual([]);
    await f.db.query("update public.scrape_callback_receipts set expected_actor_id='fixture-actor' where job_id=$1", [id]);
    await f.identity(); await f.db.query("update public.app_settings set provider_account_id='changed' where owner_user_id=$1", [fixtureOwner]);
    await f.identity('service_role'); expect(await claim(id)).toEqual([]);
    await f.identity(); await f.db.query("update public.app_settings set provider_account_id='fixture' where owner_user_id=$1", [fixtureOwner]);
  });
  it('keeps processing cursor, original lease and budget untouched, bounds backoff to five minutes and ignores stale completion', async () => {
    const id = await job('processing', 'cursor');
    await f.db.query("update public.scrape_jobs set dataset_cursor=200,lease_token=$2,lease_expires_at=now()+interval '10 minutes',reconciliation_attempts=8 where id=$1", [id, nonce]);
    const [selected] = await claim(id); await complete(selected, null, 'pending', fixtureOwner, wrongNonce);
    expect(await claim(id)).toEqual([]);
    await complete(selected);
    expect(await f.value('select jsonb_build_object(\'cursor\',dataset_cursor,\'lease\',lease_token,\'hold\',reserved_usd) v from public.scrape_jobs where id=$1', [id]))
      .toEqual({ cursor: 200, lease: nonce, hold: .1 });
    expect(await f.value<number>('select extract(epoch from reconciliation_next_at-now())::float8 v from public.scrape_jobs where id=$1', [id])).toBeLessThanOrEqual(3);
    await f.db.query("update public.scrape_jobs set status='failed',reconciliation_token=null where id=$1", [id]);
    const [terminal] = await claim(id); await complete(terminal);
    const seconds = await f.value<number>('select extract(epoch from reconciliation_next_at-now())::float8 v from public.scrape_jobs where id=$1', [id]);
    expect(seconds).toBeGreaterThan(295); expect(seconds).toBeLessThanOrEqual(300);
  });
  it('recovers a crashed selected batch after its separate lease expires', async () => {
    const id = await job('running', 'crash'); const [selected] = await claim(id);
    await f.db.query("update public.scrape_jobs set reconciliation_expires_at=now()-interval '1 second',reconciliation_next_at=now()-interval '1 second' where id=$1", [id]);
    const [reclaimed] = await claim(); expect(reclaimed.job.id).toBe(id); expect(reclaimed.reconciliation_token).not.toBe(selected.reconciliation_token);
    await complete(selected); expect(await claim(id)).toEqual([]); await complete(reclaimed);
  });
  it.each([0, 11, null])('rejects an invalid batch limit: %s', async limit => {
    await expect(f.rpc('worker_claim_reconciliation', [fixtureOwner, null, null, limit])).rejects.toThrow('invalid_reconciliation_scope');
  });
});
