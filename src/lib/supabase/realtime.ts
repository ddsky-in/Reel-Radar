'use client';

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { clearResourceCache, getResourceCacheEpoch, scheduleResourceInvalidation } from '../resource-cache';
import { isResourceFamily, resourceMatchesFamilies, type ResourceDependencies } from '../resource-dependencies';

type Bridge = { access_token: string; expires_at: number; owner_user_id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only scope metadata is accepted. Unknown/missed signals request a broad safe read. */
export function createResourceRevisionTracker(owner: string) {
  const revisions = new Map<string, bigint>();
  return {
    reset: () => revisions.clear(),
    accept(payload: unknown): ResourceDependencies | 'ignore' | null {
      if (!payload || typeof payload !== 'object') return null;
      const event = payload as Record<string, unknown>;
      if (event.schema !== 'public' || event.table !== 'owner_resource_revisions' || !['INSERT', 'UPDATE'].includes(String(event.eventType))) return null;
      if (!event.new || typeof event.new !== 'object' || Array.isArray(event.new)) return null;
      const row = event.new as Record<string, unknown>;
      if (typeof row.owner_user_id === 'string' && row.owner_user_id.toLowerCase() !== owner.toLowerCase()) return 'ignore';
      if (row.owner_user_id !== owner || !isResourceFamily(row.family)
        || !(row.workspace_id === null || (typeof row.workspace_id === 'string' && UUID.test(row.workspace_id)))
        || row.scope_key !== (row.workspace_id ?? 'global')
        || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))
        || Object.keys(row).some(key => !['owner_user_id', 'family', 'workspace_id', 'scope_key', 'revision', 'updated_at'].includes(key))) return null;
      let revision: bigint;
      if (typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision > 0) revision = BigInt(row.revision);
      else if (typeof row.revision === 'string' && /^[1-9][0-9]*$/.test(row.revision) && row.revision.length <= 19) revision = BigInt(row.revision);
      else return null;
      if (revision > 9223372036854775807n) return null;
      const key = JSON.stringify([row.family, row.workspace_id]);
      const previous = revisions.get(key);
      if (previous !== undefined && revision === previous) return 'ignore';
      revisions.set(key, revision);
      if (previous !== undefined && revision !== previous + 1n) return null;
      return { families: [row.family], workspaceId: row.workspace_id as string | null };
    },
  };
}

export function startAppSync(onUnauthorized: () => void) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return () => {};
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let stopped = false, connected = false, renewing = false;
  const epoch = getResourceCacheEpoch();
  const isActive = () => !stopped && getResourceCacheEpoch() === epoch;
  let owner: string | null = null, expiresAt = 0;
  let tracker: ReturnType<typeof createResourceRevisionTracker> | null = null;
  let channel: RealtimeChannel | null = null;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    request?.abort();
    clearTimeout(renewal);
    clearInterval(fallback);
    window.removeEventListener('focus', recover);
    window.removeEventListener('online', recover);
    window.removeEventListener('reelradar-auth-change', stop);
    document.removeEventListener('visibilitychange', visible);
    if (channel) void client.removeChannel(channel);
    client.realtime.disconnect();
    tracker?.reset();
    owner = null;
    expiresAt = 0;
  }
  function retry(delay: number) {
    clearTimeout(renewal);
    if (isActive()) renewal = setTimeout(() => { void renew(); }, delay);
  }
  async function renew() {
    if (!isActive()) { stop(); return; }
    if (renewing) return;
    renewing = true;
    request = new AbortController();
    try {
      const response = await fetch('/api/auth/realtime', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (!isActive()) { stop(); return; }
      if (response.status === 401 || response.status === 403) {
        stop(); clearResourceCache(); onUnauthorized(); return;
      }
      if (!response.ok) throw new Error('Realtime authorization unavailable');
      const session: Bridge = await response.json();
      if (!isActive()) { stop(); return; }
      if (!session || typeof session.access_token !== 'string' || !session.access_token
        || typeof session.owner_user_id !== 'string' || !UUID.test(session.owner_user_id)
        || !Number.isFinite(session.expires_at) || session.expires_at * 1000 <= Date.now() + 10_000) throw new Error('Invalid realtime session');
      if (owner && owner !== session.owner_user_id) {
        stop(); clearResourceCache(); onUnauthorized(); return;
      }
      owner = session.owner_user_id;
      tracker ??= createResourceRevisionTracker(owner);
      expiresAt = session.expires_at * 1000;
      await client.realtime.setAuth(session.access_token);
      if (!isActive()) { stop(); client.realtime.disconnect(); return; }
      if (!channel) {
        channel = client.channel(`owner-resource-revision:${owner}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'owner_resource_revisions', filter: `owner_user_id=eq.${owner}` }, payload => {
            if (!isActive()) { stop(); return; }
            if (expiresAt <= Date.now()) { connected = false; client.realtime.disconnect(); scheduleResourceInvalidation(); void renew(); return; }
            const scope = tracker?.accept(payload);
            if (scope === 'ignore') return;
            if (!scope) scheduleResourceInvalidation();
            else scheduleResourceInvalidation(path => resourceMatchesFamilies(path, scope.families, scope.workspaceId));
          }).subscribe(status => {
            if (!isActive()) { stop(); return; }
            connected = status === 'SUBSCRIBED';
            if (connected) { tracker?.reset(); scheduleResourceInvalidation(); }
            // An older database without this feed produces a channel error.
            // Keep the authenticated broad fallback timer, never subscribe to
            // the legacy feed in parallel and undo scoped invalidation.
          });
      } else client.realtime.connect();
      retry(Math.max(10_000, Math.min(600_000, expiresAt - Date.now() - 60_000)));
    } catch {
      if (isActive()) {
        if (expiresAt <= Date.now()) { connected = false; client.realtime.disconnect(); }
        retry(30_000);
      } else stop();
    } finally { renewing = false; request = null; }
  }
  function recover() {
    if (!isActive()) { stop(); return; }
    scheduleResourceInvalidation();
    if (!connected || expiresAt - Date.now() < 120_000) void renew();
  }
  function visible() { if (document.visibilityState === 'visible') recover(); }
  const fallback = setInterval(() => {
    if (!isActive()) { stop(); return; }
    if (!connected && document.visibilityState === 'visible') {
      scheduleResourceInvalidation(); void renew();
    }
  }, 60_000);
  window.addEventListener('focus', recover);
  window.addEventListener('online', recover);
  window.addEventListener('reelradar-auth-change', stop);
  document.addEventListener('visibilitychange', visible);
  void renew();
  return stop;
}
