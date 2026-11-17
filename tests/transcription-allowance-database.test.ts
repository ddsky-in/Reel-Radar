import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Attempt = { id: string; reel_id: string; attempt_id: string; lease_token: string };
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
async function claim() {
  await f.identity('service_role');
  return (await f.rpc<{ jobs: Attempt[] }>('worker_transcription_claim', [2])).jobs;
}
async function start() { await f.reel(); await f.activate(); return (await claim())[0]; }
async function fail(a: Attempt, status = 'media_unavailable', estimate: number | null = null) {
  await f.identity('service_role');
  return f.rpc('worker_transcription_fail', [a.attempt_id, a.lease_token, status, 'private signed fixture URL', estimate]);
}
async function ledger(a: Attempt) {
  await f.identity();
  return f.value<{ status: string; accounted: number; reserved: number; actual: number | null; reconciled: boolean; denied: boolean; provider: string | null }>(`select jsonb_build_object(
    'status',status,'accounted',accounted_usd,'reserved',reserved_usd,'actual',actual_cost_usd,
    'reconciled',reconciled_at is not null,'denied',submit_denied,'provider',provider_job_id) v
    from public.transcript_attempts where id=$1`, [a.attempt_id]);
}
async function correction(ids: string[], owner = fixtureOwner, workspace = f.workspace) {
  await f.identity('service_role');
  return f.rpc('worker_transcription_correct_unsubmitted', [workspace, owner, ids]);
}
async function historical(a: Attempt) {
  await f.identity();
  await f.db.query(`update public.transcript_attempts set status='media_unavailable',accounted_usd=.08,
    reserved_usd=0,actual_cost_usd=null,reconciled_at=null where id=$1`, [a.attempt_id]);
  await f.db.query("update public.transcript_jobs set status='media_unavailable' where id=$1", [a.id]);
}
async function reject(run: () => Promise<unknown>, pattern: RegExp) {
  await f.db.exec('savepoint expected_error');
  await expect(run()).rejects.toThrow(pattern);
  await f.db.exec('rollback to savepoint expected_error');
}

