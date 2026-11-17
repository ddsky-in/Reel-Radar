import { describe, expect, it } from 'vitest';
import { canonicalAppUrl } from '../src/lib/server/app-origin';
import { assertMutationOrigin } from '../src/lib/server/security';

const origin = 'http://localhost:3000';

describe('local application origin', () => {
  it('redirects the old local address while preserving the page and filter parameters', () => {
    const request = new Request('http://127.0.0.1:3000/reels?keywords=AI+tools&view=table');
    expect(canonicalAppUrl(request, origin)?.href).toBe(`${origin}/reels?keywords=AI+tools&view=table`);
    expect(canonicalAppUrl(new Request('http://127.0.0.1:3000/login', { method: 'HEAD' }), origin)?.href).toBe(`${origin}/login`);
  });

  it('uses the actual Host when Next reconstructs its internal request URL', () => {
    expect(canonicalAppUrl(new Request(`${origin}/login`, { headers: { host: '127.0.0.1:3000' } }), origin)?.href).toBe(`${origin}/login`);
    expect(canonicalAppUrl(new Request('http://127.0.0.1:3000/login', { headers: { host: 'localhost:3000' } }), origin)).toBeNull();
  });

  it('leaves the canonical host, API calls and asset requests alone', () => {
    for (const url of [`${origin}/reels`, 'http://127.0.0.1:3000/api', 'http://127.0.0.1:3000/api/auth/login', 'http://127.0.0.1:3000/_next/static/app.css']) {
      expect(canonicalAppUrl(new Request(url), origin)).toBeNull();
    }
    expect(canonicalAppUrl(new Request('http://127.0.0.1:3000/login', { method: 'POST' }), origin)).toBeNull();
  });

  it('never redirects to external hosts, invalid origins or another port', () => {
    const request = new Request('http://127.0.0.1:3000/login');
    for (const configured of ['', 'invalid', 'https://outside.test', 'http://localhost:3001', 'http://localhost:3000/other', 'http://localhost:3000/?x=1', 'http://localhost:3000/#fragment', 'http://user:password@localhost:3000']) {
      expect(canonicalAppUrl(request, configured)).toBeNull();
    }
    expect(canonicalAppUrl(new Request('http://outside.test/login'), origin)).toBeNull();
    expect(canonicalAppUrl(new Request('http://127.0.0.1:3000/login', { headers: { host: 'outside.test' } }), origin)).toBeNull();
    expect(canonicalAppUrl(new Request('http://127.0.0.1:3000//outside.test/path'), origin)?.origin).toBe(origin);
  });

  it('does not trust forwarded hosts to choose a redirect', () => {
    const forwardedHeaders: Record<string, string>[] = [{ 'x-forwarded-host': 'outside.test' }, { forwarded: 'host=outside.test' }];
    for (const headers of forwardedHeaders) {
      expect(canonicalAppUrl(new Request('http://127.0.0.1:3000/login', { headers }), origin)).toBeNull();
    }
  });

  it('retains strict same-origin validation for sign-in mutations', () => {
    const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: origin };
    const login = (host: string) => new Request(`http://${host}/api/auth/login`, { method: 'POST', headers: { host, origin: `http://${host}` } });
    expect(() => assertMutationOrigin(login('127.0.0.1:3000'), env)).toThrow('A same-origin request is required.');
    expect(() => assertMutationOrigin(login('localhost:3000'), env)).not.toThrow();
  });

  it('moves Vercel page aliases to the configured HTTPS domain before sign-in', () => {
    const deployed = 'https://reels.ddsky.in';
    const request = new Request('http://localhost:3000/login?next=%2Freels', { headers: { host: 'reelradar-delta.vercel.app', forwarded: 'host=reelradar-delta.vercel.app;proto=https' } });
    expect(canonicalAppUrl(request, deployed)?.href).toBe(`${deployed}/login?next=%2Freels`);
    expect(canonicalAppUrl(new Request(`${deployed}/login`), deployed)).toBeNull();
  });

  it('does not forward credentials, APIs, lookalike hosts or local demos through an alias redirect', () => {
    const deployed = 'https://reels.ddsky.in';
    for (const request of [
      new Request('https://reelradar-delta.vercel.app/api/auth/login'),
      new Request('https://reelradar-delta.vercel.app/login', { method: 'POST' }),
      new Request('https://reelradar-delta.vercel.app.evil.test/login'),
    ]) expect(canonicalAppUrl(request, deployed)).toBeNull();
    expect(canonicalAppUrl(new Request('https://reelradar-delta.vercel.app/login'), origin)).toBeNull();
  });
});
