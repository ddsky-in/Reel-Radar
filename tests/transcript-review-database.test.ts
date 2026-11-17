import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Job = { id: string; reel_id: string; attempt_id: string; lease_token: string };
type Claim = { jobs: Job[]; reason: string | null };
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
async function claim() { await f.identity('service_role'); return f.rpc<Claim>('worker_transcription_claim', [2]); }
async function reviewAttempt() {
  await f.reel(); await f.activate();
  const job = (await claim()).jobs[0];
  expect(await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token])).toMatchObject({ allow: true });
  await f.identity();
  await f.db.exec("update public.transcript_attempts set status='uncertain',lease_expires_at=now()-interval '1 hour'; update public.transcript_jobs set status='uncertain'");
  return job;
}

describe('bounded review of an expired paid submission', () => {
  it('keeps the old hold and worker slot while a different priority Reel uses the other slot', async () => {
    const held = await reviewAttempt();
    await f.reel(); const priority = await f.reel();
    await f.identity('authenticated');
    expect(await f.rpc('request_reel_transcript', [f.workspace, priority])).toMatchObject({ processing: { request_allowed: true, priority: 'high', queue_position: 1 } });
    const next = await claim();
    expect(next.jobs.map(job => job.reel_id)).toEqual([priority]);
    expect(await claim()).toMatchObject({ jobs: [], reason: 'concurrency' });
    await f.identity();
    expect(await f.value('select jsonb_build_object(\'status\',status,\'reserved\',reserved_usd,\'actual\',actual_cost_usd) v from public.transcript_attempts where id=$1', [held.attempt_id]))
      .toEqual({ status: 'uncertain', reserved: .08, actual: null });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.16);
    await f.identity('authenticated');
    expect(await f.rpc('request_reel_transcript', [f.workspace, held.reel_id])).toMatchObject({ processing: { request_allowed: false, reason: 'review_required' } });
  });

  it.each([
    "reserved_usd=.07", "accounted_usd=.01", "phase='pilot'", "submit_denied=true",
    "submit_checked_at=null", "lease_expires_at=now()+interval '5 minutes'",
    "billing_month=(date_trunc('month',now())-interval '1 month')::date",
  ])('keeps the account blocked when the old reservation cannot safely isolate: %s', async patch => {
    await reviewAttempt(); await f.reel();
    await f.identity(); await f.db.exec(`update public.transcript_attempts set ${patch}`);
    expect(await claim()).toMatchObject({ jobs: [], reason: 'uncertain' });
  });

  it('never admits a third paid job after both slots become uncertain', async () => {
    await f.reel(); await f.reel(); await f.activate();
    for (const job of (await claim()).jobs) await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token]);
    await f.identity();
    await f.db.exec("update public.transcript_attempts set status='uncertain',lease_expires_at=now()-interval '1 hour'; update public.transcript_jobs set status='uncertain'");
    await f.reel();
    expect(await claim()).toMatchObject({ jobs: [], reason: 'uncertain' });
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.transcript_attempts')).toBe(2);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.16);
  });

  it('promotes an unrelated queued Reel during provider review without retrying held attempts or waking paid work', async () => {
    await f.reel(); await f.reel(); await f.activate();
    const held = (await claim()).jobs;
    for (const job of held) await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token]);
    await f.identity();
    await f.db.exec("update public.transcript_attempts set status='uncertain',lease_expires_at=now()-interval '1 hour'; update public.transcript_jobs set status='uncertain'");
    await f.reel(); const priority = await f.reel();
    await f.identity();
    const wakes = await f.value<number>('select count(*)::int v from net.requests');
    await f.identity('authenticated');
    const before = await f.rpc('get_reel_detail', [f.workspace, priority]);
    expect(before).toMatchObject({ processing: { request_allowed: true, reason: 'provider_review_required', priority: 'normal', estimate: null } });
    for (let click = 0; click < 2; click++) {
      expect(await f.rpc('request_reel_transcript', [f.workspace, priority])).toMatchObject({
        transcript: { status: 'queued' }, processing: { request_allowed: true, reason: 'provider_review_required', priority: 'high', queue_position: 1, estimate: null },
      });
    }
    for (const job of held) {
      expect(await f.rpc('request_reel_transcript', [f.workspace, job.reel_id])).toMatchObject({ processing: { request_allowed: false, reason: 'review_required' } });
    }
    expect(await claim()).toMatchObject({ jobs: [], reason: 'uncertain' });
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.transcript_attempts')).toBe(2);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.16);
    expect(await f.value<number>('select count(*)::int v from net.requests')).toBe(wakes);
  });

  it('counts the isolated hold in the same monthly budget before any new claim', async () => {
    await reviewAttempt(); await f.reel();
    await f.identity(); await f.db.exec('update public.transcription_settings set monthly_budget_usd=.08');
    expect(await claim()).toMatchObject({ jobs: [], reason: 'budget_paused' });
    await f.identity(); await f.db.exec('update public.transcription_settings set monthly_budget_usd=.16');
    expect((await claim()).jobs).toHaveLength(1);
    await f.identity();
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.16);
  });

  it('uses the remaining capacity for measured estimates instead of assuming two available workers', async () => {
    await reviewAttempt();
    for (let index = 0; index < 5; index++) {
      const id = await f.reel(); await f.identity();
      await f.db.query(`insert into public.transcript_attempts(job_id,attempt_number,lease_expires_at,status,phase,billing_month,reserved_usd,created_at,completed_at)
        select id,1,now(),'ready','automatic',date_trunc('month',now())::date,0,now()-interval '2 minutes',now()-interval '90 seconds' from public.transcript_jobs where reel_id=$1`, [id]);
      await f.db.query("update public.transcript_jobs set status='ready',attempt_count=1 where reel_id=$1", [id]);
    }
    const first = await f.reel(), second = await f.reel();
    await f.identity(); await f.db.query("update public.transcript_jobs set created_at=now()-interval '1 day' where reel_id=$1", [first]);
    await f.identity('authenticated');
    expect(await f.rpc('get_reel_detail', [f.workspace, second])).toMatchObject({ processing: { queue_position: 2, estimate: { min_seconds: 60, max_seconds: 60, sample_count: 5 } } });
  });
});
