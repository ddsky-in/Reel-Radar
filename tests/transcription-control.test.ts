import { afterEach, describe, expect, it, vi } from 'vitest';

const origin = 'https://project.supabase.co';
const creatorId = '11111111-1111-4111-8111-111111111111';
const fixture = vi.hoisted(() => ({ authenticated: true }));

vi.mock('node:fs', () => ({ default: {
  readFileSync(file: string) {
    if (String(file).endsWith('.env.worker.local')) return fixture.authenticated ? 'EXPECTED_SUPABASE_ORIGIN=https://project.supabase.co\nINTERNAL_CRON_SECRET=fixture-only-secret' : '';
    if (String(file).endsWith('.env.local')) return `NEXT_PUBLIC_SUPABASE_URL=${origin}`;
    throw new Error('Unexpected configuration read');
  },
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Execute the actual operator module with isolated configuration and intercepted
// HTTP. Module resets replace cold child-process starts, which can exceed the
// test timeout on Windows. All argument/auth/transport assertions remain intact;
// no developer credentials are read and no hosted action can be started.
async function run(args: string[], authenticated = true) {
  vi.resetModules(); fixture.authenticated = authenticated;
  const argv = process.argv, exitCode = process.exitCode;
  const requests: Record<string, unknown>[] = [];
  const logs: unknown[][] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...values) => { logs.push(values); });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    if (String(url) !== `${origin}/functions/v1/transcript-dispatch` && String(url) !== `${origin}/functions/v1/transcript-reconcile`) throw new Error('Unexpected fixture endpoint');
    const headers = new Headers(options?.headers);
    requests.push({ url: String(url), method: options?.method, redirect: options?.redirect,
      body: JSON.parse(String(options?.body)), authenticated: headers.get('x-internal-secret') === 'fixture-only-secret' });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  process.argv = [process.execPath, 'transcription-control.mjs', ...args];
  try {
    await import('../scripts/transcription-control.mjs' as string);
    return { status: 0, stdout: JSON.stringify(logs), stderr: '', requests };
  } catch (error) {
    return { status: 1, stdout: JSON.stringify(logs), stderr: error instanceof Error ? error.message : String(error), requests };
  } finally {
    process.argv = argv; process.exitCode = exitCode; log.mockRestore();
  }
}

describe('transcription operator requests', () => {
  it.each(['media_refresh', 'source_refresh'])('sends the validated creator ID with %s', async action => {
    const result = await run([action, creatorId]);
    expect(result.status).toBe(0);
    expect(result.requests).toEqual([{ url: `${origin}/functions/v1/transcript-dispatch`, method: 'POST', redirect: 'error', body: { action, creator_id: creatorId }, authenticated: true }]);
    expect(result.stdout).not.toContain('fixture-only-secret');
  });

  it.each([
    { args: [], action: 'diagnostics', endpoint: 'transcript-dispatch' },
    { args: ['reconcile'], action: 'reconcile', endpoint: 'transcript-reconcile' },
  ])('routes $action to its own endpoint', async ({ args, action, endpoint }) => {
    const result = await run(args);
    expect(result.status).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ url: `${origin}/functions/v1/${endpoint}`, body: { action } });
  });

  it.each([
    { args: ['media_refresh'] }, { args: ['media_refresh', 'not-a-uuid'] }, { args: ['media_refresh', 'https://example.test/reel'] },
  ])('rejects missing or invalid target before making any request: $args', async ({ args }) => {
    const result = await run(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('An existing authorized creator UUID is required.');
    expect(result.requests).toEqual([]);
  });

  it.each([
    { args: ['unknown'] }, { args: ['dispatch', creatorId] }, { args: ['account_diagnostics', creatorId] },
  ])('rejects unsupported action or stray argument before HTTP: $args', async ({ args }) => {
    const result = await run(args);
    expect(result.status).not.toBe(0);
    expect(result.requests).toEqual([]);
  });

  it('requires internal authentication even for diagnostics', async () => {
    const result = await run(['diagnostics'], false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Worker authentication is not configured.');
    expect(result.requests).toEqual([]);
  });
});
