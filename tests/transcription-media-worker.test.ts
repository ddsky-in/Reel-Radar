import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const media = await import('../supabase/functions/_shared/transcription-media.ts' as string);
const provider = await import('../supabase/functions/_shared/transcription-provider.ts' as string);
const worker = await import('../supabase/functions/_shared/transcription-worker.ts' as string);
const ids = { job: '11111111-1111-4111-8111-111111111111', reel: '22222222-2222-4222-8222-222222222222', attempt: '33333333-3333-4333-8333-333333333333', nonce: '44444444-4444-4444-8444-444444444444' };
const source = 'https://scontent.cdninstagram.com/video.mp4', alternate = 'https://video.xx.fbcdn.net/alternate.mp4';
const job = { id: ids.job, reel_id: ids.reel, attempt_id: ids.attempt, lease_token: ids.nonce, source_url: source, candidates: [source, alternate], has_audio: null, duration_seconds: 12, model: 'scribe_v2', options_version: 1, reservation_usd: .08, max_duration_seconds: 180, max_media_bytes: 26214400 };
function join(...parts: Uint8Array[]) { const value = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { value.set(part, offset); offset += part.length; } return value; }
function box(type: string, ...parts: Uint8Array[]) { const data = join(...parts), value = new Uint8Array(data.length + 8); new DataView(value.buffer).setUint32(0, value.length); value.set(new TextEncoder().encode(type), 4); value.set(data, 8); return value; }
function timing(seconds: number, version = 0) { const value = new Uint8Array(version ? 32 : 20), view = new DataView(value.buffer); value[0] = version; view.setUint32(version ? 20 : 12, 1000); if (version) view.setBigUint64(24, BigInt(Math.round(seconds * 1000))); else view.setUint32(16, seconds * 1000); return value; }
function mp4(seconds = 12, sampleSeconds = seconds, version = 0, audio = true) {
  const handler = new Uint8Array(12); handler.set(new TextEncoder().encode(audio ? 'soun' : 'vide'), 8);
  const samples = new Uint8Array(16), view = new DataView(samples.buffer); view.setUint32(4, 1); view.setUint32(8, 1); view.setUint32(12, sampleSeconds * 1000);
  const sampleTable = box('minf', box('stbl', box('stts', samples)));
  const track = box('trak', box('mdia', box('mdhd', timing(seconds, version)), box('hdlr', handler), sampleTable));
  return join(box('ftyp', new TextEncoder().encode('isom0000')), box('moov', box('mvhd', timing(seconds, version)), track), box('mdat', new Uint8Array([1, 2, 3])));
}
function response(bytes = mp4()) { return new Response(bytes.slice().buffer, { headers: { 'content-type': 'video/mp4' } }); }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
let values: Record<string, string>, fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => { values = { ENVIRONMENT: 'test', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-secret', INTERNAL_CRON_SECRET: 'fixture-internal-secret', ELEVENLABS_API_KEY: 'fixture-api-secret', ELEVENLABS_WEBHOOK_ID: 'fixture-webhook-id', ELEVENLABS_WEBHOOK_SECRET: 'fixture-hmac-secret', TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER_VALIDATED: 'true' }; vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] } }); vi.stubGlobal('crypto', webcrypto); fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('No network outside explicit fixture')); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded actual-media verification', () => {
  it('reads mvhd, mdhd and sample duration in v0/v1 containers and requires audio', () => {
    expect(media.mp4Duration(mp4())).toBe(12); expect(media.mp4Duration(mp4(180, 180, 1))).toBe(180);
    for (const bytes of [mp4(181), mp4(12, 181), mp4(12, 12, 0, false), mp4().subarray(0, 40), new TextEncoder().encode('not-media')]) expect(() => media.mp4Duration(bytes)).toThrow();
  });
  it('rejects forged small movie duration against actual sample timing, fragmented media, and excessive boxes', () => {
    expect(() => media.mp4Duration(mp4(12, 120))).toThrow();
    expect(() => media.mp4Duration(join(mp4(), box('moof', new Uint8Array())))).toThrow();
    expect(() => media.mp4Duration(join(mp4(), ...Array.from({ length: 4097 }, () => box('free', new Uint8Array()))))).toThrow();
  });
  it('tries at most three distinct allowlisted candidates with no credentials or redirects', async () => {
    const third = 'https://scontent.cdninstagram.com/third.mp4', fourth = 'https://scontent.cdninstagram.com/fourth.mp4';
    fetcher.mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(response());
    const result = await media.probeTranscriptMedia({ ...job, candidates: [source, 'https://evil.test/x', alternate, alternate, third, fourth] });
    expect(result).toMatchObject({ source_url: third, content_type: 'video/mp4', duration_seconds: 12 }); expect(result.bytes).toEqual(mp4());
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([source, alternate, third]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('fixture-');
  });
  it('rejects metadata duration tampering and body overflow before any paid POST', async () => {
    fetcher.mockImplementation(async () => response(mp4(120)));
    await expect(media.probeTranscriptMedia(job)).rejects.toThrow('Media unavailable');
    fetcher.mockImplementation(async () => response());
    await expect(media.probeTranscriptMedia({ ...job, max_media_bytes: 32 })).rejects.toThrow();
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    const before = fetcher.mock.calls.length;
    for (const patch of [{ reservation_usd: .01 }, { duration_seconds: null }, { max_duration_seconds: 181 }]) await expect(media.probeTranscriptMedia({ ...job, ...patch })).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBe(before);
  });
  it('verifies actual audio even when provider metadata says false and falls back from video-only variants', async () => {
    fetcher.mockResolvedValueOnce(response(mp4(12, 12, 0, false))).mockResolvedValueOnce(response());
    expect(await media.probeTranscriptMedia({ ...job, has_audio: false })).toMatchObject({ source_url: alternate, duration_seconds: 12 });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([source, alternate]);
    fetcher.mockReset().mockImplementation(async () => response(mp4(12, 12, 0, false)));
    await expect(media.probeTranscriptMedia(job)).rejects.toThrow('Media unavailable');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retries transient GET and interrupted body once while permanent failures only try another candidate', async () => {
    for (const failure of [new Error('Connection interrupted'), json({}, 503), json({}, 429), new Response(new ReadableStream({ start(controller) { controller.error(new Error('Body interrupted')); } }), { headers: { 'content-type': 'video/mp4' } })]) {
      fetcher.mockReset();
      if (failure instanceof Error) fetcher.mockRejectedValueOnce(failure); else fetcher.mockResolvedValueOnce(failure);
      fetcher.mockResolvedValueOnce(response());
      expect((await media.probeTranscriptMedia(job)).source_url).toBe(source);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([source, source]);
    }
    for (const failure of [json({}, 403), response(new Uint8Array(300)), response(mp4(181))]) {
      fetcher.mockReset().mockResolvedValueOnce(failure).mockResolvedValueOnce(response());
      expect((await media.probeTranscriptMedia(job)).source_url).toBe(alternate);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([source, alternate]);
    }
  });
  it('uploads exactly the validated file without source_url or provider CDN refetch', async () => {
    fetcher.mockResolvedValueOnce(response()).mockResolvedValueOnce(json({ message: 'accepted', request_id: 'request_123' }));
    const probed = await media.probeTranscriptMedia(job); await provider.submitTranscription(job, probed.source_url, undefined, probed);
    const [url, options] = fetcher.mock.calls[1]; expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    const form = options?.body as FormData, file = form.get('file') as File;
    expect(form.has('source_url')).toBe(false); expect(file.type).toBe('video/mp4'); expect(file.name).toBe('reel.mp4'); expect(new Uint8Array(await file.arrayBuffer())).toEqual(mp4());
    expect(form.get('model_id')).toBe('scribe_v2'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry billed multipart POST on timeout, throttling, or malformed acceptance', async () => {
    const probed = { source_url: source, bytes: mp4(), content_type: 'video/mp4', duration_seconds: 12 };
    for (const result of [new Error('timeout'), json({}, 429), json({}, 500), json({ message: 'accepted' })]) {
      fetcher.mockReset(); if (result instanceof Error) fetcher.mockRejectedValue(result); else fetcher.mockResolvedValue(result);
      await expect(provider.submitTranscription(job, source, undefined, probed)).rejects.toThrow('Transcription acceptance uncertain'); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});

function internal(action: string, extra: Record<string, unknown> = {}, secret = 'fixture-internal-secret') { return new Request('https://project.supabase.co/worker', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret }, body: JSON.stringify({ action, ...extra }) }); }
const config = { enabled: true, paused: false, key_validated: true, contract_validated: true, phase: 'pilot' };
const subscription = { tier: 'free', status: 'active', character_count: 10, character_limit: 20000, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 86400, current_overage: { amount: '0.00', currency: 'usd' }, email: 'must-not-return@example.test', invoice_secret: 'must-not-return' };
function dispatchFixture(allow: unknown = true, postError = false) {
  fetcher.mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith('/worker_transcription_config')) return json(config);
    if (url.endsWith('/worker_transcription_claim')) return json({ jobs: [job] });
    if (url === source) return response();
    if (url.endsWith('/worker_transcription_before_submit')) return json({ allow });
    if (url.endsWith('/worker_transcription_select_media')) return json({ selected: true });
    if (url.endsWith('/worker_transcription_cancel_not_started')) return json({ status: 'not_started' });
    if (url.endsWith('/worker_transcription_attach') || url.endsWith('/worker_transcription_fail')) return json({});
    if (url === 'https://api.elevenlabs.io/v1/speech-to-text') { if (postError) throw new Error('timeout-secret'); return json({ message: 'accepted', request_id: 'request_123', transcription_id: 'transcript_456' }); }
    throw new Error('Unexpected test request');
  });
}
function apifyEnvironment() {
  values.SUPABASE_URL = 'https://fixture.supabase.co';
  Object.assign(values, { PROVIDER_MODE: 'apify', REELRADAR_OWNER_USER_ID: ids.reel, APIFY_API_TOKEN: 'fixture-apify-secret', APIFY_ACCOUNT_ID: 'account_123', APIFY_REEL_ACTOR_RESOURCE_ID: 'actor_123', APIFY_WEBHOOK_SHARED_SECRET: 'fixture-callback-secret', SCRAPING_ENABLED: 'true', PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true' });
}
const mediaJob = { id: ids.job, owner_user_id: ids.reel, kind: 'manual', collection_source: 'target_media', status: 'submitting', live: true, results_limit: 100, actor_run_id: null, dispatch_nonce: ids.nonce, expected_actor_id: 'actor_123', expected_provider_user_id: 'account_123', dataset_id: null, dataset_cursor: 0, dataset_finished: false, lease_token: ids.nonce, started_at: new Date().toISOString(), provider_terminal_status: null, actual_cost_usd: null };
function apifyFixture(postError = false) {
  fetcher.mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith('/worker_accounts')) return json([{ owner_user_id: ids.reel, account_slot: 1, provider_user_id: 'account_123', enabled: true, authorization_confirmed: true }]);
    if (url.endsWith('/worker_begin_account_usage')) return json({ observation_id: ids.nonce, observed_at: new Date().toISOString() });
    if (url === 'https://api.apify.com/v2/users/me') return json({ data: { id: 'account_123' } });
    if (url === 'https://api.apify.com/v2/users/me/limits') return json({ data: { monthlyUsageCycle: { startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() }, current: { monthlyUsageUsd: .1 }, limits: { maxMonthlyUsageUsd: 5 } } });
    if (url.endsWith('/worker_get_collection_recovery_state')) return json({ input_digest: null, accepted_evidence: [], callback_hints: [] });
    if (url.endsWith('/worker_record_accepted_evidence')) return json({ recorded: true });
    if (url.endsWith('/worker_authorize_collection_submit')) return json({ authorized: true });
    if (url.endsWith('/worker_cancel_pre_submit')) return json({ cancelled: true });
    if (url.endsWith('/worker_record_usage') || url.endsWith('/worker_attach_run') || url.endsWith('/worker_dispatch_failure')) return json({});
    if (url.endsWith('/worker_transcription_media_claim')) return json({ job: { ...mediaJob, reserved_usd: .5 }, creators: [{ id: ids.attempt, username: 'harshpanwar.ai' }], max_total_charge_usd: .5 });
    if (url.startsWith('https://api.apify.com/v2/actors/actor_123/runs?')) { if (postError) return json({}, 429); return json({ data: { id: 'run_123', actId: 'actor_123', userId: 'account_123', status: 'RUNNING', defaultDatasetId: 'dataset_123' } }); }
    throw new Error('Unexpected test request');
  });
}

