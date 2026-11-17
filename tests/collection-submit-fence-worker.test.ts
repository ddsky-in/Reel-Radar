import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../supabase/functions/_shared/model.ts';
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const providers = await import('../supabase/functions/_shared/providers.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
const executor = '44444444-4444-4444-8444-444444444444';
const context = (): Context => ({ job: { id: jobId, owner_user_id: owner, kind: 'daily', live: true, status: 'dispatching',
  collection_source: 'ordinary', apify_account_slot: 1, results_limit: 30, reserved_usd: .1, actor_run_id: null, dispatch_nonce: nonce,
  expected_actor_id: 'actor', expected_provider_user_id: 'account', dataset_id: null, dataset_cursor: 0, dataset_finished: false,
  lease_token: nonce, started_at: '2026-11-16T12:00:00Z', provider_terminal_status: null, actual_cost_usd: null },
  creators: [{ id: owner, username: 'synthetic.creator' }] });
const run = { id: 'safe_run', actId: 'actor', userId: 'account', status: 'RUNNING', defaultDatasetId: 'dataset' };
const json = (value: unknown, status = 200) => Response.json(value, { status });
let values: Record<string, string>, fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let journal: { run_id: string; source: string; verified: boolean }[];
let authorize: 'allow' | 'deny' | 'lost_ack', failure: 'none' | 'timeout' | 'bad_metadata', evidenceFailures: number;
const calls = (name: string) => fetcher.mock.calls.filter(([input]) => String(input).endsWith(`/rpc/${name}`));
const paid = () => fetcher.mock.calls.filter(([input, init]) => String(input).includes('/actors/') && init?.method === 'POST');
const submit = () => worker.submitCollectionClaim(context(), .1, 'ordinary', { executorNonce: executor, claimedRevision: 7 });
beforeEach(() => {
  values = { PROVIDER_MODE: 'apify', APIFY_ACCOUNT_ID: 'account', APIFY_API_TOKEN: 'synthetic-secret-token', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-secret-service', APIFY_WEBHOOK_SHARED_SECRET: 'synthetic-secret-webhook',
    SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true' };
  journal = []; authorize = 'allow'; failure = 'none'; evidenceFailures = 0;
  vi.stubGlobal('Deno', { env: { get: (key: string) => values[key] } });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://fixture.supabase.co') {
      const args = JSON.parse(String(init?.body)), name = url.pathname.split('/').at(-1);
      if (name === 'worker_accounts') return json([{ owner_user_id: owner, account_slot: 1, provider_user_id: 'account', enabled: true, authorization_confirmed: true }]);
      if (name === 'worker_get_collection_recovery_state') return json({ input_digest: null, accepted_evidence: journal, callback_hints: [] });
      if (name === 'worker_authorize_collection_submit') {
        if (authorize === 'lost_ack') throw new Error('Synthetic authorization response lost after commit');
        return json({ authorized: authorize === 'allow' });
      }
      if (name === 'worker_record_accepted_evidence') {
        if (evidenceFailures-- > 0) return json({}, 503);
        journal.push({ run_id: args.p_run_id, source: args.p_source, verified: args.p_verified }); return json({ recorded: true });
      }
      if (name === 'worker_attach_run' || name === 'worker_dispatch_failure') return json(null);
      if (name === 'worker_cancel_pre_submit') return json({ cancelled: authorize !== 'lost_ack' });
    }
    if (url.origin === 'https://api.apify.com') {
      if (url.pathname === '/v2/users/me') return json({ data: { id: 'account' } });
      if (url.pathname === '/v2/actor-runs/safe_run') return json({ data: run });
      if (url.pathname === '/v2/actors/actor/runs' && init?.method === 'POST') {
        if (failure === 'timeout') throw new Error('synthetic-secret-error');
        return json({ data: failure === 'bad_metadata' ? { id: 'safe_run', userId: 'foreign', status: 'INVALID' } : run });
      }
    }
    throw new Error('Unexpected synthetic request');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('prepared intent and transactional one-use paid submission', () => {
  it('hashes exact serialized body and gates immediately before one paid POST', async () => {
    expect(await submit()).toEqual({ job_id: jobId, status: 'running' });
    const paidCall = paid()[0], args = JSON.parse(String(calls('worker_authorize_collection_submit')[0][1]?.body));
    expect(args).toEqual({ p_owner_user_id: owner, p_job_id: jobId, p_dispatch_nonce: nonce,
      p_input_digest: createHash('sha256').update(String(paidCall[1]?.body)).digest('hex'), p_executor_nonce: executor, p_claimed_revision: 7 });
    const names = fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(names[names.indexOf('/v2/actors/actor/runs') - 1]).toBe('/rest/v1/rpc/worker_authorize_collection_submit');
    expect(names.indexOf('/rest/v1/rpc/worker_record_accepted_evidence')).toBeLessThan(names.indexOf('/rest/v1/rpc/worker_attach_run'));
    expect(JSON.stringify(args)).not.toContain('synthetic-secret'); expect(paid()).toHaveLength(1);
  });
  it('prepares immutable body/pins and consumes a second call even when authorizer denies', async () => {
    const claimed = context(), adapter = await worker.providerForJob(claimed.job), prepared = await adapter.prepare(claimed, .1);
    claimed.creators[0].username = 'changed'; claimed.job.expected_actor_id = 'changed';
    const auth = vi.fn(async () => true);
    expect((await prepared.submit(auth)).kind).toBe('accepted');
    expect(JSON.parse(String(paid()[0][1]?.body)).directUrls).toEqual(['synthetic.creator']);
    expect(await prepared.submit(auth)).toEqual({ kind: 'not_authorized' }); expect(auth).toHaveBeenCalledTimes(1); expect(paid()).toHaveLength(1);
  });
  it('has no live legacy start bypass without an authorization function', async () => {
    await expect(new providers.ApifyReels().start(context(), .1)).rejects.toThrow('authorization required'); expect(paid()).toHaveLength(0);
  });
  it('cancels only pre-submit preparation failure without authorize or paid POST', async () => {
    delete values.APIFY_WEBHOOK_SHARED_SECRET;
    expect(await submit()).toEqual({ job_id: jobId, status: 'cancelled' });
    expect(calls('worker_cancel_pre_submit')).toHaveLength(1); expect(calls('worker_authorize_collection_submit')).toHaveLength(0);
    expect(calls('worker_dispatch_failure')).toHaveLength(0); expect(paid()).toHaveLength(0);
  });
  it('does not retry a lost authorization ACK and keeps unknown state protected', async () => {
    authorize = 'lost_ack'; expect(await submit()).toEqual({ job_id: jobId, status: 'uncertain' });
    expect(calls('worker_authorize_collection_submit')).toHaveLength(1); expect(paid()).toHaveLength(0);
    expect(calls('worker_cancel_pre_submit')).toHaveLength(0); expect(calls('worker_dispatch_failure')).toHaveLength(1);
  });
  it('denied winner consumes no POST and asks SQL whether uncrossed cancellation is legal', async () => {
    authorize = 'deny'; expect(await submit()).toEqual({ job_id: jobId, status: 'cancelled' });
    expect(paid()).toHaveLength(0); expect(calls('worker_cancel_pre_submit')).toHaveLength(1);
  });
  it('reports a transactional no-authorization cancellation after an RPC failure without retrying the paid start', async () => {
    authorize = 'lost_ack';
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => String(input).endsWith('/rpc/worker_dispatch_failure')
      ? json({ recorded: true, cancelled: true }) : original(input, init));
    expect(await submit()).toEqual({ job_id: jobId, status: 'cancelled' });
    expect(calls('worker_authorize_collection_submit')).toHaveLength(1); expect(paid()).toHaveLength(0);
    expect(JSON.parse(String(calls('worker_dispatch_failure')[0][1]?.body)).p_error).toContain('authorization response unavailable');
  });
  it('records a sanitized unverified safe-ID hint when accepted metadata fails', async () => {
    failure = 'bad_metadata'; expect(await submit()).toEqual({ job_id: jobId, status: 'uncertain' });
    expect(journal).toEqual([{ run_id: 'safe_run', source: 'start_response', verified: false }]);
    expect(calls('worker_attach_run')).toHaveLength(0); expect(paid()).toHaveLength(1);
    expect(String(calls('worker_record_accepted_evidence')[0][1]?.body)).not.toContain('foreign');
  });
  it('fresh invocation recovers journal hint by exact provider read without another paid POST', async () => {
    journal = [{ run_id: 'safe_run', source: 'start_response', verified: false }];
    expect(await submit()).toEqual({ job_id: jobId, status: 'running' });
    expect(paid()).toHaveLength(0); expect(calls('worker_authorize_collection_submit')).toHaveLength(0);
    expect(calls('worker_attach_run')).toHaveLength(1); expect(journal.at(-1)?.verified).toBe(true);
  });
  it('retries only the same journal write three times before canonical attach', async () => {
    evidenceFailures = 2;
    expect(await submit()).toEqual({ job_id: jobId, status: 'running' });
    const receipts = calls('worker_record_accepted_evidence'); expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map(([, init]) => init?.body)).size).toBe(1); expect(paid()).toHaveLength(1);
  });
  it('ordinary scope cannot use a null pilot/media executor bypass', async () => {
    expect(await worker.submitCollectionClaim(context(), .1, 'target_media')).toEqual({ job_id: jobId, status: 'cancelled' });
    expect(calls('worker_authorize_collection_submit')).toHaveLength(0); expect(paid()).toHaveLength(0);
  });
  it('postauth timeout remains unknown and never gets pre-submit cancellation', async () => {
    failure = 'timeout'; const result = await submit();
    expect(result).toEqual({ job_id: jobId, status: 'uncertain' }); expect(JSON.stringify(result)).not.toContain('secret');
    expect(calls('worker_cancel_pre_submit')).toHaveLength(0); expect(paid()).toHaveLength(1);
  });
});
