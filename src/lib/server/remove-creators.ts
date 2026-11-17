import type { BulkRemoveCreatorsResult } from '../types';
import type { Repository } from './repository';
import { ApiError, publicError } from './errors';

export async function removeCreators(
  repo: Pick<Repository, 'workspace' | 'creators' | 'removeCreator'>,
  workspaceId: string,
  creatorIds: string[],
): Promise<BulkRemoveCreatorsResult> {
  const workspace = await repo.workspace(workspaceId);
  if (workspace.archived_at) throw new ApiError(409, 'WORKSPACE_ARCHIVED', 'Restore the workspace before making changes.');
  const linked = new Set((await repo.creators(workspaceId)).map(creator => creator.id));
  const ids = [...new Set(creatorIds)];
  const pending = ids.filter(id => linked.has(id));
  const result: BulkRemoveCreatorsResult = {
    removed_ids: [],
    already_removed_ids: ids.filter(id => !linked.has(id)),
    failed: [],
  };

  // Reuse the authorized single-creator cleanup without flooding the database.
  // Each deletion is independent, so report confirmed results for safe retries.
  for (let offset = 0; offset < pending.length; offset += 4) {
    const batch = pending.slice(offset, offset + 4);
    const outcomes = await Promise.allSettled(batch.map(async id => repo.removeCreator(workspaceId, id)));
    outcomes.forEach((outcome, index) => {
      const creatorId = batch[index];
      if (outcome.status === 'fulfilled') result.removed_ids.push(creatorId);
      else result.failed.push({ creator_id: creatorId, error: publicError(outcome.reason).body.error });
    });
  }
  return result;
}
