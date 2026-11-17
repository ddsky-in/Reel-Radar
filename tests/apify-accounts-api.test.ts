import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH } from '../src/app/api/[...path]/route';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { DemoRepository } from '../src/lib/server/demo-repository';

const owner = vi.hoisted(() => ({ id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' }));
vi.mock('@/lib/supabase/server', () => ({ authenticatedClient: async () => ({ client: {}, user: owner }), createSupabaseServerClient: vi.fn() }));
const origin = 'http://127.0.0.1:3100';
beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('DEMO_MODE', 'false'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('owner-authorized provider status API', () => {
  it('returns sanitized status only, with private no-store response and no mutation', async () => {
    const status = await new DemoRepository().apifyAccounts();
    const read = vi.spyOn(SupabaseRepository.prototype, 'apifyAccounts').mockResolvedValue({ ...status, accounts: status.accounts.map(row => ({ ...row, token: 'private-secret', provider_user_id: 'private-secret' })) });
    const result = await GET(new Request(`${origin}/api/apify-accounts`), { params: Promise.resolve({ path: ['apify-accounts'] }) });
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store, private');
    expect(await result.json()).toEqual(status); expect(read).toHaveBeenCalledOnce();
  });
  it('rejects account/owner override query parameters', async () => {
    const read = vi.spyOn(SupabaseRepository.prototype, 'apifyAccounts');
    const result = await GET(new Request(`${origin}/api/apify-accounts?owner=foreign`), { params: Promise.resolve({ path: ['apify-accounts'] }) });
    expect(result.status).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it('does not accept tokens through browser settings or public account mutations', async () => {
    const write = vi.spyOn(SupabaseRepository.prototype, 'settings');
    for (const body of [{ apify_api_token: 'private-secret' }, { APIFY_API_TOKEN_2: 'private-secret' }, { account_slot: 2, enabled: true }]) {
      const result = await PATCH(new Request(`${origin}/api/settings`, { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: ['settings'] }) });
      expect(result.status).toBe(400); expect(await result.text()).not.toContain('private-secret');
    }
    expect(write).not.toHaveBeenCalled();
  });
});
