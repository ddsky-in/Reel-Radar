import type { Creator, JobStatus } from './types';

export interface CompetitorProgress { label: string; tone: 'active' | 'pending' | 'running' | 'partial' | 'failed' | 'paused' | 'uncertain' | 'private' | 'unavailable' }

export function competitorProgress(creator: Creator, profileStatus?: JobStatus): CompetitorProgress {
  if (['private', 'unavailable', 'paused'].includes(creator.status)) return { label: creator.status === 'private' ? 'Private' : creator.status === 'unavailable' ? 'Unavailable' : 'Paused', tone: creator.status as 'private' | 'unavailable' | 'paused' };
  const initial = creator.initial_backfill_status;
  if (initial === 'uncertain') return { label: 'Needs review', tone: 'uncertain' };
  if (initial === 'failed') return { label: 'Import failed', tone: 'failed' };
  if (initial && ['budget_paused', 'blocked', 'not_queued', 'disabled'].includes(initial)) return { label: 'Import waiting', tone: 'paused' };
  if (initial === 'pending') return { label: 'Import queued', tone: 'pending' };
  if (initial && ['dispatching', 'running', 'processing'].includes(initial)) return { label: 'Importing', tone: 'running' };
  if (profileStatus === 'uncertain' || profileStatus === 'failed') return { label: 'Profile needs review', tone: profileStatus };
  if (profileStatus === 'budget_paused') return { label: 'Profile waiting', tone: 'paused' };
  if (profileStatus && ['pending', 'dispatching', 'running', 'processing'].includes(profileStatus)) return { label: 'Profile updating', tone: 'pending' };
  if (initial === 'partial' || profileStatus === 'partial') return { label: 'Partial update', tone: 'partial' };
  if (creator.last_error) return { label: 'Needs review', tone: 'partial' };
  return { label: creator.status === 'active' ? 'Active' : creator.status === 'failed' ? 'Needs review' : 'Pending', tone: creator.status === 'active' ? 'active' : creator.status === 'failed' ? 'failed' : 'pending' };
}
