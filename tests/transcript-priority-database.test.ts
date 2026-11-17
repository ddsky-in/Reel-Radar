import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Claim = { jobs: { id: string; reel_id: string; attempt_id: string; lease_token: string }[]; reason: string | null };
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
async function claim() { await f.identity('service_role'); return f.rpc<Claim>('worker_transcription_claim', [2]); }
async function request(reelId: string) {
  await f.identity('authenticated');
  return f.rpc<{ transcript: { status: string }; processing: { request_allowed: boolean; priority: string; queue_position: number | null; reason: string | null; estimate: { min_seconds: number; max_seconds: number; sample_count: number } | null } }>('request_reel_transcript', [f.workspace, reelId]);
}

describe('transcript priority and abandoned-worker recovery', () => {
  it('recovers the live failure pattern: two expired pre-submit attempts no longer block the queue', async () => {
    await f.reel(); await f.reel(); await f.activate();
    const abandoned = await claim(); expect(abandoned.jobs).toHaveLength(2);
    await f.identity();
    await f.db.exec("update public.transcript_attempts set status='uncertain',lease_expires_at=now()-interval '1 hour'; update public.transcript_jobs set status='uncertain'");
    const recovered = await claim(); expect(recovered.jobs).toHaveLength(2);
    await f.identity();
    expect((await f.db.query(`select status,actual_cost_usd::float8 actual,reserved_usd::float8 reserved from public.transcript_attempts where attempt_number=1`)).rows)
      .toEqual([{ status: 'not_started', actual: 0, reserved: 0 }, { status: 'not_started', actual: 0, reserved: 0 }]);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.16);
    expect(await f.value<number>('select max(attempt_count) v from public.transcript_jobs')).toBe(2);
  });
  it('never releases an expired attempt that crossed the paid fence', async () => {
    await f.reel(); await f.activate(); const job = (await claim()).jobs[0];
    await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token]);
    await f.identity(); await f.db.exec("update public.transcript_attempts set lease_expires_at=now()-interval '1 hour'");
    expect(await claim()).toMatchObject({ jobs: [] });
    expect(await f.rpc('worker_transcription_release_unsubmitted', [job.attempt_id, job.lease_token])).toMatchObject({ released: false });
    await f.identity(); expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.08);
  });
  it('does not reclaim live leases and rejects a late paid fence after an explicit pre-submit release', async () => {
    await f.reel(); await f.activate(); const job = (await claim()).jobs[0];
    expect(await f.rpc('worker_transcription_recover_stale')).toEqual({ recovered: 0 });
    expect(await f.rpc('worker_transcription_release_unsubmitted', [job.attempt_id, job.lease_token])).toMatchObject({ released: true });
    expect(await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token])).toMatchObject({ allow: false });
    expect(await f.rpc('worker_transcription_release_unsubmitted', [job.attempt_id, job.lease_token])).toMatchObject({ released: true, duplicate: true });
    expect((await claim()).jobs).toHaveLength(0); // Backoff, not a busy retry loop.
  });
  it('promotes a later Reel above normal jobs without creating another logical job or paid attempt', async () => {
    const normal = await f.reel(), priority = await f.reel(); await f.activate();
    await f.identity(); await f.db.query("update public.transcript_jobs set created_at=now()-interval '1 day' where reel_id=$1", [normal]);
    const result = await request(priority);
    expect(result.processing).toMatchObject({ priority: 'high', queue_position: 1 });
    await f.identity(); expect(await f.value<number>('select count(*)::int v from public.transcript_attempts')).toBe(0);
    const firstRequestedAt = await f.value<string>('select priority_requested_at::text v from public.transcript_jobs where reel_id=$1', [priority]);
    await request(priority);
    await f.identity(); expect(await f.value<string>('select priority_requested_at::text v from public.transcript_jobs where reel_id=$1', [priority])).toBe(firstRequestedAt);
    expect(await f.value<number>('select count(*)::int v from public.transcript_jobs')).toBe(2);
    expect((await claim()).jobs.map(job => job.reel_id)).toEqual([priority, normal]);
  });
  it('keeps promotion free while paused and honors the existing concurrency and monthly limits', async () => {
    const ids = [await f.reel(), await f.reel(), await f.reel()]; await f.activate();
    await f.identity(); await f.db.exec('update public.transcription_settings set paused=true');
    const promoted = await request(ids[2]); expect(promoted.processing).toMatchObject({ priority: 'high', reason: 'paused', estimate: null });
    expect(await claim()).toMatchObject({ jobs: [], reason: 'paused' });
    await f.identity(); await f.db.exec('update public.transcription_settings set paused=false,monthly_budget_usd=.08');
    expect((await claim()).jobs.map(job => job.reel_id)).toEqual([ids[2]]);
    expect((await claim()).jobs).toEqual([]);
    await f.identity(); expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.08);
  });
  it('offers an explicit bounded retry after a signed provider failure', async () => {
    const id = await f.reel(); await f.activate(); const job = (await claim()).jobs[0];
    await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token]);
    await f.rpc('worker_transcription_attach', [job.attempt_id, job.lease_token, 'fixture-request', 'fixture-transcript']);
    await f.rpc('worker_transcription_provider_failure', [job.attempt_id, job.lease_token, 'fixture-request']);
    const detail = await request(id);
    expect(detail.transcript.status).toBe('queued'); expect(detail.processing.priority).toBe('high');
    expect((await claim()).jobs).toHaveLength(1);
  });
  it('shows an honest reason after all attempts are exhausted and never resets attempt history', async () => {
    const id = await f.reel(); await f.activate();
    await f.identity(); await f.db.query("update public.transcript_jobs set status='failed',attempt_count=3,completed_at=now() where reel_id=$1", [id]);
    const detail = await request(id);
    expect(detail.processing).toMatchObject({ request_allowed: false, reason: 'retry_limit_reached', estimate: null });
    expect(detail.transcript.status).toBe('failed'); expect((await claim()).jobs).toEqual([]);
  });
  it('does not invent a timing estimate without enough recent successful samples', async () => {
    const id = await f.reel(); await f.activate(); expect((await request(id)).processing.estimate).toBeNull();
  });
  it('calculates ETA from observed attempts and updates it after priority promotion', async () => {
    for (let index = 0; index < 5; index++) {
      const id = await f.reel(); await f.identity();
      await f.db.query(`insert into public.transcript_attempts(job_id,attempt_number,lease_expires_at,phase,billing_month,reserved_usd,status,created_at,completed_at)
        select id,1,now(),'automatic',date_trunc('month',now())::date,0,'ready',now()-interval '40 seconds',now()-interval '10 seconds' from public.transcript_jobs where reel_id=$1`, [id]);
      await f.db.query("update public.transcript_jobs set status='ready',attempt_count=1 where reel_id=$1", [id]);
    }
    const older = [await f.reel(), await f.reel(), await f.reel(), await f.reel()]; const id = await f.reel(); await f.activate();
    await f.identity(); await f.db.query("update public.transcript_jobs set created_at=now()-interval '1 day' where reel_id=any($1::uuid[])", [older]);
    await f.identity('authenticated');
    const before = await f.rpc<{ processing: { estimate: { min_seconds: number }; queue_position: number } }>('get_reel_detail', [f.workspace, id]);
    expect(before.processing.queue_position).toBe(5);
    expect(before.processing.estimate.min_seconds).toBe(90);
    const after = await request(id);
    expect(after.processing.estimate).toMatchObject({ min_seconds: 30, max_seconds: 30, sample_count: 5 });
  });
  it('moves ready jobs past a large awaiting-media backlog', async () => {
    for (let index = 0; index < 105; index++) await f.reel(false);
    const id = await f.reel(); await f.activate();
    expect((await claim()).jobs.map(job => job.reel_id)).toEqual([id]);
    await f.identity();
    expect(await f.value<number>("select count(*)::int v from public.transcript_jobs where status='awaiting_media'")).toBe(105);
    expect(await f.value<number>('select count(*)::int v from public.transcript_attempts')).toBe(1);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.08);
  }, 60_000);
  it('rejects a foreign user priority request without exposing queue or media', async () => {
    const id = await f.reel(); await f.identity('authenticated', fixtureStranger);
    await expect(f.rpc('request_reel_transcript', [f.workspace, id])).rejects.toThrow(/forbidden|42501/);
  });
  it('keeps recovery and paid claims inaccessible to the authenticated owner', async () => {
    await f.identity();
    for (const signature of ['worker_transcription_release_unsubmitted(uuid,uuid)', 'worker_transcription_recover_stale()', 'worker_transcription_claim(integer)']) {
      expect(await f.value<boolean>(`select has_function_privilege('authenticated',$1,'execute') v`, [`public.${signature}`])).toBe(false);
    }
    expect(fixtureOwner).not.toBe(fixtureStranger);
  });
});
