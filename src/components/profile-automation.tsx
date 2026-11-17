'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ProfileAutomationStatus } from '@/lib/types';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useResource } from './ui';

const profileReasons: Record<Exclude<ProfileAutomationStatus['reason'], null>, string> = {
  disabled: 'Daily profile refresh disabled', setup_required: 'Daily profile refresh awaiting provider setup',
  paused: 'Daily profile refresh paused', scraping_disabled: 'Live profile collection disabled',
  concurrency_limit: 'Daily profile refresh waiting for collection capacity',
  unreconciled_charges: 'Daily profile refresh protected by unresolved billing',
  budget_paused: 'Daily profile refresh waiting for allowance', usage_unverified: 'Daily profile refresh awaiting usage verification',
};

export function ProfileAutomationSummary({ status, compact = false }: { status: ProfileAutomationStatus; compact?: boolean }) {
  if (compact) return <p className="collection-notice" role="status">{status.reason ? profileReasons[status.reason] : 'Daily profile refresh active'}{status.active_jobs > 0 ? ` · ${status.active_jobs} running` : status.pending_jobs > 0 ? ` · ${status.pending_jobs} queued` : ''}<Link className="text-link" href="/jobs">View Jobs</Link></p>;
  return <details className="collection-notice" aria-label="Daily profile refresh"><summary>{status.reason ? profileReasons[status.reason] : 'Daily profile refresh active'}{status.active_jobs > 0 ? ` · ${status.active_jobs} running` : status.pending_jobs > 0 ? ` · ${status.pending_jobs} queued` : ''}</summary>
    <p>One profile fetch updates followers, name and the profile-picture URL together. No separate paid photo fetch. Checks due creators every {status.interval_hours} hours in batches of up to {status.batch_limit}; shared creators count once across workspaces.</p>
    <p>{formatNumber(status.due_creators)} creators due. Last captured profile: {formatDateTime(status.last_fetch_at)}. {status.next_due_at ? `Next due: ${formatDateTime(status.next_due_at)}.` : 'Next collection depends on setup, budget and current queue.'} <Link className="text-link" href="/jobs">View Jobs</Link></p>
    <p>Counts are last captured, not live. Fresh photo URLs depend on provider output; unavailable profiles, expired links and protected job holds can delay pictures. Refreshing this status starts no paid work.</p>
  </details>;
}

export function ProfileAutomation({ demo, compact = false }: { demo: boolean; compact?: boolean }) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<ProfileAutomationStatus>(demo ? null : '/api/profile-automation', revision);
  if (demo) return null;
  return resource.error ? <p className="collection-notice" role="status">Daily profile refresh status unavailable. <button className="text-link" onClick={() => setRevision(value => value + 1)}>Retry profile status</button></p> : resource.data ? <ProfileAutomationSummary status={resource.data} compact={compact}/> : null;
}
