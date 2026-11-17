import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const secret = 'fixture-internal-only';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup() {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Deno', { env: { get: (key: string) => key === 'INTERNAL_CRON_SECRET' ? secret : undefined }, serve: vi.fn() });
  const fetcher = vi.fn(() => { throw new Error('Retired audit must never perform network or mutate holds'); });
  vi.stubGlobal('fetch', fetcher);
  const { handler } = await import('../supabase/functions/competitor-run-audit/retired.ts' as string);
  return { handler, fetcher };
}

describe('retired temporary provider audit', () => {
  it('returns authenticated retirement without database/provider access or proof of no charge', async () => {
    const { handler, fetcher } = await setup();
    const response = await handler(new Request('http://localhost', { method: 'POST', headers: { 'x-internal-secret': secret } }));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'audit_retired', read_only: true, no_start_proven: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'DELETE'])('keeps retired control POST-only for %s', async method => {
    const { handler, fetcher } = await setup();
    expect((await handler(new Request('http://localhost', { method, headers: { 'x-internal-secret': secret } }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects absent authentication before any work', async () => {
    const { handler, fetcher } = await setup();
    expect((await handler(new Request('http://localhost', { method: 'POST' }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
