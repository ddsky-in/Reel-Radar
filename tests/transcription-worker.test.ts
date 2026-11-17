import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { mp4Fixture } from './mp4-fixture';

// Edge modules use Deno globals; Vitest supplies an isolated Node shim and never real environment secrets.
// Nonliteral dynamic imports keep the frontend TypeScript project independent of Deno entrypoints.
const model = await import('../supabase/functions/_shared/model.ts' as string);
const transcription = await import('../supabase/functions/_shared/transcription-model.ts' as string);
const provider = await import('../supabase/functions/_shared/transcription-provider.ts' as string);
const db = await import('../supabase/functions/_shared/transcription-db.ts' as string);
const worker = await import('../supabase/functions/_shared/transcription-worker.ts' as string);
const apify = await import('../supabase/functions/_shared/providers.ts' as string);
const ids = {
  job: '11111111-1111-4111-8111-111111111111', reel: '22222222-2222-4222-8222-222222222222',
  attempt: '33333333-3333-4333-8333-333333333333', nonce: '44444444-4444-4444-8444-444444444444',
};
const source = 'https://scontent.cdninstagram.com/video.mp4?token=untrusted-cdn-value';
const job = { id: ids.job, reel_id: ids.reel, attempt_id: ids.attempt, lease_token: ids.nonce, source_url: source, candidates: [source],
  has_audio: null, duration_seconds: 12, model: 'scribe_v2', options_version: 1, reservation_usd: .08, max_duration_seconds: 180, max_media_bytes: 26214400 };
const attempt: typeof job & { provider_job_id: string | null; provider_transcription_id: string | null; status: string } = { ...job, provider_job_id: 'req_123', provider_transcription_id: 'transcript_456', status: 'submitted' };
const config = { enabled: true, paused: false, key_validated: true, contract_validated: true, phase: 'pilot' };
const transcript = { text: 'Hello world', language_code: 'eng', language_probability: .98, audio_duration_secs: 12, transcription_id: 'transcript_456',
  words: [{ text: 'Hello', type: 'word', start: 0, end: .5 }, { text: ' ', type: 'spacing', start: .5, end: .5 }, { text: 'world', type: 'word', start: .6, end: 1 }] };
