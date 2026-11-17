import type { BillingSyncResult } from '../types';
import { ApiError } from './errors';
import { safeBillingSync } from './public-data';
import { isLoopbackHost } from './security';

type Environment = Record<string, string | undefined>;

/** Owner route only. Isolated from queue wakes: this action never starts paid work. */
export async function syncProviderBilling(env: Environment = process.env, fetcher: typeof fetch = fetch): Promise<BillingSyncResult> {
  const secret = env.REELRADAR_DISPATCH_SECRET?.trim();
  const base = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  let url: string;
  try {
    if (!secret || /[\r\n]/.test(secret) || !base) throw new Error('Missing configuration');
    const parsed = new URL(base);
    const local = ['test', 'development'].includes(env.NODE_ENV ?? '') && isLoopbackHost(parsed.host);
    const hosted = parsed.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) && !parsed.port;
    if ((!hosted && !(local && ['http:', 'https:'].includes(parsed.protocol))) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid configuration');
    url = `${parsed.origin}/functions/v1/reconcile-jobs`;
  } catch { throw new ApiError(503, 'BILLING_SYNC_SETUP_REQUIRED', 'Billing sync requires secure server configuration. Stored billing status remains available.'); }
  let result: unknown;
  try {
    const response = await fetcher(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret! },
      body: JSON.stringify({ action: 'billing_sync', continuation_budget: 0 }),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) { if (response.body) await response.body.cancel(); throw new Error('Billing sync unavailable'); }
    result = await response.json();
  } catch { throw new ApiError(503, 'BILLING_SYNC_UNAVAILABLE', 'Billing sync could not be confirmed. Refresh stored account and hold status before checking again. No new paid collection was requested.'); }
  return safeBillingSync(result);
}
