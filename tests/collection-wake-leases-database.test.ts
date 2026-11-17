import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Lease = { reason?: string; executor_nonce: string; claimed_revision: number; starts_remaining: number; executor_starts: number };
type State = { wake_revision: number; drained_revision: number; wake_pending: boolean; executor_nonce: string | null; executor_starts: number; wake_retry_after: string | null };
const claim = (completionOnly = true, owner = fixtureOwner) => f.rpc<Lease>('worker_claim_collection_executor', [owner, completionOnly]);
const runtime = () => f.rpc<State>('worker_collection_runtime', [fixtureOwner]);
const drain = (lease: Lease, revision = lease.claimed_revision, owner = fixtureOwner) => f.rpc<boolean>('worker_drain_completion_wake', [owner, revision, lease.executor_nonce]);
const release = (lease: Lease) => f.rpc<boolean>('worker_release_collection_executor', [fixtureOwner, lease.executor_nonce, lease.claimed_revision]);
const next = (lease: Lease) => f.rpc<{ reason?: string; job?: { id: string; dispatch_nonce: string } }>('worker_claim_next', [fixtureOwner, false, '{"daily":"fixture-actor"}', ['daily'], lease.executor_nonce, lease.claimed_revision]);
async function mutate(sql: string, args: unknown[] = []) {
  await f.identity(); await f.db.query(sql, args); await f.identity('service_role');
}
async function pending() {
  const id = await f.value<string>("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit) values($1,'daily',1,30) returning id v", [fixtureOwner]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]);
  return id;
}
async function rejected(call: () => Promise<unknown>, message: string) {
  await f.db.exec('savepoint reject');
  try { await expect(call()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint reject; release savepoint reject'); }
}
beforeAll(async () => { f = await featureDatabase(); }, 90000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0; update public.collection_worker_settings set wake_revision=1,drained_revision=0");
  await f.identity('service_role');
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });

describe('local SQL ordinary completion executor ownership (PGlite serial interleavings, not multi-session PostgreSQL)', () => {
  it('coalesces callback contenders and only the nonce owner can claim/drain', async () => {
    const contenders = await Promise.all(Array.from({ length: 8 }, () => claim()));
    const winner = contenders.find(value => value.executor_nonce)!;
    expect(contenders.filter(value => value.executor_nonce)).toHaveLength(1);
    expect(contenders.filter(value => value.reason === 'executor_busy')).toHaveLength(7);
    await pending();
    expect(await f.rpc('worker_claim_next', [fixtureOwner, false, '{"daily":"fixture-actor"}', ['daily']])).toEqual({ reason: 'executor_busy' });
    expect((await next(winner)).job).toBeDefined();
    expect(await drain(winner)).toBe(true);
    expect(await drain(winner)).toBe(false);
    expect(await runtime()).toMatchObject({ wake_pending: false, executor_nonce: null, executor_starts: 1 });
    expect(await claim()).toEqual({ reason: 'wake_not_pending' });
  });
  it('rejects stale nonce, foreign owner and wrong revision without losing a later wake', async () => {
    const winner = await claim();
    await mutate('update public.collection_worker_settings set wake_revision=wake_revision+1');
    expect(await drain(winner, 2)).toBe(false);
    expect(await drain(winner, 1, fixtureStranger)).toBe(false);
    expect(await drain({ ...winner, executor_nonce: fixtureStranger })).toBe(false);
    expect(await release({ ...winner, executor_nonce: fixtureStranger })).toBe(false);
    expect(await drain(winner)).toBe(true);
    expect(await runtime()).toMatchObject({ wake_revision: 2, drained_revision: 1, wake_pending: true });
    expect((await claim()).claimed_revision).toBe(2);
  });
  it('fences delayed old executors after bounded expired lease recovery and preserves start budget', async () => {
    await pending(); await pending(); await pending();
    const old = await claim(); const first = (await next(old)).job!;
    await mutate("update public.collection_worker_settings set executor_expires_at=clock_timestamp()-interval '1 second'");
    expect(await next(old)).toEqual({ reason: 'executor_lease_lost' });
    expect(await drain(old)).toBe(false);
    expect(await f.rpc('worker_renew_collection_executor', [fixtureOwner, old.executor_nonce, old.claimed_revision])).toBe(false);
    const recovered = await claim();
    expect(recovered.executor_nonce).not.toBe(old.executor_nonce);
    expect(recovered.starts_remaining).toBe(1);
    expect(await drain(old)).toBe(false); expect(await release(old)).toBe(false);
    const second = (await next(recovered)).job!;
    expect(second.id).not.toBe(first.id);
    expect(await next(recovered)).toEqual({ reason: 'wake_start_limit' });
    await mutate("update public.collection_worker_settings set executor_expires_at=clock_timestamp()-interval '1 second'");
    expect(await claim()).toEqual({ reason: 'wake_start_limit' });
    expect(await f.value('select attempt_count::int v from public.scrape_jobs where id=$1', [first.id])).toBe(1);
    expect(await runtime()).toMatchObject({ wake_pending: true, drained_revision: 0, executor_starts: 2 });
  });
  it('failure release retains revision and defers duplicate retries without blocking a later completion', async () => {
    const lease = await claim(); expect(await release(lease)).toBe(true);
    expect(await runtime()).toMatchObject({ wake_pending: true, drained_revision: 0, executor_nonce: null, wake_retry_after: expect.any(String) });
    expect(await claim()).toEqual({ reason: 'wake_retry_deferred' });
    await mutate('update public.collection_worker_settings set wake_revision=wake_revision+1');
    expect((await claim()).claimed_revision).toBe(2);
    expect(await drain(lease)).toBe(false);
  });
  it('recovers released work after the cooldown, using only the remaining reservation attempts', async () => {
    await pending(); const old = await claim(); await next(old); await release(old);
    await mutate("update public.collection_worker_settings set wake_retry_after=clock_timestamp()-interval '1 second'");
    const recovered = await claim(); expect(recovered.starts_remaining).toBe(1);
    expect(await f.rpc('worker_renew_collection_executor', [fixtureOwner, recovered.executor_nonce, recovered.claimed_revision])).toBe(true);
    expect(await release(old)).toBe(false); expect(await drain(recovered)).toBe(true);
  });
  it('manual/maintenance work needs no pending completion but shares ownership with callbacks', async () => {
    const first = await claim(); await drain(first);
    expect(await claim()).toEqual({ reason: 'wake_not_pending' });
    const manual = await claim(false); expect(manual.claimed_revision).toBe(2);
    expect(await claim()).toEqual({ reason: 'executor_busy' });
    expect(await claim(false)).toEqual({ reason: 'executor_busy' });
    expect(await drain(manual)).toBe(true);
    expect((await claim(false)).claimed_revision).toBe(3);
  });
  it('completion transaction durably records a later revision while executor is owned', async () => {
    const id = await pending();
    await mutate("update public.scrape_jobs set collection_source='ordinary',live=true,status='succeeded',provider_terminal_status='SUCCEEDED',actual_cost_usd=.01 where id=$1", [id]);
    const lease = await claim(); expect(lease.claimed_revision).toBe(2);
    const later = await pending();
    await mutate("update public.scrape_jobs set collection_source='ordinary',live=true,status='succeeded',provider_terminal_status='SUCCEEDED',actual_cost_usd=.01 where id=$1", [later]);
    expect(await f.rpc('worker_record_completion_wake', [fixtureOwner, later])).toBe(true);
    expect(await drain(lease)).toBe(true);
    expect(await runtime()).toMatchObject({ wake_revision: 3, drained_revision: 2, wake_pending: true });
  });
  it.each(['anon','authenticated'])('denies all lease mutations and reads to %s', async role => {
    const lease = await claim(); await f.identity(role);
    await rejected(() => claim(), 'permission denied');
    await rejected(() => runtime(), 'permission denied');
    await rejected(() => next(lease), 'permission denied');
    await rejected(() => drain(lease), 'permission denied');
    await rejected(() => release(lease), 'permission denied');
    await rejected(() => f.rpc('worker_renew_collection_executor', [fixtureOwner, lease.executor_nonce, lease.claimed_revision]), 'permission denied');
  });
  it('revokes stale unsafe drain and private selector, and changes no financial or scheduling policy', async () => {
    await rejected(() => f.rpc('worker_drain_completion_wake', [fixtureOwner, 1]), 'permission denied');
    await rejected(() => f.value('select collection_worker_private.claim_next($1,false,$2::jsonb,$3::text[]) v', [fixtureOwner, '{"daily":"fixture-actor"}', ['daily']]), 'permission denied');
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/202611150005_collection_wake_leases.sql'), 'utf8');
    expect(sql).not.toMatch(/cron\.|net\.|vault\.|set reserved_usd|monthly_budget_usd|actual_cost_usd\s*=/i);
    expect(await f.value('select monthly_budget_usd::float8 v from public.app_settings')).toBe(50);
  });
});