let values: Record<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function media() { return new Response(new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]), { headers: { 'content-type': 'video/mp4' } }); }
function internal(action = 'dispatch', secret = 'fixture-internal-secret') {
  return new Request('https://project.supabase.co/functions/v1/transcript-dispatch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret }, body: JSON.stringify({ action }) });
}
function event(failed = false) {
  const metadata = { job_id: ids.job, attempt_id: ids.attempt, nonce: ids.nonce };
  return failed ? { type: 'webhook_error', request_id: 'req_123', error_message: 'secret-provider-error', webhook_metadata: metadata } :
    { type: 'speech_to_text_transcription', data: { request_id: 'req_123', webhook_metadata: metadata, transcription: transcript } };
}
async function signed(payload: unknown, timestamp = Math.floor(Date.now() / 1000), suppliedBody?: string) {
  const body = suppliedBody ?? JSON.stringify(payload), bytes = new TextEncoder().encode(`${timestamp}.${body}`);
  const signature = await transcription.hmacHex('fixture-hmac-secret', bytes);
  return new Request('https://project.supabase.co/functions/v1/elevenlabs-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'elevenlabs-signature': `t=${timestamp},v0=${signature}` }, body });
}
function callbackMocks(context = attempt) {
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/worker_transcription_callback_context')) return json({ job: context });
    if (url.endsWith('/worker_transcription_attach') || url.endsWith('/worker_transcription_complete') || url.endsWith('/worker_transcription_fail') || url.endsWith('/worker_transcription_provider_failure')) return json({ status: 'completed', duplicate: false });
    throw new Error('Unexpected fixture network request');
  });
}
beforeEach(() => {
  values = { ENVIRONMENT: 'test', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-secret',
    INTERNAL_CRON_SECRET: 'fixture-internal-secret', ELEVENLABS_API_KEY: 'fixture-api-secret', ELEVENLABS_WEBHOOK_ID: 'fixture-webhook-id', ELEVENLABS_WEBHOOK_SECRET: 'fixture-hmac-secret',
    TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER_VALIDATED: 'true' };
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] }, serve: vi.fn() });
  vi.stubGlobal('crypto', webcrypto);
  fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network forbidden outside explicit test fixture'));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('verified media normalization and SSRF boundaries', () => {
  it('uses the database reservation as the provider cap, including amounts above the old fixed cap', async () => {
    Object.assign(values, { PROVIDER_MODE: 'apify', APIFY_API_TOKEN: 'fixture', APIFY_ACCOUNT_ID: 'account',
      APIFY_REEL_ACTOR_RESOURCE_ID: 'actor', APIFY_WEBHOOK_SHARED_SECRET: 'fixture', SCRAPING_ENABLED: 'true',
      PROVIDER_VALIDATED: 'true', RUN_CHARGE_CAP_VALIDATED: 'true', ACCOUNT_USAGE_VALIDATED: 'true' });
    const context = { job: { id: ids.job, dispatch_nonce: ids.nonce, kind: 'backfill', results_limit: 100,
      reserved_usd: '2.500000', expected_actor_id: 'actor', expected_provider_user_id: 'account' },
      creators: [{ id: ids.reel, username: 'creator' }] };
    fetcher.mockImplementation(async input => String(input).endsWith('/users/me') ? json({ data: { id: 'account' } })
      : json({ data: { id: 'run', actId: 'actor', userId: 'account', status: 'RUNNING' } }));
    values.SUPABASE_URL = 'https://fixture.supabase.co';
    await new apify.ApifyReels().start(context, 2.5, async () => true);
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('maxTotalChargeUsd')).toBe('2.5');
    for (const cap of [0, -1, NaN, Infinity, .1, 2.6, 10001]) await expect(new apify.ApifyReels().start(context, cap)).rejects.toThrow(/reserved maximum/);
    await expect(new apify.ApifyReels().start({ ...context, job: { ...context.job, reserved_usd: undefined } }, 2.5)).rejects.toThrow(/reserved maximum/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('accepts only exact HTTPS Instagram CDN subdomains', () => {
    expect(model.instagramMediaUrl(source)).toBe(source);
    expect(model.instagramMediaUrl('https://video.xx.fbcdn.net/a.mp4')).toBe('https://video.xx.fbcdn.net/a.mp4');
    for (const url of ['http://scontent.cdninstagram.com/a', 'https://cdninstagram.com/a', 'https://fbcdn.net/a', 'https://evilcdninstagram.com/a',
      'https://scontent.cdninstagram.com.evil.test/a', 'https://user:pass@scontent.cdninstagram.com/a', 'https://scontent.cdninstagram.com:443/a',
      'https://scontent.cdninstagram.com:8443/a', 'https://127.0.0.1/a', 'https://169.254.169.254/a', 'https://[::1]/a', 'https://localhost/a',
      'https://scontent.cdninstagram.com./a', 'https://scontent.cdninstagram.com/a#redirect', ' https://scontent.cdninstagram.com/a', 'https://scontent.cdninstagram.com\\@evil.test/a']) {
      expect(model.instagramMediaUrl(url), url).toBeNull();
    }
  });
  it('reads only verified videoUrl/videoVersions.url and keeps unknown audio null', () => {
    const row = { videoUrl: 'https://evil.test/video', videoVersions: [{ url: source }, { url: source }, { url: 'https://video.xx.fbcdn.net/other' }], displayUrl: source, url: source };
    expect(model.reelMedia(row, 'apify:esdrasdw/instagram-reels-scrapy-low-cost')).toEqual({ media_source_url: source, media_candidates: [source, 'https://video.xx.fbcdn.net/other'], has_audio: null });
    expect(model.reelMedia({ ...row, hasAudio: false }, 'apify:esdrasdw/instagram-reels-scrapy-low-cost').has_audio).toBe(false);
    expect(model.reelMedia({ ...row, hasAudio: 'false' }, 'apify:esdrasdw/instagram-reels-scrapy-low-cost').has_audio).toBeNull();
    expect(model.reelMedia(row, 'mock:synthetic')).toEqual({ media_source_url: null, media_candidates: [], has_audio: null });
    expect(model.reelMedia({ displayUrl: source }, 'apify:esdrasdw/instagram-reels-scrapy-low-cost').media_source_url).toBeNull();
  });
  it('requests the complete Actor payload and includes pinned Reels in full imports', () => {
    values.APIFY_REEL_ACTOR_RESOURCE_ID = 'fixture-actor';
    const context = { job: { results_limit: 10 }, creators: [{ id: ids.reel, username: 'creator' }] };
    const adapter = new apify.ApifyReels();
    expect(adapter.input(context).selectedFields).toEqual([]);
    expect(adapter.input({ ...context, job: { results_limit: 100, kind: 'backfill' } }).skipPinnedPosts).toBe(false);
    expect(adapter.input({ ...context, job: { results_limit: 100, kind: 'manual' } }).skipPinnedPosts).toBe(false);
    expect(adapter.input({ ...context, job: { results_limit: 10, kind: 'daily' } }).skipPinnedPosts).toBe(true);
    values.PROVIDER_MODE = 'mock'; values.SUPABASE_URL = 'https://project.supabase.co';
    expect(() => apify.liveMode()).toThrow();
  });
  it('fully probes bounded media without sending secrets or following redirects', async () => {
    fetcher.mockResolvedValue(media());
    await expect(provider.accessibleMedia(job)).resolves.toBe(source);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('fixture-api-secret');
  });
  it('chooses one verified candidate when primary source is absent without retry', async () => {
    fetcher.mockResolvedValue(media());
    const fallback = { ...job, source_url: null, candidates: ['https://evil.test/invalid', source] };
    await expect(provider.accessibleMedia(fallback)).resolves.toBe(source);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects redirect responses, huge declared length, HTML and invalid media before paid work', async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }), new Response('x', { headers: { 'content-type': 'video/mp4', 'content-length': '26214401' } }),
      new Response('<html>access denied</html>', { headers: { 'content-type': 'video/mp4' } }), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(provider.accessibleMedia(job)).rejects.toThrow('Media unavailable');
    }
    const before = fetcher.mock.calls.length;
    for (const patch of [{ has_audio: false }, { duration_seconds: null }, { duration_seconds: 181 }, { source_url: 'https://evil.test/x', candidates: [] }, { max_media_bytes: 26214401 }]) await expect(provider.accessibleMedia({ ...job, ...patch })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
  it('bounds streaming bytes, not attacker-declared Content-Length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16)); controller.enqueue(new Uint8Array(17)); }, cancel });
    fetcher.mockResolvedValue(new Response(stream, { headers: { 'content-type': 'video/mp4', 'content-length': '1' } }));
    await expect(provider.accessibleMedia({ ...job, max_media_bytes: 32 })).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });
});

describe('transcript text and faithful word timing normalization', () => {
  it('keeps text language and millisecond word timestamps, discarding extra provider output', () => {
    const result = transcription.normalizeTranscript({ ...transcript, edited_transcript: 'secret unwanted edit', actual_cost_usd: 999 });
    expect(result).toEqual({ text: 'Hello world', language: 'eng', no_speech: false, transcription_id: 'transcript_456', segments: [{ text: 'Hello', start_ms: 0, end_ms: 500 }, { text: 'world', start_ms: 600, end_ms: 1000 }] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('preserves the original transcript text rather than trimming provider output', () => {
    expect(transcription.normalizeTranscript({ ...transcript, text: '  Hello world\n' }).text).toBe('  Hello world\n');
  });
  it('retains valid text with missing, invalid, overlapping, or absent timing without guessing SRT', () => {
    for (const words of [[], [{ text: 'Hello', type: 'word' }], [{ text: 'Hello', type: 'word', start: null, end: null }], [{ text: 'Hello', type: 'word', start: -1, end: 1 }],
      [{ text: 'Hello', type: 'word', start: 0, end: 1 }, { text: 'world', type: 'word', start: .5, end: 2 }], [{ text: 'Hello', type: 'word', start: 0, end: 181 }]]) {
      expect(transcription.normalizeTranscript({ ...transcript, words })).toMatchObject({ text: 'Hello world', no_speech: false, segments: [] });
    }
  });
  it('recognizes no speech but never converts missing transcription to empty success', () => {
    expect(transcription.normalizeTranscript({ ...transcript, text: '', words: [] })).toMatchObject({ no_speech: true, text: '', segments: [] });
    expect(transcription.normalizeTranscript({ ...transcript, text: '', words: [{ text: '[music]', type: 'audio_event' }] }).no_speech).toBe(true);
    for (const invalid of [null, {}, { ...transcript, text: null }, { ...transcript, words: null }, { ...transcript, audio_duration_secs: 181 }, { ...transcript, language_probability: 2 }, { ...transcript, transcripts: [] }]) expect(() => transcription.normalizeTranscript(invalid)).toThrow();
  });
  it('parses exact success and top-level failure envelopes with strict metadata identity', () => {
    expect(transcription.normalizeEvent(event()).failed).toBe(false);
    expect(transcription.normalizeEvent(event(true))).toMatchObject({ failed: true, request_id: 'req_123', transcription: null });
    expect(() => transcription.normalizeEvent({ type: 'webhook_error', data: event(true) })).toThrow();
    const invalid = event();
    if ('data' in invalid && invalid.data) invalid.data.webhook_metadata.nonce = 'not-a-uuid';
    expect(() => transcription.normalizeEvent(invalid)).toThrow();
  });
});

describe('raw HMAC authentication, replay fencing and callback identity', () => {
  it('verifies exact raw UTF-8 bytes rather than parsed/reserialized JSON', async () => {
    const request = await signed({}, undefined, '{ "text": "héllo" }');
    const bytes = new Uint8Array(await request.arrayBuffer());
    await expect(transcription.verifyWebhook(bytes, request.headers.get('elevenlabs-signature'), values.ELEVENLABS_WEBHOOK_SECRET)).resolves.toBe(true);
    await expect(transcription.verifyWebhook(new TextEncoder().encode('{"text":"héllo"}'), request.headers.get('elevenlabs-signature'), values.ELEVENLABS_WEBHOOK_SECRET)).resolves.toBe(false);
  });
  it('rejects missing, forged, old, future and duplicate-scheme signatures before DB', async () => {
    // Keep the one-second boundary invalid even on a heavily loaded test worker.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const now = Math.floor(Date.now() / 1000);
    const unsigned = new Request('https://project.supabase.co/callback', { method: 'POST', headers: { 'x-internal-secret': values.INTERNAL_CRON_SECRET }, body: '{}' });
    const forged = new Request('https://project.supabase.co/callback', { method: 'POST', headers: { 'elevenlabs-signature': `t=${now},v0=${'0'.repeat(64)}` }, body: '{}' });
    for (const request of [unsigned, forged, await signed(event(), now - 1801), await signed(event(), now + 61)]) {
      expect((await worker.transcriptionWebhookHandler(request)).status).toBe(401);
    }
    expect(transcription.signatureParts(`t=${now},t=${now},v0=${'a'.repeat(64)}`)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds callback streaming at 1MiB and rejects unauthenticated malformed JSON without parsing', async () => {
    const request = await signed({}, undefined, 'x'.repeat(1048577));
    expect((await worker.transcriptionWebhookHandler(request)).status).toBe(401);
    const malformed = new Request('https://project.supabase.co/callback', { method: 'POST', body: 'not-json' });
    expect((await worker.transcriptionWebhookHandler(malformed)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates job, attempt, nonce and provider request independently after HMAC', async () => {
    for (const patch of [{ id: ids.reel }, { attempt_id: ids.reel }, { lease_token: ids.reel }, { provider_job_id: 'wrong_request' }, { provider_transcription_id: 'wrong_transcript' }, { model: 'scribe_v1' }]) {
      fetcher.mockClear(); callbackMocks({ ...attempt, ...patch });
      expect((await worker.transcriptionWebhookHandler(await signed(event()))).status).toBe(409);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('accepts early callback and normalizes words using fenced nonce; duplicates are DB-idempotent', async () => {
    callbackMocks({ ...attempt, provider_job_id: null, provider_transcription_id: null });
    const request = await signed(event());
    expect((await worker.transcriptionWebhookHandler(request)).status).toBe(200);
    expect((await worker.transcriptionWebhookHandler(await signed(event()))).status).toBe(200);
    const completeCall = fetcher.mock.calls.find(([input]) => String(input).endsWith('/worker_transcription_complete'));
    expect(JSON.parse(String(completeCall?.[1]?.body))).toMatchObject({ p_attempt_id: ids.attempt, p_lease_token: ids.nonce, p_text: 'Hello world', p_segments: [{ text: 'Hello', start_ms: 0, end_ms: 500 }, { text: 'world', start_ms: 600, end_ms: 1000 }] });
    expect(JSON.parse(String(completeCall?.[1]?.body))).not.toHaveProperty('p_actual_cost_usd');
  });
  it('late callback completes the same uncertain attempt without a new paid POST', async () => {
    callbackMocks({ ...attempt, status: 'uncertain', provider_job_id: null, provider_transcription_id: null });
    expect((await worker.transcriptionWebhookHandler(await signed(event()))).status).toBe(200);
    expect(fetcher.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['worker_transcription_callback_context', 'worker_transcription_attach', 'worker_transcription_complete']);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('api.elevenlabs.io'))).toBe(false);
  });
  it('signed failure uses attached request identity and never stores arbitrary provider errors', async () => {
    callbackMocks();
    const response = await worker.transcriptionWebhookHandler(await signed(event(true)));
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('secret-provider-error');
    const failCall = fetcher.mock.calls.find(([input]) => String(input).endsWith('/worker_transcription_provider_failure'));
    expect(JSON.parse(String(failCall?.[1]?.body))).toEqual({ p_attempt_id: ids.attempt, p_lease_token: ids.nonce, p_provider_job_id: 'req_123' });
    expect(String(failCall?.[1]?.body)).not.toContain('secret-provider-error');
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/worker_transcription_fail'))).toBe(false);
  });
  it('signed failure after uncertain acceptance uses the same attempt without a paid retry', async () => {
    callbackMocks({ ...attempt, status: 'uncertain', provider_job_id: null, provider_transcription_id: null });
    expect((await worker.transcriptionWebhookHandler(await signed(event(true)))).status).toBe(200);
    expect(fetcher.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['worker_transcription_callback_context', 'worker_transcription_attach', 'worker_transcription_provider_failure']);
  });
});

describe('async provider nonretry and independent guarded transport', () => {
  it('uses minimal asynchronous scribe_v2 source_url and stores dual identifiers', async () => {
    fetcher.mockResolvedValue(json({ message: 'accepted', request_id: 'req_123', transcription_id: 'transcript_456' }));
    expect(await provider.submitTranscription(job, source)).toEqual({ request_id: 'req_123', transcription_id: 'transcript_456' });
    const [url, options] = fetcher.mock.calls[0]; expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    const form = options?.body as FormData;
    expect(Object.fromEntries(form.entries())).toEqual({ model_id: 'scribe_v2', source_url: source, webhook: 'true', webhook_id: 'fixture-webhook-id',
      webhook_metadata: JSON.stringify({ job_id: ids.job, attempt_id: ids.attempt, nonce: ids.nonce }), timestamps_granularity: 'word', diarize: 'false', tag_audio_events: 'false', use_multi_channel: 'false' });
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'xi-api-key': 'fixture-api-secret' } });
  });
  it('does not retry timeouts, 429, 500, malformed success, or missing request identity', async () => {
    for (const result of [new Error('fixture-api-secret timeout'), json({}, 429), json({}, 500), json({ message: 'accepted' }), new Response('not-json')]) {
      fetcher.mockReset();
      if (result instanceof Error) fetcher.mockRejectedValue(result); else fetcher.mockResolvedValue(result);
      await expect(provider.submitTranscription(job, source)).rejects.toThrow('Transcription acceptance uncertain');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('defaults gates to false and requires key, webhook identity and own HMAC secret', async () => {
    for (const name of ['TRANSCRIPTION_ENABLED', 'TRANSCRIPTION_PROVIDER_VALIDATED', 'ELEVENLABS_API_KEY', 'ELEVENLABS_WEBHOOK_ID', 'ELEVENLABS_WEBHOOK_SECRET']) {
      const old = values[name]; delete values[name];
      expect(provider.transcriptionCanDispatch(config)).toBe(false);
      await expect(provider.submitTranscription(job, source)).rejects.toThrow(); values[name] = old;
    }
    for (const patch of [{ enabled: false }, { paused: true }, { key_validated: false }, { contract_validated: false }]) expect(provider.transcriptionCanDispatch({ ...config, ...patch })).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('database transport works without any Apify mode but forbids hosted mocks', async () => {
    fetcher.mockResolvedValue(json(config));
    await expect(db.transcriptionRpc('worker_transcription_config')).resolves.toEqual(config);
    expect(values.PROVIDER_MODE).toBeUndefined();
    values.PROVIDER_MODE = 'mock'; values.SUPABASE_URL = 'https://project.supabase.co';
    fetcher.mockClear(); await expect(db.transcriptionRpc('worker_transcription_config')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('claims reservations before media and paid POST and retains uncertainty', async () => {
    fetcher.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/worker_transcription_config')) return json(config);
      if (url.endsWith('/worker_transcription_claim')) return json({ jobs: [job] });
      if (url === source) return new Response(mp4Fixture().slice().buffer, { headers: { 'content-type': 'video/mp4' } });
      if (url.endsWith('/worker_transcription_before_submit')) return json({ allow: true });
      if (url.endsWith('/worker_transcription_select_media')) return json({ selected: true });
      if (url === 'https://api.elevenlabs.io/v1/speech-to-text') throw new Error('fixture-api-secret timeout');
      if (url.endsWith('/worker_transcription_fail')) return json({ status: 'uncertain' });
      throw new Error('Unexpected fixture request');
    });
    expect(await worker.dispatchTranscripts()).toEqual([{ job_id: ids.job, status: 'uncertain' }]);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls.map(url => url.split('/').pop())).toEqual(['worker_transcription_config', 'worker_transcription_claim', 'video.mp4?token=untrusted-cdn-value', 'worker_transcription_select_media', 'worker_transcription_before_submit', 'speech-to-text', 'worker_transcription_fail']);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ p_limit: 1 });
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ p_status: 'uncertain' });
    expect(JSON.stringify(fetcher.mock.calls.at(-1)?.[1]?.body)).not.toContain('fixture-api-secret');
  });
  it('media failure never starts paid work or invents an actual bill', async () => {
    fetcher.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/worker_transcription_config')) return json(config);
      if (url.endsWith('/worker_transcription_claim')) return json({ jobs: [{ ...job, has_audio: false }] });
      if (url.endsWith('/worker_transcription_fail')) return json({ status: 'media_unavailable' });
      throw new Error('Unexpected fixture request');
    });
    expect(await worker.dispatchTranscripts()).toEqual([{ job_id: ids.job, status: 'media_unavailable' }]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === source)).toHaveLength(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('api.elevenlabs.io'))).toBe(false);
    expect(String(fetcher.mock.calls.at(-1)?.[1]?.body)).not.toContain('cost');
  });
  it('GET uses documented transcription_id only and never treats 404 as not_started', async () => {
    fetcher.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/worker_transcription_candidates')) return json({ jobs: [attempt] });
      if (url.endsWith('/worker_transcription_callback_context')) return json({ job: attempt });
      if (url.endsWith('/transcripts/transcript_456')) return json({}, 404);
      throw new Error('Unexpected fixture request');
    });
    expect(await worker.reconcileTranscripts()).toEqual([{ job_id: ids.job, status: 'unresolved' }]);
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('req_123'))).toBe(false);
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/worker_transcription_reconcile'))).toBe(false);
  });
  it('missing optional transcription_id leaves uncertain state without guessed polling', async () => {
    fetcher.mockImplementation(async input => {
      if (String(input).endsWith('/worker_transcription_candidates')) return json({ jobs: [{ ...attempt, provider_transcription_id: null }] });
      if (String(input).endsWith('/worker_transcription_callback_context')) return json({ job: { ...attempt, provider_transcription_id: null } });
      throw new Error('Unexpected fixture request');
    });
    expect(await worker.reconcileTranscripts()).toEqual([{ job_id: ids.job, status: 'unresolved' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('endpoint authentication, scheduler separation and secret-free responses', () => {
  it('all entrypoints reject unauthenticated requests before DB or provider', async () => {
    const dispatch = await import('../supabase/functions/transcript-dispatch/index.ts' as string);
    const reconcile = await import('../supabase/functions/transcript-reconcile/index.ts' as string);
    const webhook = await import('../supabase/functions/elevenlabs-webhook/index.ts' as string);
    for (const handler of [dispatch.handler, reconcile.handler, webhook.handler]) expect((await handler(new Request('https://project.supabase.co/endpoint', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('derives a separate scheduler secret; it cannot configure or install schedules', async () => {
    const secret = await worker.maintenanceSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/); expect(secret).not.toBe(values.INTERNAL_CRON_SECRET);
    expect(await worker.authenticateTranscriptionInternal(internal('maintenance', secret))).toBe('maintenance');
    for (const action of ['configure', 'install_schedule']) expect((await worker.transcriptionInternalHandler(internal(action, secret))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const callback = internal('maintenance', secret);
    expect((await worker.transcriptionWebhookHandler(callback)).status).toBe(401);
  });
  it('returns safe diagnostics without key and without database writes', async () => {
    delete values.ELEVENLABS_API_KEY; values.TRANSCRIPTION_ENABLED = 'false';
    fetcher.mockResolvedValue(json({ ...config, enabled: false, key_validated: false, ELEVENLABS_API_KEY: 'secret-should-not-leak' }));
    const response = await worker.transcriptionInternalHandler(internal('diagnostics'));
    expect(response.status).toBe(200);
    const data = await response.text();
    expect(data).toContain('"key_configured":false'); expect(data).not.toContain('secret-should-not-leak');
    for (const value of Object.values(values).filter(value => value.startsWith('fixture-'))) expect(data).not.toContain(value);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0][0])).toContain('worker_transcription_config');
  });
  it('base-only schedule installation stores derived secret but never returns it', async () => {
    fetcher.mockResolvedValue(json({ installed: true, secret: 'malicious-db-extra' }));
    const response = await worker.transcriptionInternalHandler(internal('install_schedule'));
    expect(await response.json()).toEqual({ installed: true });
    const args = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(args).toEqual({ p_secret: await worker.maintenanceSecret() });
    expect(args.p_secret).not.toBe(values.INTERNAL_CRON_SECRET);
  });
  it('never reflects environment keys, network errors or database payloads on failure', async () => {
    fetcher.mockRejectedValue(new Error('fixture-api-secret fixture-service-secret raw-secret-payload'));
    const response = await worker.transcriptionInternalHandler(internal());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"transcription_blocked_or_unavailable"}');
  });
});
