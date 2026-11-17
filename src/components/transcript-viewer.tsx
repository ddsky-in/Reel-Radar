'use client';

import { useState } from 'react';
import { Copy, Download, FileText, Loader2, RefreshCw } from 'lucide-react';
import type { ReelTranscript } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { formatElapsedMs, groupTranscriptSegments, transcriptParagraphs, transcriptPlainText, transcriptSrt, transcriptStatusMessage, transcriptTimeLabel } from '../lib/transcript';
import { Dialog, ErrorState, Status, useResource } from './ui';

export function TranscriptButton({ workspaceId, reelId, username }: { workspaceId: string; reelId: string; username: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="button button-secondary transcript-button" aria-label={`View transcript for Reel by @${username}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><FileText size={14} aria-hidden="true"/>Transcript</button>
    {open && <TranscriptViewer workspaceId={workspaceId} reelId={reelId} username={username} onClose={() => setOpen(false)}/>}
  </>;
}

/** Mounted only on demand. Signal-only realtime invalidates this existing resource subscription. */
export function TranscriptViewer({ workspaceId, reelId, username, onClose }: { workspaceId: string; reelId: string; username: string; onClose: () => void }) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<ReelTranscript>(`/api/workspaces/${encodeURIComponent(workspaceId)}/reels/${encodeURIComponent(reelId)}/transcript`, revision);
  return <Dialog title="Original AI transcript" subtitle={`@${username} · Original audio, not a translation`} onClose={onClose} wide>
    <div className="transcript-viewer">
      <p className="helper-copy">Read-only. Opening or refreshing this viewer never starts transcription or downloads video.</p>
      {resource.loading ? <p className="transcript-feedback helper-copy" role="status" aria-busy="true"><Loader2 size={16} className="spin" aria-hidden="true"/>Loading transcript…</p>
        : resource.error ? <ErrorState message={resource.error} retry={() => setRevision(value => value + 1)}/>
        : resource.data ? <TranscriptContent transcript={resource.data} reelId={reelId}/> : <p role="status">No transcript data is available.</p>}
      <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={resource.loading || resource.refreshing} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true"/>{resource.refreshing ? 'Updating…' : 'Refresh status'}</button><button type="button" className="button button-secondary" onClick={onClose}>Close</button></div>
    </div>
  </Dialog>;
}

export function TranscriptContent({ transcript, reelId, onSeek, compact = false, statusMessage }: { transcript: ReelTranscript; reelId: string; onSeek?: (seconds: number) => void; compact?: boolean; statusMessage?: string }) {
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [copying, setCopying] = useState(false);
  const [view, setView] = useState<'reading' | 'timeline'>('reading');
  const text = transcriptPlainText(transcript);
  const srt = transcript.status === 'ready' ? transcriptSrt(transcript.segments) : null;
  const timeline = srt ? groupTranscriptSegments(transcript.segments) : [];
  const message = statusMessage ?? transcriptStatusMessage(transcript.status);
  async function copy() {
    if (!text) return;
    setCopying(true); setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setFeedback({ message: 'Transcript copied.', error: false });
    } catch {
      setFeedback({ message: 'Could not copy. Select the transcript text manually or download TXT.', error: true });
    } finally { setCopying(false); }
  }
  function download(content: string, extension: 'txt' | 'srt') {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `reelradar-transcript-${reelId.replace(/[^a-z0-9-]/gi, '').slice(0, 36) || 'reel'}.${extension}`;
      document.body.append(link); link.click(); link.remove();
      setFeedback({ message: `${extension.toUpperCase()} download started.`, error: false });
    } catch { setFeedback({ message: 'Could not download the transcript. Select the text manually or try again.', error: true }); }
    finally { if (url) { const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); } }
  }
  return <>
    <div className="transcript-meta"><Status status={transcript.status}/>{transcript.language && <span>{new Intl.DisplayNames(['en'], { type: 'language' }).of(transcript.language) ?? transcript.language}</span>}{transcript.completed_at && !compact && <span title={formatDateTime(transcript.completed_at)}>Original audio · AI transcript</span>}</div>
    {message && (!compact || !['ready', 'awaiting_media', 'queued', 'submitting', 'processing', 'budget_paused'].includes(transcript.status)) && <p className="helper-copy" role="status">{message}</p>}
    {transcript.error_message && <p className="inline-error" role="status">{transcript.error_message}</p>}
    {text && <>
      <div className="transcript-toolbar">
        <div className="transcript-view-options" role="group" aria-label="Transcript format"><button type="button" aria-pressed={view === 'reading'} onClick={() => setView('reading')}>Reading</button>{srt && <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>Timeline</button>}</div>
        <div className="transcript-actions"><button type="button" className="button button-secondary" disabled={copying} onClick={copy}><Copy size={14} aria-hidden="true"/>{copying ? 'Copying…' : 'Copy text'}</button><button type="button" className="button button-secondary" aria-label="Download transcript as TXT" onClick={() => download(text, 'txt')}><Download size={14} aria-hidden="true"/>TXT</button><button type="button" className="button button-secondary" aria-label="Download transcript as SRT" disabled={!srt} title={srt ? 'Export the recorded timestamps' : 'SRT requires valid recorded timestamps; timing is never guessed.'} onClick={() => { if (srt) download(srt, 'srt'); }}><Download size={14} aria-hidden="true"/>SRT</button></div>
      </div>
      {!srt && <p className="helper-copy">SRT unavailable: valid recorded timestamps are required. No timing is guessed.</p>}
      <div className="transcript-content" tabIndex={0} role="region" aria-label="Original AI transcript text">
        {view === 'timeline' && srt ? <ol className="transcript-segments">{timeline.map((segment, index) => <li className="transcript-segment" key={`${segment.start_ms}-${index}`}>
          {onSeek ? <button type="button" className="transcript-time transcript-seek" title={`${formatElapsedMs(segment.start_ms)} – ${formatElapsedMs(segment.end_ms)}`} aria-label={`Play video from ${transcriptTimeLabel(segment.start_ms)}`} onClick={() => onSeek(segment.start_ms / 1000)}>{transcriptTimeLabel(segment.start_ms)}</button> : <span className="transcript-time" title={`${formatElapsedMs(segment.start_ms)} – ${formatElapsedMs(segment.end_ms)}`}>{transcriptTimeLabel(segment.start_ms)}</span>}<p className="transcript-text">{segment.text}</p>
        </li>)}</ol> : <div className="transcript-reading">{transcriptParagraphs(text).map((paragraph, index) => <p className="transcript-text" key={index}>{paragraph}</p>)}</div>}
      </div>
    </>}
    {transcript.status === 'ready' && !text && <p className="helper-copy" role="status">The completed transcript contains no text.</p>}
    {feedback && <p className={`transcript-feedback ${feedback.error ? 'inline-error' : 'helper-copy'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
  </>;
}
