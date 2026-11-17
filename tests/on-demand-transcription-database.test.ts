import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Claim = { jobs: { id: string; reel_id: string; attempt_id: string; lease_token: string }[] };
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); await f.activate(); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });
const imported = (media = true) => f.reel(media, f.creator, '2026-01-01T00:00:00Z', false);
async function claim() { await f.identity('service_role'); return f.rpc<Claim>('worker_transcription_claim', [2]); }
async function request(id: string) { await f.identity('authenticated'); return f.rpc('request_reel_transcript', [f.workspace, id]); }

describe('transcription only after an owner request', () => {
  it('does not spend, recover media or wake work for imported and merely viewed Reels', async () => {
    const ready = await imported(), missing = await imported(false);
    await f.identity();
    await f.db.exec("insert into vault.secrets(name,secret) values('reelradar_transcription_maintenance_v1',repeat('a',64))");
    await f.db.exec("insert into vault.secrets(name,secret) values('reelradar_edge_url','https://project.supabase.co')");
    await f.identity('authenticated');
    for (const id of [ready, missing]) {
      expect(await f.rpc('get_reel_transcript', [f.workspace, id])).toMatchObject({ status: 'not_requested' });
      expect(await f.rpc('get_reel_detail', [f.workspace, id])).toMatchObject({ transcript: { status: 'not_requested' }, processing: { request_allowed: true, queue_position: null } });
    }
    expect(await f.rpc('get_transcription_overview')).toMatchObject({ job_counts: {}, jobs: [] });
    expect((await claim()).jobs).toEqual([]);
    expect(await f.rpc('worker_transcription_media_candidates', [1])).toEqual({ creators: [] });
    expect(await f.rpc('worker_transcription_media_enqueue', [f.creator])).toMatchObject({ job_id: null });
    await f.identity();
    expect(await f.rpc('transcription_request_wake', ['maintenance'])).toBeNull();
    expect(await f.value<number>('select count(*)::int v from public.transcript_attempts')).toBe(0);
    expect(await f.value<number>('select count(*)::int v from net.requests')).toBe(0);
  });
  it('processes the clicked Reel once and leaves the old automatic backlog alone', async () => {
    const backlog = await imported(), clicked = await imported();
    await f.identity(); await f.db.query("update public.transcript_jobs set status='budget_paused' where reel_id=$1", [backlog]);
    await request(clicked); await request(clicked);
    const jobs = (await claim()).jobs;
    expect(jobs.map(j => j.reel_id)).toEqual([clicked]);
    expect(await f.rpc('worker_transcription_before_submit', [jobs[0].attempt_id, jobs[0].lease_token])).toMatchObject({ allow: true });
    expect((await claim()).jobs).toEqual([]);
    await f.identity();
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.08);
    expect(await f.value<number>('select attempt_count v from public.transcript_jobs where reel_id=$1', [backlog])).toBe(0);
  });
  it('fences a pre-migration automatic claim before it reaches the provider', async () => {
    await f.reel(); const job = (await claim()).jobs[0];
    await f.identity(); await f.db.query('update public.transcript_jobs set priority_requested_at=null where id=$1', [job.id]);
    await f.identity('service_role');
    expect(await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token])).toMatchObject({ allow: false });
    expect(await f.rpc('worker_transcription_release_unsubmitted', [job.attempt_id, job.lease_token])).toMatchObject({ released: true });
    expect((await claim()).jobs).toEqual([]);
  });
  it('requests missing-media recovery only for the clicked Reel', async () => {
    const ignored = await imported(false), clicked = await imported(false);
    await request(clicked); await f.identity();
    expect(await f.rpc('transcription_recovery_target', [fixtureOwner, ignored])).toBe(false);
    expect(await f.rpc('transcription_recovery_target', [fixtureOwner, clicked])).toBe(true);
    await f.identity('service_role');
    expect(await f.rpc('worker_transcription_media_enqueue', [f.creator])).toMatchObject({ target_count: 1 });
  });
  it('preserves both ceilings and enforces concurrency for explicitly requested work', async () => {
    const ids = [await imported(), await imported(), await imported()];
    for (const id of ids) await request(id);
    expect((await claim()).jobs).toHaveLength(2);
    expect((await claim()).jobs).toEqual([]);
    await f.identity();
    expect(await f.value<number>('select monthly_budget_usd::float8 v from public.transcription_settings')).toBe(100);
    expect(await f.value<number>('select monthly_budget_usd::float8 v from public.app_settings')).toBe(50);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.transcript_attempts')).toBe(.16);
  });
  it('keeps a clicked request paused at the monthly ceiling without erasing charges', async () => {
    const first = await imported(), second = await imported();
    await request(first); const job = (await claim()).jobs[0];
    await f.rpc('worker_transcription_before_submit', [job.attempt_id, job.lease_token]);
    await f.rpc('worker_transcription_complete', [job.attempt_id, job.lease_token, 'Verified fixture text']);
    await f.identity(); await f.db.exec('update public.transcription_settings set monthly_budget_usd=.08');
    await request(second); expect((await claim()).jobs).toEqual([]);
    await f.identity('authenticated');
    expect(await f.rpc('get_reel_detail', [f.workspace, second])).toMatchObject({ transcript: { status: 'budget_paused' }, processing: { queue_position: 1 } });
    expect(await f.rpc('get_reel_transcript', [f.workspace, first])).toMatchObject({ status: 'ready', text: 'Verified fixture text' });
  });
  it('rejects foreign owner requests and does not expose worker entrypoints', async () => {
    const id = await imported(); await f.identity('authenticated', fixtureStranger);
    await f.db.exec('savepoint denied');
    await expect(f.rpc('request_reel_transcript', [f.workspace, id])).rejects.toThrow(/forbidden/);
    await f.db.exec('rollback to savepoint denied'); await f.identity();
    expect(await f.value<string | null>('select priority_requested_at v from public.transcript_jobs where reel_id=$1', [id])).toBeNull();
    for (const role of ['anon', 'authenticated']) for (const fn of ['worker_transcription_claim(integer)', 'worker_transcription_before_submit(uuid,uuid)', 'transcription_request_wake(text)']) {
      expect(await f.value<boolean>("select has_function_privilege($1,$2,'execute') v", [role, `public.${fn}`])).toBe(false);
    }
  });
});
