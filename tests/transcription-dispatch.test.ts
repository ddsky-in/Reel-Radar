import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const worker = await import('../supabase/functions/_shared/transcription-worker.ts' as string);
const dispatcher = await import('../supabase/functions/transcript-dispatch/index.ts' as string);
const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

function request(action = 'dispatch', secret = 'fixture-internal-secret') {
  return new Request('http://127.0.0.1/transcript-dispatch', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify({ action }),
  });
}
beforeEach(() => {
  vi.stubGlobal('Deno', { env: { get: (name: string) => name === 'INTERNAL_CRON_SECRET' ? 'fixture-internal-secret' : undefined }, serve: vi.fn() });
  vi.stubGlobal('EdgeRuntime', { waitUntil });
  waitUntil.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden in fixtures')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('authenticated asynchronous transcription wake', () => {
  it('acknowledges an authenticated wake before the bounded batch completes', async () => {
    let finish!: (response: Response) => void;
    const batch = new Promise<Response>(resolve => { finish = resolve; });
    const handler = vi.spyOn(worker, 'transcriptionInternalHandler').mockReturnValue(batch);
    const response = await dispatcher.handler(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    finish(new Response('{}'));
    await waitUntil.mock.calls[0][0];
  });

  it('accepts the existing derived maintenance secret without exposing it', async () => {
    const secret = await worker.maintenanceSecret();
    vi.spyOn(worker, 'transcriptionInternalHandler').mockResolvedValue(new Response('{}'));
    const response = await dispatcher.handler(request('maintenance', secret));
    expect(response.status).toBe(202);
    expect(await response.text()).not.toContain(secret);
    await waitUntil.mock.calls[0][0];
  });

  it('does not start background work for a forged secret or a GET', async () => {
    const handler = vi.spyOn(worker, 'transcriptionInternalHandler');
    expect((await dispatcher.handler(request('dispatch', 'forged'))).status).toBe(401);
    expect((await dispatcher.handler(new Request('http://127.0.0.1/transcript-dispatch'))).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps diagnostics and operator configuration synchronous', async () => {
    const handler = vi.spyOn(worker, 'transcriptionInternalHandler').mockResolvedValue(new Response('{"diagnostics":{}}'));
    const response = await dispatcher.handler(request('diagnostics'));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('falls back to bounded foreground handling without an Edge background runtime', async () => {
    vi.stubGlobal('EdgeRuntime', undefined);
    vi.spyOn(worker, 'transcriptionInternalHandler').mockResolvedValue(new Response('{"dispatched":[]}'));
    const response = await dispatcher.handler(request());
    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('handles a failed background batch without logging database or provider details', async () => {
    vi.spyOn(worker, 'transcriptionInternalHandler').mockRejectedValue(new Error('fixture-sensitive-provider-details'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await dispatcher.handler(request())).status).toBe(202);
    await waitUntil.mock.calls[0][0];
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain('fixture-sensitive-provider-details');
  });
});
