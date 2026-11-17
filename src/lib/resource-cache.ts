import { resourceMatchesFamilies, type ResourceFamily, type ResourcePredicate } from './resource-dependencies';

export type { ResourceFamily, ResourcePredicate } from './resource-dependencies';

export interface ResourceState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error: string | null;
}

export interface ResourceCacheOptions {
  load?: (path: string, signal: AbortSignal) => Promise<unknown>;
  maxEntries?: number;
  debounceMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
}

type Listener = () => void;
type Subscription = { listener: Listener };
type PendingRequest = {
  controller: AbortController;
  dirty: boolean;
  urgent: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};
type Entry = {
  path: string;
  data: unknown;
  snapshot: ResourceState<unknown>;
  hasValue: boolean;
  stale: boolean;
  listeners: Set<Subscription>;
  pending: PendingRequest | null;
  failures: number;
  retryAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

const EMPTY: ResourceState<never> = Object.freeze({ data: null, loading: false, refreshing: false, error: null });
const INITIAL: ResourceState<never> = Object.freeze({ data: null, loading: true, refreshing: false, error: null });

// Keep reads below client.ts: that module can invalidate successful mutations
// without a circular import. These are the same authenticated API GET semantics.
async function fetchResource(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.error?.message === 'string'
      ? body.error.message
      : `Request failed (${response.status}). Please try again.`;
    throw Object.assign(new Error(message), {
      name: 'ApiError', code: body?.error?.code ?? 'REQUEST_FAILED', status: response.status,
    });
  }
  if (response.status === 204) return undefined;
  return response.json();
}

