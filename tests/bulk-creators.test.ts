import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { creatorListToCsv, MAX_BULK_CREATOR_INPUT } from '../src/lib/creator-import';
import { parseCreatorCsv, previewCsv } from '../src/lib/server/csv';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';

describe('bulk creator list parsing', () => {
  it('accepts mixed usernames and profile links with commas, Windows newlines, and blank entries', () => {
    const csv = creatorListToCsv('  @First_Creator ,\r\n\r\nhttps://www.instagram.com/Second.Creator/?igsh=example==\nTHIRD_CREATOR, instagram.com/fourth/reels/ , ');
    const rows = previewCsv(parseCreatorCsv(csv, 'Research'), new Map());
    expect(rows.map(row => row.username)).toEqual(['first_creator', 'second.creator', 'third_creator', 'fourth']);
    expect(rows.every(row => row.status === 'ready' && row.workspace === 'Research')).toBe(true);
  });

  it('normalizes before detecting repeated and already tracked profiles', () => {
    const csv = creatorListToCsv('@Creator, https://instagram.com/CREATOR/?igsh=test\ncreator\ntracked');
    const rows = previewCsv(parseCreatorCsv(csv, 'Research'), new Map([['research', new Set(['tracked'])]]));
    expect(rows.map(row => row.status)).toEqual(['ready', 'duplicate', 'duplicate', 'duplicate']);
  });

  it('preserves invalid entries for review instead of turning words into unintended usernames', () => {
    const inputs = ['valid_creator', 'bad username', 'https://evil.test/profile', 'https://instagram.com/reel/ABC123/', 'https://instagram.com/p/ABC123/', 'https://instagram.com/explore/', 'javascript:alert(1)', 'a'.repeat(31)];
    const rows = previewCsv(parseCreatorCsv(creatorListToCsv(inputs.join('\n')), 'Research'), new Map());
    expect(rows.map(row => row.input)).toEqual(inputs);
    expect(rows[0].status).toBe('ready');
    expect(rows.slice(1).every(row => row.status === 'invalid' && row.error)).toBe(true);
  });

  it('quotes untrusted entries without allowing extra CSV columns or workspace destinations', () => {
    const rows = parseCreatorCsv(creatorListToCsv('@valid\nbad""name\n=HYPERLINK("https://evil.test")\n"attacker","Other Workspace"'), 'Selected workspace');
    expect(rows[0].username).toBe('valid');
    expect(rows[1].input).toBe('bad""name');
    expect(rows.every(row => row.workspace === 'Selected workspace')).toBe(true);
    expect(rows.slice(1).every(row => row.username === null)).toBe(true);
  });

  it.each(['', ' \r\n , ,, \n '])('rejects an empty list (%j)', input => {
    expect(() => creatorListToCsv(input)).toThrow('Paste at least one');
  });

  it('accepts 1,000 entries but rejects excess rows or text without truncating profiles', () => {
    const input = Array.from({ length: 1000 }, (_, index) => `creator_${index}`).join('\n');
    expect(parseCreatorCsv(creatorListToCsv(input), 'Research')).toHaveLength(1000);
    expect(() => creatorListToCsv(`${input}\nlast_creator`)).toThrow('up to 1,000');
    expect(() => creatorListToCsv('x'.repeat(MAX_BULK_CREATOR_INPUT + 1))).toThrow('too long');
  });
});

