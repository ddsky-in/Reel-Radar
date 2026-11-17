import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { safeCollectionState } from '../src/lib/server/public-data';
import type { CreatorCollectionState, Workspace } from '../src/lib/types';
import { POST, GET } from '../src/app/api/[...path]/route';

const auth = vi.hoisted(() => ({ client: {} as SupabaseClient }));
const wake = vi.hoisted(() => vi.fn(() => 'queued'));
vi.mock('@/lib/supabase/server', () => ({ authenticatedClient: async () => ({ client: auth.client, user: { id: 'owner', email: 'owner@example.com' } }), createSupabaseServerClient: vi.fn() }));
vi.mock('@/lib/server/dispatcher', () => ({ scheduleDispatcherWake: wake }));

const workspace: Workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Research', slug: 'research', created_at: '2026-11-14T00:00:00Z', archived_at: null };
const job = '22222222-2222-4222-8222-222222222222';
const profile = '33333333-3333-4333-8333-333333333333';
const creator = '44444444-4444-4444-8444-444444444444';
const empty: CreatorCollectionState = { reason: null, blocking_job_id: null, pending_job_ids: [], active_job_ids: [], profiles: [] };
const origin = 'http://127.0.0.1:3100';

function repository(state: CreatorCollectionState, newIds: string[] = []) {
  const rpc = vi.fn().mockResolvedValue({ data: { job_ids: newIds }, error: null });
  const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, 'owner', 'owner@example.com');
  vi.spyOn(repo, 'workspace').mockResolvedValue(workspace);
  vi.spyOn(repo, 'collectionState').mockResolvedValue(state);
  return { repo, rpc };
}

