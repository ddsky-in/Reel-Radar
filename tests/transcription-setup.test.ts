import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const setup = await import('../supabase/functions/_shared/transcription-setup.ts' as string);
const worker = await import('../supabase/functions/_shared/transcription-worker.ts' as string);
const provider = await import('../supabase/functions/_shared/transcription-provider.ts' as string);
const model = await import('../supabase/functions/_shared/transcription-model.ts' as string);
const db = new PGlite();
const api = 'https://api.elevenlabs.io/v1/workspace/webhooks';
const webhookId = 'fixture_owned_webhook';
const secret = 'fixture-private-hmac-secret';
const fixtureNonce = '44444444-4444-4444-8444-444444444444';
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let providerCalls: { method: string; url: string; body: unknown }[];
let listed: Record<string, unknown>[];
let failure: '403' | '401_permissions' | '401_invalid' | 'timeout' | 'invalid_create' | 'invalid_verify' | 'patch_failure' | null;
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function owned(events: unknown = []) {
  return { webhook_id: webhookId, name: setup.TRANSCRIPTION_WEBHOOK_NAME, webhook_url: setup.transcriptionWebhookUrl(),
    auth_type: 'hmac', is_disabled: true, is_auto_disabled: false, events, usage: { ignored: 'fixture-private-provider-payload' } };
}
function internal(supplied = 'fixture-base-secret', extra: Record<string, unknown> = {}) {
  return new Request('https://project.supabase.co/functions/v1/transcript-dispatch', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': supplied }, body: JSON.stringify({ action: 'setup_webhook', ...extra }) });
}
async function queryRpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const contracts: Record<string, string[]> = {
    worker_transcription_webhook_begin: [], worker_transcription_webhook_get_credentials: [],
    worker_transcription_webhook_mark_create: ['p_lease_token'], worker_transcription_webhook_store: ['p_lease_token', 'p_webhook_id', 'p_webhook_secret'],
    worker_transcription_webhook_finish: ['p_lease_token', 'p_status'],
  };
  if (!(name in contracts)) throw new Error('Business RPC forbidden in setup fixture');
  const keys = contracts[name];
  const sql = `select public.${name}(${keys.map((_, i) => '$' + (i + 1)).join(',')}) result`;
  return (await db.query<{ result: unknown }>(sql, keys.map(key => args[key]))).rows[0].result;
}
async function network(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.startsWith('https://project.supabase.co/rest/v1/rpc/')) {
    expect(options?.headers).toMatchObject({ apikey: 'fixture-service-secret', Authorization: 'Bearer fixture-service-secret' });
    return json(await queryRpc(url.split('/').pop()!, JSON.parse(String(options?.body))));
  }
  if (!url.startsWith(api)) throw new Error('Unexpected fixture network request');
  expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { 'xi-api-key': 'fixture-api-secret' } });
  expect(new URL(url).origin).toBe('https://api.elevenlabs.io');
  const method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : null;
  providerCalls.push({ method, url, body });
  if (method === 'GET') {
    expect(url).toBe(`${api}?include_usages=true`);
    if (failure === '403') return json({ detail: { status: 'missing_permissions', message: 'fixture-api-secret do not reflect' } }, 403);
    if (failure === '401_permissions') return json({ detail: { status: 'missing_permissions', message: 'fixture-api-secret do not reflect' } }, 401);
    if (failure === '401_invalid') return json({ detail: { status: 'invalid_api_key', message: 'fixture-api-secret do not reflect' } }, 401);
    return json({ webhooks: listed });
  }
  if (method === 'POST') {
    expect(body).toEqual({ settings: { auth_type: 'hmac', name: setup.TRANSCRIPTION_WEBHOOK_NAME, webhook_url: setup.transcriptionWebhookUrl() } });
    // Assert durable intent exists before any external creation could have been accepted.
    expect((await db.query('select status from public.transcription_webhook_setup')).rows[0]).toEqual({ status: 'create_pending' });
    if (failure === 'timeout') throw new Error('fixture-api-secret ambiguous timeout');
    listed.push(owned());
    if (failure === 'invalid_create') return json({ webhook_id: webhookId });
    return json({ webhook_id: webhookId, webhook_secret: secret, extra: 'fixture-private-provider-payload' });
  }
  expect(method).toBe('PATCH');
  expect(url).toBe(`${api}/${webhookId}`);
  expect(body).toEqual({ name: setup.TRANSCRIPTION_WEBHOOK_NAME, is_disabled: false, events: ['speech_to_text'], retry_enabled: true });
  if (failure === 'patch_failure') return json({ detail: 'fixture-api-secret' }, 403);
  listed = listed.map(row => row.webhook_id === webhookId ? { ...row, is_disabled: false, events: failure === 'invalid_verify' ? [] : ['speech_to_text'] } : row);
  return json({ status: 'ok' });
}
async function state() { return (await db.query<{ status: string; webhook_id: string | null; secret_id: string | null }>('select status,webhook_id,secret_id from public.transcription_webhook_setup')).rows[0]; }
async function acquire() { return await queryRpc('worker_transcription_webhook_begin') as { status: string; lease_token: string }; }
async function storeKnown() {
  const lease = await acquire();
  await queryRpc('worker_transcription_webhook_store', { p_lease_token: lease.lease_token, p_webhook_id: webhookId, p_webhook_secret: secret });
  await queryRpc('worker_transcription_webhook_finish', { p_lease_token: lease.lease_token, p_status: 'configured' });
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema vault;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create function public.require_service() returns void language plpgsql as $$ begin
      if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
    end $$;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/202611090010_transcription_webhook_setup.sql'), 'utf8'));
  await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/202611090012_webhook_setup_lease.sql'), 'utf8'));
}, 60000);
beforeEach(async () => {
  await db.exec(`reset role; set request.jwt.claim.role='service_role'; truncate public.transcription_webhook_setup;
    delete from vault.secrets; insert into public.transcription_webhook_setup(singleton) values(true);`);
  values = { ENVIRONMENT: 'test', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-secret',
    INTERNAL_CRON_SECRET: 'fixture-base-secret', ELEVENLABS_API_KEY: 'fixture-api-secret', TRANSCRIPTION_ENABLED: 'false', TRANSCRIPTION_PROVIDER_VALIDATED: 'false' };
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  vi.stubGlobal('crypto', webcrypto);
  providerCalls = []; listed = []; failure = null;
  fetcher = vi.fn<typeof fetch>().mockImplementation(network);
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await db.close(); });

