'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { api } from './client';
import { getResourceCacheEpoch, optimisticallyUpdateResources } from './resource-cache';
import { savedReelResourceMatches } from './resource-dependencies';
import type { Reel, ReelCompletionStatus } from './types';

const pending = new Set<string>();
const listeners = new Set<() => void>();
const keyFor = (workspaceId: string, reelId: string) => JSON.stringify([getResourceCacheEpoch(), workspaceId, reelId]);
const publish = () => { for (const listener of listeners) listener(); };

function updateSaved(data: unknown, reelId: string, patch: { saved?: boolean; completion_status?: ReelCompletionStatus }): unknown {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    const next = data.map(item => updateSaved(item, reelId, patch));
    return next.some((item, index) => item !== data[index]) ? next : data;
  }
  const record = data as Record<string, unknown>;
  if (record.id === reelId && typeof record.saved === 'boolean') return Object.entries(patch).every(([key, value]) => record[key] === value) ? data : { ...record, ...patch };
  // Only the defined Reel containers are visited; unrelated objects are untouched.
  let result = record;
  for (const field of ['items', 'recent', 'reel']) {
    if (!(field in record)) continue;
    const value = updateSaved(record[field], reelId, patch);
    if (value !== record[field]) result = { ...result, [field]: value };
  }
  return result;
}

export function useReelSavePending(workspaceId: string, reelId: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const snapshot = useCallback(() => pending.has(keyFor(workspaceId, reelId)), [workspaceId, reelId]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export async function saveReel(workspaceId: string, reel: Reel): Promise<boolean> {
  const epoch = getResourceCacheEpoch();
  const key = keyFor(workspaceId, reel.id);
  if (pending.has(key)) return false;
  pending.add(key);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const settle = optimisticallyUpdateResources(path => savedReelResourceMatches(path, workspaceId), data => updateSaved(data, reel.id, { saved: !reel.saved, ...(reel.saved ? { completion_status: 'pending' } : {}) }));
  publish();
  try {
    await api(`${base}/saved${reel.saved ? '/' + encodeURIComponent(reel.id) : ''}`, {
      method: reel.saved ? 'DELETE' : 'POST',
      ...(reel.saved ? {} : { body: JSON.stringify({ reel_id: reel.id }) }),
    });
    settle(true);
    return getResourceCacheEpoch() === epoch;
  } catch (error) {
    settle(false);
    if (getResourceCacheEpoch() !== epoch) return false;
    throw error;
  } finally {
    pending.delete(key);
    publish();
  }
}

export async function setReelCompletion(workspaceId: string, reel: Reel): Promise<boolean> {
  const epoch = getResourceCacheEpoch(), key = keyFor(workspaceId, reel.id);
  if (!reel.saved || pending.has(key)) return false;
  const completion_status = reel.completion_status === 'done' ? 'pending' : 'done';
  pending.add(key);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const settle = optimisticallyUpdateResources(path => savedReelResourceMatches(path, workspaceId), data => updateSaved(data, reel.id, { completion_status }));
  publish();
  try {
    await api(`${base}/saved/${encodeURIComponent(reel.id)}`, { method: 'PATCH', body: JSON.stringify({ completion_status }) });
    settle(true);
    return getResourceCacheEpoch() === epoch;
  } catch (error) {
    settle(false);
    if (getResourceCacheEpoch() !== epoch) return false;
    throw error;
  } finally { pending.delete(key); publish(); }
}
