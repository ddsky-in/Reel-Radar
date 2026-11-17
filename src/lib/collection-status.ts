import type { CollectionReason, JobStatus } from './types';

export const collectionReasons: readonly CollectionReason[] = ['unreconciled_charges', 'scraping_disabled', 'initial_import_disabled', 'usage_unverified', 'budget_paused', 'concurrency_limit'];
export const collectionJobStatuses: readonly JobStatus[] = ['pending', 'dispatching', 'running', 'processing', 'succeeded', 'partial', 'failed', 'budget_paused', 'uncertain'];

export function collectionMessage(reason: CollectionReason): string {
  const messages: Record<CollectionReason, string> = {
    unreconciled_charges: 'Collection blocked: an earlier provider run has an unresolved charge. New profile and Reel imports are waiting for reconciliation. Refresh cannot safely restart that run.',
    scraping_disabled: 'Collection is disabled in server setup. Profiles are saved, but names, photos and Reels have not been fetched.',
    initial_import_disabled: 'Initial Reel imports are disabled in server setup. Saved profiles do not imply their Reels have been fetched.',
    usage_unverified: 'Collection is waiting for verified provider usage. Budget availability has not been confirmed.',
    budget_paused: 'Collection is waiting for available budget. Provider allowance and reserved charges apply independently of the app budget.',
    concurrency_limit: 'Collection is waiting for the current runs to finish. Queued imports have been preserved.',
  };
  return messages[reason];
}

export function profileCollectionLabel(status: JobStatus | undefined): string | null {
  if (!status) return null;
  if (['pending', 'dispatching', 'running', 'processing'].includes(status)) return `Profile photo, name and followers · ${status}`;
  if (status === 'budget_paused') return 'Profile update awaiting budget';
  if (status === 'uncertain' || status === 'failed') return 'Profile update needs attention · see Jobs';
  if (status === 'partial') return 'Profile update partially completed · see Jobs';
  return 'Profile update completed';
}