describe('base-only API webhook setup and private durable state', () => {
  it('derives the callback from this installation without a private deployment constant', () => {
    values.SUPABASE_URL = 'https://synthetic-project.supabase.co/';
    expect(setup.transcriptionWebhookUrl()).toBe('https://synthetic-project.supabase.co/functions/v1/elevenlabs-webhook');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['', 'http://project.supabase.co', 'https://user:password@project.supabase.co', 'https://project.supabase.co/path', 'https://project.supabase.co?token=fixture', 'https://project.supabase.co#fragment'])('rejects invalid callback origin %s before network access', origin => {
    values.SUPABASE_URL = origin;
    expect(() => setup.transcriptionWebhookUrl()).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated and derived scheduler setup before all network access', async () => {
    for (const supplied of ['', 'wrong', await worker.maintenanceSecret()]) {
      expect((await worker.transcriptionInternalHandler(internal(supplied))).status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed callback headers before a Vault credential read', async () => {
    for (const signature of ['', 'invalid', `t=1000000000,v0=${'a'.repeat(64)}`]) {
      const request = new Request('https://project.supabase.co/callback', { method: 'POST', headers: { 'elevenlabs-signature': signature }, body: 'not-json' });
      expect((await worker.transcriptionWebhookHandler(request)).status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['403', '401_permissions', '401_invalid'] as const)('sanitizes %s and never writes to the provider', async mode => {
    failure = mode;
    const response = await worker.transcriptionInternalHandler(internal());
    expect(response.status).toBe(403);
    const result = await response.json();
    expect(result.status).toBe(mode === '401_invalid' ? 'unauthorized' : 'missing_permission');
    expect(result.configured).toBe(false); expect(result.api_key_valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture');
    expect(providerCalls.map(call => call.method)).toEqual(['GET']);
    expect((await state()).status).toBe('idle');
  });
  it('creates once, atomically stores only private credentials, patches and verifies without enabling paid gates', async () => {
    listed = [{ ...owned(null), webhook_id: 'unrelated', name: 'Other application', webhook_url: 'https://unrelated.test/webhook' }];
    const unrelated = { ...listed[0] };
    const response = await worker.transcriptionInternalHandler(internal());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, status: 'configured', api_key_valid: true, webhook_registered: true, event_verified: true });
    expect(providerCalls.map(call => call.method)).toEqual(['GET', 'POST', 'GET', 'PATCH', 'GET']);
    expect(listed[0]).toEqual(unrelated);
    expect((await state()).status).toBe('configured');
    expect(await queryRpc('worker_transcription_webhook_get_credentials')).toEqual({ id: webhookId, secret });
    expect((await db.query('select name from vault.secrets')).rows).toEqual([{ name: 'reelradar_transcription_webhook_hmac_v1' }]);
    expect(values.TRANSCRIPTION_ENABLED).toBe('false'); expect(values.TRANSCRIPTION_PROVIDER_VALIDATED).toBe('false');
    expect(fetcher.mock.calls.some(([url]) => /claim|configure|speech-to-text|cron/.test(String(url)))).toBe(false);
    providerCalls = [];
    expect((await setup.setupTranscriptionWebhook()).configured).toBe(true);
    expect(providerCalls.map(call => call.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect((await db.query('select id from vault.secrets')).rows).toHaveLength(1);
  });
  it.each(['timeout', 'invalid_create'] as const)('blocks reentry after ambiguous %s with no POST retry', async mode => {
    failure = mode;
    expect((await setup.setupTranscriptionWebhook()).status).toBe('uncertain');
    expect((await state()).status).toBe('uncertain');
    const before = providerCalls.length;
    expect((await setup.setupTranscriptionWebhook()).status).toBe('uncertain');
    expect(providerCalls).toHaveLength(before);
    expect(providerCalls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it('blocks matching existing webhook without its secret and conflicts without touching any webhook', async () => {
    for (const row of [owned(), { ...owned(), name: 'Someone else' }, { ...owned(), webhook_url: 'https://unrelated.test' }]) {
      await db.exec("update public.transcription_webhook_setup set status='idle',lease_token=null,lease_expires_at=null");
      listed = [row]; providerCalls = [];
      const result = await setup.setupTranscriptionWebhook();
      expect(result.status).toBe('recovery_required'); expect(result.configured).toBe(false);
      expect(providerCalls.map(call => call.method)).toEqual(['GET']);
    }
  });
  it('adopts a verified environment pair without rotation or creating a duplicate', async () => {
    values.ELEVENLABS_WEBHOOK_ID = webhookId; values.ELEVENLABS_WEBHOOK_SECRET = secret;
    listed = [owned()];
    expect((await setup.setupTranscriptionWebhook()).configured).toBe(true);
    expect(providerCalls.map(call => call.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(await queryRpc('worker_transcription_webhook_get_credentials')).toEqual({ id: webhookId, secret });
  });
  it('never patches an ID whose name, callback or HMAC ownership is not verified', async () => {
    await storeKnown();
    listed = [{ ...owned(), auth_type: 'none' }];
    expect((await setup.setupTranscriptionWebhook()).status).toBe('recovery_required');
    expect(providerCalls.map(call => call.method)).toEqual(['GET']);
  });
  it.each(['patch_failure', 'invalid_verify'] as const)('does not mark configured on %s and keeps the original secret', async mode => {
    failure = mode;
    const result = await setup.setupTranscriptionWebhook();
    expect(result.configured).toBe(false); expect(result.event_verified).toBe(false);
    expect((await state()).status).toBe('idle');
    expect(await queryRpc('worker_transcription_webhook_get_credentials')).toEqual({ id: webhookId, secret });
    failure = null; providerCalls = [];
    expect((await setup.setupTranscriptionWebhook()).configured).toBe(true);
    expect(providerCalls.some(call => call.method === 'POST')).toBe(false);
  });
  it('fails closed on capped or redirected listing without any external writes', async () => {
    for (const response of [new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } }),
      new Response(null, { status: 302, headers: { location: 'https://unrelated.test' } })]) {
      fetcher.mockImplementation(async (input, options) => String(input).startsWith(api) ? response : network(input, options));
      const result = await setup.setupTranscriptionWebhook();
      expect(result.configured).toBe(false);
      expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(api)).every(([, options]) => options?.method === 'GET')).toBe(true);
      fetcher.mockClear();
    }
  });
  it('returns only paired credentials and reads Vault once for safe diagnostics', async () => {
    await storeKnown();
    fetcher.mockImplementation(async (input, options) => String(input).endsWith('/worker_transcription_config') ? json({ enabled: false, paused: true, key_validated: false, contract_validated: false, phase: 'pilot' }) : network(input, options));
    const response = await worker.transcriptionInternalHandler(internal('fixture-base-secret', { action: 'diagnostics' }));
    const data = await response.json();
    expect(data.diagnostics).toMatchObject({ webhook_id_configured: true, webhook_secret_configured: true, can_dispatch: false, key_configured: true });
    expect(JSON.stringify(data)).not.toContain(secret); expect(JSON.stringify(data)).not.toContain(webhookId);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/worker_transcription_webhook_get_credentials'))).toHaveLength(1);
    values.ELEVENLABS_WEBHOOK_ID = 'fixture_partial_override';
    fetcher.mockClear(); expect(await setup.resolveWebhookCredentials()).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('resolves the Vault ID for submission only after paid gates and leaves those gates independent', async () => {
    await storeKnown();
    const source = 'https://scontent.cdninstagram.com/video.mp4';
    const job = { id: '11111111-1111-4111-8111-111111111111', attempt_id: '33333333-3333-4333-8333-333333333333', lease_token: fixtureNonce, source_url: source, candidates: [source] };
    await expect(provider.submitTranscription(job, source)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    values.TRANSCRIPTION_ENABLED = 'true'; values.TRANSCRIPTION_PROVIDER_VALIDATED = 'true';
    fetcher.mockImplementation(async (input, options) => {
      if (String(input) === 'https://api.elevenlabs.io/v1/speech-to-text') {
        expect((options?.body as FormData).get('webhook_id')).toBe(webhookId);
        return json({ message: 'accepted', request_id: 'fixture_request' });
      }
      return network(input, options);
    });
    expect(await provider.submitTranscription(job, source)).toEqual({ request_id: 'fixture_request', transcription_id: null });
    expect(fetcher.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['worker_transcription_webhook_get_credentials', 'speech-to-text']);
  });
  it('uses only trusted credential lookup before exact-byte HMAC, never business RPCs for a forged callback', async () => {
    await storeKnown();
    const now = Math.floor(Date.now() / 1000);
    const forged = new Request('https://project.supabase.co/callback', { method: 'POST', headers: { 'elevenlabs-signature': `t=${now},v0=${'0'.repeat(64)}` }, body: 'not-json' });
    expect((await worker.transcriptionWebhookHandler(forged)).status).toBe(401);
    expect(fetcher.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['worker_transcription_webhook_get_credentials']);
    fetcher.mockClear();
    const body = '{ "not": "an event" }';
    const hmac = await model.hmacHex(secret, new TextEncoder().encode(`${now}.${body}`));
    const signed = new Request('https://project.supabase.co/callback', { method: 'POST', headers: { 'elevenlabs-signature': `t=${now},v0=${hmac}` }, body });
    expect((await worker.transcriptionWebhookHandler(signed)).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('real migration service authorization, nonce fencing and atomic Vault persistence', () => {
  it('keeps a live pending creation busy without poisoning its one-time secret storage', async () => {
    const lease = await acquire();
    await queryRpc('worker_transcription_webhook_mark_create', { p_lease_token: lease.lease_token });
    expect(await queryRpc('worker_transcription_webhook_begin')).toEqual({ status: 'busy' });
    expect((await state()).status).toBe('create_pending');
    expect(await queryRpc('worker_transcription_webhook_store', { p_lease_token: lease.lease_token, p_webhook_id: webhookId, p_webhook_secret: secret })).toEqual({ stored: true });
    await queryRpc('worker_transcription_webhook_finish', { p_lease_token: lease.lease_token, p_status: 'configured' });
    expect(await queryRpc('worker_transcription_webhook_get_credentials')).toEqual({ id: webhookId, secret });
  });
  it('revokes every table and RPC from browsers and only grants service RPC execution', async () => {
    const functions = ['worker_transcription_webhook_begin()', 'worker_transcription_webhook_get_credentials()',
      'worker_transcription_webhook_mark_create(uuid)', 'worker_transcription_webhook_store(uuid,text,text)', 'worker_transcription_webhook_finish(uuid,text)'];
    for (const role of ['anon', 'authenticated']) {
      for (const name of functions) expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, 'public.' + name])).rows[0].allowed).toBe(false);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'public.transcription_webhook_setup','SELECT,INSERT,UPDATE,DELETE') allowed", [role])).rows[0].allowed).toBe(false);
    }
    await db.exec("set role authenticated; set request.jwt.claim.role='authenticated'");
    await expect(db.exec('select public.worker_transcription_webhook_get_credentials()')).rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role service_role; set request.jwt.claim.role='authenticated'");
    await expect(db.exec('select public.worker_transcription_webhook_get_credentials()')).rejects.toThrow(/forbidden/);
    await db.exec("set request.jwt.claim.role='service_role'");
    expect(await queryRpc('worker_transcription_webhook_get_credentials')).toBeNull();
    await db.exec('reset role');
  });
  it('blocks stale and null nonces, serializes leases and never reopens expired create intent', async () => {
    await expect(queryRpc('worker_transcription_webhook_store', { p_lease_token: null, p_webhook_id: webhookId, p_webhook_secret: secret })).rejects.toThrow(/fenced/);
    const first = await acquire();
    expect((await acquire()).status).toBe('busy');
    await expect(queryRpc('worker_transcription_webhook_mark_create', { p_lease_token: fixtureNonce })).rejects.toThrow(/fenced/);
    await db.exec("update public.transcription_webhook_setup set lease_expires_at=clock_timestamp()-interval '1 second'");
    const next = await acquire(); expect(next.lease_token).not.toBe(first.lease_token);
    await expect(queryRpc('worker_transcription_webhook_store', { p_lease_token: first.lease_token, p_webhook_id: webhookId, p_webhook_secret: secret })).rejects.toThrow(/fenced/);
    await queryRpc('worker_transcription_webhook_mark_create', { p_lease_token: next.lease_token });
    await expect(queryRpc('worker_transcription_webhook_finish', { p_lease_token: next.lease_token, p_status: 'idle' })).rejects.toThrow(/transition/);
    await db.exec("update public.transcription_webhook_setup set lease_expires_at=clock_timestamp()-interval '1 second'");
    expect((await acquire()).status).toBe('uncertain');
    await expect(queryRpc('worker_transcription_webhook_store', { p_lease_token: next.lease_token, p_webhook_id: webhookId, p_webhook_secret: secret })).rejects.toThrow(/fenced/);
    expect((await db.query('select id from vault.secrets')).rows).toHaveLength(0);
  });
  it('atomically stores an immutable secret, returns no secret from write RPCs, and never rotates it', async () => {
    const first = await acquire();
    const args = { p_lease_token: first.lease_token, p_webhook_id: webhookId, p_webhook_secret: secret };
    expect(await queryRpc('worker_transcription_webhook_store', args)).toEqual({ stored: true });
    expect(await queryRpc('worker_transcription_webhook_store', args)).toEqual({ stored: true });
    await expect(queryRpc('worker_transcription_webhook_store', { ...args, p_webhook_secret: 'fixture-different-secret' })).rejects.toThrow(/recovery/);
    await expect(queryRpc('worker_transcription_webhook_store', { ...args, p_webhook_id: 'fixture_different_id' })).rejects.toThrow(/recovery/);
    expect((await db.query('select id from vault.secrets')).rows).toHaveLength(1);
    expect(await queryRpc('worker_transcription_webhook_get_credentials')).toEqual({ id: webhookId, secret });
    expect(await queryRpc('worker_transcription_webhook_finish', { p_lease_token: first.lease_token, p_status: 'configured' })).toEqual({ status: 'configured' });
  });
});
