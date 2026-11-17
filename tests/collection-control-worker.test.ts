import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('Deno', { env: { get: () => undefined }, serve: vi.fn() });
const control = await import('../supabase/functions/collection-control/index.ts' as string);
const retired = await import('../supabase/functions/collection-control/retired.ts' as string);
const owner = '43292213-87a3-4000-8000-9d779fbe6659';
const pins = [
  { job_id: 'd8817ff8-10d8-4000-8000-edb3e96298f4', dispatch_nonce: '9ff6f18c-bcae-4000-8000-8449f68cb1a5', started_at: '2026-11-13T14:23:48.972496Z', expected_version: 1 },
  { job_id: 'e02b7054-ffda-4000-8000-b3b4f090c045', dispatch_nonce: '34c98f8f-5262-4000-8000-b1deb10fa28f', started_at: '2026-11-15T08:17:38.568660Z', expected_version: 1 },
  { job_id: 'e5adbea1-2892-4000-8000-53937ec86da7', dispatch_nonce: '3233b414-86ea-4000-8000-1d6ff2734f1b', started_at: '2026-11-15T07:31:00.818521Z', expected_version: 1 },
];
let env: Record<string, string>, fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const request = (input: unknown, secret = 'synthetic-internal') => new Request('https://fixture.test', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-secret': secret }, body: JSON.stringify(input) });
const release = () => ({ action: 'risk_release', request_key: '11111111-1111-4111-8111-111111111111',
  reason: 'Explicit operator acknowledgement of unknown exposure', evidence_reference: 'audit/fixture-read-only', expected: pins });
beforeEach(() => {
  env = { PROVIDER_MODE: 'apify', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    REELRADAR_OWNER_USER_ID: owner, INTERNAL_CRON_SECRET: 'synthetic-internal', COLLECTION_CONTROL_EXPIRES_AT: new Date(Date.now() + 1800000).toISOString() };
  vi.stubGlobal('Deno', { env: { get: (key: string) => env[key] }, serve: vi.fn() });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input)), args = JSON.parse(String(init?.body));
    expect(url.origin).toBe('https://fixture.supabase.co'); expect(init?.method).toBe('POST'); expect(args.p_owner_user_id).toBe(owner);
    if (url.pathname.endsWith('/worker_set_collection_start_gate')) return Response.json({ paid_starts_gated: args.p_gated });
    if (url.pathname.endsWith('/worker_risk_release_collection_jobs')) return Response.json({ items: pins.map(pin => ({ id: pin.job_id })), replayed: false });
    throw new Error('No other control requests are allowed');
  }); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('standalone scoped collection control and retirement', () => {
  it('allows only gatingtrue without provider or generic dispatcher imports/calls', async () => {
    const response = await control.handler(request({ action: 'set_start_gate', gated: true })); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gated: true, paidStarts: 0 }); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await control.handler(request({ action: 'set_start_gate', gated: false }))).status).toBe(400); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends exactly the atomic originalthree manifest with actualcost unknown', async () => {
    const response = await control.handler(request(release())); expect(response.status).toBe(200);
    const text = await response.text(), result = JSON.parse(text);
    expect(result.actualCostUsd).toBeNull(); expect(result.unknownRiskAcknowledged).toBe(true); expect(result.paidStarts).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1); const args = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(args.p_job_ids).toEqual(pins.map(pin => pin.job_id)); expect(args.p_expected).toEqual(pins);
    for (const pin of pins) expect(text).not.toContain(pin.dispatch_nonce);
  });
  it('rejects foreignstale missingduplicate pins without any DB call', async () => {
    for (const expected of [pins.slice(0, 2), [pins[0], pins[0], pins[2]], [{ ...pins[0], dispatch_nonce: owner }, pins[1], pins[2]]]) {
      expect((await control.handler(request({ ...release(), expected }))).status).toBeGreaterThanOrEqual(400);
    } expect(fetcher).not.toHaveBeenCalled();
  });
  it('is expired without valid boundedactivation expiry and never autoactivates the prioraudit', async () => {
    for (const expiry of ['', 'invalid', new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 7200000).toISOString()]) {
      env.COLLECTION_CONTROL_EXPIRES_AT = expiry; expect((await control.handler(request(release()))).status).toBe(410);
    } expect(fetcher).not.toHaveBeenCalled();
  });
  it('retirement and failedauthentication never perform IO', async () => {
    expect((await control.handler(request(release(), 'wrong'))).status).toBe(401);
    expect((await retired.handler(request(release()))).status).toBe(410); expect(fetcher).not.toHaveBeenCalled();
  });
});
