import { isLoopbackHost } from './security';

/** Keep page navigation on the configured host before sign-in starts. */
export function canonicalAppUrl(request: Request, configuredUrl = process.env.NEXT_PUBLIC_APP_URL): URL | null {
  if (!configuredUrl || !['GET', 'HEAD'].includes(request.method)) return null;
  const current = new URL(request.url);
  if (current.pathname === '/api' || current.pathname.startsWith('/api/') || current.pathname.startsWith('/_next/')) return null;
  const host = request.headers.get('host') ?? current.host;
  try {
    const configured = new URL(configuredUrl);
    if (!['http:', 'https:'].includes(configured.protocol)
      || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) return null;
    if (configured.protocol === 'https:' && !isLoopbackHost(configured.host)
      && /^[a-z0-9-]+\.vercel\.app$/i.test(host) && host !== configured.host) {
      configured.pathname = current.pathname;
      configured.search = current.search;
      return configured;
    }
    if (!isLoopbackHost(current.host) || !isLoopbackHost(host) || !isLoopbackHost(configured.host)) return null;
    const actual = new URL(`${current.protocol}//${host}`);
    if (actual.protocol !== configured.protocol || actual.port !== configured.port || actual.origin === configured.origin) return null;
    // Forwarded hosts cannot turn a local redirect into public access.
    const forwardedHost = request.headers.get('x-forwarded-host');
    if (request.headers.has('forwarded') || (forwardedHost && forwardedHost !== host)) return null;
    configured.pathname = current.pathname;
    configured.search = current.search;
    return configured;
  } catch { return null; }
}
