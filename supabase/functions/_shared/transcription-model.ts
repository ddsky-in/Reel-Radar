import { object } from './model.ts';

export const TRANSCRIPTION_MODEL = 'scribe_v2';
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 180;
export const MAX_CALLBACK_BYTES = 1024 * 1024;
export interface TranscriptConfig {
  enabled: boolean; paused: boolean; key_validated: boolean; contract_validated: boolean;
  phase: string; max_duration_seconds?: number; max_media_bytes?: number;
  monthly_budget_usd?: number; pilot_limit_usd?: number; concurrency?: number;
}
export interface TranscriptJob {
  id: string; reel_id: string; attempt_id: string; lease_token: string;
  source_url: string | null; candidates: string[]; has_audio: boolean | null;
  duration_seconds: number | null; model: string; options_version: number;
  reservation_usd: number; max_duration_seconds: number; max_media_bytes: number;
}
export interface TranscriptAttempt {
  id: string; reel_id: string; attempt_id: string; lease_token: string;
  provider_job_id: string | null; provider_transcription_id?: string | null;
  status: string; model: string; duration_seconds: number | null; max_duration_seconds: number;
}
export interface ValidatedTranscriptMedia {
  source_url: string; bytes: Uint8Array; content_type: 'video/mp4'; duration_seconds: number;
}
export interface TranscriptResult {
  text: string; language: string | null; segments: { text: string; start_ms: number; end_ms: number }[];
  no_speech: boolean; transcription_id: string | null;
}
export interface TranscriptEvent {
  failed: boolean; request_id: string; metadata: { job_id: string; attempt_id: string; nonce: string };
  transcription: unknown;
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function providerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
export function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export function normalizeEvent(value: unknown): TranscriptEvent {
  const event = object(value);
  const failed = event.type === 'webhook_error';
  if (!failed && event.type !== 'speech_to_text_transcription') throw new Error('Unsupported transcription event');
  const data = failed ? event : object(event.data);
  const metadata = object(data.webhook_metadata);
  if (!providerId(data.request_id) || !uuid(metadata.job_id) || !uuid(metadata.attempt_id) || !uuid(metadata.nonce)) throw new Error('Invalid transcription event identity');
  return { failed, request_id: data.request_id, metadata: { job_id: metadata.job_id, attempt_id: metadata.attempt_id, nonce: metadata.nonce }, transcription: failed ? null : data.transcription };
}
export function normalizeTranscript(value: unknown, maxDuration = MAX_DURATION_SECONDS): TranscriptResult {
  const row = object(value);
  if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > MAX_DURATION_SECONDS ||
      typeof row.text !== 'string' || row.text.length > 200000 || !Array.isArray(row.words) || row.words.length > 20000 || row.transcripts !== undefined || row.channel_index != null) throw new Error('Invalid transcript schema');
  const duration = row.audio_duration_secs;
  if (duration !== undefined && duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > maxDuration)) throw new Error('Invalid transcript duration');
  const language = row.language_code;
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) throw new Error('Invalid transcript language');
  if (row.language_probability !== undefined && (typeof row.language_probability !== 'number' || !Number.isFinite(row.language_probability) || row.language_probability < 0 || row.language_probability > 1)) throw new Error('Invalid language probability');
  if (row.transcription_id != null && !providerId(row.transcription_id)) throw new Error('Invalid transcript identity');
  const segments: TranscriptResult['segments'] = [];
  let previousEnd = 0, timingValid = true, speechWords = 0;
  for (const value of row.words) {
    const word = object(value);
    if (!['word', 'spacing', 'audio_event'].includes(String(word.type)) || typeof word.text !== 'string' || word.text.length > 2000 || word.channel_index != null) throw new Error('Invalid transcript word');
    if (word.type !== 'word' || !word.text.trim()) continue;
    speechWords++;
    const { start, end } = word;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > maxDuration) { timingValid = false; continue; }
    const startMs = Math.round(start * 1000), endMs = Math.round(end * 1000);
    if (startMs < previousEnd || endMs <= startMs || segments.length >= 5000) timingValid = false;
    previousEnd = endMs;
    segments.push({ text: word.text.trim(), start_ms: startMs, end_ms: endMs });
  }
  const text = row.text.trim();
  if (!text && speechWords > 0) throw new Error('Transcript text missing');
  // Text remains valid when word timing is absent/overlapping. No manufactured SRT timing.
  return { text: row.text, language, segments: timingValid ? segments : [], no_speech: !text && speechWords === 0, transcription_id: typeof row.transcription_id === 'string' ? row.transcription_id : null };
}
export class MediaBodyLimitError extends Error {
  constructor() { super('Body exceeds bound'); }
}
export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!stream || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MEDIA_BYTES) throw new Error('Invalid body bound');
  // One bounded allocation avoids retaining every downloaded chunk alongside a
  // second complete video. This matters inside a 256 MB Edge isolate.
  const reader = stream.getReader(), bytes = new Uint8Array(maxBytes); let length = 0;
  const aborted = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      if (length + part.value.byteLength > maxBytes) throw new MediaBodyLimitError();
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    return bytes.subarray(0, length);
  } catch (error) { await reader.cancel().catch(() => undefined); if (error instanceof MediaBodyLimitError) throw error; throw new Error('Body unavailable or exceeds bound'); }
  finally { signal.removeEventListener('abort', aborted); reader.releaseLock(); }
}
export async function hmacHex(secret: string, bytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, bytes as BufferSource);
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function constantEqual(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const values = await Promise.all([left, right].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]); let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export function signatureParts(header: string | null, now = Date.now()): { timestamp: string; signature: string } | null {
  if (!header || header.length > 200) return null;
  const parts = header.split(',').map(part => part.trim());
  if (parts.length !== 2) return null;
  const timestamp = parts.find(part => /^t=\d{10}$/.test(part))?.slice(2);
  const signature = parts.find(part => /^v0=[0-9a-f]{64}$/.test(part))?.slice(3);
  if (!timestamp || !signature) return null;
  const age = now - Number(timestamp) * 1000;
  // SDK documents 30 minutes past tolerance; future timestamps cannot extend replay validity.
  if (age > 30 * 60 * 1000 || age < -60000) return null;
  return { timestamp, signature };
}
export async function verifyWebhook(bytes: Uint8Array, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
  const parts = signatureParts(header, now);
  if (!secret || !parts || bytes.byteLength > MAX_CALLBACK_BYTES) return false;
  const prefix = new TextEncoder().encode(`${parts.timestamp}.`);
  const message = new Uint8Array(prefix.length + bytes.length); message.set(prefix); message.set(bytes, prefix.length);
  return await constantEqual(await hmacHex(secret, message), parts.signature);
}
