'use client';

import { useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { Reel } from '../lib/types';
import { errorMessage } from '../lib/client';

export function ReelDownloadButton({ reel, workspaceId }: { reel: Reel; workspaceId: string }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const pending = useRef(false);
  const synthetic = reel.provider.startsWith('mock');
  async function download() {
    if (pending.current || synthetic) return;
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/reels/${encodeURIComponent(reel.id)}/download`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error?.message ?? 'Could not download this video. Please try again.');
      }
      if (response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') throw new Error('Could not download this video. Please try again.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const identity = reel.shortcode.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || reel.id.replace(/[^a-z0-9-]/gi, '').slice(0, 36);
      link.href = url;
      link.download = `reelradar-${identity}.mp4`;
      document.body.append(link);
      link.click();
      link.remove();
      // Keep the object URL alive long enough for the browser to start saving the file.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setFeedback({ text: 'Video download started.', error: false });
    } catch (error) {
      setFeedback({ text: errorMessage(error), error: true });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const label = synthetic ? 'Synthetic Reel: video download unavailable' : busy ? 'Downloading video…' : `Download video by @${reel.username}`;
  return <>
    <button type="button" className="reel-download-button" aria-label={label} title={label} disabled={busy || synthetic} aria-busy={busy} onClick={() => void download()}>{busy ? <Loader2 size={15} className="spin" aria-hidden="true"/> : <Download size={15} aria-hidden="true"/>}</button>
    {feedback && <span className={`reel-download-feedback${feedback.error ? ' is-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</span>}
  </>;
}
