'use client';

import Link from 'next/link';
import type { CreatorCollectionState, CreatorCollectionSummary } from '@/lib/types';
import { collectionMessage } from '@/lib/collection-status';
import { appPath } from '@/lib/app-navigation';

export function CollectionStatus({ state }: { state: CreatorCollectionState | CreatorCollectionSummary }) {
  if (!state.reason) return state.blocking_job_id ? <p className="collection-notice" role="status">Account needs review<Link className="text-link" href={appPath('settings')}>View Settings</Link></p> : null;
  if (state.reason === 'concurrency_limit') return <p className="collection-notice" role="status">Import queue active · waiting for the current run <Link className="text-link" href={appPath('jobs')}>View Jobs</Link></p>;
  return <details className="collection-notice collection-notice-warning" open><summary>Collection needs attention</summary><p role="status">{collectionMessage(state.reason)}{' '}<Link className="text-link" href={appPath('jobs')}>View Jobs</Link></p></details>;
}