export function createResourceCache(options: ResourceCacheOptions = {}) {
  const load = options.load ?? fetchResource;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 100));
  const debounceMs = options.debounceMs ?? 350;
  const maxWaitMs = options.maxWaitMs ?? 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  // Map insertion order is the LRU order; identities depend on path, never revision.
  const entries = new Map<string, Entry>();
  const optimisticLayers = new Map<symbol, { matches: (path: string) => boolean; transform: (data: unknown) => unknown }>();
  let epoch = 0;
  const notifications = new Set<Entry>();
  let notificationQueued = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maximumTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduledPredicates = new Set<ResourcePredicate>();
  const scheduledConsumedPaths = new Set<string>();
  let scheduledFull = false;

  function notify(entry: Entry) {
    if (!entry.listeners.size) return;
    notifications.add(entry);
    if (notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      const changed = [...notifications];
      notifications.clear();
      for (const current of changed) {
        for (const subscription of [...current.listeners]) subscription.listener();
      }
    });
  }

  function update(entry: Entry, next: ResourceState<unknown>) {
    const previous = entry.snapshot;
    if (Object.is(previous.data, next.data) && previous.loading === next.loading
      && previous.refreshing === next.refreshing && previous.error === next.error) return;
    entry.snapshot = Object.freeze(next);
    notify(entry);
  }

  function renderData(entry: Entry) {
    let data = entry.data;
    for (const layer of optimisticLayers.values()) if (layer.matches(entry.path)) data = layer.transform(data);
    update(entry, { ...entry.snapshot, data });
  }

  function touch(entry: Entry) {
    entries.delete(entry.path);
    entries.set(entry.path, entry);
  }

  function cancelDeadline(pending: PendingRequest) {
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  function abort(entry: Entry) {
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    const pending = entry.pending;
    entry.pending = null; // Detach first: even loaders ignoring abort cannot commit.
    if (!pending) return;
    cancelDeadline(pending);
    pending.controller.abort();
  }

  function prune() {
    for (const [path, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (entry.listeners.size) continue; // Never evict an actively observed resource.
      abort(entry);
      notifications.delete(entry);
      entries.delete(path);
    }
  }

  function start(entry: Entry) {
    if (!entry.listeners.size || entry.pending || (!entry.stale && entry.hasValue)) return;
    if (entry.retryAt > Date.now()) {
      if (entry.retryTimer === null) entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null; entry.retryAt = 0; start(entry);
      }, entry.retryAt - Date.now());
      return;
    }
    const pending: PendingRequest = { controller: new AbortController(), dirty: false, urgent: false, timeout: null };
    entry.pending = pending;
    entry.stale = false;
    update(entry, { ...entry.snapshot, loading: !entry.hasValue, refreshing: entry.hasValue, error: null });

    // Subscription is an effect, not render. Defer the loader as well so a
    // subscribe/unsubscribe Strict Mode probe does not issue an obsolete request.
    void Promise.resolve().then(() => {
      if (entry.pending !== pending || pending.controller.signal.aborted) return;
      // Events before the GET actually starts are included in this read, not a
      // second trailing refresh (including events during a deferred retry).
      pending.dirty = false;
      pending.urgent = false;
      entry.stale = false;
      pending.timeout = setTimeout(() => {
        if (entry.pending !== pending) return;
        update(entry, {
          ...entry.snapshot, loading: false, refreshing: false,
          error: 'Loading took too long. Please try again.',
        });
        // Settle independently of the loader and detach before aborting. A
        // loader may ignore abort, or reject with an unhelpful AbortError.
        finish(entry, pending, true);
        pending.controller.abort();
      }, requestTimeoutMs);
      return load(entry.path, pending.controller.signal);
    }).then(data => {
      if (entry.pending !== pending || pending.controller.signal.aborted) return;
      entry.hasValue = true;
      entry.data = data ?? null;
      renderData(entry);
      update(entry, { ...entry.snapshot, loading: false, refreshing: false, error: null });
      finish(entry, pending);
    }, error => {
      if (entry.pending !== pending || pending.controller.signal.aborted) return;
      update(entry, {
        ...entry.snapshot, loading: false, refreshing: false,
        error: error instanceof Error ? error.message : 'Something went wrong. Please try again.',
      });
      finish(entry, pending, true);
    });
  }

  function finish(entry: Entry, pending: PendingRequest, failed = false) {
    if (entry.pending !== pending) return;
    cancelDeadline(pending);
    entry.pending = null;
    entry.failures = failed ? Math.min(entry.failures + 1, 6) : 0;
    // Background signals share a capped cooldown after failed reads. Explicit
    // retries/mutations remain immediate, and last-good data remains visible.
    entry.retryAt = failed && !pending.urgent ? Date.now() + Math.min(30_000, 1000 * 2 ** (entry.failures - 1)) : 0;
    entry.stale = pending.dirty;
    touch(entry);
    // An event arriving in flight requires one trailing request, not an abort
    // storm and not a discarded invalidation. Further events share that request.
    if (entry.stale) start(entry);
    prune();
  }

  function getSnapshot<T>(path: string | null): ResourceState<T> {
    if (!path) return EMPTY;
    return (entries.get(path)?.snapshot ?? INITIAL) as ResourceState<T>;
  }

  function getServerSnapshot<T>(path: string | null): ResourceState<T> {
    // Never expose an owner's module cache through SSR or hydration.
    return path ? INITIAL : EMPTY;
  }

  function subscribe(path: string | null, listener: Listener): () => void {
    if (!path) return () => {};
    let entry = entries.get(path);
    if (!entry) {
      entry = { path, data: null, snapshot: INITIAL, hasValue: false, stale: true, listeners: new Set(), pending: null,
        failures: 0, retryAt: 0, retryTimer: null };
      entries.set(path, entry);
    }
    const current = entry;
    const subscription = { listener };
    current.listeners.add(subscription);
    touch(current);
    start(current);
    prune();
    return () => {
      if (!current.listeners.delete(subscription)) return;
      if (!current.listeners.size) {
        abort(current);
        current.stale = true; // Revisit cached paths with last-good data and a fresh GET.
        update(current, { ...current.snapshot, loading: !current.hasValue && current.snapshot.error === null, refreshing: false });
        notifications.delete(current);
        touch(current);
        prune();
      }
    };
  }

  function cancelScheduledInvalidation() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (maximumTimer !== null) clearTimeout(maximumTimer);
    debounceTimer = null;
    maximumTimer = null;
    scheduledPredicates.clear();
    scheduledConsumedPaths.clear();
    scheduledFull = false;
  }

  function invalidateEntry(entry: Entry, immediate = true) {
    if (immediate) {
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
      entry.retryTimer = null; entry.failures = 0; entry.retryAt = 0;
    }
    entry.stale = true;
    // Pending optimistic writes own their settlement refresh. Keep their overlay
    // and avoid starting a GET that settlement would immediately abort/replay.
    if ([...optimisticLayers.values()].some(layer => layer.matches(entry.path))) return;
    if (entry.pending) { entry.pending.dirty = true; entry.pending.urgent ||= immediate; }
    else start(entry);
  }

  function invalidateWhere(matches: ResourcePredicate) {
    for (const entry of entries.values()) {
      if (!matches(entry.path)) continue;
      // An immediate mutation absorbs only this scope, not another family's
      // queued event. New events remove the consumed marker for affected paths.
      if (debounceTimer !== null || maximumTimer !== null) scheduledConsumedPaths.add(entry.path);
      invalidateEntry(entry);
    }
  }

  function invalidate(path?: string) {
    if (path === undefined) {
      cancelScheduledInvalidation();
      for (const entry of entries.values()) invalidateEntry(entry);
    } else invalidateWhere(current => current === path);
  }

  function flushScheduledInvalidation() {
    const full = scheduledFull, predicates = [...scheduledPredicates], consumed = new Set(scheduledConsumedPaths);
    cancelScheduledInvalidation();
    for (const entry of entries.values()) {
      if (!consumed.has(entry.path) && (full || predicates.some(matches => matches(entry.path)))) invalidateEntry(entry, false);
    }
  }

  function scheduleInvalidation(matches?: ResourcePredicate) {
    if (!matches) { scheduledFull = true; scheduledPredicates.clear(); }
    else if (!scheduledFull) scheduledPredicates.add(matches);
    for (const path of scheduledConsumedPaths) if (!matches || matches(path)) scheduledConsumedPaths.delete(path);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushScheduledInvalidation, debounceMs);
    if (maximumTimer === null) maximumTimer = setTimeout(flushScheduledInvalidation, maxWaitMs);
  }

  function invalidateFamilies(families: readonly ResourceFamily[], workspaceId?: string | null) {
    invalidateWhere(path => resourceMatchesFamilies(path, families, workspaceId));
  }

  function scheduleFamilyInvalidation(families: readonly ResourceFamily[], workspaceId?: string | null) {
    if (!families.length) return;
    // Copy caller-owned arrays so queued invalidation cannot change its scope.
    const scope = [...families];
    scheduleInvalidation(path => resourceMatchesFamilies(path, scope, workspaceId));
  }

  function optimisticUpdate(matches: (path: string) => boolean, transform: (data: unknown) => unknown) {
    const token = Symbol('optimistic-update');
    optimisticLayers.set(token, { matches, transform });
    for (const entry of entries.values()) if (matches(entry.path)) renderData(entry);
    return (commit: boolean) => {
      // Clearing an account also invalidates late mutation settlements.
      if (!optimisticLayers.delete(token)) return;
      for (const entry of entries.values()) {
        if (!matches(entry.path)) continue;
        // A GET started before the write settled must never restore stale state.
        abort(entry);
        entry.failures = 0; entry.retryAt = 0;
        if (commit) entry.data = transform(entry.data);
        renderData(entry);
        if (debounceTimer !== null || maximumTimer !== null) scheduledConsumedPaths.add(entry.path);
        entry.stale = true;
        start(entry);
      }
    };
  }

  function clear() {
    epoch++;
    optimisticLayers.clear();
    cancelScheduledInvalidation();
    notifications.clear();
    for (const [path, entry] of entries) {
      abort(entry);
      entry.data = null;
      entry.hasValue = false;
      entry.failures = 0; entry.retryAt = 0;
      entry.stale = true;
      if (!entry.listeners.size) entries.delete(path);
      else {
        // Keep registrations so mounted consumers immediately forget private
        // data. No unauthenticated refetch on logout; remount/invalidate resumes.
        entry.snapshot = INITIAL;
        notify(entry);
      }
    }
  }

  return { getSnapshot, getServerSnapshot, subscribe, invalidate, invalidateWhere, invalidateFamilies, scheduleInvalidation, scheduleFamilyInvalidation, optimisticUpdate, getEpoch: () => epoch, clear };
}

const resourceCache = createResourceCache();

export const getResourceSnapshot = resourceCache.getSnapshot;
export const getResourceServerSnapshot = resourceCache.getServerSnapshot;
export const subscribeResource = resourceCache.subscribe;
/** Immediate mutation/retry refresh; omitted path refreshes all observed resources. */
export const invalidateResources = resourceCache.invalidate;
/** Immediate predicate refresh without touching unrelated paths or queued scopes. */
export const invalidateResourcesWhere = resourceCache.invalidateWhere;
export const invalidateResourceFamilies = resourceCache.invalidateFamilies;
/** Coalesce scoped unions with a 350ms quiet period and a 1000ms maximum wait. */
export const scheduleResourceInvalidation = resourceCache.scheduleInvalidation;
export const scheduleResourceFamilyInvalidation = resourceCache.scheduleFamilyInvalidation;
/** Abort requests, cancel scheduled events and discard all prior owner's data. */
export const clearResourceCache = resourceCache.clear;
/** Overlay pending writes on both cached data and in-flight read results. */
export const optimisticallyUpdateResources = resourceCache.optimisticUpdate;
export const getResourceCacheEpoch = resourceCache.getEpoch;
