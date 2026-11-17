/** Browser cache dependencies only; API authorization is still performed per request. */
export const RESOURCE_FAMILIES = [
  'creators', 'reels', 'carousels', 'jobs', 'settings', 'transcription',
  'saved_reels', 'saved_carousels', 'reel_filters', 'carousel_filters', 'workspaces',
] as const;
export type ResourceFamily = typeof RESOURCE_FAMILIES[number];
export type ResourcePredicate = (path: string) => boolean;
export interface ResourceDependencies { families: readonly ResourceFamily[]; workspaceId?: string | null }

export function isResourceFamily(value: unknown): value is ResourceFamily {
  return typeof value === 'string' && (RESOURCE_FAMILIES as readonly string[]).includes(value);
}

function apiParts(path: string): string[] | null {
  // Cache keys are same-origin relative API URLs, not arbitrary external URLs.
  if (!path.startsWith('/api/') || path.includes('#')) return null;
  try {
    const parts = path.split('?')[0].slice(5).split('/').map(decodeURIComponent);
    return parts.every(part => part && !part.includes('/')) ? parts : null;
  } catch { return null; }
}

function readDependencies(parts: string[]): ResourceDependencies | null {
  if (parts.length === 1) {
    const global: Record<string, readonly ResourceFamily[]> = {
      bootstrap: ['workspaces', 'jobs', 'settings', 'transcription'],
      jobs: ['jobs', 'settings', 'transcription'], settings: ['settings'],
      'profile-automation': ['creators', 'jobs', 'settings', 'workspaces'],
      'apify-accounts': ['settings', 'jobs'], transcription: ['transcription', 'settings'],
      'reel-filters': ['reel_filters'], 'carousel-filters': ['carousel_filters'],
      workspaces: ['workspaces'],
    };
    return global[parts[0]] ? { families: global[parts[0]] } : null;
  }
  if (parts[0] === 'jobs' && (parts.length === 2 && parts[1] === 'holds' || parts.length === 3 && parts[2] === 'recovery')) return { families: ['jobs', 'settings', 'creators'] };
  if (parts[0] !== 'workspaces' || parts.length < 2) return null;
  const workspaceId = parts[1], resource = parts[2];
  if (parts.length === 2) return { workspaceId, families: ['workspaces'] };
  if (parts.length === 3) {
    const workspace: Record<string, readonly ResourceFamily[]> = {
      overview: ['creators', 'reels', 'saved_reels'], creators: ['creators', 'jobs', 'carousels'],
      competitors: ['creators', 'reels', 'jobs', 'carousels'], 'creator-directory': ['creators', 'jobs'],
      'collection-summary': ['creators', 'jobs', 'settings'], status: ['creators', 'jobs', 'settings'],
      'collection-status': ['creators', 'jobs', 'settings'],
      reels: ['reels', 'creators', 'saved_reels'], saved: ['reels', 'creators', 'saved_reels'],
      export: ['reels', 'creators', 'saved_reels'],
      carousels: ['carousels', 'creators', 'saved_carousels'],
      'carousel-summaries': ['carousels', 'creators', 'saved_carousels'],
    };
    return workspace[resource] ? { workspaceId, families: workspace[resource] } : null;
  }
  if (resource === 'reels') {
    if (parts.length === 4) return { workspaceId, families: ['reels', 'creators', 'saved_reels', 'transcription', 'settings', 'jobs'] };
    if (parts.length === 5 && parts[4] === 'neighbors') return { workspaceId, families: ['reels', 'creators', 'saved_reels'] };
    if (parts.length === 5 && parts[4] === 'transcript') return { workspaceId, families: ['transcription', 'settings'] };
  }
  if (resource === 'carousels' && parts.length === 4) {
    return { workspaceId, families: parts[3] === 'collection-status' ? ['carousels', 'jobs', 'settings'] : ['carousels', 'creators', 'saved_carousels'] };
  }
  if (resource === 'creators' && parts.length === 4) return { workspaceId, families: ['creators', 'jobs', 'carousels'] };
  if (resource === 'creators' && parts.length === 5 && parts[4] === 'source-refresh') {
    return { workspaceId, families: ['creators', 'reels', 'jobs', 'settings'] };
  }
  return null;
}

