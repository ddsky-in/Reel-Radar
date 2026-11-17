import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { ApiError } from '../src/lib/server/errors';
import { POST } from '../src/app/api/[...path]/route';
import { Carousels } from '../src/components/carousels';
import type { CarouselCollectionStatus, CreatorDirectoryEntry, Workspace } from '../src/lib/types';

const mocks = vi.hoisted(() => ({ client: {} as SupabaseClient, owner: 'owner', denied: false,
  wake: vi.fn((): string => 'queued'), api: vi.fn(), invalidate: vi.fn(), params: new URLSearchParams(),
  channels: [] as CreatorDirectoryEntry[], router: { replace: vi.fn(), push: vi.fn() }, slots: [] as unknown[], cursor: 0 }));
vi.mock('@/lib/supabase/server', () => ({ authenticatedClient: async () => {
  if (mocks.denied) throw new ApiError(403, 'FORBIDDEN', 'Owner access required.');
  return { client: mocks.client, user: { id: mocks.owner, email: 'owner@example.invalid' } };
}, createSupabaseServerClient: vi.fn() }));
vi.mock('@/lib/server/dispatcher', () => ({ scheduleDispatcherWake: mocks.wake }));
vi.mock('@/lib/client', () => ({ api: mocks.api, errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed' }));
vi.mock('@/lib/resource-cache', () => ({ invalidateResources: mocks.invalidate }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router, usePathname: () => '/carousels', useSearchParams: () => mocks.params }));
vi.mock('../src/components/ui', async () => ({ ...await vi.importActual<typeof import('../src/components/ui')>('../src/components/ui'),
  useResource: (path: string | null) => ({ loading: false, refreshing: false, error: '', data: path?.endsWith('/creator-directory') ? mocks.channels : { items: [], total: 0, page: 1, limit: 30 } }) }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  useState: (initial: unknown) => { const index = mocks.cursor++; if (!(index in mocks.slots)) mocks.slots[index] = initial;
    return [mocks.slots[index], (value: unknown) => { mocks.slots[index] = typeof value === 'function' ? value(mocks.slots[index]) : value; }]; },
  useContext: () => null,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useRef: (initial: unknown) => ({ current: initial }) }));

const workspace: Workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Research', slug: 'research', archived_at: null, created_at: '2026-11-15T00:00:00Z' };
const job = '22222222-2222-4222-8222-222222222222';
const origin = 'http://127.0.0.1:3100';
const status: CarouselCollectionStatus = { enabled: true, provider_validated: true, paused: false, reason: null, pending_jobs: 0, active_jobs: 0, last_fetch_at: null, next_due_at: null, interval_hours: 24, window_limit: 30 };
const directory = (count: number): CreatorDirectoryEntry[] => Array.from({ length: count }, (_, index) => ({ id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`, username: `channel${index}`, display_name: null, avatar_url: null, status: 'active' }));
let ownerSequence = 0;
function repository(count = 2, options: { member?: boolean; directoryError?: string; collection?: CarouselCollectionStatus } = {}) {
  const rows = directory(count);
  const eq = vi.fn();
  const from = vi.fn((table: string) => {
    const query = { select: vi.fn(() => query), eq: vi.fn((...args: unknown[]) => { eq(table, ...args); return query; }),
      maybeSingle: vi.fn(async () => ({ data: table === 'workspace_members' ? options.member === false ? null : { workspace_id: workspace.id } : workspace, error: null })) };
    return query;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === 'list_creator_directory') return { data: rows, error: options.directoryError ? { code: options.directoryError } : null };
    if (name === 'get_carousel_collection_status') return { data: options.collection ?? status, error: null };
    if (name === 'enqueue_carousel_refresh') return { data: { job_ids: [job] }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const client = { from, rpc } as unknown as SupabaseClient;
  mocks.client = client;
  return { repo: new SupabaseRepository(client, mocks.owner, 'owner@example.invalid'), rows, rpc, from, eq };
}
async function request(body: unknown = {}) {
  const path = ['workspaces', workspace.id, 'carousels', 'refresh'];
  return POST(new Request(`${origin}/api/${path.join('/')}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ path }) });
}
beforeEach(() => {
  mocks.owner = `owner-${++ownerSequence}`; mocks.denied = false; mocks.wake.mockReset().mockReturnValue('queued'); mocks.api.mockReset(); mocks.invalidate.mockReset(); mocks.router.replace.mockReset(); mocks.params = new URLSearchParams(); mocks.slots = []; mocks.cursor = 0; mocks.channels = directory(2);
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('DEMO_MODE', 'false'); vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('carousel collection authorized scope', () => {
  it('checks exact workspace and owner before directory, status or enqueue', async () => {
    const { repo, rpc, eq } = repository(2, { member: false });
    await expect(repo.refreshCarousels(workspace.id)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(eq.mock.calls).toEqual([['workspace_members', 'workspace_id', workspace.id], ['workspace_members', 'user_id', mocks.owner]]);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['42501', 'XX000'])('fails closed on directory failure %s without enqueue or fallback', async directoryError => {
    const { repo, rpc } = repository(2, { directoryError });
    await expect(repo.refreshCarousels(workspace.id)).rejects.toMatchObject({ code: directoryError === '42501' ? 'FORBIDDEN' : 'DATABASE_UNAVAILABLE' });
    expect(rpc.mock.calls).toEqual([['list_creator_directory', { p_workspace_id: workspace.id }]]);
  });
  it('requires explicit selection above 120; never slices or sends NULL', async () => {
    const { repo, rpc } = repository(121);
    await expect(repo.refreshCarousels(workspace.id)).rejects.toMatchObject({ status: 409, code: 'CAROUSEL_SELECTION_REQUIRED', message: expect.stringContaining('121 channels') });
    expect(rpc.mock.calls).toEqual([['list_creator_directory', { p_workspace_id: workspace.id }]]);
  });
  it('sends exactly the selected <=120 IDs once, preserving order and no invented counts', async () => {
    const { repo, rpc, rows } = repository(150);
    const ids = rows.slice(30).reverse().map(row => row.id);
    const result = await repo.refreshCarousels(workspace.id, ids);
    expect(rpc).toHaveBeenLastCalledWith('enqueue_carousel_refresh', { p_workspace_id: workspace.id, p_creator_ids: ids });
    expect(rpc.mock.calls.filter(([name]) => name === 'enqueue_carousel_refresh')).toHaveLength(1);
    expect(result).toMatchObject({ job_ids: [job], processing: 'queued', carousel_collection: { scope: 'selected', requested_creators: 120, selection_limit: 120, new_jobs: null, reused_jobs: null } });
    expect(result).not.toHaveProperty('reused');
    expect(result.message).toContain('queued or reused');
  });
  it('resolves <=120 workspace requests to explicit directory IDs', async () => {
    const { repo, rpc, rows } = repository(120);
    await repo.refreshCarousels(workspace.id);
    expect(rpc).toHaveBeenLastCalledWith('enqueue_carousel_refresh', { p_workspace_id: workspace.id, p_creator_ids: rows.map(row => row.id) });
  });
  it('rejects empty, oversize, and foreign selections before paid enqueue', async () => {
    const { repo, rpc } = repository(2);
    await expect(repo.refreshCarousels(workspace.id, [])).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(repo.refreshCarousels(workspace.id, directory(121).map(row => row.id))).rejects.toMatchObject({ code: 'CAROUSEL_SELECTION_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
    await expect(repo.refreshCarousels(workspace.id, [job])).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(rpc.mock.calls).toEqual([['list_creator_directory', { p_workspace_id: workspace.id }]]);
  });
  it('preserves disabled automatic pending work without duplicate manual jobs or claims', async () => {
    const { repo, rpc, rows } = repository(2, { collection: { ...status, enabled: false, reason: 'disabled', pending_jobs: 1 } });
    await expect(repo.refreshCarousels(workspace.id, [rows[0].id])).rejects.toMatchObject({ code: 'CAROUSEL_COLLECTION_BLOCKED' });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['list_creator_directory', 'get_carousel_collection_status']);
    expect(mocks.wake).not.toHaveBeenCalled();
  });
  it('allows explicit manual collection when automatic collection is disabled with no ambiguous pending work', async () => {
    const { repo, rows } = repository(2, { collection: { ...status, enabled: false, reason: 'disabled' } });
    expect(await repo.refreshCarousels(workspace.id, [rows[0].id])).toMatchObject({ processing: 'queued' });
  });
});

describe('carousel refresh API processing', () => {
  it('returns actionable configuration-required text, preserving legacy unknown counts', async () => {
    repository(); mocks.wake.mockReturnValue('configuration_required');
    const response = await request();
    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data).toMatchObject({ processing: 'configuration_required', message: expect.stringContaining('Processing configuration is required'), carousel_collection: { new_jobs: null, reused_jobs: null } });
    expect(data).not.toHaveProperty('wake_dispatcher'); expect(mocks.wake).toHaveBeenCalledOnce();
  });
  it('rejects empty and oversized selections without any RPC or wake', async () => {
    const { rpc } = repository();
    expect((await request({ creator_ids: [] })).status).toBe(400);
    const response = await request({ creator_ids: directory(121).map(row => row.id) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'CAROUSEL_SELECTION_REQUIRED' } });
    expect(rpc).not.toHaveBeenCalled(); expect(mocks.wake).not.toHaveBeenCalled();
  });
  it('returns selection guidance for an oversized workspace without a partial enqueue', async () => {
    const { rpc } = repository(121);
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CAROUSEL_SELECTION_REQUIRED', message: expect.stringContaining('Choose up to 120') } });
    expect(rpc.mock.calls).toEqual([['list_creator_directory', { p_workspace_id: workspace.id }]]);
    expect(mocks.wake).not.toHaveBeenCalled();
  });
  it('rejects foreign owners and disabled pending work without wake', async () => {
    const { rpc } = repository(2, { collection: { ...status, enabled: false, reason: 'disabled', pending_jobs: 1 } });
    mocks.denied = true; expect((await request()).status).toBe(403); expect(rpc).not.toHaveBeenCalled();
    mocks.denied = false; const response = await request(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CAROUSEL_COLLECTION_BLOCKED' } }); expect(mocks.wake).not.toHaveBeenCalled();
  });
  it.each(['blocked', 'in_progress'] as const)('does not override %s or schedule a wake', async processing => {
    vi.spyOn(SupabaseRepository.prototype, 'refreshCarousels').mockResolvedValue({ job_id: job, job_ids: [job], processing, wake_dispatcher: false, reused: true, message: 'Existing work preserved.' });
    const response = await request(); expect(await response.json()).toMatchObject({ processing, reused: true }); expect(mocks.wake).not.toHaveBeenCalled();
  });
});

type Props = { children?: ReactNode; onClick?: () => void | Promise<void>; disabled?: boolean; title?: string };
function control(tree: ReactNode, text: string): ReactElement<Props> {
  if (Array.isArray(tree)) { for (const child of tree) { try { return control(child, text); } catch { /* search siblings */ } } }
  else if (isValidElement<Props>(tree)) {
    if (tree.type === 'button' && (tree.props.children === text || Array.isArray(tree.props.children) && tree.props.children.includes(text))) return tree;
    if (tree.props.children) return control(tree.props.children, text);
  }
  throw new Error(`Control not found: ${text}`);
}
function view(notify = vi.fn(), savedOnly = false) { mocks.cursor = 0; return Carousels({ workspaceId: workspace.id, notify, savedOnly }); }
describe('carousel UI refresh controls', () => {
  it('shows <=120 guidance and disables unfiltered oversized collection', () => {
    mocks.channels = directory(121);
    expect(control(view(), 'Choose up to 120 channels').props.disabled).toBe(true);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('reloads only the exact filtered library and status without paid mutation or navigation', async () => {
    mocks.params = new URLSearchParams('keywords=hooks&page=2&saved=true');
    await control(view(), 'Reload library').props.onClick!();
    expect(mocks.invalidate.mock.calls).toEqual([[`/api/workspaces/${workspace.id}/carousel-summaries?keywords=hooks&limit=30&page=2&saved=true`], [`/api/workspaces/${workspace.id}/carousels/collection-status`]]);
    expect(mocks.api).not.toHaveBeenCalled(); expect(mocks.router.replace).not.toHaveBeenCalled();
    mocks.invalidate.mockClear(); await control(view(vi.fn(), true), 'Reload library').props.onClick!();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('rejects empty selection and malformed filters without falling back to ALL', async () => {
    mocks.params = new URLSearchParams({ creator_ids: '[]' });
    let tree = view();
    expect(control(tree, 'Collect carousels').props.disabled).toBe(true);
    await control(tree, 'Collect carousels').props.onClick!();
    expect(mocks.api).not.toHaveBeenCalled();
    mocks.params = new URLSearchParams({ creator_ids: 'not-a-list' });
    tree = view();
    expect(control(tree, 'Collect carousels').props.disabled).toBe(true);
    await control(tree, 'Collect carousels').props.onClick!();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('uses API processing for warning toast and preserves selected IDs and filters', async () => {
    const id = directory(1)[0].id; mocks.params = new URLSearchParams({ creator_ids: JSON.stringify([id]), keywords: 'hooks' });
    mocks.api.mockResolvedValue({ job_id: job, processing: 'configuration_required', message: 'Collection success' });
    const notify = vi.fn(); await control(view(notify), 'Collect carousels').props.onClick!();
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(`/api/workspaces/${workspace.id}/carousels/refresh`, { method: 'POST', body: JSON.stringify({ creator_ids: [id] }) });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Processing configuration is required'), 'error');
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });
});