describe('single-claim pre-submit fencing', () => {
  it('claims one and checks durable fence after exact media probe immediately before multipart POST', async () => {
    dispatchFixture(); expect(await worker.dispatchTranscripts()).toEqual([{ job_id: ids.job, status: 'submitted' }]);
    expect(fetcher.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['worker_transcription_config', 'worker_transcription_claim', 'video.mp4', 'worker_transcription_select_media', 'worker_transcription_before_submit', 'speech-to-text', 'worker_transcription_attach']);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ p_limit: 1 });
  });
  it('releases only explicit known pre-submit denial and never sends paid POST', async () => {
    dispatchFixture(false); expect(await worker.dispatchTranscripts()).toEqual([{ job_id: ids.job, status: 'not_started' }]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('api.elevenlabs.io'))).toBe(false);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('worker_transcription_cancel_not_started');
  });
  it('retains holds for malformed fence or uncertain POST without another claim or POST', async () => {
    dispatchFixture(null); expect(await worker.dispatchTranscripts()).toEqual([{ job_id: ids.job, status: 'unresolved' }]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('cancel_not_started') || String(url).includes('api.elevenlabs.io'))).toBe(false);
    fetcher.mockClear(); dispatchFixture(true, true); expect(await worker.dispatchTranscripts()).toEqual([{ job_id: ids.job, status: 'uncertain' }]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.elevenlabs.io'))).toHaveLength(1);
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ p_status: 'uncertain' });
  });
});

