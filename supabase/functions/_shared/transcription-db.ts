import { object } from './model.ts';
import { boundedBytes, decodeJson } from './transcription-model.ts';

// Independent of Apify liveMode: disabling scraping must not disable signed callbacks.
export function transcriptionEnv(name: string): string { return Deno.env.get(name) ?? ''; }
export function transcriptionRequired(name: string): string {
  const value = transcriptionEnv(name); if (!value) throw new Error('Transcription configuration missing'); return value;
}
function databaseOrigin(): string {
  const value = transcriptionRequired('SUPABASE_URL'); let url: URL;
  try { url = new URL(value); } catch { throw new Error('Transcription database configuration invalid'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const local = ['test', 'local'].includes(transcriptionEnv('ENVIRONMENT')) && !transcriptionEnv('SB_REGION') && !transcriptionEnv('DENO_DEPLOYMENT_ID');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (!loopback && (url.protocol !== 'https:' || url.port || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname))) ||
      (loopback && (!local || !['http:', 'https:'].includes(url.protocol))) ||
      (transcriptionEnv('PROVIDER_MODE') === 'mock' && (!local || !loopback))) throw new Error('Transcription database runtime invalid');
  return url.origin;
}
export async function transcriptionRpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!/^worker_transcription_[a-z_]+$/.test(name)) throw new Error('Transcription RPC invalid');
  const base = databaseOrigin(), key = transcriptionRequired('SUPABASE_SERVICE_ROLE_KEY');
  const signal = AbortSignal.timeout(12000);
  try {
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Database unavailable'); }
    const bytes = await boundedBytes(response.body, 1024 * 1024, signal);
    return (bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null) as T;
  } catch { throw new Error('Transcription database unavailable'); }
}
export function transcriptionJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
export async function transcriptionBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || Number(request.headers.get('content-length') ?? 0) > 16384) throw new Error('Invalid request body');
  return object(decodeJson(await boundedBytes(request.body, 16384, AbortSignal.timeout(5000))));
}
