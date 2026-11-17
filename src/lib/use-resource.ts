'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  getResourceServerSnapshot,
  getResourceSnapshot,
  invalidateResources,
  subscribeResource,
  type ResourceState,
} from './resource-cache';

export function useResource<T>(path: string | null, revision = 0): ResourceState<T> {
  const subscribe = useCallback((listener: () => void) => subscribeResource(path, listener), [path]);
  const snapshot = useCallback(() => getResourceSnapshot<T>(path), [path]);
  const serverSnapshot = useCallback(() => getResourceServerSnapshot<T>(path), [path]);
  const resource = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const previous = useRef({ path, revision });

  useEffect(() => {
    const prior = previous.current;
    previous.current = { path, revision };
    // Revision is a refresh trigger, not cache identity. Subscription owns the
    // first load and path changes; only same-path revision changes invalidate.
    if (path && prior.path === path && prior.revision !== revision) invalidateResources(path);
  }, [path, revision]);

  return resource;
}
