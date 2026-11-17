'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { Carousel, CarouselSlide } from '@/lib/types';
import { carouselMediaUrl } from '@/lib/carousels';
import { errorMessage } from '@/lib/client';

type DownloadChoice = { slide: number } | { all: true };
type RequestScope = { workspaceId: string; carouselId: string };
type DownloadRequest = RequestScope & { controller: AbortController; choice: DownloadChoice };
type Feedback = RequestScope & { text: string; error: boolean };

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/zip': 'zip' };

function hasCapturedMedia(slide: CarouselSlide) {
  const media = slide.media_type === 'video' ? slide.video_url : slide.media_type === 'image' ? slide.image_url : null;
  return carouselMediaUrl(media)?.startsWith('https://') === true;
}

function attachmentFilename(disposition: string | null, mime: string, fallback: string) {
  if (!disposition || !/^attachment(?:\s*;|\s*$)/i.test(disposition)) throw new Error('The download response was not a media attachment. Please try again.');
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i.exec(disposition)?.slice(1).find(value => value !== undefined) ?? '';
  if (encoded) {
    try { name = decodeURIComponent(encoded.trim()); } catch { name = ''; }
  }
  // Never derive a name from media URLs, paths, or URL-like header values.
  if (/[\x00-\x1f\x7f/\\:?#]/.test(name)) name = '';
  const extension = extensions[mime];
  const stem = name.replace(/\.[^.]*$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 140);
  return `${stem || fallback}.${extension}`;
}

export function CarouselDownloadControls({ carousel, workspaceId, currentSlide }: { carousel: Carousel; workspaceId?: string; currentSlide: number }) {
  const [busy, setBusy] = useState<(RequestScope & { choice: DownloadChoice }) | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const pending = useRef<DownloadRequest | null>(null);
  const mounted = useRef(true);
  const noteId = useId();
  const slides = carousel.slides;
  const slide = Number.isInteger(currentSlide) && currentSlide > 0 ? slides[currentSlide - 1] : undefined;
  const synthetic = /^(mock|synthetic|demo)/i.test(carousel.provider);
  const currentAvailable = !!slide && hasCapturedMedia(slide);
  const allAvailable = slides.length > 0 && slides.every(hasCapturedMedia);
  const activeBusy = busy?.workspaceId === workspaceId && busy?.carouselId === carousel.id ? busy : null;
  const activeFeedback = feedback?.workspaceId === workspaceId && feedback?.carouselId === carousel.id ? feedback : null;
  const commonDisabled = synthetic || !workspaceId;
  const currentDisabled = commonDisabled || !currentAvailable;
  const allDisabled = commonDisabled || !allAvailable;
  const note = synthetic ? 'Synthetic carousel: downloads unavailable. Demo slides are not verified Instagram media.'
    : !workspaceId ? 'Select a workspace to download captured media.'
      : !slides.length ? 'Slide media is unavailable. Downloads cannot start.'
        : !currentAvailable ? `Slide ${currentSlide} media is unavailable. All-slides ZIP requires media for every slide; no partial archive is downloaded.`
          : !allAvailable ? 'All-slides ZIP is unavailable because some slide media is missing. No partial archive is downloaded.'
            : 'Download captured media only: an image or MP4 for the current slide, or one ZIP for all slides (up to 128 MB). Media links may have expired.';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, [carousel.id, workspaceId]);

  async function download(choice: DownloadChoice) {
    if (!mounted.current || pending.current || !workspaceId || ('all' in choice ? allDisabled : currentDisabled)) return;
    const request: DownloadRequest = { workspaceId, carouselId: carousel.id, choice, controller: new AbortController() };
    pending.current = request;
    setBusy(request);
    setFeedback(null);
    // Capture the requested ordinal, kind and fallback name before the gallery moves.
    const requestedMediaType = slide?.media_type;
    const count = slides.length;
    const identity = carousel.shortcode.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'carousel';
    const fallback = `reelradar-${identity}-${'all' in choice ? 'all-slides' : `slide-${choice.slide}`}`;
    const isCurrentRequest = () => mounted.current && pending.current === request;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.controller.abort(); }, 65_000);
    try {
      const query = 'all' in choice ? 'all=true' : `slide=${choice.slide}`;
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/carousels/${encodeURIComponent(carousel.id)}/download?${query}`, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: request.controller.signal,
      });
      request.controller.signal.throwIfAborted();
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        const message = failure?.error?.message;
        throw new Error(typeof message === 'string' && message.trim() ? message : 'Could not download this carousel media. Please try again.');
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
      const validType = 'all' in choice ? mime === 'application/zip' : requestedMediaType === 'video' ? mime === 'video/mp4' : imageTypes.has(mime);
      if (response.status !== 200 || !validType) throw new Error('The download response was not the requested media. Please try again.');
      const filename = attachmentFilename(response.headers.get('content-disposition'), mime, fallback);
      const blob = await response.blob();
      request.controller.signal.throwIfAborted();
      if (!isCurrentRequest()) return;
      if (!blob.size || blob.size > 128 * 1024 * 1024) throw new Error('The download is empty or exceeds the 128 MB limit. No file was saved.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        // Keep the blob alive long enough for the browser to begin saving, even after unmount.
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setFeedback({ workspaceId, carouselId: carousel.id, text: 'all' in choice ? `ZIP download started (${count} slides).` : `Slide ${choice.slide} download started.`, error: false });
    } catch (error) {
      if (isCurrentRequest()) setFeedback({ workspaceId, carouselId: carousel.id, text: timedOut ? 'The download timed out. Please try again.' : errorMessage(error), error: true });
    } finally {
      window.clearTimeout(timeout);
      if (isCurrentRequest()) { pending.current = null; setBusy(null); }
    }
  }

  const currentLabel = `Download current slide ${currentSlide} of ${slides.length}`;
  const allLabel = `Download all ${slides.length} slides as one ZIP`;
  const currentBusy = !!activeBusy && 'slide' in activeBusy.choice;
  const allBusy = !!activeBusy && 'all' in activeBusy.choice;
  return <div className="carousel-download-controls">
    <div className="carousel-download-actions" role="group" aria-label="Carousel downloads">
      <button type="button" className="carousel-download-button" aria-label={currentLabel} aria-describedby={noteId} title={currentDisabled ? note : currentLabel} disabled={!!activeBusy || currentDisabled} aria-busy={currentBusy} onClick={() => void download({ slide: currentSlide })}>
        {currentBusy ? <Loader2 size={15} className="spin" aria-hidden="true"/> : <Download size={15} aria-hidden="true"/>}Download current slide ({currentSlide})
      </button>
      <button type="button" className="carousel-download-button" aria-label={allLabel} aria-describedby={noteId} title={allDisabled ? note : allLabel} disabled={!!activeBusy || allDisabled} aria-busy={allBusy} onClick={() => void download({ all: true })}>
        {allBusy ? <Loader2 size={15} className="spin" aria-hidden="true"/> : <Download size={15} aria-hidden="true"/>}Download all slides ZIP
      </button>
    </div>
    <p id={noteId} className="carousel-download-note">{note}</p>
    {activeBusy && <p className="carousel-download-feedback" role="status" aria-live="polite">{'all' in activeBusy.choice ? 'Preparing all slides as one ZIP…' : `Downloading slide ${activeBusy.choice.slide}…`}</p>}
    {activeFeedback && <p className={`carousel-download-feedback${activeFeedback.error ? ' is-error' : ''}`} role={activeFeedback.error ? 'alert' : 'status'}>{activeFeedback.text}</p>}
  </div>;
}
