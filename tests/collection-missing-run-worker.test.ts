import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../supabase/functions/_shared/model.ts';
const recovery = await import('../supabase/functions/_shared/collection-recovery.ts' as string);
const worker = await import('../supabase/functions/_shared/worker.ts' as string);
const owner = '11111111-1111-4111-8111-111111111111', nonce = '22222222-2222-4222-8222-222222222222';
const job: Job = { id: owner, owner_user_id: owner, kind: 'daily', live: true, status: 'uncertain', apify_account_slot: 2,
  collection_source: 'ordinary', actor_run_id: null, dispatch_nonce: nonce, expected_actor_id: 'actor', expected_provider_user_id: 'account',
  results_limit: 30, dataset_id: null, dataset_cursor: 0, dataset_finished: false, lease_token: nonce,
  started_at: '2026-11-16T12:00:00Z', actual_cost_usd: null, provider_terminal_status: null };
const hook = (patch: Record<string, unknown> = {}) => ({ id: 'hook', userId: 'account', actionType: 'HTTP_REQUEST', condition: { actorId: 'actor', actorRunId: 'run' },
  requestUrl: `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${owner}&dispatch_nonce=${nonce}`, ...patch });
const page = (items: unknown[], patch: Record<string, unknown> = {}) => ({ data: { items, offset: 0, limit: 50, count: items.length, desc: false, total: items.length, ...patch } });
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>, hooks: unknown[], receipts: unknown[], pages: number;
const reader = () => new recovery.RecoveryReader({ accountSlot: 2, expectedProviderUserId: 'account' });
beforeEach(() => {
  const config: Record<string, string> = { APIFY_API_TOKEN_2: 'synthetic-private-token', SUPABASE_URL: 'https://fixture.supabase.co' };
  vi.stubGlobal('Deno', { env: { get: (key: string) => config[key] } });
  hooks = []; receipts = []; pages = 0;
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.apify.com'); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined(); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-private-token');
    expect(url.searchParams.has('token')).toBe(false);
    if (url.pathname === '/v2/users/me') return Response.json({ data: { id: 'account' } });
    if (url.pathname === '/v2/webhooks') { pages++; return Response.json(page(hooks)); }
    if (url.pathname === '/v2/webhook-dispatches') { pages++; return Response.json(page(receipts)); }
    if (url.pathname === '/v2/actor-runs/run') return Response.json({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: null } });
    throw new Error('No synthetic request matches');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded durable missing-run GET evidence', () => {
  it('verifies selected account identity once and accepts only exact job+nonce+run webhook', async () => {
    hooks = [hook()]; const result = await recovery.findMissingRun(job, reader());
    expect(result).toMatchObject({ outcome: 'matched', pagesUsed: 1, run: { id: 'run', actorId: 'actor', userId: 'account', usageTotalUsd: null } });
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/users/me'))).toHaveLength(1);
    expect(pages).toBe(1); expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
  it.each([
    { requestUrl: `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${nonce}&dispatch_nonce=${nonce}` },
    { requestUrl: `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${owner}&dispatch_nonce=${owner}` },
    { requestUrl: `https://fixture.supabase.co.evil.test/functions/v1/apify-webhook?job_id=${owner}&dispatch_nonce=${nonce}` },
    { requestUrl: `https://fixture.supabase.co/functions/v1/apify-webhook?job_id=${owner}&dispatch_nonce=${nonce}&extra=1` },
    { condition: { actorRunId: 'run', actorId: 'foreign' } }, { condition: { actorRunId: 'run', actorTaskId: 'task' } }, { userId: 'foreign' },
  ])('rejects approximate/foreign hooks without run reads: %j', async patch => {
    hooks = [hook(patch)]; expect(await recovery.findMissingRun(job, reader())).toMatchObject({ outcome: 'exhausted', pagesUsed: 2 });
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/actor-runs/'))).toBe(false);
  });
  it('empty listings mean exhausted review, never zero charge or safe retry', async () => {
    const result = await recovery.findMissingRun(job, reader()); expect(result).toEqual({ outcome: 'exhausted', cursor: null, pagesUsed: 2 });
    expect(result).not.toHaveProperty('usageTotalUsd'); expect(result).not.toHaveProperty('noStartProven');
    expect(fetcher.mock.calls.some(([input]) => /INPUT|actors\//.test(String(input)))).toBe(false);
  });
  it('uses persisted text cursor and a remaining one-page limit', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/v2/webhooks'
      ? Response.json(page([], { offset: 50, total: 50 })) : original(input, init));
    const result = await recovery.findMissingRun(job, reader(), JSON.stringify({ mode: 'webhooks', offset: 50 }), 1);
    expect(result).toEqual({ outcome: 'no_match', pagesUsed: 1, cursor: { mode: 'receipts', offset: 0 } });
    expect(fetcher.mock.calls).toHaveLength(2);
  });
  it('bounds streaming responses to1MB even without content-length', async () => {
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } })));
    await expect(recovery.findMissingRun(job, reader())).rejects.toThrow('Bounded provider recovery unavailable'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('blocks redirects, mismatched detail pins and malformed pagination', async () => {
    fetcher.mockResolvedValue(Response.redirect('https://evil.test', 302));
    await expect(recovery.findMissingRun(job, reader())).rejects.toThrow();
    fetcher.mockReset().mockImplementation(async input => String(input).endsWith('/users/me') ? Response.json({ data: { id: 'account' } }) : Response.json(page([], { total: 1 })));
    await expect(recovery.findMissingRun(job, reader())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('recovers fresh durable journal evidence after the lookup page budget is exhausted without searching again', async () => {
    const config: Record<string, string> = { PROVIDER_MODE: 'apify', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
      APIFY_ACCOUNT_ID: 'primary', APIFY_API_TOKEN_2: 'synthetic-private-token', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor' };
    vi.stubGlobal('Deno', { env: { get: (key: string) => config[key] } });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://fixture.supabase.co') {
        if (url.pathname === '/v2/users/me') return Response.json({ data: { id: 'account' } });
        if (url.pathname === '/v2/actor-runs/run') return Response.json({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } });
        return original(input, init);
      }
      const name = url.pathname.split('/').at(-1), args = JSON.parse(String(init?.body));
      if (name === 'worker_accounts') return Response.json([{ owner_user_id: owner, account_slot: 2, provider_user_id: 'account', enabled: false, authorization_confirmed: true }]);
      if (name === 'worker_claim_missing_run_recovery') return Response.json([{ job, recovery_token: nonce, cursor: '{"mode":"receipts","offset":100}', attempt: 8, pages_remaining: 0 }]);
      if (name === 'worker_get_collection_recovery_state') return Response.json({ input_digest: null, accepted_evidence: [{ run_id: 'run', source: 'start_response', verified: false }], callback_hints: [] });
      if (name === 'worker_record_accepted_evidence') return Response.json({ recorded: true });
      if (name === 'worker_attach_run') return Response.json(null);
      if (name === 'worker_complete_missing_run_recovery') {
        expect(args.p_outcome).toBe('matched'); expect(args.p_pages_used).toBe(0); expect(args.p_cursor).toBeNull(); return Response.json({ recorded: true });
      }
      throw new Error('Unexpected synthetic recovery DB call');
    });
    expect(await recovery.recoverMissingRuns(owner, new worker.CollectionSession(owner))).toEqual([{ job_id: job.id, state: 'run_recovered' }]);
    expect(pages).toBe(0);
  });
  it('stops at totalcall and overall45second budget without automatic retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); const selected = reader();
    await selected.read('/webhooks?desc=0&limit=50&offset=0');
    vi.setSystemTime(Date.now() + 45000);
    await expect(selected.read('/webhooks?desc=0&limit=50&offset=0')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
