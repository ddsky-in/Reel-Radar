import { object } from './model.ts';
import { boundedBytes, decodeJson, providerId, uuid } from './transcription-model.ts';
import { transcriptionEnv, transcriptionRpc } from './transcription-db.ts';

export const TRANSCRIPTION_WEBHOOK_NAME = 'ReelRadar transcription v1';
export function transcriptionWebhookUrl(): string {
  const origin = new URL(transcriptionEnv('SUPABASE_URL'));
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('A valid HTTPS Supabase origin is required');
  return origin.origin + '/functions/v1/elevenlabs-webhook';
}
const WEBHOOK_API = 'https://api.elevenlabs.io/v1/workspace/webhooks';
const MAX_SETUP_BYTES = 256 * 1024;
export interface WebhookCredentials { id: string; secret: string }
export interface WebhookSetupResult {
  configured: boolean; status: string; api_key_valid: boolean; webhook_registered: boolean; event_verified: boolean;
}
function credentials(value: unknown): WebhookCredentials | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = object(value);
  return providerId(row.id) && typeof row.secret === 'string' && /^[\x21-\x7e]{1,4096}$/.test(row.secret) ? { id: row.id, secret: row.secret } : null;
}
export function environmentWebhookCredentials(): WebhookCredentials | null {
  return credentials({ id: transcriptionEnv('ELEVENLABS_WEBHOOK_ID'), secret: transcriptionEnv('ELEVENLABS_WEBHOOK_SECRET') });
}
export async function resolveWebhookCredentials(): Promise<WebhookCredentials | null> {
  const env = environmentWebhookCredentials();
  if (env) return env;
  // A partial/invalid override must not combine a different ID with the Vault secret.
  if (transcriptionEnv('ELEVENLABS_WEBHOOK_ID') || transcriptionEnv('ELEVENLABS_WEBHOOK_SECRET')) return null;
  return credentials(await transcriptionRpc('worker_transcription_webhook_get_credentials'));
}
class SetupError extends Error {
  constructor(readonly status: string) { super('Webhook setup unavailable'); }
}
interface Webhook {
  id: string; name: string; url: string; auth: string; disabled: boolean; autoDisabled: boolean; events: string[];
}
async function providerRequest(key: string, method: 'GET' | 'POST' | 'PATCH', id?: string, body?: unknown): Promise<Record<string, unknown>> {
  if (id !== undefined && !providerId(id)) throw new SetupError('invalid_response');
  const url = method === 'GET' ? `${WEBHOOK_API}?include_usages=true` : id ? `${WEBHOOK_API}/${encodeURIComponent(id)}` : WEBHOOK_API;
  const signal = AbortSignal.timeout(12000);
  try {
    const response = await fetch(url, { method, redirect: 'error', cache: 'no-store', credentials: 'omit', signal,
      headers: { 'xi-api-key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      let status = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'missing_permission' : 'provider_unavailable';
      if ([401, 403].includes(response.status)) {
        // Whitelist the official permission enum only, never retain or reflect provider messages.
        try {
          const failure = decodeJson(await boundedBytes(response.body, MAX_SETUP_BYTES, signal));
          if (failure.detail && typeof failure.detail === 'object' && !Array.isArray(failure.detail) && object(failure.detail).status === 'missing_permissions') status = 'missing_permission';
        } catch { /* HTTP status remains safe even with malformed/oversized error JSON */ }
      } else await response.body?.cancel();
      throw new SetupError(status);
    }
    const length = response.headers.get('content-length');
    if (response.redirected || response.url && response.url !== url ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
        length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SETUP_BYTES)) {
      await response.body?.cancel(); throw new SetupError('invalid_response');
    }
    try { return decodeJson(await boundedBytes(response.body, MAX_SETUP_BYTES, signal)); }
    catch { throw new SetupError('invalid_response'); }
  } catch (error) { throw error instanceof SetupError ? error : new SetupError('provider_unavailable'); }
}
async function listWebhooks(key: string): Promise<Webhook[]> {
  const row = await providerRequest(key, 'GET');
  if (!Array.isArray(row.webhooks) || row.webhooks.length > 1000) throw new SetupError('invalid_response');
  const ids = new Set<string>();
  return row.webhooks.map(value => {
    const item = object(value);
    if (!providerId(item.webhook_id) || ids.has(item.webhook_id) || typeof item.name !== 'string' || item.name.length > 1000 ||
        typeof item.webhook_url !== 'string' || item.webhook_url.length > 8192 || typeof item.auth_type !== 'string' ||
        typeof item.is_disabled !== 'boolean' || typeof item.is_auto_disabled !== 'boolean' ||
        item.events != null && (!Array.isArray(item.events) || item.events.length > 100 || item.events.some(event => typeof event !== 'string'))) throw new SetupError('invalid_response');
    ids.add(item.webhook_id);
    // Deliberately discard usage and every other provider field.
    return { id: item.webhook_id, name: item.name, url: item.webhook_url, auth: item.auth_type,
      disabled: item.is_disabled, autoDisabled: item.is_auto_disabled, events: (item.events ?? []) as string[] };
  });
}
function owned(webhook: Webhook): boolean {
  return webhook.name === TRANSCRIPTION_WEBHOOK_NAME && webhook.url === transcriptionWebhookUrl() && webhook.auth === 'hmac';
}

// Caller MUST have authenticated the base internal secret; the scheduler may never enter here.
export async function setupTranscriptionWebhook(): Promise<WebhookSetupResult> {
  const result: WebhookSetupResult = { configured: false, status: 'unavailable', api_key_valid: false, webhook_registered: false, event_verified: false };
  const key = transcriptionEnv('ELEVENLABS_API_KEY');
  if (!key) return { ...result, status: 'api_key_missing' };
  let token: string | null = null, createPending = false;
  const finish = async (status: string) => {
    if (!token) return;
    await transcriptionRpc('worker_transcription_webhook_finish', { p_lease_token: token, p_status: status });
    token = null;
  };
  try {
    const lease = object(await transcriptionRpc('worker_transcription_webhook_begin'));
    if (lease.status !== 'acquired') {
      return { ...result, status: ['busy', 'uncertain', 'recovery_required'].includes(String(lease.status)) ? String(lease.status) : 'unavailable' };
    }
    if (!uuid(lease.lease_token)) throw new SetupError('unavailable');
    token = lease.lease_token;
    let known = await resolveWebhookCredentials();
    let webhooks = await listWebhooks(key);
    result.api_key_valid = true;
    const collisions = webhooks.filter(row => row.name === TRANSCRIPTION_WEBHOOK_NAME || row.url === transcriptionWebhookUrl());
    if (known) {
      const match = webhooks.find(row => row.id === known!.id);
      if (!match || !owned(match) || collisions.length !== 1) {
        await finish('recovery_required'); return { ...result, status: 'recovery_required' };
      }
    } else {
      // Even an exact existing HMAC callback cannot recover its one-time secret by listing it.
      if (collisions.length || lease.webhook_id || transcriptionEnv('ELEVENLABS_WEBHOOK_ID') || transcriptionEnv('ELEVENLABS_WEBHOOK_SECRET')) {
        await finish('recovery_required'); return { ...result, status: 'recovery_required' };
      }
      await transcriptionRpc('worker_transcription_webhook_mark_create', { p_lease_token: token });
      createPending = true;
      // Never retry this POST, including malformed success, timeout or failed credential storage.
      const created = await providerRequest(key, 'POST', undefined, { settings: { auth_type: 'hmac', name: TRANSCRIPTION_WEBHOOK_NAME, webhook_url: transcriptionWebhookUrl() } });
      known = credentials({ id: created.webhook_id, secret: created.webhook_secret });
      if (!known) throw new SetupError('invalid_response');
      const stored = object(await transcriptionRpc('worker_transcription_webhook_store', { p_lease_token: token, p_webhook_id: known.id, p_webhook_secret: known.secret }));
      if (stored.stored !== true) throw new SetupError('unavailable');
      createPending = false;
      webhooks = await listWebhooks(key);
      const match = webhooks.find(row => row.id === known!.id);
      if (!match || !owned(match) || webhooks.filter(row => row.name === TRANSCRIPTION_WEBHOOK_NAME || row.url === transcriptionWebhookUrl()).length !== 1) {
        await finish('recovery_required'); return { ...result, status: 'recovery_required' };
      }
    }
    result.webhook_registered = true;
    // Adopt a verified env pair without rotating it; Vault storage is transactional and immutable.
    const stored = object(await transcriptionRpc('worker_transcription_webhook_store', { p_lease_token: token, p_webhook_id: known.id, p_webhook_secret: known.secret }));
    if (stored.stored !== true) throw new SetupError('unavailable');
    const patched = await providerRequest(key, 'PATCH', known.id, { name: TRANSCRIPTION_WEBHOOK_NAME, is_disabled: false, events: ['speech_to_text'], retry_enabled: true });
    if (patched.status !== 'ok') throw new SetupError('invalid_response');
    const verified = (await listWebhooks(key)).find(row => row.id === known!.id);
    result.event_verified = Boolean(verified && owned(verified) && !verified.disabled && !verified.autoDisabled && verified.events.includes('speech_to_text'));
    if (!result.event_verified) { await finish('idle'); return { ...result, status: 'verification_failed' }; }
    await finish('configured');
    return { ...result, configured: true, status: 'configured' };
  } catch (error) {
    const status = error instanceof SetupError ? error.status : 'unavailable';
    // Durable create_pending itself blocks reentry even if this finish RPC also times out.
    try { await finish(createPending ? 'uncertain' : 'idle'); } catch { /* never expose database/provider errors */ }
    return { ...result, api_key_valid: status === 'unauthorized' ? false : result.api_key_valid,
      status: createPending && !['unauthorized', 'missing_permission'].includes(status) ? 'uncertain' : status };
  }
}
