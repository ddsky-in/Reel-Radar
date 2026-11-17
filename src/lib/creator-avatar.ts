const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function creatorAvatarPath(workspaceId: string, creatorId: string): string | null {
  if (!uuid.test(workspaceId) || !uuid.test(creatorId)) return null;
  return `/api/workspaces/${workspaceId}/creators/${creatorId}/avatar`;
}

export function validCreatorAvatarPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  return parts.length === 7 && parts[1] === 'api' && parts[2] === 'workspaces' && parts[4] === 'creators' && parts[6] === 'avatar'
    && creatorAvatarPath(parts[3], parts[5]) === value ? value : null;
}
