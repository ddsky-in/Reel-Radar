import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Job = { id: string; reel_id: string; attempt_id: string; lease_token: string };
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
async function failJobs(count = 1) {
  for (let i = 0; i < count; i++) await f.reel();
  await f.activate();
  const { jobs } = await f.rpc<{ jobs: Job[] }>('worker_transcription_claim', [2]);
  for (const j of jobs) await f.rpc('worker_transcription_before_submit', [j.attempt_id, j.lease_token]);
  for (const j of jobs) {
    await f.rpc('worker_transcription_fail', [j.attempt_id, j.lease_token, 'uncertain', 'Fixture 502', null]);
  }
  await f.identity('authenticated');
  return jobs;
}
async function retry(job: Job, confirmation = true, workspace = f.workspace) {
  await f.identity('authenticated');
  return recoverError(() => f.rpc('retry_reel_transcript', [workspace, job.reel_id, job.attempt_id, confirmation]));
}
async function recoverError<T>(work: () => Promise<T>) {
  await f.db.exec('savepoint expected_error');
  try { return await work(); }
  catch (error) { await f.db.exec('rollback to savepoint expected_error'); throw error; }
  finally { await f.db.exec('release savepoint expected_error'); }
}
describe('owner-authorized uncertain transcript retries', () => {
  it('offers immediate recovery of a returned 502 while ordinary refresh/request does not retry', async () => {
    const [job] = await failJobs();
    expect(await f.rpc('get_reel_detail', [f.workspace, job.reel_id])).toMatchObject({
      transcript: { status: 'uncertain' }, processing: { request_allowed: false, retry_attempt_id: job.attempt_id },
    });
    expect(await f.rpc('request_reel_transcript', [f.workspace, job.reel_id])).toMatchObject({ transcript: { status: 'uncertain' } });
    await expect(retry(job, false)).rejects.toThrow('retry_confirmation_required');
  });
  it('requeues both blocked Reels without clearing old holds or exceeding two new attempts', async () => {
    const jobs = await failJobs(2);
    await f.identity();
    const wakesBefore = await f.value<number>('select count(*)::int v from net.requests');
    await f.db.query('insert into vault.secrets(name,secret) values($1,$2)', ['reelradar_transcription_maintenance_v1', 'a'.repeat(64)]);
    await f.db.exec("insert into vault.secrets(name,secret) values('reelradar_edge_url','https://project.supabase.co')");
    await f.db.exec("select set_config('reelradar.transcription_wake_dispatch','',true)");
    for (const job of jobs) expect(await retry(job)).toMatchObject({
      transcript: { status: 'queued' }, processing: { priority: 'high', retry_attempt_id: null },
    });
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from net.requests')).toBe(wakesBefore + 1);
    await f.identity('service_role');
    const next = await f.rpc<{ jobs: Job[] }>('worker_transcription_claim', [2]);
    expect(next.jobs.map(j => j.reel_id).sort()).toEqual(jobs.map(j => j.reel_id).sort());
    for (const j of next.jobs) expect(await f.rpc('worker_transcription_before_submit', [j.attempt_id, j.lease_token])).toMatchObject({ allow: true });
    expect(await f.rpc('worker_transcription_claim', [2])).toMatchObject({ jobs: [] });
    await f.identity();
    expect(await f.value('select jsonb_agg(jsonb_build_object(\'status\',status,\'reserved\',reserved_usd,\'actual\',actual_cost_usd,\'authorized\',retry_authorized_at is not null)) v from public.transcript_attempts where retry_authorized_at is not null'))
      .toEqual(jobs.map(() => ({ status: 'uncertain', reserved: .08, actual: null, authorized: true })));
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.32);
  });
  it('makes repeated clicks and a lost response idempotent, fencing late callbacks and a new failed attempt', async () => {
    const [old] = await failJobs();
    await retry(old);
    await f.identity('service_role');
    const [next] = (await f.rpc<{ jobs: Job[] }>('worker_transcription_claim', [2])).jobs;
    await retry(old);
    await f.identity('service_role');
    expect(await f.rpc('worker_transcription_callback_context', [old.attempt_id])).toEqual({ job: null });
    await expect(recoverError(() => f.rpc('worker_transcription_attach', [old.attempt_id, old.lease_token, 'stale-provider', null]))).rejects.toThrow('lease_expired');
    await f.rpc('worker_transcription_before_submit', [next.attempt_id, next.lease_token]);
    await f.rpc('worker_transcription_complete', [next.attempt_id, next.lease_token, 'New result', 'en', '[]', false]);
    await retry(old);
    expect(await f.rpc('get_reel_detail', [f.workspace, old.reel_id])).toMatchObject({ transcript: { status: 'ready', text: 'New result' } });
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.transcript_attempts')).toBe(2);
  });
  it('counts the old potential charge before reserving any new paid retry', async () => {
    const [job] = await failJobs();
    await f.identity(); await f.db.exec('update public.transcription_settings set monthly_budget_usd=.08');
    await retry(job);
    await f.identity('service_role');
    expect(await f.rpc('worker_transcription_claim', [2])).toMatchObject({ jobs: [], reason: 'budget_paused' });
    await f.identity();
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.08);
  });
  it.each(["lease_expires_at=now()+interval '1 hour'", "reserved_usd=.07", "actual_cost_usd=.01", "submit_authorized=false", "submit_denied=true", "phase='pilot'"])
    ('refuses unsafe retry state: %s', async patch => {
      const [job] = await failJobs();
      await f.identity(); await f.db.exec(`update public.transcript_attempts set ${patch}`);
      await expect(retry(job)).rejects.toThrow('retry_state_changed');
    });
  it('rejects exhausted retries, inaccessible workspaces, strangers and anonymous/service RPC callers', async () => {
    const [job] = await failJobs();
    await f.identity(); await f.db.exec('update public.transcript_jobs set attempt_count=3');
    await expect(retry(job)).rejects.toThrow('retry_state_changed');
    await f.identity('authenticated', fixtureStranger);
    await expect(recoverError(() => f.rpc('retry_reel_transcript', [f.workspace, job.reel_id, job.attempt_id, true]))).rejects.toThrow(/forbidden|42501/);
    for (const role of ['anon', 'service_role']) {
      await f.identity(role);
      await expect(recoverError(() => f.rpc('retry_reel_transcript', [f.workspace, job.reel_id, job.attempt_id, true]))).rejects.toThrow(/permission denied|42501/);
    }
    await f.identity();
    await f.db.query('update public.workspaces set archived_at=now() where id=$1', [f.workspace]);
    await expect(retry(job)).rejects.toThrow(/archived|forbidden|reel_not_in_workspace/);
  });
  it('rejects a stale click when the signed result arrived before retry authorization', async () => {
    const [job] = await failJobs();
    await f.identity('service_role');
    await f.rpc('worker_transcription_complete', [job.attempt_id, job.lease_token, 'Recovered result', 'en', '[]', false]);
    await expect(retry(job)).rejects.toThrow('retry_state_changed');
  });
});
