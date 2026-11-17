'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import { Bookmark, ChevronLeft, ChevronRight, Heart, History, Layers, MessageCircle, NotebookPen, Play } from 'lucide-react';
import type { Carousel, CarouselDetail, CarouselSlide } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { carouselMediaUrl } from '@/lib/carousels';
import { formatDate, formatDateTime, formatNumber, formatPercent, formatScore } from '@/lib/format';
import { isStale } from '@/lib/metrics';
import { invalidateResources } from '@/lib/resource-cache';
import { Avatar, Dialog, ErrorState, Skeleton, SourceLink, useResource, type Notify } from './ui';
import { CarouselDownloadControls } from './carousel-download-controls';

export function CarouselImage({ url, alt, large = false }: { url: string | null; alt: string; large?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = carouselMediaUrl(url);
  return src && src !== failed
    ? <Image src={src} alt={alt} fill unoptimized sizes={large ? '(max-width: 800px) 85vw, (max-width: 1200px) 60vw, 800px' : '(max-width: 640px) 90vw, 320px'} referrerPolicy="no-referrer" onError={() => setFailed(src)}/>
    : <div className="carousel-media-missing"><Layers size={28}/><span>Image unavailable</span></div>;
}

function SlideMedia({ slide, alt }: { slide: CarouselSlide; alt: string }) {
  const [failed, setFailed] = useState(false);
  const video = slide.media_type === 'video' ? carouselMediaUrl(slide.video_url) : null;
  return video && !failed
    ? <video src={video} poster={carouselMediaUrl(slide.image_url) ?? undefined} controls playsInline preload="none" aria-label={alt} onError={() => setFailed(true)}/>
    : <><CarouselImage url={slide.image_url} alt={alt} large/>{slide.media_type === 'video' && <span className="carousel-video-note">Video unavailable · preview image</span>}</>;
}

export function CarouselGallery({ carousel, workspaceId }: { carousel: Carousel; workspaceId?: string }) {
  const [requestedIndex, setIndex] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const slides = carousel.slides;
  const index = Math.min(requestedIndex, Math.max(0, slides.length - 1));
  const slide = slides[index];

  useEffect(() => {
    const row = strip.current;
    const active = row?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!row || !active) return;
    const bounds = row.getBoundingClientRect(), thumb = active.getBoundingClientRect();
    if (thumb.left < bounds.left) row.scrollLeft -= bounds.left - thumb.left + 4;
    else if (thumb.right > bounds.right) row.scrollLeft += thumb.right - bounds.right + 4;
    if (row.contains(document.activeElement)) active.focus({ preventScroll: true });
  }, [index]);

  function move(amount: number) {
    setIndex(current => Math.max(0, Math.min(slides.length - 1, current + amount)));
  }

  return <section className="carousel-gallery" aria-label="Carousel slides" onKeyDown={event => {
    if (!slides.length || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('video')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home') { event.preventDefault(); setIndex(0); }
    else if (event.key === 'End') { event.preventDefault(); setIndex(slides.length - 1); }
  }}>
    <div className="carousel-slide-frame">
      <div className="carousel-slide" tabIndex={0} onPointerDown={event => {
        if (event.pointerType !== 'mouse' && !(event.target as HTMLElement).closest('video'))
          start.current = { x: event.clientX, y: event.clientY };
      }} onPointerCancel={() => { start.current = null; }} onPointerUp={event => {
        const origin = start.current;
        start.current = null;
        if (!origin) return;
        const x = event.clientX - origin.x, y = event.clientY - origin.y;
        if (Math.abs(x) > 50 && Math.abs(x) > Math.abs(y)) move(x < 0 ? 1 : -1);
      }}>
        {slide
          ? <SlideMedia key={carousel.id + '-' + index} slide={slide} alt={'Slide ' + (index + 1) + ' of ' + slides.length + ' from @' + carousel.username}/>
          : <div className="carousel-media-missing"><Layers size={32}/><span>Slides unavailable</span><small>Open the original post to view the carousel.</small></div>}
      </div>
      {slides.length > 1 && <>
        <button type="button" className="carousel-viewer-arrow carousel-viewer-previous" aria-label="Previous slide" disabled={index === 0} onClick={() => move(-1)}><ChevronLeft size={22}/></button>
        <button type="button" className="carousel-viewer-arrow carousel-viewer-next" aria-label="Next slide" disabled={index === slides.length - 1} onClick={() => move(1)}><ChevronRight size={22}/></button>
      </>}
    </div>
    {slides.length > 0 && <div className="carousel-gallery-footer">
      <div className="carousel-slide-controls">
        <span className="carousel-slide-kind">{slide.media_type === 'video' ? <Play size={13}/> : <Layers size={13}/>} {slide.media_type === 'video' ? 'Video slide' : 'Carousel'}</span>
        <span aria-live="polite" aria-atomic="true"><strong>{index + 1}</strong><span className="carousel-slide-total"> / {slides.length}</span></span>
        <span className="carousel-keyboard-hint">← → to navigate</span>
      </div>
      <div ref={strip} className="carousel-thumbnails" role="group" aria-label="Choose slide">
        {slides.map((item, i) => <button type="button" key={i} className="carousel-thumbnail" aria-label={'Go to slide ' + (i + 1)} aria-pressed={index === i} tabIndex={index === i ? 0 : -1} onClick={() => setIndex(i)}>
          <CarouselImage url={item.image_url} alt=""/>
          <span className="carousel-thumbnail-number" aria-hidden="true">{i + 1}</span>
          {item.media_type === 'video' && <Play className="carousel-thumbnail-video" size={12} fill="currentColor" aria-hidden="true"/>}
        </button>)}
      </div>
      <CarouselDownloadControls carousel={carousel} workspaceId={workspaceId} currentSlide={index + 1}/>
    </div>}
    {!slides.length && <div className="carousel-gallery-footer"><CarouselDownloadControls carousel={carousel} workspaceId={workspaceId} currentSlide={1}/></div>}
  </section>;
}

function CarouselResearch({ carousel: c, workspaceId, notify }: { carousel: Carousel; workspaceId: string; notify: Notify }) {
  const [note, setNote] = useState(c.note), [tags, setTags] = useState(c.tags.join(', '));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const id = useId();
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const list = [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))];
    if (list.length > 20 || list.some(tag => tag.length > 40)) {
      setError('Use up to 20 tags, with at most 40 characters each.');
      return;
    }
    setBusy(true); setError('');
    try {
      await api('/api/workspaces/' + workspaceId + '/carousels/' + c.id + '/saved', { method: 'PUT', body: JSON.stringify({ saved: true, note, tags: list }) });
      notify('Carousel research saved to this workspace.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <form className="carousel-research" onSubmit={save}>
    <div className="carousel-panel-heading"><h3>Research notes</h3><p>Keep the ideas you want to return to.</p></div>
    <label htmlFor={id + '-note'}>Notes<textarea id={id + '-note'} value={note} onChange={event => setNote(event.target.value)} maxLength={4000} rows={7} placeholder="What makes this carousel work?"/></label>
    <label htmlFor={id + '-tags'}>Tags<input id={id + '-tags'} value={tags} onChange={event => setTags(event.target.value)} placeholder="hook, storytelling, tutorial" aria-describedby={id + '-tags-help'}/></label>
    <p id={id + '-tags-help'} className="carousel-field-help">Separate tags with commas.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button className="button button-accent" disabled={busy}><Bookmark size={15}/>{busy ? 'Saving…' : 'Save research'}</button>
  </form>;
}

const tabs = [
  { id: 'overview', label: 'Overview', icon: Layers },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
  { id: 'history', label: 'History', icon: History },
] as const;
type DetailTab = typeof tabs[number]['id'];

export function CarouselDetailView({ detail, workspaceId, notify, error, retry }: { detail: CarouselDetail; workspaceId: string; notify: Notify; error?: string | null; retry?: () => void }) {
  const c = detail.carousel;
  const [tab, setTab] = useState<DetailTab>('overview');
  const id = useId();
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div className="carousel-detail-layout">
    <CarouselGallery key={c.id} carousel={c} workspaceId={workspaceId}/>
    <aside className="carousel-details-panel" aria-label="Carousel details and research">
      <div className="carousel-details-creator"><Avatar username={c.username} url={c.avatar_url}/><div><strong>@{c.username}</strong><p>{formatDate(c.published_at)} · {c.slides.length} slides</p></div>{c.saved && <span className="carousel-saved-indicator" title="Saved to this workspace"><Bookmark size={15} fill="currentColor"/><span className="sr-only">Saved to this workspace</span></span>}</div>
      <div className="carousel-details-tabs" role="tablist" aria-label="Carousel information">
        {tabs.map((item, index) => <button type="button" key={item.id} ref={element => { tabButtons.current[index] = element; }} role="tab" id={id + '-tab-' + item.id} aria-controls={id + '-panel-' + item.id} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
          let next: number;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else return;
          event.preventDefault(); setTab(tabs[next].id); tabButtons.current[next]?.focus();
        }}><item.icon size={15} aria-hidden="true"/>{item.label}</button>)}
      </div>
      <div className="carousel-details-content">
        {error && <div className="inline-error" role="status"><p>Update failed: {error}</p>{retry && <button type="button" className="button" onClick={retry}>Retry details</button>}</div>}
        <section role="tabpanel" id={id + '-panel-overview'} aria-labelledby={id + '-tab-overview'} hidden={tab !== 'overview'} tabIndex={0}>
          <div className="carousel-panel-heading"><h3>Performance</h3></div>
          <dl className="carousel-detail-metrics">
            <div><dt><Heart size={14}/>Likes</dt><dd>{formatNumber(c.latest_likes)}{c.likes_state === 'hidden' && <small>Hidden</small>}</dd></div>
            <div><dt><MessageCircle size={14}/>Comments</dt><dd>{formatNumber(c.latest_comments)}</dd></div>
            <div><dt>Profile outlier</dt><dd>{formatScore(c.profile_outlier_score)}</dd></div>
            <div><dt>Follower engagement</dt><dd>{formatPercent(c.follower_engagement_pct)}</dd></div>
          </dl>
          <div className="carousel-caption-section"><h3>Caption</h3><p className="carousel-full-caption">{c.caption || 'No caption available'}</p></div>
          <details className="carousel-data-context"><summary>About these metrics</summary>
            <p>{c.profile_baseline_sample} earlier comparisons · median {formatNumber(c.profile_baseline_interactions)} interactions. {c.profile_baseline_sample < 10 ? 'At least 10 known comparisons are needed for a profile score.' : c.profile_baseline_sample < 30 ? 'Limited sample.' : ''}</p>
            <p>{formatNumber(c.followers_count)} captured followers · {formatDateTime(c.follower_captured_at)}.</p>
            <p>Updated {formatDateTime(c.latest_fetched_at)}{isStale(c.latest_fetched_at) ? ' · stale' : ''}.</p>
          </details>
        </section>
        <section role="tabpanel" id={id + '-panel-notes'} aria-labelledby={id + '-tab-notes'} hidden={tab !== 'notes'} tabIndex={0}>
          <CarouselResearch key={c.id} carousel={c} workspaceId={workspaceId} notify={notify}/>
        </section>
        <section role="tabpanel" id={id + '-panel-history'} aria-labelledby={id + '-tab-history'} hidden={tab !== 'history'} tabIndex={0}>
          <div className="carousel-panel-heading"><h3>Metric history</h3><p>Captured snapshots for this carousel.</p></div>
          {detail.snapshots.length ? <ol className="carousel-history-list">{detail.snapshots.map(snapshot => <li key={snapshot.fetched_at}>
            <time dateTime={snapshot.fetched_at}>{formatDateTime(snapshot.fetched_at)}</time>
            <dl><div><dt>Likes</dt><dd>{formatNumber(snapshot.likes)}</dd></div><div><dt>Comments</dt><dd>{formatNumber(snapshot.comments)}</dd></div><div><dt>Captured followers</dt><dd>{formatNumber(snapshot.followers_at_snapshot)}</dd></div></dl>
          </li>)}</ol> : <p className="carousel-panel-empty">No metric snapshots yet.</p>}
        </section>
      </div>
    </aside>
  </div>;
}

export function CarouselDialog({ id, workspaceId, notify, onClose }: { id: string; workspaceId: string; notify: Notify; onClose: () => void }) {
  const path = '/api/workspaces/' + workspaceId + '/carousels/' + id;
  const resource = useResource<CarouselDetail>(path);
  const c = resource.data?.carousel;
  return <Dialog title="Carousel details" wide className="carousel-detail-dialog" onClose={onClose} actions={c ? <SourceLink url={c.post_url} label="Open on Instagram"/> : undefined}>
    {resource.loading
      ? <div className="carousel-detail-status"><Skeleton/></div>
      : resource.error && !c
        ? <div className="carousel-detail-status"><ErrorState message={resource.error} retry={() => invalidateResources(path)}/></div>
        : resource.data && <CarouselDetailView key={c?.id} detail={resource.data} workspaceId={workspaceId} notify={notify} error={resource.error} retry={() => invalidateResources(path)}/>}
  </Dialog>;
}