describe('transcription allowance for unsubmitted media failures', () => {
  it('records proven zero cost, retains the failure and preserves bounded explicit retry', async () => {
    const a = await start();
    expect(await fail(a)).toMatchObject({ status: 'media_unavailable', duplicate: false });
    expect(await ledger(a)).toMatchObject({ status: 'media_unavailable', accounted: 0, reserved: 0, actual: 0, reconciled: true, denied: true });
    expect(await f.value<string>('select error_message v from public.transcript_jobs where id=$1', [a.id])).not.toContain('private');
    await f.identity('authenticated');
    const result = await f.rpc<{ transcript: { status: string }; processing: { request_allowed: boolean } }>('get_reel_detail', [f.workspace, a.reel_id]);
    expect(result.transcript.status).toBe('media_unavailable'); expect(result.processing.request_allowed).toBe(true);
    await f.rpc('request_reel_transcript', [f.workspace, a.reel_id]);
    expect((await claim())[0].reel_id).toBe(a.reel_id);
    await f.identity();
    expect(await f.value<number>('select sum(accounted_usd+reserved_usd)::float8 v from public.transcript_attempts')).toBe(.08);
  });
  it('repeats failure safely and fences a late paid start, callback and completion', async () => {
    const a = await start(); await fail(a);
    expect(await fail(a)).toMatchObject({ duplicate: true });
    expect(await f.rpc('worker_transcription_before_submit', [a.attempt_id, a.lease_token])).toMatchObject({ allow: false });
    expect(await f.rpc('worker_transcription_attach', [a.attempt_id, a.lease_token, 'late-fixture'])).toMatchObject({ status: 'media_unavailable', duplicate: true });
    await reject(() => f.rpc('worker_transcription_complete', [a.attempt_id, a.lease_token, 'Late fixture']), /attempt_not_completable/);
    expect(await ledger(a)).toMatchObject({ accounted: 0, actual: 0, provider: null });
  });
  it('rejects a stale lease without releasing the live reservation', async () => {
    const a = await start();
    await reject(() => f.rpc('worker_transcription_fail', [a.attempt_id, fixtureStranger, 'media_unavailable']), /lease_expired/);
    expect(await ledger(a)).toMatchObject({ status: 'submitting', reserved: .08, actual: null });
  });
  it('retains conservative accounting once paid permission was granted', async () => {
    const a = await start(); await f.rpc('worker_transcription_before_submit', [a.attempt_id, a.lease_token]);
    await fail(a);
    expect(await ledger(a)).toMatchObject({ accounted: .08, reserved: 0, actual: null, reconciled: false });
  });
  it('retains provider-linked attempts even without a submission flag', async () => {
    const a = await start(); await f.rpc('worker_transcription_attach', [a.attempt_id, a.lease_token, 'fixture-linked']);
    await fail(a);
    expect(await ledger(a)).toMatchObject({ accounted: .08, actual: null, reconciled: false });
  });
  it('preserves uncertainty and rejects a definitive media failure without reconciliation', async () => {
    const a = await start(); await fail(a, 'uncertain');
    await f.identity('service_role');
    await reject(() => fail(a), /reconciliation_required/);
    expect(await ledger(a)).toMatchObject({ status: 'uncertain', reserved: .08, actual: null, reconciled: false });
  });
  it('does not discard a supplied nonzero cost estimate', async () => {
    const a = await start(); await fail(a, 'media_unavailable', .03);
    expect(await ledger(a)).toMatchObject({ accounted: .08, actual: null, reconciled: false });
  });
  it('does not release ready or no-speech allocations on a later failure message', async () => {
    for (const speech of [true, false]) {
      const a = await start(); await f.rpc('worker_transcription_before_submit', [a.attempt_id, a.lease_token]);
      await f.rpc('worker_transcription_complete', [a.attempt_id, a.lease_token, speech ? 'Fixture speech' : '', 'en', '[]', !speech]);
      expect(await fail(a)).toMatchObject({ status: speech ? 'ready' : 'no_speech', duplicate: true });
      expect(await ledger(a)).toMatchObject({ accounted: .08, actual: null });
    }
  });
  it('repairs only explicit proven-unsubmitted historical IDs and is idempotent', async () => {
    const safe = await start(); await historical(safe);
    const paid = await start(); await f.rpc('worker_transcription_before_submit', [paid.attempt_id, paid.lease_token]); await historical(paid);
    const untouched = await start(); await historical(untouched);
    expect(await correction([safe.attempt_id, paid.attempt_id])).toEqual({ corrected: 1, released_usd: .08 });
    expect(await correction([safe.attempt_id, paid.attempt_id])).toEqual({ corrected: 0, released_usd: 0 });
    expect(await ledger(safe)).toMatchObject({ status: 'media_unavailable', actual: 0, accounted: 0 });
    expect(await ledger(paid)).toMatchObject({ actual: null, accounted: .08 });
    expect(await ledger(untouched)).toMatchObject({ actual: null, accounted: .08 });
  });
  it('skips historical provider identity, known cost, and uncertain holds', async () => {
    const linked = await start(); await historical(linked);
    await f.db.query("update public.transcript_attempts set provider_transcription_id='fixture-linked' where id=$1", [linked.attempt_id]);
    const known = await start(); await historical(known);
    await f.db.query('update public.transcript_attempts set actual_cost_usd=.04,reconciled_at=now() where id=$1', [known.attempt_id]);
    const uncertain = await start(); await fail(uncertain, 'uncertain');
    expect(await correction([linked.attempt_id, known.attempt_id, uncertain.attempt_id])).toEqual({ corrected: 0, released_usd: 0 });
    expect(await ledger(uncertain)).toMatchObject({ reserved: .08, actual: null });
  });
  it('restores capacity for the prioritized Reel and still enforces the exact cap', async () => {
    const failed = await start(); await historical(failed);
    const normal = await f.reel(), prioritized = await f.reel();
    await f.identity(); await f.db.exec('update public.transcription_settings set monthly_budget_usd=.08');
    await f.identity('authenticated'); await f.rpc('request_reel_transcript', [f.workspace, prioritized]);
    expect(await claim()).toEqual([]);
    expect(await correction([failed.attempt_id])).toMatchObject({ released_usd: .08 });
    expect((await claim()).map(a => a.reel_id)).toEqual([prioritized]);
    expect(await claim()).toEqual([]);
    await f.identity();
    expect(await f.value<number>('select monthly_budget_usd::float8 v from public.transcription_settings')).toBe(.08);
    expect(await f.value<string>('select status v from public.transcript_jobs where reel_id=$1', [normal])).toBe('budget_paused');
  });
  it('rejects wrong owner, foreign workspace attempts and nonexistent IDs atomically', async () => {
    const a = await start(); await historical(a); await f.identity('service_role');
    await reject(() => correction([a.attempt_id], fixtureStranger), /forbidden/);
    await reject(() => correction([a.attempt_id, fixtureStranger]), /forbidden/);
    await f.identity('authenticated');
    const { id: other } = await f.rpc<{ id: string }>('create_workspace', ['Unrelated fixture']);
    await f.identity('service_role'); await reject(() => correction([a.attempt_id], fixtureOwner, other), /forbidden/);
    expect(await ledger(a)).toMatchObject({ accounted: .08, actual: null });
  });
  it('keeps correction and settlement RPCs inaccessible to browser roles', async () => {
    await f.identity();
    for (const signature of ['worker_transcription_correct_unsubmitted(uuid,uuid,uuid[])', 'worker_transcription_fail(uuid,uuid,text,text,numeric)',
      'worker_transcription_attach(uuid,uuid,text,text)', 'worker_transcription_reconcile(uuid,text,numeric)']) {
      for (const role of ['anon', 'authenticated']) {
        expect(await f.value<boolean>('select has_function_privilege($1,$2,\'execute\') v', [role, `public.${signature}`])).toBe(false);
      }
    }
  });
  it('replaces provisional allocation only with verified actual USD, preserving replay checks', async () => {
    const a = await start(); await f.rpc('worker_transcription_before_submit', [a.attempt_id, a.lease_token]);
    await f.rpc('worker_transcription_complete', [a.attempt_id, a.lease_token, 'Fixture speech']);
    expect(await ledger(a)).toMatchObject({ accounted: .08, actual: null });
    await f.identity('service_role'); await f.rpc('worker_transcription_reconcile', [a.attempt_id, 'charged', .012]);
    await f.rpc('worker_transcription_reconcile', [a.attempt_id, 'charged', .012]);
    await reject(() => f.rpc('worker_transcription_reconcile', [a.attempt_id, 'charged', .08]), /reconciliation_mismatch/);
    expect(await ledger(a)).toMatchObject({ status: 'ready', accounted: .012, actual: .012, reserved: 0, reconciled: true });
  });
});
