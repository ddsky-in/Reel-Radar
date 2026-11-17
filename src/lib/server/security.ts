import { ApiError } from './errors';

type Environment = Record<string, string | undefined>;

export function isLoopbackHost(value: string): boolean {
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

export function demoEnabled(env: Environment = process.env): boolean {
  return env.DEMO_MODE === 'true' && (env.NODE_ENV === 'development' || (env.NODE_ENV === 'production' && env.ALLOW_LOCAL_DEMO === 'true'));
}

export function assertDemoRequest(request: Request, env: Environment = process.env): boolean {
  if (env.DEMO_MODE !== 'true') return false;
  if (!demoEnabled(env)) throw new ApiError(503, 'DEMO_DISABLED', 'Local demo mode is not enabled in this environment.');
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  if (!isLoopbackHost(url.host) || !isLoopbackHost(host)) throw new ApiError(403, 'LOCAL_ONLY', 'Demo mode is available on loopback hosts only.');
  // Do not permit a reverse proxy to expose the unauthenticated local demo.
  for (const name of ['x-forwarded-host', 'forwarded']) {
    const forwarded = request.headers.get(name);
    if (forwarded && (name === 'forwarded' || forwarded !== host)) throw new ApiError(403, 'LOCAL_ONLY', 'Forwarded demo requests are not allowed.');
  }
  return true;
}

function originForHost(protocol: string, host: string): string | null {
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(host)) return null;
  try {
    const parsed = new URL(`${protocol}//${host}`);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : null;
  } catch { return null; }
}

/** Forwarded metadata may confirm the configured origin, never choose it. */
function forwardedMatchesOrigin(value: string, app: URL): boolean {
  if (!value || value.length > 2048 || value.includes(',')) return false;
  const parameters = new Map<string, string>();
  for (const part of value.split(';')) {
    const match = /^([a-z]+)=(?:"([^"\\]*)"|([^\s";]+))$/i.exec(part.trim());
    if (!match || parameters.has(match[1].toLowerCase())) return false;
    parameters.set(match[1].toLowerCase(), match[2] ?? match[3]);
  }
  const host = parameters.get('host');
  return !!host && parameters.get('proto') === app.protocol.slice(0, -1)
    && originForHost(app.protocol, host) === app.origin;
}

export function assertMutationOrigin(request: Request, env: Environment = process.env): void {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  let expected = url.origin;
  let requestOrigin: string | null = url.origin;
  if (env.DEMO_MODE === 'true') {
    // Next start may reconstruct localhost while the browser requests 127.0.0.1.
    // After the demo gate passes, use the actual Host; aliases are NOT equivalent.
    assertDemoRequest(request, env);
    requestOrigin = originForHost(url.protocol, host);
    expected = requestOrigin ?? '';
  } else if (env.NEXT_PUBLIC_APP_URL) {
    let app: URL;
    try {
      app = new URL(env.NEXT_PUBLIC_APP_URL);
      if (!['http:', 'https:'].includes(app.protocol) || app.username || app.password || app.pathname !== '/' || app.search || app.hash || (app.protocol === 'http:' && !isLoopbackHost(app.host))) throw new Error('invalid');
    } catch { throw new ApiError(503, 'CONFIG_REQUIRED', 'A valid application origin must be configured.'); }
    expected = app.origin;
    // Configured deployment scheme is authoritative; Next's internal URL may be HTTP.
    requestOrigin = originForHost(app.protocol, host);
    const forwardedHost = request.headers.get('x-forwarded-host');
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwarded = request.headers.get('forwarded');
    if ((forwarded !== null && !forwardedMatchesOrigin(forwarded, app)) || (forwardedHost && originForHost(app.protocol, forwardedHost) !== expected) || (forwardedProto && forwardedProto !== app.protocol.slice(0, -1))) {
      throw new ApiError(403, 'INVALID_ORIGIN', 'A same-origin request is required.');
    }
  } else if (env.NODE_ENV === 'production') {
    throw new ApiError(503, 'CONFIG_REQUIRED', 'The application origin must be configured.');
  }
  if (!origin || origin !== expected || origin !== requestOrigin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ApiError(403, 'INVALID_ORIGIN', 'A same-origin request is required.');
  }
}

export interface SupabaseConfig { url: string; key: string; ownerEmail: string; ownerId: string }
export function supabaseConfig(env: Environment = process.env): SupabaseConfig {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  const ownerId = env.OWNER_USER_ID?.trim();
  if (!url || !key || !ownerEmail || !ownerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new ApiError(503, 'CONFIG_REQUIRED', 'Supabase and owner authentication must be configured.');
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.host))) throw new Error('invalid');
    if (parsed.username || parsed.password) throw new Error('invalid');
    // Explicitly reject legacy service-role JWTs and modern secret keys in browser-safe configuration.
    if (key.startsWith('sb_secret_')) throw new Error('invalid');
    if (key.split('.').length === 3) {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()) as { role?: string };
      if (payload.role !== 'anon') throw new Error('invalid');
    } else if (!key.startsWith('sb_publishable_')) throw new Error('invalid');
  } catch { throw new ApiError(503, 'CONFIG_REQUIRED', 'Supabase browser-safe configuration is invalid.'); }
  return { url, key, ownerEmail, ownerId };
}

interface Bucket { count: number; reset: number }
const buckets = new Map<string, Bucket>();
/** Best-effort per-process protection; production ingress should additionally rate-limit by trusted IP. */
export function consumeLimit(key: string, maximum: number, windowMs: number, now = Date.now()): void {
  if (buckets.size > 5000) {
    for (const [entry, bucket] of buckets) if (bucket.reset <= now) buckets.delete(entry);
    if (buckets.size > 5000) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
  }
  const old = buckets.get(key);
  const bucket = old && old.reset > now ? old : { count: 0, reset: now + windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count > maximum) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
}