beforeEach(() => { wake.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('existing creator collection work', () => {
  it('acknowledges pending profile and initial import jobs without duplicates', async () => {
    const { repo, rpc } = repository({ ...empty, pending_job_ids: [job, profile] });
    const result = await repo.refresh(workspace.id, [creator, creator]);
    expect(result).toMatchObject({ reused: true, job_id: job, job_ids: [job, profile], wake_dispatcher: true, processing: 'queued' });
    expect(result.message).toContain('without creating duplicates');
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('enqueue_refresh', { p_workspace_id: workspace.id, p_creator_ids: [creator], p_kind: 'manual' });
  });
  it('does not wake or restart active work with no pending jobs', async () => {
    const { repo } = repository({ ...empty, active_job_ids: [job] });
    expect(await repo.refresh(workspace.id)).toMatchObject({ reused: true, wake_dispatcher: false, processing: 'in_progress' });
  });
  it('preserves unresolved charge holds and exposes their blocking reason', async () => {
    const { repo } = repository({ ...empty, reason: 'unreconciled_charges', blocking_job_id: profile, pending_job_ids: [job], active_job_ids: [profile] });
    const result = await repo.refresh(workspace.id);
    expect(result).toMatchObject({ wake_dispatcher: false, processing: 'blocked', collection_state: { reason: 'unreconciled_charges' } });
    expect(result.message).toContain('unresolved charge');
  });
  it.each(['scraping_disabled', 'budget_paused'] as const)('does not wake blocked work: %s', async reason => {
    const { repo } = repository({ ...empty, reason, pending_job_ids: [job] });
    expect(await repo.refresh(workspace.id)).toMatchObject({ wake_dispatcher: false, processing: 'blocked' });
  });
  it('does not stop profile work merely because initial Reel imports are disabled', async () => {
    const { repo } = repository({ ...empty, reason: 'initial_import_disabled', pending_job_ids: [profile], profiles: [{ creator_id: creator, job_id: profile, status: 'pending' }] });
    expect(await repo.refresh(workspace.id)).toMatchObject({ wake_dispatcher: true, message: expect.stringContaining('Initial Reel imports are disabled') });
  });
  it('lets the worker refresh authoritative usage without claiming readiness', async () => {
    const { repo } = repository({ ...empty, reason: 'usage_unverified', pending_job_ids: [job] });
    const result = await repo.refresh(workspace.id);
    expect(result.wake_dispatcher).toBe(true);
    expect(result.message).toContain('has not been confirmed');
  });
  it('preserves genuinely new refresh jobs and rejects an empty queue', async () => {
    expect(await repository(empty, [job]).repo.refresh(workspace.id)).toMatchObject({ reused: false, wake_dispatcher: true });
    await expect(repository(empty).repo.refresh(workspace.id)).rejects.toMatchObject({ code: 'NO_JOB_ENQUEUED' });
  });
  it('authorizes before enqueue or collection lookup and rejects archives', async () => {
    const { repo, rpc } = repository(empty);
    vi.mocked(repo.workspace).mockRejectedValueOnce(new Error('not allowed'));
    await expect(repo.refresh(workspace.id)).rejects.toThrow('not allowed');
    expect(repo.collectionState).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    vi.mocked(repo.workspace).mockResolvedValue({ ...workspace, archived_at: '2026-11-14T00:00:00Z' });
    await expect(repo.refresh(workspace.id)).rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('read-only collection state', () => {
  it('calls only the scoped status RPC after authorization', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: empty, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, 'owner', 'owner@example.com');
    vi.spyOn(repo, 'workspace').mockResolvedValue(workspace);
    expect(await repo.collectionState(workspace.id, [creator, creator])).toEqual(empty);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_creator_collection_state', { p_workspace_id: workspace.id, p_creator_ids: [creator] });
  });
  it('strips privileged fields and rejects unknown reasons or malformed jobs', () => {
    const raw = { ...empty, reason: 'unreconciled_charges', blocking_job_id: job, pending_job_ids: [job, job], profiles: [{ creator_id: creator, job_id: profile, status: 'partial', nonce: 'private-secret' }], token: 'private-secret' };
    expect(safeCollectionState(raw)).toEqual({ ...empty, reason: 'unreconciled_charges', blocking_job_id: job, pending_job_ids: [job], profiles: [{ creator_id: creator, job_id: profile, status: 'partial' }] });
    expect(JSON.stringify(safeCollectionState(raw))).not.toContain('private');
    for (const patch of [{ reason: 'secret-error' }, { pending_job_ids: ['invalid'] }, { active_job_ids: null }, { profiles: [{ creator_id: creator, job_id: profile, status: 'invented' }] }, { blocking_job_id: 'invalid' }]) expect(() => safeCollectionState({ ...empty, ...patch })).toThrow('Collection status could not be loaded');
  });
  it('never creates jobs or live data in demo status reads', async () => {
    const repo = new DemoRepository(), data = await repo.bootstrap();
    expect(await repo.collectionState(data.workspaces[0].id)).toEqual({ ...empty, reason: 'scraping_disabled' });
    expect(await repo.bootstrap()).toEqual(data);
  });
});

describe('collection API wake and status contracts', () => {
  beforeEach(() => { vi.stubEnv('DEMO_MODE', 'false'); vi.stubEnv('NODE_ENV', 'development'); vi.spyOn(SupabaseRepository.prototype, 'workspace').mockResolvedValue(workspace); });
  async function refresh(result: Awaited<ReturnType<SupabaseRepository['refresh']>>) {
    vi.spyOn(SupabaseRepository.prototype, 'refresh').mockResolvedValue(result);
    return POST(new Request(`${origin}/api/refresh`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspace.id, creator_ids: [creator] }) }), { params: Promise.resolve({ path: ['refresh'] }) });
  }
  it('wakes existing pending work once and never exposes its internal wake flag', async () => {
    const response = await refresh(await repository({ ...empty, pending_job_ids: [job] }).repo.refresh(workspace.id));
    expect(response.status).toBe(202); expect(wake).toHaveBeenCalledOnce();
    const data = await response.json(); expect(data).toMatchObject({ reused: true, processing: 'queued' }); expect(data).not.toHaveProperty('wake_dispatcher');
  });
  it('does not call dispatch on blocked or active-only work', async () => {
    const result = await repository({ ...empty, reason: 'unreconciled_charges', pending_job_ids: [job] }).repo.refresh(workspace.id);
    const response = await refresh(result);
    expect(response.status).toBe(202); expect(wake).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ processing: 'blocked', message: result.message });
  });
  it('reads authorized status without a wake and rejects query overrides', async () => {
    vi.spyOn(SupabaseRepository.prototype, 'collectionState').mockResolvedValue(empty);
    const path = ['workspaces', workspace.id, 'collection-status'];
    const request = async (query = '') => GET(new Request(`${origin}/api/${path.join('/')}${query}`), { params: Promise.resolve({ path }) });
    const response = await request(); expect(response.status).toBe(200); expect(await response.json()).toEqual(empty); expect(wake).not.toHaveBeenCalled();
    expect((await request('?owner=foreign')).status).toBe(400);
  });
});
