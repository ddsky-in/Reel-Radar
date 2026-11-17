import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ authenticated: true }));
const origin = 'https://project.supabase.co';
vi.mock('node:fs', () => ({ default: { readFileSync(file: string) {
  if (String(file).endsWith('.env.worker.local')) return fixture.authenticated ? 'EXPECTED_SUPABASE_ORIGIN=https://project.supabase.co\nINTERNAL_CRON_SECRET=fixture-only-secret' : '';
  if (String(file).endsWith('.env.local')) return `NEXT_PUBLIC_SUPABASE_URL=${origin}`;
  throw new Error('Unexpected configuration read');
} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Actual CLI module, isolated configuration and intercepted transport only.
async function run(args: string[], authenticated = true) {
  vi.resetModules(); fixture.authenticated = authenticated;
  const argv = process.argv, exitCode = process.exitCode;
  const requests: unknown[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(options.body)) });
    return new Response('{}');
  }));
  process.argv = [process.execPath, 'worker-control.mjs', ...args];
  try { await import('../scripts/worker-control.mjs' as string); return { success: true, requests }; }
  catch { return { success: false, requests }; }
  finally { process.argv = argv; process.exitCode = exitCode; }
}

describe('explicit collection throughput operator configuration', () => {
  it.each([2, 3, 4])('configures capacity %s only without a dispatch/continuation request', async capacity => {
    const result = await run(['configure_collection_throughput', String(capacity), String(capacity)]);
    expect(result).toEqual({ success: true, requests: [{ url: `${origin}/functions/v1/refresh-dispatch`, body: { action: 'configure_collection_throughput', max_active: capacity, max_starts_per_wake: capacity } }] });
  });
  it.each([[], ['3'], ['0', '3'], ['3', '5'], ['3.5', '3'], ['NaN', '3'], ['3', '3', 'extra']].map(args => ({ args })))('rejects invalid bounds before transport: $args', async ({ args }) => {
    expect(await run(['configure_collection_throughput', ...args])).toEqual({ success: false, requests: [] });
  });
  it('requires internal authentication even for configuration-only work', async () => {
    expect(await run(['configure_collection_throughput', '3', '3'], false)).toEqual({ success: false, requests: [] });
  });
});
