import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { transcriptRequestSchema, validate } from '../src/lib/server/validation';

const workspace = 'ba100000-0000-4000-8000-000000000001';
const reel = 'ba100000-0000-4000-8000-000000000002';
const attempt = 'ba100000-0000-4000-8000-000000000003';
describe('transcript retry request authorization', () => {
  it('requires both the exact attempt and explicit duplicate-charge acceptance', () => {
    expect(validate(transcriptRequestSchema, {})).toEqual({});
    expect(validate(transcriptRequestSchema, { retry_attempt_id: attempt, accept_duplicate_charge: true })).toEqual({ retry_attempt_id: attempt, accept_duplicate_charge: true });
    for (const body of [null, [], { retry_attempt_id: attempt }, { accept_duplicate_charge: true }, { retry_attempt_id: attempt, accept_duplicate_charge: false }, { retry_attempt_id: 'bad', accept_duplicate_charge: true }, { retry_attempt_id: attempt, accept_duplicate_charge: true, reserved_usd: 0 }, { retry: true }]) {
      expect(() => validate(transcriptRequestSchema, body)).toThrow();
    }
  });
  it('keeps ordinary promotion separate and sends the fenced retry only after workspace authorization', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, workspace, 'owner@example.test');
    const authorize = vi.spyOn(repo, 'workspace').mockResolvedValue({ id: workspace, name: 'Test', slug: 'test', created_at: '', archived_at: null });
    await repo.requestTranscript(workspace, reel);
    expect(rpc).toHaveBeenLastCalledWith('request_reel_transcript', { p_workspace_id: workspace, p_reel_id: reel });
    await repo.requestTranscript(workspace, reel, { retry_attempt_id: attempt, accept_duplicate_charge: true });
    expect(rpc).toHaveBeenLastCalledWith('retry_reel_transcript', { p_workspace_id: workspace, p_reel_id: reel, p_attempt_id: attempt, p_accept_duplicate_charge: true });
    rpc.mockClear(); authorize.mockRejectedValue(new Error('Forbidden workspace'));
    await expect(repo.requestTranscript(workspace, reel, { retry_attempt_id: attempt, accept_duplicate_charge: true })).rejects.toThrow('Forbidden workspace');
    expect(rpc).not.toHaveBeenCalled();
  });
});
