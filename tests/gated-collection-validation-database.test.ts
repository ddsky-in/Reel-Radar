import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';
let f: Awaited<ReturnType<typeof featureDatabase>>;
const key = '11111111-1111-4111-8111-111111111111';
beforeAll(async () => { f = await featureDatabase(); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0; update public.app_settings set collection_job_cap_usd=2,scraping_enabled=true,paused=false;");
  await f.identity('service_role'); await f.rpc('worker_set_collection_start_gate', [fixtureOwner, true]);
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
async function pending(kind = 'profile', priority = 0) {
  await f.identity();
  const id = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by,priority)
    values($1,$2,1,1,$1,$3) returning id v`, [fixtureOwner, kind, priority]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]); await f.identity('service_role'); return id;
}
const permit = (id: string, request = key, owner = fixtureOwner, creator = f.creator) => f.rpc<{ expires_at: string }>('worker_allow_collection_validation', [owner, id, creator, request, 'Explicit synthetic single-job validation approval']);
const claim = () => f.rpc<{ job?: { id: string; dispatch_nonce: string }; reason?: string; max_total_charge_usd?: number }>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'profile']);
describe('single-job validation under a closed general gate', () => {
  it('does not enable anything merely by installing the migration', async () => { await pending(); expect(await claim()).toEqual({ reason: 'paid_starts_gated' }); });
  it('claims only the pinned job, caps it at ten cents, and leaves all other jobs gated', async () => {
    const id = await pending(); await pending('profile', 100); await permit(id);
    const result = await claim(); expect(result.job?.id).toBe(id); expect(result.max_total_charge_usd).toBe(.1);
    expect((await claim()).job).toBeUndefined();
    expect(await f.value<boolean>('select paid_starts_gated v from public.collection_worker_settings where owner_user_id=$1', [fixtureOwner])).toBe(true);
  });
  it('makes permit replay idempotent without extending its expiry', async () => {
    const id = await pending(), first = await permit(id);
    expect(await permit(id)).toEqual(first);
  });
  it('does not allow a second active validation', async () => {
    const first = await pending(), second = await pending(); await permit(first);
    await expect(permit(second, '22222222-2222-4222-8222-222222222222')).rejects.toThrow('validation_already_active');
  });
  it('rejects expired permission at submission even with a valid executor fence', async () => {
    const id = await pending(); await permit(id);
    const executor = await f.rpc<{ executor_nonce: string; claimed_revision: number }>('worker_claim_collection_executor', [fixtureOwner, false]);
    const result = await f.rpc<{ job: { id: string; dispatch_nonce: string } }>('worker_claim_next', [fixtureOwner, true, JSON.stringify({ profile: 'fixture-actor' }), ['profile'], executor.executor_nonce, executor.claimed_revision]);
    await f.identity(); await f.db.exec("update collection_intents_private.validation_permits set expires_at=clock_timestamp()-interval '1 second'"); await f.identity('service_role');
    expect(await f.rpc('worker_authorize_collection_submit', [fixtureOwner, id, result.job.dispatch_nonce, 'ab'.repeat(32), executor.executor_nonce, executor.claimed_revision])).toMatchObject({ authorized: false, reason: 'paid_starts_gated' });
  });
  it('allows exactly one fresh submission winner while keeping the general gate closed', async () => {
    const id = await pending(); await pending('profile', 100); await permit(id);
    const executor = await f.rpc<{ executor_nonce: string; claimed_revision: number }>('worker_claim_collection_executor', [fixtureOwner, false]);
    const result = await f.rpc<{ job: { dispatch_nonce: string } }>('worker_claim_next', [fixtureOwner, true, JSON.stringify({ profile: 'fixture-actor' }), ['profile'], executor.executor_nonce, executor.claimed_revision]);
    const args = [fixtureOwner, id, result.job.dispatch_nonce, 'ab'.repeat(32), executor.executor_nonce, executor.claimed_revision];
    expect(await f.rpc('worker_authorize_collection_submit', args)).toMatchObject({ authorized: true });
    expect(await f.rpc('worker_authorize_collection_submit', args)).toMatchObject({ authorized: false });
  });
  it('does not permit an already attempted job', async () => {
    const id = await pending(); await f.identity(); await f.db.query('update public.scrape_jobs set attempt_count=1 where id=$1', [id]); await f.identity('service_role');
    await expect(permit(id)).rejects.toThrow('validation_scope_invalid');
  });
  it('denies a foreign owner and browser access', async () => {
    const id = await pending(); await expect(permit(id, key, fixtureStranger)).rejects.toThrow('paid_starts_gate_required');
  });
  it('denies browser permit creation', async () => {
    const id = await pending(); await f.identity('authenticated'); await expect(permit(id)).rejects.toThrow('permission denied');
  });
  it('revokes future authorization without claiming an accepted request was cancelled', async () => {
    const id = await pending(); await permit(id);
    await f.rpc('worker_close_collection_validation', [fixtureOwner, id, key]);
    expect(await claim()).toEqual({ reason: 'paid_starts_gated' });
    expect((await permit(id)).expires_at).toBeDefined();
    expect((await claim()).job).toBeUndefined();
  });
  it('rejects the Reel stage until its exact permitted profile job is succeeded and billed', async () => {
    const id = await pending(); await permit(id);
    await expect(f.rpc('worker_allow_reel_validation', [fixtureOwner, id, f.creator, '22222222-2222-4222-8222-222222222222', 'Synthetic approved second validation stage'])).rejects.toThrow('profile_validation_not_reconciled');
  });
  it('creates exactly one bounded Reel job after a reconciled profile and never duplicates it on replay', async () => {
    const id = await pending(); await permit(id); await f.identity();
    await f.db.query("update public.scrape_jobs set status='succeeded',actor_run_id='synthetic-profile-run',actual_cost_usd=.01,billing_reconciled_at=clock_timestamp() where id=$1", [id]);
    await f.identity('service_role');
    const args = [fixtureOwner, id, f.creator, '22222222-2222-4222-8222-222222222222', 'Synthetic approved second validation stage'];
    const first = await f.rpc<{ job_id: string }>('worker_allow_reel_validation', args);
    expect(first.job_id).not.toBe(id);
    expect(await f.rpc('worker_allow_reel_validation', args)).toEqual(first);
    expect(await f.value('select jsonb_build_object(\'kind\',kind,\'results_limit\',results_limit,\'profiles\',requested_profiles_count) v from public.scrape_jobs where id=$1', [first.job_id])).toEqual({ kind: 'daily', results_limit: 30, profiles: 1 });
  });
  it('blocks the second stage when a provider charge decrease needs review', async () => {
    const id = await pending(); await permit(id); await f.identity();
    await f.db.query("update public.scrape_jobs set status='succeeded',actor_run_id='synthetic-profile-run',actual_cost_usd=.01,billing_reconciled_at=clock_timestamp(),billing_review_required=true where id=$1", [id]);
    await f.identity('service_role');
    await expect(f.rpc('worker_allow_reel_validation', [fixtureOwner, id, f.creator, '22222222-2222-4222-8222-222222222222', 'Synthetic approved second validation stage'])).rejects.toThrow('profile_validation_not_reconciled');
  });
});
