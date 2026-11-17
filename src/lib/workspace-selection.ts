'use client';

import { useCallback, useSyncExternalStore } from 'react';

const eventName = 'reelradar-workspace-selection';
const memory = new Map<string, string>();
export function workspaceSelectionKey(mode: string, email: string): string {
  return `reelradar:workspace:${mode}:${email.trim().toLowerCase()}`;
}

function read(key: string | null): string | null {
  if (!key || typeof window === 'undefined') return null;
  if (memory.has(key)) return memory.get(key)!;
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

export function rememberWorkspace(key: string, workspaceId: string): void {
  if (typeof window === 'undefined') return;
  memory.set(key, workspaceId);
  try { window.sessionStorage.setItem(key, workspaceId); } catch { /* Memory preserves navigation when storage is unavailable. */ }
  window.dispatchEvent(new Event(eventName));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
export function useWorkspaceSelection(key: string | null): string | null {
  const snapshot = useCallback(() => read(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
