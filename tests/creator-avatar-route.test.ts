import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../src/app/api/[...path]/route';
import { createDemoData } from '../src/lib/demo';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import type { Creator } from '../src/lib/types';

// Exercise the real authenticatedClient/repository/route. Only cookie access,
// the Supabase client boundary, media transport and dispatcher are substituted.
// This is the same backend harness used by carousel-download.test.ts.
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, from: vi.fn(), rpc: vi.fn() }));
const network = vi.hoisted(() => ({ read: vi.fn(), wake: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => client }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock('../src/lib/server/media-transport', () => ({ readMediaResponse: network.read }));
vi.mock('@/lib/server/dispatcher', () => ({ scheduleDispatcherWake: network.wake }));

const fixture = createDemoData(), workspaceId = fixture.workspaces[0].id, creatorId = fixture.creators[0].id;
const origin = 'http://127.0.0.1:3100';
const ownerId = '00000000-0000-4000-8000-000000000001', ownerEmail = 'owner@example.test';
const unknownId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
let storedCreator: Creator, sequence = 0;
const mutations = ['addCreator', 'removeCreator', 'importCreators', 'refresh', 'refreshCarousels', 'requestCreatorSourceRefresh', 'updateWorkspace', 'settings'] as const;

function api(query = '', workspace = workspaceId, creator = creatorId, init: RequestInit = {}) {
  const path = ['workspaces', workspace, 'creators', creator, 'avatar'];
  const request = new Request(`${origin}/api/${path.join('/')}${query ? '?' + query : ''}`, init);
  return { request, response: GET(request, { params: Promise.resolve({ path }) }) };
}
function mediaResponse() { return new Response(new Uint8Array(jpeg), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(jpeg.length) } }); }
function authorizeOwner() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test');
  vi.stubEnv('OWNER_USER_ID', ownerId); vi.stubEnv('OWNER_EMAIL', ownerEmail);
  client.auth.getUser.mockResolvedValue({ data: { user: { id: ownerId, email: ownerEmail } }, error: null });
  client.from.mockImplementation((table: string) => {
    if (!['workspace_members', 'workspaces'].includes(table)) throw new Error(`Unexpected table: ${table}`);
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: table === 'workspace_members' ? { workspace_id: workspaceId } : fixture.workspaces[0], error: null });
    return chain;
  });
  client.rpc.mockImplementation(async (name: string) => {
    if (name !== 'get_creator') throw new Error(`Avatar GET must not invoke ${name}`);
    return { data: storedCreator, error: null };
  });
}
function denyMembership() {
  client.from.mockImplementation(() => {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); return chain;
  });
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store, private');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.json()).toMatchObject({ error: { code } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DEMO_MODE', 'false'); vi.stubEnv('SCRAPING_ENABLED', 'false');
  vi.stubEnv('ALLOW_LOCAL_DEMO', 'false'); vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OWNER_USER_ID', 'OWNER_EMAIL']) vi.stubEnv(key, '');
  vi.stubGlobal('__reelradarDemo', undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Avatar tests must never make external fetch calls'); }));
  network.read.mockImplementation(() => { throw new Error('Unexpected media request'); });
  // Different signed source per test prevents success-cache leakage between cases.
  storedCreator = { ...fixture.creators[0], avatar_url: `https://images.cdninstagram.com/stored.jpg?token=private&case=${++sequence}`,
    tracked_reels: 0, latest_reel_date: null, initial_backfill_job_id: null, initial_backfill_status: null };
  for (const method of mutations) {
    vi.spyOn(DemoRepository.prototype, method);
    vi.spyOn(SupabaseRepository.prototype, method);
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(network.wake).not.toHaveBeenCalled();
    for (const method of mutations) {
      expect(DemoRepository.prototype[method]).not.toHaveBeenCalled();
      expect(SupabaseRepository.prototype[method]).not.toHaveBeenCalled();
    }
    expect(client.rpc.mock.calls.every(([name]) => name === 'get_creator')).toBe(true);
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

describe('creator avatar GET authentication and scope', () => {
  it('fails closed without production Supabase/owner configuration before any client or media work', async () => {
    await expectError(await api().response, 503, 'CONFIG_REQUIRED');
    expect(client.auth.getUser).not.toHaveBeenCalled(); expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled(); expect(network.read).not.toHaveBeenCalled();
  });

  it.each([
    { user: null, error: null, status: 401, code: 'UNAUTHENTICATED' },
    { user: { id: ownerId, email: ownerEmail }, error: { message: 'expired session' }, status: 401, code: 'UNAUTHENTICATED' },
    { user: { id: unknownId, email: ownerEmail }, error: null, status: 403, code: 'OWNER_ONLY' },
    { user: { id: ownerId, email: 'not-owner@example.test' }, error: null, status: 403, code: 'OWNER_ONLY' },
  ])('rejects unauthenticated/non-owner sessions with $status before reads', async ({ user, error, status, code }) => {
    authorizeOwner(); client.auth.getUser.mockResolvedValue({ data: { user }, error });
    await expectError(await api('', workspaceId, creatorId, { headers: { 'x-owner-id': ownerId } }).response, status, code);
    expect(client.auth.getUser).toHaveBeenCalledOnce(); expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled(); expect(network.read).not.toHaveBeenCalled();
  });

  it('uses current owner/workspace authorization and only the stored creator URL, returning private inline bytes', async () => {
    authorizeOwner();
    network.read.mockImplementation((url: string) => {
      expect(client.auth.getUser).toHaveBeenCalledOnce();
      expect(client.from.mock.calls).toEqual([['workspace_members'], ['workspaces']]);
      const membership = client.from.mock.results[0].value;
      expect(membership.eq.mock.calls).toEqual([['workspace_id', workspaceId], ['user_id', ownerId]]);
      expect(client.from.mock.results[1].value.eq).toHaveBeenCalledWith('id', workspaceId);
      expect(client.rpc).toHaveBeenCalledExactlyOnceWith('get_creator', { p_workspace_id: workspaceId, p_creator_id: creatorId });
      expect(url).toBe(storedCreator.avatar_url);
      return Promise.resolve(mediaResponse());
    });
    const storedBefore = structuredClone(storedCreator), abort = new AbortController();
    const { response } = api('', workspaceId, creatorId, { signal: abort.signal, headers: { 'x-owner-id': unknownId } });
    const result = await response;
    expect(result.status).toBe(200);
    expect(Object.fromEntries(result.headers)).toEqual({
      'cache-control': 'no-store, private', 'content-disposition': 'inline', 'content-length': String(jpeg.length),
      'content-type': 'image/jpeg', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    });
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(jpeg);
    expect(network.read).toHaveBeenCalledOnce(); expect(storedCreator).toEqual(storedBefore);
  });

  it('rechecks membership on a warm cache and denies foreign workspaces before RPC or media access', async () => {
    authorizeOwner(); network.read.mockResolvedValue(mediaResponse());
    expect((await api().response).status).toBe(200);
    network.read.mockClear(); client.rpc.mockClear(); denyMembership();
    await expectError(await api().response, 404, 'NOT_FOUND');
    await expectError(await api('', unknownId).response, 404, 'NOT_FOUND');
    expect(client.rpc).not.toHaveBeenCalled(); expect(network.read).not.toHaveBeenCalled();
  });

  it.each([['42501', 403, 'FORBIDDEN'], ['P0002', 404, 'NOT_FOUND']] as const)('rejects denied/missing creator RPC %s without media or fallback reads', async (databaseCode, status, code) => {
    authorizeOwner(); client.rpc.mockResolvedValue({ data: null, error: { code: databaseCode } });
    await expectError(await api().response, status, code);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('get_creator', { p_workspace_id: workspaceId, p_creator_id: creatorId });
    expect(network.read).not.toHaveBeenCalled();
  });

  it('propagates an already-aborted request after authorization without media access', async () => {
    authorizeOwner(); const abort = new AbortController(); abort.abort();
    await expectError(await api('', workspaceId, creatorId, { signal: abort.signal }).response, 502, 'CREATOR_AVATAR_UNAVAILABLE');
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('get_creator', { p_workspace_id: workspaceId, p_creator_id: creatorId });
    expect(network.read).not.toHaveBeenCalled();
  });
});

describe('creator avatar GET validation and synthetic demo safety', () => {
  it.each(['url=https%3A%2F%2Fevil.invalid%2Favatar', 'owner_id=' + unknownId, 'refresh=true', 'token=secret', 'v=1', 'url=a&url=b'])('rejects query %s before repository or network access', async query => {
    authorizeOwner(); await expectError(await api(query).response, 400, 'INVALID_QUERY');
    expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled(); expect(network.read).not.toHaveBeenCalled();
  });

  it.each([['not-a-workspace', creatorId], [workspaceId, 'not-a-creator'], ['', creatorId], [workspaceId, 'avatar.jpg']])('rejects malformed workspace/creator IDs %s %s before reads', async (workspace, creator) => {
    authorizeOwner(); await expectError(await api('', workspace, creator).response, 400, 'INVALID_INPUT');
    expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled(); expect(network.read).not.toHaveBeenCalled();
  });

  it('denies demo avatars even with a real-looking stored source and preserves all synthetic records/jobs', async () => {
    vi.stubEnv('DEMO_MODE', 'true'); vi.stubEnv('ALLOW_LOCAL_DEMO', 'true');
    const data = createDemoData(); data.creators[0].avatar_url = storedCreator.avatar_url;
    const state = { data, saved: [] }; vi.stubGlobal('__reelradarDemo', state);
    const before = structuredClone(state), read = vi.spyOn(DemoRepository.prototype, 'creator');
    await expectError(await api().response, 404, 'CREATOR_AVATAR_UNAVAILABLE');
    expect(read).toHaveBeenCalledExactlyOnceWith(workspaceId, creatorId);
    expect(state).toEqual(before); expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled(); expect(network.read).not.toHaveBeenCalled();
  });

  it('keeps workspace and active creator scoping in demo denials', async () => {
    vi.stubEnv('DEMO_MODE', 'true'); vi.stubEnv('ALLOW_LOCAL_DEMO', 'true');
    const data = createDemoData(), link = data.workspaceCreators.find(link => link.workspace_id === workspaceId && link.creator_id === creatorId)!;
    link.active = false;
    const state = { data, saved: [] }; vi.stubGlobal('__reelradarDemo', state);
    const before = structuredClone(state);
    await expectError(await api().response, 404, 'NOT_FOUND');
    await expectError(await api('', unknownId).response, 404, 'NOT_FOUND');
    await expectError(await api('', workspaceId, unknownId).response, 404, 'NOT_FOUND');
    expect(state).toEqual(before); expect(network.read).not.toHaveBeenCalled(); expect(client.auth.getUser).not.toHaveBeenCalled();
  });
});
