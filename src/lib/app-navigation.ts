import type { ReelQuery, Workspace } from './types';
import { readReelFilters, reelQueryString } from './reel-filters';

const paths: Record<string, string> = {
  overview: '/dashboard', reels: '/reels', carousels: '/carousels', competitors: '/creators',
  saved: '/saved', workspaces: '/workspaces', jobs: '/jobs', settings: '/settings',
};

export function appPath(section: string): string { return Object.hasOwn(paths, section) ? paths[section] : '/dashboard'; }

export function reelReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return '/reels';
  try {
    const url = new URL(value, 'http://reelradar.local');
    return url.origin === 'http://reelradar.local' && ['/dashboard', '/reels', '/saved', '/creators'].includes(url.pathname)
      ? `${url.pathname}${url.search}` : '/reels';
  } catch { return '/reels'; }
}

export function reelDetailPath(reelId: string, workspaceId: string, returnTo: string, list?: ReelQuery): string {
  const query = new URLSearchParams({ workspace: workspaceId, returnTo: reelReturnPath(returnTo) });
  if (list) query.set('list', reelQueryString({ ...list, page: undefined, limit: undefined }));
  return `/reels/${encodeURIComponent(reelId)}?${query}`;
}

export function reelListQuery(list: string | null, returnTo: string | null): ReelQuery | null {
  try {
    const source = new URL(reelReturnPath(returnTo), 'http://reelradar.local');
    const query = readReelFilters(list === null ? source.searchParams : new URLSearchParams(list));
    return { ...query, ...(source.pathname === '/saved' ? { saved: true } : {}), page: undefined, limit: undefined };
  } catch { return null; }
}

/** A remembered preference never grants access to a workspace outside bootstrap. */
export function selectedWorkspace(workspaces: Workspace[], rememberedId: string | null, explicitId?: string): Workspace | undefined {
  if (explicitId !== undefined) return workspaces.find(workspace => workspace.id === explicitId);
  return workspaces.find(workspace => workspace.id === rememberedId && !workspace.archived_at)
    ?? workspaces.find(workspace => !workspace.archived_at);
}
