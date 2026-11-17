'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CarouselCollectionStatus } from '@/lib/types';
import { formatDateTime } from '@/lib/format';
import { useResource } from './ui';

export function CarouselAutomationSummary({ status, compact = false }: { status: CarouselCollectionStatus; compact?: boolean }) {
  const title = status.reason === 'setup_required' ? 'Automatic collection awaiting provider setup' : status.reason === 'disabled' ? 'Automatic collection disabled' : status.reason === 'paused' ? 'Automatic collection paused' : status.reason === 'scraping_disabled' ? 'Live collection disabled' : 'Daily carousel collection active';
  if (compact) return <p className="collection-notice" role="status">{title}{status.active_jobs > 0 ? ` · ${status.active_jobs} running` : status.pending_jobs > 0 ? ` · ${status.pending_jobs} queued` : ''}<Link className="text-link" href="/jobs">View Jobs</Link></p>;
  return <details className="collection-notice"><summary>{title}{status.active_jobs > 0 ? ` · ${status.active_jobs} running` : status.pending_jobs > 0 ? ` · ${status.pending_jobs} queued` : ''}</summary>
    <p>Checks up to {status.window_limit} recent photo posts per competitor every {status.interval_hours} hours. Only carousels are saved. Shared collection budgets and provider availability apply.</p>
    <p>Last completed fetch: {formatDateTime(status.last_fetch_at)}. {status.next_due_at ? `Next due: ${formatDateTime(status.next_due_at)}.` : 'Next collection depends on setup and current queue.'} <Link className="text-link" href="/jobs">View Jobs</Link></p>
  </details>;
}

export function CarouselAutomation({ workspaceId, demo, compact = false }: { workspaceId: string; demo: boolean; compact?: boolean }) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<CarouselCollectionStatus>(demo ? null : `/api/workspaces/${encodeURIComponent(workspaceId)}/carousels/collection-status`, revision);
  if (demo) return null;
  return <>{resource.error ? <p className="collection-notice" role="status">Carousel collection status unavailable. <button className="text-link" onClick={() => setRevision(value => value + 1)}>Retry status</button></p> : resource.data && <CarouselAutomationSummary status={resource.data} compact={compact}/>}</>;
}
