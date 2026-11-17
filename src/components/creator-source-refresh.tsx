'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../lib/client';
import type { CreatorSourceRefresh as SourceReport } from '../lib/types';
import type { RefreshResult } from '../lib/server/repository';
import { ErrorState, Status, useResource, type Notify } from './ui';

const active = new Set(['pending', 'dispatching', 'running', 'processing']);

export function SourceCoverageSummary({ report }: { report: SourceReport }) {
  if (active.has(report.status)) return <p role="status">Collecting source details. Coverage will appear when processing finishes.</p>;
  if (!report.coverage_recorded && !report.source_refresh) return <p>This older collection has no detailed coverage report. Refresh all details to check captions and media.</p>;
  const returned = report.expected_reels === null ? `${report.returned_reels} Reels returned.`
    : `${report.expected_reels - report.missing_reels} of ${report.expected_reels} previously saved Reels returned.`;
  const newReels = report.expected_reels === null ? 0 : Math.max(0, report.returned_reels - (report.expected_reels - report.missing_reels));
  return <>
    <p>{returned}{newReels > 0 && ` ${newReels} additional Reels imported.`}</p>
    <p>{report.missing_reels} Reels not returned · {report.missing_captions} captions missing · {report.missing_media} media links missing</p>
    {report.missing.length > 0 && <details><summary>Show missing details ({report.missing.length} Reels)</summary><ul>{report.missing.map(item => <li key={item.reel_id}>
      {item.shortcode}: {item.not_returned ? 'not returned by the provider' : [item.caption_missing && 'caption missing', item.media_missing && 'media link missing'].filter(Boolean).join(', ')}
    </li>)}</ul></details>}
    <p className="helper-copy">Audio is checked separately before transcription. Existing completed transcripts are preserved.</p>
  </>;
}

export function CreatorSourceRefresh({ workspaceId, creatorId, notify }: { workspaceId: string; creatorId: string; notify: Notify }) {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/creators/${encodeURIComponent(creatorId)}/source-refresh`;
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  const resource = useResource<SourceReport | null>(path, revision);
  const processing = Boolean(resource.data && active.has(resource.data.status));
  useEffect(() => {
    if (!processing) return;
    const timer = setTimeout(() => setRevision(value => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [processing, revision]);
  async function refresh() {
    if (busy || processing) return;
    setBusy(true);
    try {
      const result = await api<RefreshResult>(path, { method: 'POST', body: '{}' });
      notify(result.processing === 'configuration_required' ? 'Refresh queued. Background processing configuration is required.' : result.message);
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  return <section className="source-refresh-panel" aria-label="Source details coverage">
    <div className="source-refresh-heading"><h3>Source details</h3>{resource.data && <Status status={resource.data.status}/>}</div>
    <p>Re-fetch up to 100 recent available Reels with full captions and media. Missing returned Reels are imported; eligible failed transcripts are retried.</p>
    {resource.error ? <ErrorState message={resource.error} retry={() => setRevision(value => value + 1)}/>
      : resource.loading ? <p role="status">Checking collection coverage…</p>
      : resource.data ? <SourceCoverageSummary report={resource.data}/> : <p>No collection has been recorded yet.</p>}
    <button type="button" className="button button-secondary" disabled={busy || processing} onClick={() => void refresh()}>
      <RefreshCw size={14} className={busy || processing ? 'spin' : ''}/>{busy ? 'Queuing refresh…' : processing ? 'Refresh in progress' : 'Refresh all details'}
    </button>
  </section>;
}
