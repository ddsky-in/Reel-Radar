import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ authenticated: true, origin: 'https://project.supabase.co' }));
const origin = 'https://project.supabase.co';
vi.mock('node:fs', () => ({ default: { readFileSync(file: string) {
  if (String(file).endsWith('.env.worker.local')) return fixture.authenticated ? 'EXPECTED_SUPABASE_ORIGIN=https://project.supabase.co\nINTERNAL_CRON_SECRET=fixture-only-secret\nAPIFY_API_TOKEN=fixture-provider-token' : '';
  if (String(file).endsWith('.env.local')) return `NEXT_PUBLIC_SUPABASE_URL=${fixture.origin}`;
  throw new Error('Unexpected configuration read');
} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Import the real CLI with isolated config and intercepted transport; never run a live operator action.
async function run(args: string[], options: { authenticated?: boolean; origin?: string; status?: number } = {}) {
  vi.resetModules(); fixture.authenticated = options.authenticated ?? true; fixture.origin = options.origin ?? origin;
  const argv = process.argv, exitCode = process.exitCode;
  const requests: { url: string; body: unknown; secret: string | null; method: string | undefined; redirect: RequestRedirect | undefined }[] = [];
  const logs: string[] = [];
  const logger = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(logger);
  vi.spyOn(console, 'error').mockImplementation(logger);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), secret: new Headers(init.headers).get('x-internal-secret'), method: init.method, redirect: init.redirect });
    return Response.json({ automation: { enabled: args[1] === 'true' } }, { status: options.status ?? 200 });
  }));
  process.argv = [process.execPath, 'worker-control.mjs', ...args];
  try {
    await import('../scripts/worker-control.mjs' as string);
    return { success: true, requests, logs, exitCode: process.exitCode };
  } catch (error) {
    return { success: false, requests, logs, error: error instanceof Error ? error.message : 'Unknown error', exitCode: process.exitCode };
  } finally { process.argv = argv; process.exitCode = exitCode; }
}

function expectNoPrivateOutput(result: Awaited<ReturnType<typeof run>>) {
  expect(JSON.stringify({ logs: result.logs, error: result.error })).not.toMatch(/fixture-only-secret|fixture-provider-token|x-internal-secret|configure_profile_automation|continuation_budget/);
}

describe('explicit profile automation operator control', () => {
  it.each(['true', 'false'])('sends only strict enabled=%s configuration without enqueue or continuation', async enabled => {
    const result = await run(['configure_profile_automation', enabled]);
    expect(result.success).toBe(true);
    expect(result.requests).toEqual([{ url: `${origin}/functions/v1/refresh-dispatch`, body: { action: 'configure_profile_automation', enabled: enabled === 'true' },
      secret: 'fixture-only-secret', method: 'POST', redirect: 'error' }]);
    expect(result.logs).toHaveLength(1);
    expectNoPrivateOutput(result);
  });
  it.each([[], ['TRUE'], ['True'], ['FALSE'], ['1'], ['0'], ['yes'], ['null'], [' true '], ['{"enabled":true}'],
    ['true', 'extra'], ['false', '--token=fixture-provider-token']].map(args => ({ args })))(
    'rejects absent, coerced or extra boolean arguments before transport: $args', async ({ args }) => {
      const result = await run(['configure_profile_automation', ...args]);
      expect(result.success).toBe(false); expect(result.requests).toEqual([]); expect(result.logs).toEqual([]);
      expect(result.error).toBe('Explicit profile automation boolean required.'); expectNoPrivateOutput(result);
    },
  );
  it('requires a configured internal authentication secret even when disabling', async () => {
    const result = await run(['configure_profile_automation', 'false'], { authenticated: false });
    expect(result.success).toBe(false); expect(result.requests).toEqual([]);
    expect(result.error).toBe('Worker authentication is not configured.'); expectNoPrivateOutput(result);
  });
  it('rejects unexpected project targets without transport', async () => {
    const result = await run(['configure_profile_automation', 'true'], { origin: 'https://fixture.supabase.co' });
    expect(result.success).toBe(false); expect(result.requests).toEqual([]);
    expect(result.error).toBe('Unexpected project target.'); expectNoPrivateOutput(result);
  });
  it('does not accept raw RPC or alternate action names', async () => {
    const result = await run(['worker_configure_profile_automation', 'true']);
    expect(result.success).toBe(false); expect(result.requests).toEqual([]);
    expect(result.error).toBe('Unsupported action.'); expectNoPrivateOutput(result);
  });
  it('reports configuration failure without retrying or switching to dispatch', async () => {
    const result = await run(['configure_profile_automation', 'true'], { status: 503 });
    expect(result.success).toBe(true); expect(result.exitCode).toBe(1); expect(result.requests).toHaveLength(1);
    expectNoPrivateOutput(result);
  });
});
