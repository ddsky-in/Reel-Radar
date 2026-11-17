'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import type { Reel } from '../lib/types';
import { startReelPreview } from '../lib/reel-preview';
import { Dialog, SourceLink } from './ui';

export function ReelPreviewButton({ reel, workspaceId }: { reel: Reel; workspaceId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="reel-preview-button" aria-label={`Preview video by @${reel.username}`} title="Preview video" aria-haspopup="dialog" onClick={() => setOpen(true)}><Play size={15} aria-hidden="true"/>Preview</button>
    {open && <ReelPreviewDialog key={`${workspaceId}-${reel.id}`} reel={reel} workspaceId={workspaceId} onClose={() => setOpen(false)}/>}
  </>;
}

export function ReelPreviewDialog({ reel, workspaceId, onClose }: { reel: Reel; workspaceId: string; onClose: () => void }) {
  const [sources, setSources] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const requestRef = useRef<ReturnType<typeof startReelPreview> | null>(null);
  const synthetic = reel.provider.startsWith('mock');
  const source = sources[index] ?? null;
  useEffect(() => {
    if (synthetic) return;
    const request = startReelPreview(workspaceId, reel.id, setSources, setError);
    requestRef.current = request;
    return () => { request.cancel(); requestRef.current = null; };
  }, [workspaceId, reel.id, synthetic]);
  useEffect(() => {
    if (!source || error) return;
    const video = videoRef.current;
    return () => { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } };
  }, [source, error]);
  function close() {
    videoRef.current?.pause();
    requestRef.current?.cancel();
    onClose();
  }
  function playbackError() {
    if (sources[index + 1]) { setBuffering(true); setIndex(value => value + 1); }
    else setError('Stored video links are unavailable or could not be played. View the original Reel on Instagram instead.');
  }
  const loading = !synthetic && !error && (!source || buffering);
  return <Dialog title="Reel preview" subtitle={`@${reel.username}`} onClose={close} className="reel-preview-dialog">
    <ReelPreviewContent reel={reel} source={source} error={error} loading={loading} videoRef={videoRef} onPlaybackError={playbackError} onReady={() => setBuffering(false)} onWaiting={() => setBuffering(true)}/>
    <div className="reel-preview-footer"><SourceLink url={reel.reel_url} label="Open on Instagram"/></div>
  </Dialog>;
}

export function ReelPreviewContent({ reel, source, error, loading, videoRef, onPlaybackError, onReady, onWaiting }: { reel: Reel; source: string | null; error: string | null; loading: boolean; videoRef: React.RefObject<HTMLVideoElement | null>; onPlaybackError: () => void; onReady?: () => void; onWaiting?: () => void }) {
  if (reel.provider.startsWith('mock')) return <div className="reel-preview-status" role="status"><Play size={24} aria-hidden="true"/><p>Synthetic demo Reel: no real video is available to preview.</p></div>;
  if (error) return <div className="reel-preview-status" role="alert"><p>{error}</p></div>;
  if (source) return <><div className="reel-preview-player"><video key={source} ref={videoRef} src={source} controls playsInline autoPlay preload="auto" aria-label={`Video preview by @${reel.username}`} onError={onPlaybackError} onLoadedData={onReady} onCanPlay={onReady} onPlaying={onReady} onWaiting={onWaiting} onSeeking={onWaiting} onSeeked={onReady}>Your browser does not support video playback.</video>{loading && <div className="reel-preview-buffering" role="status"><Loader2 size={24} className="spin" aria-hidden="true"/><span>Buffering video…</span></div>}</div><p className="reel-preview-footer">If playback doesn’t start automatically, press Play.</p></>;
  return <div className="reel-preview-status" role="status" aria-busy={loading}>{loading && <Loader2 size={24} className="spin" aria-hidden="true"/>}<p>{loading ? 'Loading video…' : 'No playable video is available for this Reel.'}</p></div>;
}
