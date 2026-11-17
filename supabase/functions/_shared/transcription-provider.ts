import { instagramMediaUrl, object } from './model.ts';
import { boundedBytes, decodeJson, MAX_CALLBACK_BYTES, MAX_DURATION_SECONDS, MAX_MEDIA_BYTES, normalizeTranscript, providerId, TRANSCRIPTION_MODEL, uuid } from './transcription-model.ts';
import type { TranscriptConfig, TranscriptJob, TranscriptResult, ValidatedTranscriptMedia } from './transcription-model.ts';
import { mediaCandidates, mp4Duration } from './transcription-media.ts';
import { transcriptionEnv, transcriptionRequired } from './transcription-db.ts';
import { environmentWebhookCredentials, resolveWebhookCredentials } from './transcription-setup.ts';
import type { WebhookCredentials } from './transcription-setup.ts';

export function validateTranscriptionSetup(webhook: WebhookCredentials | null = environmentWebhookCredentials()): void {
  if (transcriptionEnv('TRANSCRIPTION_ENABLED') !== 'true' || transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') !== 'true') throw new Error('Transcription disabled or unvalidated');
  transcriptionRequired('ELEVENLABS_API_KEY');
  if (!webhook) throw new Error('Transcription webhook configuration missing');
  if (transcriptionEnv('PROVIDER_MODE') === 'mock') throw new Error('No live transcription from mock runtime');
}
export function transcriptionCanDispatch(config: TranscriptConfig, webhook: WebhookCredentials | null = environmentWebhookCredentials()): boolean {
  try { validateTranscriptionSetup(webhook); return config.enabled === true && config.paused === false && config.key_validated === true && config.contract_validated === true; } catch { return false; }
}
export function selectedMedia(job: TranscriptJob): string | null {
  const direct = instagramMediaUrl(job.source_url);
  if (direct) return direct;
  if (!Array.isArray(job.candidates)) return null;
  return job.candidates.slice(0, 4).map(instagramMediaUrl).find((url): url is string => url !== null) ?? null;
}
export async function accessibleMedia(job: TranscriptJob): Promise<string> {
  if (!uuid(job.id) || !uuid(job.attempt_id) || !uuid(job.lease_token) || job.model !== TRANSCRIPTION_MODEL || job.options_version !== 1 ||
      job.has_audio === false || !Number.isFinite(job.duration_seconds) || Number(job.duration_seconds) <= 0 || Number(job.duration_seconds) > MAX_DURATION_SECONDS ||
      !Number.isFinite(job.max_duration_seconds) || job.max_duration_seconds <= 0 || job.max_duration_seconds > MAX_DURATION_SECONDS || Number(job.duration_seconds) > job.max_duration_seconds ||
      !Number.isSafeInteger(job.max_media_bytes) || job.max_media_bytes <= 0 || job.max_media_bytes > MAX_MEDIA_BYTES || !Number.isFinite(job.reservation_usd) || job.reservation_usd <= 0) throw new Error('Media unavailable');
  // One exact, already-allowlisted provider URL. No redirect, arbitrary fallback, or paid recovery.
  const url = selectedMedia(job);
  if (!url) throw new Error('Media unavailable');
  const signal = AbortSignal.timeout(15000);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const declared = response.headers.get('content-length');
    if (!response.ok || response.redirected || (response.url && response.url !== url) || !['video/mp4', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'video/webm', 'audio/webm', 'application/octet-stream'].includes(type ?? '') ||
        (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > job.max_media_bytes))) { await response.body?.cancel(); throw new Error('Media unavailable'); }
    const bytes = await boundedBytes(response.body, job.max_media_bytes, signal);
    // Reject HTML/JSON disguised as binary; recognize conservative supported media magic.
    const magic = bytes.length >= 12 && (new TextDecoder().decode(bytes.subarray(4, 8)) === 'ftyp' ||
      new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WAVE' ||
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ||
      new TextDecoder().decode(bytes.subarray(0, 3)) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    if (!magic) throw new Error('Media unavailable');
    return url;
  } catch { throw new Error('Media unavailable'); }
}
export interface Submission { request_id: string; transcription_id: string | null }
export class TranscriptionSubmissionError extends Error {
  constructor(readonly reason: 'transport' | 'http' | 'response', readonly status: number | null = null) {
    super('Transcription acceptance uncertain');
  }
}
export async function submitTranscription(job: TranscriptJob, sourceUrl: string, resolved?: WebhookCredentials, media?: ValidatedTranscriptMedia): Promise<Submission> {
  const submit = await prepareTranscription(job, sourceUrl, resolved, media);
  return await submit();
}
export async function prepareTranscription(job: TranscriptJob, sourceUrl: string, resolved?: WebhookCredentials, media?: ValidatedTranscriptMedia): Promise<() => Promise<Submission>> {
  // Check paid environment gates before any Vault configuration query.
  if (transcriptionEnv('TRANSCRIPTION_ENABLED') !== 'true' || transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') !== 'true' || !transcriptionEnv('ELEVENLABS_API_KEY') || transcriptionEnv('PROVIDER_MODE') === 'mock') throw new Error('Transcription disabled or unvalidated');
  const webhook = resolved ?? await resolveWebhookCredentials();
  validateTranscriptionSetup(webhook);
  if (instagramMediaUrl(sourceUrl) !== sourceUrl || !(media ? mediaCandidates(job).includes(sourceUrl) : sourceUrl === selectedMedia(job))) throw new Error('Invalid transcription source');
  const form = new FormData();
  form.set('model_id', TRANSCRIPTION_MODEL);
  if (media) {
    if (media.source_url !== sourceUrl || media.content_type !== 'video/mp4' || !(media.bytes instanceof Uint8Array) || media.bytes.length > job.max_media_bytes ||
        mp4Duration(media.bytes) !== media.duration_seconds || media.duration_seconds > job.max_duration_seconds ||
        Math.abs(media.duration_seconds - Number(job.duration_seconds)) > Math.max(1, media.duration_seconds * .05)) throw new Error('Invalid transcription media');
    // Upload the exact validated bytes: no second CDN fetch, expired link, or input substitution.
    const buffer = media.bytes.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Invalid transcription media buffer');
    // Blob copies the exact view once. Do not slice a second full video first,
    // or include unused capacity beyond the bounded reader's returned view.
    form.set('file', new Blob([new Uint8Array(buffer, media.bytes.byteOffset, media.bytes.byteLength)], { type: media.content_type }), 'reel.mp4');
  } else form.set('source_url', sourceUrl);
  form.set('webhook', 'true'); form.set('webhook_id', webhook!.id);
  form.set('webhook_metadata', JSON.stringify({ job_id: job.id, attempt_id: job.attempt_id, nonce: job.lease_token }));
  form.set('timestamps_granularity', 'word'); form.set('diarize', 'false'); form.set('tag_audio_events', 'false'); form.set('use_multi_channel', 'false');
  // language_code omitted means automatic detection. No entities, editing, keyterms or surcharge features.
  // All validation and full-size allocations finish before the worker crosses
  // its paid fence. Preparation itself performs no non-idempotent request.
  return async () => {
  validateTranscriptionSetup(webhook);
  // Every POST error (even 429/5xx/invalid success) is acceptance-uncertain; never blindly retry.
  const signal = AbortSignal.timeout(20000);
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'xi-api-key': transcriptionRequired('ELEVENLABS_API_KEY') }, body: form, signal });
    if (!response.ok) { await response.body?.cancel(); throw new TranscriptionSubmissionError('http', response.status); }
    let row: Record<string, unknown>;
    try { row = object(decodeJson(await boundedBytes(response.body, MAX_CALLBACK_BYTES, signal))); }
    catch { throw new TranscriptionSubmissionError('response', response.status); }
    if (typeof row.message !== 'string' || !providerId(row.request_id) || row.transcription_id != null && !providerId(row.transcription_id)) throw new TranscriptionSubmissionError('response', response.status);
    return { request_id: row.request_id, transcription_id: typeof row.transcription_id === 'string' ? row.transcription_id : null };
  } catch (error) { throw error instanceof TranscriptionSubmissionError ? error : new TranscriptionSubmissionError('transport'); }
  };
}
export interface SubscriptionDiagnostics {
  status: 'available' | 'missing_key' | 'unauthorized' | 'missing_permission' | 'unavailable';
  tier: string | null; subscription_status: string | null; credit_count: number | null; credit_limit: number | null;
  credit_reset_unix: number | null; current_overage_usd: number | null;
}
export interface TranscriptionAccountDiagnostics {
  subscription: SubscriptionDiagnostics;
  models: { status: SubscriptionDiagnostics['status']; scribe_v2_catalog_confirmed: boolean; basis: string };
  usable: boolean; price: { rate_usd_per_hour: number; max_item_reservation_usd: number; source: string; verified_on: string; basis: string };
}
export async function transcriptionAccountDiagnostics(): Promise<TranscriptionAccountDiagnostics> {
  const key = transcriptionEnv('ELEVENLABS_API_KEY');
  async function read(path: string): Promise<{ status: SubscriptionDiagnostics['status']; value?: unknown }> {
    if (!key) return { status: 'missing_key' };
    const signal = AbortSignal.timeout(12000);
    try {
      const response = await fetch(`https://api.elevenlabs.io${path}`, { method: 'GET', redirect: 'error', cache: 'no-store', headers: { 'xi-api-key': key }, signal });
      if (!response.ok) { await response.body?.cancel(); return { status: response.status === 401 ? 'unauthorized' : response.status === 403 ? 'missing_permission' : 'unavailable' }; }
      const bytes = await boundedBytes(response.body, MAX_CALLBACK_BYTES, signal);
      return { status: 'available', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    } catch { return { status: 'unavailable' }; }
  }
  const subscriptionRead = await read('/v1/user/subscription'), modelsRead = await read('/v1/models');
  const subscription: SubscriptionDiagnostics = { status: subscriptionRead.status, tier: null, subscription_status: null, credit_count: null, credit_limit: null, credit_reset_unix: null, current_overage_usd: null };
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
  if (subscriptionRead.status === 'available') {
    try {
      const row = object(subscriptionRead.value);
      subscription.tier = label(row.tier); subscription.subscription_status = label(row.status);
      subscription.credit_count = Number.isSafeInteger(row.character_count) ? finite(row.character_count) : null;
      subscription.credit_limit = Number.isSafeInteger(row.character_limit) ? finite(row.character_limit) : null;
      subscription.credit_reset_unix = Number.isSafeInteger(row.next_character_count_reset_unix) ? finite(row.next_character_count_reset_unix) : null;
      if (row.current_overage && typeof row.current_overage === 'object' && !Array.isArray(row.current_overage)) {
        const overage = object(row.current_overage);
        if (overage.currency === 'usd' && typeof overage.amount === 'string' && /^\d{1,12}(?:\.\d{1,12})?$/.test(overage.amount)) subscription.current_overage_usd = finite(Number(overage.amount));
      }
      if (!subscription.tier || !subscription.subscription_status || subscription.credit_count === null || subscription.credit_limit === null || subscription.credit_reset_unix === null) subscription.status = 'unavailable';
    } catch { subscription.status = 'unavailable'; }
  }
  const models = { status: modelsRead.status, scribe_v2_catalog_confirmed: false, basis: 'optional_generic_catalog_not_stt_permission_evidence' };
  if (models.status === 'available') {
    if (!Array.isArray(modelsRead.value) || modelsRead.value.length > 500) models.status = 'unavailable';
    else models.scribe_v2_catalog_confirmed = modelsRead.value.some(value => value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).model_id === TRANSCRIPTION_MODEL);
  }
  // Public price was inspected on the official API pricing page by the operator on this date.
  // This is conservative reservation evidence, never an account-specific or actual billed amount.
  const price = { rate_usd_per_hour: .22, max_item_reservation_usd: .08, source: 'https://elevenlabs.io/pricing/api', verified_on: '2026-11-09', basis: 'official_public_api_price_not_actual_billing' };
  const observed = Date.parse(`${price.verified_on}T00:00:00Z`), now = Date.now();
  const priceFresh = Number.isFinite(observed) && observed <= now && now - observed <= 31 * 86400000;
  // A generic model catalog is not evidence of STT permission or unsupported Scribe.
  // The official fixed Scribe contract plus guarded pilot will establish STT acceptance.
  const usable = priceFresh && Boolean(key) && subscription.status === 'available' && ['active', 'trialing', 'free'].includes(subscription.subscription_status ?? '') &&
    subscription.credit_count !== null && subscription.credit_limit !== null && subscription.credit_count < subscription.credit_limit &&
    subscription.credit_reset_unix !== null && subscription.credit_reset_unix * 1000 > now;
  return { subscription, models, usable, price };
}

export async function retrieveTranscript(transcriptionId: string, maxDuration: number): Promise<TranscriptResult> {
  if (!providerId(transcriptionId)) throw new Error('Transcript identity unavailable');
  const key = transcriptionRequired('ELEVENLABS_API_KEY'), signal = AbortSignal.timeout(12000);
  // Official GET requires transcription_id, never request_id. 404 is NOT proof of nonacceptance.
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/speech-to-text/transcripts/${encodeURIComponent(transcriptionId)}`, {
      method: 'GET', redirect: 'error', cache: 'no-store', headers: { 'xi-api-key': key }, signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Transcript unavailable'); }
    const result = normalizeTranscript(decodeJson(await boundedBytes(response.body, MAX_CALLBACK_BYTES, signal)), maxDuration);
    if (result.transcription_id && result.transcription_id !== transcriptionId) throw new Error('Transcript identity mismatch');
    return result;
  } catch { throw new Error('Transcript unavailable'); }
}
