import type { QueueProcessing } from '../types';
import { isLoopbackHost } from './security';

// Server route imports only. Never import this module into client components.
type Environment = Record<string, string | undefined>;
type AfterResponse = (callback: () => Promise<void>) => void;

function dispatcherConfig(env: Environment): { url: string; secret: string } | null {
  const secret = env.REELRADAR_DISPATCH_SECRET?.trim();
  const base = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!secret || /[\r\n]/.test(secret) || !base) return null;
  try {
    const parsed = new URL(base);
    const local = ['test', 'development'].includes(env.NODE_ENV ?? '') && isLoopbackHost(parsed.host);
    const hosted = parsed.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) && !parsed.port;
    if ((!hosted && !(local && ['http:', 'https:'].includes(parsed.protocol))) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return { url: `${parsed.origin}/functions/v1/refresh-dispatch`, secret };
  } catch { return null; }
}

/** Wake the durable queue once, after its mutation committed and the response was sent. */
export function scheduleDispatcherWake(afterResponse: AfterResponse, env: Environment = process.env, fetcher: typeof fetch = fetch): QueueProcessing {
  const config = dispatcherConfig(env);
  if (!config) return 'configuration_required';
  try {
    afterResponse(async () => {
      try {
        const response = await fetcher(config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': config.secret },
          body: '{}',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error('Dispatcher unavailable');
        // Do not consume or log provider/database payloads. The durable maintenance
        // poller remains responsible for queued work if this best-effort wake fails.
        if (response.body) await response.body.cancel();
      } catch {
        console.error('[ReelRadar] queue wake failed; durable jobs remain queued.');
      }
    });
  } catch {
    console.error('[ReelRadar] queue wake could not be scheduled; durable jobs remain queued.');
  }
  return 'queued';
}