describe('account diagnostics and operator activation', () => {
  it('uses two safe official GETs and only sanitized subscription/model fields without DB or paid work', async () => {
    fetcher.mockImplementation(async input => String(input).endsWith('/subscription') ? json(subscription) : json([{ model_id: 'scribe_v2', raw_secret: 'must-not-return' }]));
    const result = await provider.transcriptionAccountDiagnostics(); expect(result.usable).toBe(true); expect(result.price.rate_usd_per_hour).toBe(.22);
    expect(JSON.stringify(result)).not.toContain('must-not-return'); expect(JSON.stringify(result)).not.toContain('fixture-');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://api.elevenlabs.io/v1/user/subscription', 'https://api.elevenlabs.io/v1/models']);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
  it('reports missing subscription permission per call and blocks activation with exhausted credits or inactive subscription', async () => {
    fetcher.mockImplementation(async input => String(input).endsWith('/subscription') ? json({}, 403) : json([{ model_id: 'scribe_v2' }]));
    expect(await provider.transcriptionAccountDiagnostics()).toMatchObject({ usable: false, subscription: { status: 'missing_permission' }, models: { status: 'available' } });
    for (const [sub, models] of [[{ ...subscription, character_count: 20000 }, [{ model_id: 'scribe_v2' }]], [{ ...subscription, status: 'past_due' }, [{ model_id: 'scribe_v1' }]]] as const) {
      fetcher.mockImplementation(async input => String(input).endsWith('/subscription') ? json(sub) : json(models));
      expect((await worker.transcriptionInternalHandler(internal('enable_pilot'))).status).toBe(409);
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('worker_transcription_activate'))).toBe(false);
    }
  });
  it('accepts free-account quota with optional catalog denied/unconfirmed and parses only exact USD overage', async () => {
    for (const catalog of [json({}, 401), json({}, 403), json([{ model_id: 'eleven_multilingual_v2' }])]) {
      fetcher.mockImplementation(async input => String(input).endsWith('/subscription') ? json({ ...subscription, status: 'free', current_overage: { amount: '1.25', currency: 'usd' } }) : catalog);
      const result = await provider.transcriptionAccountDiagnostics(); expect(result.usable).toBe(true); expect(result.models.scribe_v2_catalog_confirmed).toBe(false); expect(result.subscription.current_overage_usd).toBe(1.25);
    }
    fetcher.mockImplementation(async input => String(input).endsWith('/subscription') ? json({ ...subscription, current_overage: { amount: '123', currency: 'eur' } }) : json([]));
    expect((await provider.transcriptionAccountDiagnostics()).subscription.current_overage_usd).toBeNull();
  });
  it('validates public reservation price, configures disabled then activates without starting providers', async () => {
    fetcher.mockImplementation(async input => { const url = String(input); if (url.endsWith('/subscription')) return json(subscription); if (url.endsWith('/models')) return json([{ model_id: 'scribe_v2' }]); if (url.endsWith('/worker_transcription_activate')) return json({ ...config, raw_secret: 'must-not-return' }); return json({}); });
    const result = await worker.transcriptionInternalHandler(internal('enable_pilot')); expect(result.status).toBe(200); expect(await result.text()).not.toContain('must-not-return');
    const calls = fetcher.mock.calls.map(([url]) => String(url).split('/').pop()); expect(calls).toEqual(['subscription', 'models', 'worker_transcription_validate_account', 'worker_transcription_configure', 'worker_transcription_activate']);
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toMatchObject({ p_key_validated: true, p_enabled: false, p_contract_validated: true });
  });
  it('denies all new operator actions to derived maintenance credentials before IO', async () => {
    const secret = await worker.maintenanceSecret();
    for (const action of ['enable_pilot', 'media_refresh', 'source_refresh', 'account_diagnostics', 'verify_pilot', 'enable_automatic']) expect((await worker.transcriptionInternalHandler(internal(action, {}, secret))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('targeted media refresh and bounded maintenance', () => {
  it('allows a full source refresh for a different owned competitor without widening the pilot', async () => {
    apifyEnvironment();
    fetcher.mockImplementation(async input => {
      const url = String(input);
      if (url.includes('workspace_creators?')) return json([{ creators: { id: ids.attempt, username: 'another.creator' }, workspaces: { owner_user_id: ids.reel } }]);
      if (url.endsWith('/worker_transcription_config')) return json({ ...config, phase: 'automatic' });
      if (url.endsWith('/worker_transcription_source_refresh_enqueue')) return json({ job_id: null, target_count: 0, reason: 'creator_busy' });
      throw new Error('Unexpected owned source refresh request');
    });
    expect(await media.refreshTranscriptMedia(ids.attempt, false, true)).toEqual({ status: 'creator_busy', target_count: 0 });
    await expect(media.refreshTranscriptMedia(ids.attempt, false, false)).rejects.toThrow('Media creator not authorized');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/worker_transcription_source_refresh_enqueue'))).toHaveLength(1);
  });
  it('requires operator authorization for a source repair and uses only the source repair enqueue contract', async () => {
    apifyEnvironment();
    fetcher.mockImplementation(async input => {
      const url = String(input);
      if (url.includes('workspace_creators?')) return json([{ creators: { id: '0e4e0fb0-4b78-483c-b9a2-d95051838726', username: 'harshpanwar.ai' }, workspaces: { owner_user_id: ids.reel } }]);
      if (url.endsWith('/worker_transcription_config')) return json({ ...config, phase: 'automatic' });
      if (url.endsWith('/worker_transcription_source_refresh_enqueue')) return json({ job_id: null, target_count: 0, reason: 'budget_paused' });
      throw new Error('Unexpected source repair request');
    });
    expect(await media.refreshTranscriptMedia('0e4e0fb0-4b78-483c-b9a2-d95051838726', false, true)).toEqual({ status: 'budget_paused', target_count: 0 });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/worker_transcription_media_enqueue'))).toBe(false);
    fetcher.mockClear(); await expect(media.refreshTranscriptMedia(ids.attempt, true, true)).rejects.toThrow('Source repair requires an operator'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates authoritative usage and uses the monthly reservation above .01 for the exact linked job', async () => {
    apifyEnvironment(); apifyFixture(); expect(await media.dispatchMediaJob(ids.job)).toEqual({ job_id: ids.job, status: 'running' });
    const calls = fetcher.mock.calls.map(([url]) => String(url)); expect(calls[0]).toContain('/worker_accounts');
    expect(calls.indexOf('https://api.apify.com/v2/users/me')).toBeLessThan(calls.findIndex(url => url.endsWith('/worker_record_usage')));
    const claimCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/worker_transcription_media_claim'))!;
    expect(JSON.parse(String(claimCall[1]?.body))).toEqual({ p_job_id: ids.job, p_actor_id: 'actor_123' });
    expect(calls.findIndex(url => url.endsWith('/worker_record_usage'))).toBeLessThan(calls.findIndex(url => url.endsWith('/worker_transcription_media_claim')));
    expect(new URL(calls.find(url => url.includes('/actors/'))!).searchParams.get('maxTotalChargeUsd')).toBe('0.5');
    expect(calls.some(url => url.endsWith('/worker_claim_next') || url.includes('/scrape_jobs?'))).toBe(false);
  });
  it('never retries Apify 429, retains uncertain hold, and refuses unapproved creator input', async () => {
    apifyEnvironment(); apifyFixture(true); expect(await media.dispatchMediaJob(ids.job)).toEqual({ job_id: ids.job, status: 'uncertain' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/actors/'))).toHaveLength(1); expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('worker_dispatch_failure');
    fetcher.mockClear(); fetcher.mockImplementation(async input => String(input).includes('workspace_creators?') ? json([{ creators: { id: ids.attempt, username: 'other-creator' }, workspaces: { owner_user_id: ids.reel } }]) : json(config));
    await expect(media.refreshTranscriptMedia(ids.attempt)).rejects.toThrow('Media creator not authorized');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('media_enqueue'))).toBe(false);
  });
  it('does not invent pilot recovery and bounds linked reconciliation to two', async () => {
    apifyEnvironment(); fetcher.mockImplementation(async input => String(input).endsWith('/worker_transcription_media_jobs') ? json({ jobs: [] }) : json(config));
    expect(await media.maintainTranscriptMedia(true)).toEqual([]); expect(fetcher.mock.calls.some(([url]) => String(url).includes('media_candidates'))).toBe(false);
    fetcher.mockClear(); fetcher.mockImplementation(async input => String(input).endsWith('/worker_transcription_media_jobs') ? json({ jobs: Array.from({ length: 4 }, () => ({ id: ids.job, creator_id: ids.attempt, status: 'uncertain', actor_run_id: null })) }) : json({}));
    expect(await media.maintainTranscriptMedia(false)).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