/** null/omitted workspace is owner-global; global aggregate endpoints remain affected. */
export function resourceMatchesFamilies(path: string, families: readonly ResourceFamily[], workspaceId?: string | null): boolean {
  if (!families.length) return false;
  const parts = apiParts(path), dependencies = parts && readDependencies(parts);
  // A new/unknown endpoint must not silently become permanently stale.
  if (!dependencies) return true;
  if (workspaceId != null && dependencies.workspaceId != null && workspaceId !== dependencies.workspaceId) return false;
  return dependencies.families.some(family => families.includes(family));
}

/** Optimistic Reel fields never touch creator/status/transcript/provider resources. */
export function savedReelResourceMatches(path: string, workspaceId: string): boolean {
  const parts = apiParts(path);
  if (!parts || parts[0] !== 'workspaces' || parts[1] !== workspaceId) return false;
  return (parts.length === 3 && ['overview', 'reels', 'saved'].includes(parts[2]))
    || (parts[2] === 'reels' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'neighbors')));
}

function controlledBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

/** null means unknown mutation -> full safe fallback; [] means known non-mutating action. */
export function mutationResourceDependencies(path: string, method: string, body?: unknown): ResourceDependencies | null {
  method = method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return { families: [] };
  const parts = apiParts(path);
  if (!parts) return null;
  if (parts.length === 2 && parts[0] === 'billing' && parts[1] === 'sync' && method === 'POST') return { families: ['jobs', 'settings', 'creators'] };
  if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'settlement' && method === 'POST') return { families: ['jobs', 'settings', 'creators', 'carousels'] };
  if (parts.length === 2 && parts[0] === 'auth' && parts[1] === 'realtime') return { families: [] };
  if (parts.length === 1 || parts.length === 2) {
    if ((parts.length === 1 && method === 'POST') || (parts.length === 2 && method === 'DELETE')) {
      if (parts[0] === 'reel-filters') return { families: ['reel_filters'] };
      if (parts[0] === 'carousel-filters') return { families: ['carousel_filters'] };
    }
    if (parts.length === 1 && parts[0] === 'settings' && method === 'PATCH') return { families: ['settings', 'jobs', 'transcription'] };
    if (parts.length === 1 && parts[0] === 'transcription' && method === 'PATCH') return { families: ['transcription', 'settings', 'jobs'] };
    if (parts.length === 1 && parts[0] === 'refresh' && method === 'POST') return { families: ['jobs', 'settings', 'creators'] };
    if (parts.length === 1 && parts[0] === 'workspaces' && method === 'POST') return { families: ['workspaces'] };
  }
  if (parts[0] !== 'workspaces' || parts.length < 2) return null;
  const workspaceId = parts[1];
  if (parts.length === 2 && method === 'PATCH') return { families: ['workspaces', 'creators', 'jobs', 'settings'] };
  if (parts[2] === 'saved' && ((parts.length === 3 && method === 'POST') || (parts.length === 4 && ['PATCH', 'DELETE'].includes(method)))) {
    return { workspaceId, families: ['saved_reels'] };
  }
  if (parts[2] === 'carousels') {
    if (parts.length === 5 && parts[4] === 'saved' && method === 'PUT') return { workspaceId, families: ['saved_carousels'] };
    if (parts.length === 4 && parts[3] === 'refresh' && method === 'POST') return { families: ['jobs', 'settings', 'carousels'] };
  }
  if (parts[2] === 'creators') {
    if (parts.length === 4 && parts[3] === 'import' && method === 'POST' && controlledBody(body)?.preview === true) return { families: [] };
    if ((parts.length === 3 && ['POST', 'DELETE'].includes(method)) || (parts.length === 4 && (method === 'DELETE' || (parts[3] === 'import' && method === 'POST')))) {
      // Canonical creators and queued work can affect every workspace of this owner.
      return { families: ['creators', 'reels', 'carousels', 'jobs', 'settings', 'workspaces'] };
    }
    if (parts.length === 5 && parts[4] === 'source-refresh' && method === 'POST') return { families: ['creators', 'jobs', 'settings'] };
  }
  if (parts[2] === 'reels' && parts.length === 5 && parts[4] === 'transcript' && method === 'POST') return { families: ['transcription', 'jobs', 'settings'] };
  return null;
}