describe('bulk additions through the shared import transaction', () => {
  beforeEach(() => {
    delete (globalThis as typeof globalThis & { __reelradarDemo?: unknown }).__reelradarDemo;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls forbidden in this test'));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('previews without mutation, adds only valid unique profiles, and safely handles retries', async () => {
    const repo = new DemoRepository();
    const before = await repo.bootstrap();
    const workspace = before.workspaces[0];
    const existing = await repo.creators(workspace.id);
    const csv = creatorListToCsv(`@bulk_first\nhttps://instagram.com/Bulk_Second/?igsh=fixture\nBULK_FIRST,@${existing[0].username}\nhttps://evil.test/profile`);

    const preview = await repo.importCreators(workspace.id, csv, true);
    expect(preview).toMatchObject({ added: 0, duplicates: 2, invalid: 1 });
    expect(preview.rows.filter(row => row.status === 'ready')).toHaveLength(2);
    expect(await repo.creators(workspace.id)).toEqual(existing);
    expect(await repo.bootstrap()).toEqual(before);

    expect(await repo.importCreators(workspace.id, csv, false)).toMatchObject({ added: 2, duplicates: 2, invalid: 1 });
    expect(await repo.creators(workspace.id)).toHaveLength(existing.length + 2);
    const first = (await repo.creators(workspace.id)).find(creator => creator.username === 'bulk_first');
    expect(first).toMatchObject({ followers_count: null, display_name: null, status: 'pending', tracked_reels: 0 });
    expect(await repo.importCreators(workspace.id, csv, false)).toMatchObject({ added: 0, duplicates: 4, invalid: 1 });
    expect(await repo.creators(workspace.id)).toHaveLength(existing.length + 2);
    expect((await repo.bootstrap()).workspaces).toEqual(before.workspaces);
    expect((await repo.bootstrap()).jobs).toEqual(before.jobs);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('links a shared creator only to the selected workspace and leaves other workspaces intact', async () => {
    const repo = new DemoRepository();
    const source = (await repo.bootstrap()).workspaces[0];
    const existing = await repo.creators(source.id);
    const target = await repo.createWorkspace('Bulk destination');
    const csv = creatorListToCsv(`@${existing[0].username}, bulk_new_shared`);
    expect(await repo.importCreators(target.id, csv, false)).toMatchObject({ added: 2, duplicates: 0 });
    expect((await repo.creators(target.id)).find(creator => creator.username === existing[0].username)?.id).toBe(existing[0].id);
    expect(await repo.creators(source.id)).toEqual(existing);
  });

  it('rolls back the whole batch when capacity is exceeded', async () => {
    const repo = new DemoRepository();
    const { workspaces } = await repo.bootstrap();
    const before = await Promise.all(workspaces.map(workspace => repo.creators(workspace.id)));
    const activeCount = new Set(before.flat().map(creator => creator.id)).size;
    await repo.settings({ capacity: activeCount + 1 });
    const csv = creatorListToCsv('@bulk_overflow_one\n@bulk_overflow_two');
    await expect(repo.importCreators(workspaces[0].id, csv, false)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(await Promise.all(workspaces.map(workspace => repo.creators(workspace.id)))).toEqual(before);
    expect((await repo.bootstrap()).workspaces).toEqual(workspaces);
  });

  it('rejects archived and missing destination workspaces even for previews', async () => {
    const repo = new DemoRepository();
    const workspace = await repo.createWorkspace('Archived bulk destination');
    await repo.updateWorkspace(workspace.id, { archived: true });
    const csv = creatorListToCsv('@bulk_denied');
    for (const preview of [true, false]) {
      await expect(repo.importCreators(workspace.id, csv, preview)).rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' });
      await expect(repo.importCreators('00000000-0000-4000-8000-000000000099', csv, preview)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('refuses Supabase preview and commit before any data RPC when membership is absent', async () => {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    const client = { from: vi.fn().mockReturnValue(chain), rpc: vi.fn() };
    const repo = new SupabaseRepository(client as unknown as SupabaseClient, 'owner', 'owner@example.test');
    const csv = creatorListToCsv('@bulk_denied');
    for (const preview of [true, false]) await expect(repo.importCreators('00000000-0000-4000-8000-000000000099', csv, preview)).rejects.toMatchObject({ status: 404 });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('uses authoritative transaction counts if another import adds a profile after preview', async () => {
    const bootstrap = await new DemoRepository().bootstrap();
    const workspace = bootstrap.workspaces[0];
    const rpc = vi.fn().mockResolvedValue({ data: { added: 1, duplicates: 1, workspaces_created: 0, job_ids: [] }, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, 'owner', 'owner@example.test');
    vi.spyOn(repo, 'workspace').mockResolvedValue(workspace);
    vi.spyOn(repo, 'bootstrap').mockResolvedValue({ ...bootstrap, workspaces: [workspace] });
    vi.spyOn(repo, 'creators').mockResolvedValue([]);
    const csv = creatorListToCsv('@bulk_raced,@bulk_new');
    expect((await repo.importCreators(workspace.id, csv, true)).rows.filter(row => row.status === 'ready')).toHaveLength(2);
    expect(rpc).not.toHaveBeenCalled();
    expect(await repo.importCreators(workspace.id, csv, false)).toMatchObject({ added: 1, duplicates: 1 });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('import_creators', {
      p_workspace_id: workspace.id,
      p_rows: [{ username: 'bulk_raced', workspace: workspace.name }, { username: 'bulk_new', workspace: workspace.name }],
    });
  });
});
