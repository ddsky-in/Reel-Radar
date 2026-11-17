'use client';

import { useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import type { BulkRemoveCreatorsResult, Creator } from '@/lib/types';
import { Dialog, type Notify } from './ui';

export function RemoveCompetitors({ base, workspaceName, creators, notify, close, removed }: {
  base: string;
  workspaceName: string;
  creators: Pick<Creator, 'id' | 'username' | 'display_name'>[];
  notify: Notify;
  close: () => void;
  removed: (creatorIds: string[]) => void;
}) {
  const [remaining, setRemaining] = useState(creators);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);

  function dismiss() {
    if (!pending.current) close();
  }

  async function submit() {
    if (pending.current || !remaining.length) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<BulkRemoveCreatorsResult>(`${base}/creators`, {
        method: 'DELETE', body: JSON.stringify({ creator_ids: remaining.map(creator => creator.id) }),
      });
      const completed = [...result.removed_ids, ...result.already_removed_ids];
      if (completed.length) {
        removed(completed);
        notify(result.removed_ids.length
          ? `${result.removed_ids.length} ${result.removed_ids.length === 1 ? 'competitor' : 'competitors'} removed from ${workspaceName}. Shared Reels were preserved.`
          : 'These competitors are already removed from this workspace.');
      }
      if (result.failed.length) {
        const failedIds = new Set(result.failed.map(item => item.creator_id));
        setRemaining(items => items.filter(creator => failedIds.has(creator.id)));
        setError(`${result.failed.length} ${result.failed.length === 1 ? 'competitor could' : 'competitors could'} not be deleted. ${result.failed[0].error.message} Retry to delete the remaining selection.`);
      } else close();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <Dialog title={`Delete ${remaining.length} ${remaining.length === 1 ? 'competitor' : 'competitors'}?`} onClose={dismiss}>
    <div aria-busy={busy}>
      <p className="dialog-copy">These competitors and their saved Reels will be removed from <strong>{workspaceName}</strong>. Shared Reel data and other workspaces will stay intact.</p>
      <ul className="competitor-removal-list" aria-label="Competitors to delete">
        {remaining.map(creator => <li key={creator.id}><strong>@{creator.username}</strong>{creator.display_name && <span>{creator.display_name}</span>}</li>)}
      </ul>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button button-secondary" disabled={busy} onClick={dismiss}>Cancel</button>
        <button type="button" className="button button-danger" disabled={busy || !remaining.length} onClick={submit}>
          {busy ? <Loader2 size={16} className="spin" aria-hidden="true"/> : <Trash2 size={16} aria-hidden="true"/>}
          {busy ? 'Deleting…' : `${error ? 'Retry: delete' : 'Delete'} ${remaining.length} ${remaining.length === 1 ? 'competitor' : 'competitors'}`}
        </button>
      </div>
    </div>
  </Dialog>;
}
