import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/lib/demo';
import { reelDetailPath } from '../src/lib/app-navigation';
import { reelPreviewSources, startReelPreview } from '../src/lib/reel-preview';
import { REQUEST_TIMEOUT_MS } from '../src/lib/client';
import { ReelHrefContext, ReelListContext, ReelNavigationContext } from '../src/components/reel-navigation';
import { ReelCard, ReelTable } from '../src/components/reels';
import { ReelPreviewButton, ReelPreviewContent, ReelPreviewDialog } from '../src/components/reel-preview-button';

const original = createDemoData().reels[0];
const reel = { ...original, provider: 'apify', reel_url: 'https://www.instagram.com/reel/ABC_123/' };
const source = 'https://video.cdninstagram.com/stored.mp4?token=captured';
const details = (urls: unknown = [source]) => ({ reel, media: { urls }, processing: { reason: null } });
const metadata = (value: unknown = details()) => Response.json(value);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native Reel detail links', () => {
  it('uses real hrefs for card and table targets while preserving workspace and filter context', () => {
    const query = { saved: true, search: 'opening hook' };
    const href = reelDetailPath(reel.id, 'workspace', '/saved?search=opening+hook', query);
    for (const component of [createElement(ReelCard, { reel, workspaceId: 'workspace', onSave: () => {} }), createElement(ReelTable, { reels: [reel], workspaceId: 'workspace', onSave: () => {} })]) {
      const html = renderToStaticMarkup(createElement(ReelListContext.Provider, { value: query }, createElement(ReelHrefContext.Provider, { value: (current, workspace, list) => reelDetailPath(current.id, workspace, '/saved?search=opening+hook', list) }, createElement(ReelNavigationContext.Provider, { value: () => {} }, component))));
      const anchor = html.match(/<a\b[^>]*aria-label="Open Reel by @[^"]+"[^>]*>/)![0];
      expect(anchor).toContain(`href="${href.replaceAll('&', '&amp;')}"`);
      expect(anchor).not.toContain('aria-haspopup');
      expect(anchor).not.toContain('target=');
      expect(html).toContain('Open reel');
      expect(html).not.toContain('<video');
      expect(html).not.toContain('role="dialog"');
    }
  });
  it('keeps Download then Preview independent from the card overlay and other actions', () => {
    const html = renderToStaticMarkup(createElement(ReelHrefContext.Provider, { value: () => '/reels/fixture?workspace=workspace' }, createElement(ReelCard, { reel, workspaceId: 'workspace', onSave: () => {} })));
    expect(html.indexOf('reel-download-button')).toBeLessThan(html.indexOf('reel-preview-button'));
    expect(html).toMatch(/<a[^>]*class="reel-card-open"[^>]*><\/a>/);
    expect(html).toContain('aria-label="Preview video by @');
    expect(html).toContain('reel-detail-link');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('on-demand Reel preview', () => {
  it('does not fetch video until the popup mounts and labels synthetic media honestly', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const html = renderToStaticMarkup(createElement(ReelPreviewButton, { reel, workspaceId: 'workspace' }));
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('Preview');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('role="dialog"');
    const demo = renderToStaticMarkup(createElement(ReelPreviewDialog, { reel: original, workspaceId: 'workspace', onClose: () => {} }));
    expect(demo).toContain('Synthetic demo Reel: no real video');
    expect(demo).not.toContain('<video');
    expect(demo).not.toContain('<iframe');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('renders loading, errors, original fallback and a native autoplay player', () => {
    const props = { reel, source: null, error: null, loading: true, videoRef: createRef<HTMLVideoElement>(), onPlaybackError: () => {} };
    expect(renderToStaticMarkup(createElement(ReelPreviewContent, props))).toContain('Loading video…');
    const error = renderToStaticMarkup(createElement(ReelPreviewContent, { ...props, error: 'Video expired' }));
    expect(error).toContain('role="alert"'); expect(error).not.toContain('<video');
    const player = renderToStaticMarkup(createElement(ReelPreviewContent, { ...props, source, loading: false }));
    expect(player).toContain(`src="${source}"`); expect(player).toContain('controls=""'); expect(player).toContain('autoPlay=""'); expect(player).toContain('playsInline=""');
    expect(player).not.toContain('blob:');
    expect(player).not.toContain('Buffering video…');
    const buffering = renderToStaticMarkup(createElement(ReelPreviewContent, { ...props, source, loading: true }));
    expect(buffering).toContain('<video'); expect(buffering).toContain('Buffering video…');
    expect(player).toContain('press Play');
    const popup = renderToStaticMarkup(createElement(ReelPreviewDialog, { reel, workspaceId: 'workspace', onClose: () => {} }));
    expect(popup).toContain('Open on Instagram'); expect(popup).toContain('role="dialog"'); expect(popup).not.toContain('<iframe');
  });
  it('gets authorized metadata without fetching or buffering the complete video', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const current = { ...details(), reel: { ...reel, id: 'reel/id' } };
    const response = metadata(current);
    const blob = vi.spyOn(response, 'blob');
    const fetcher = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetcher);
    const ready = vi.fn(), error = vi.fn();
    const request = startReelPreview('workspace/id', 'reel/id', ready, error);
    await request.finished;
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/workspaces/workspace%2Fid/reels/reel%2Fid', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(ready).toHaveBeenCalledWith([source]); expect(error).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled(); expect(blob).not.toHaveBeenCalled();
    request.cancel(); request.cancel();
    expect(fetcher.mock.calls[0][0]).not.toContain('/download');
  });
  it('validates and bounds stored fallback sources before passing them to the player', () => {
    const other = 'https://video.fbcdn.net/fallback.mp4';
    expect(reelPreviewSources(details([source, source, 'https://evil.test/private', other, 'https://video.cdninstagram.com/third.mp4', 'https://video.cdninstagram.com/fourth.mp4']), reel.id)).toEqual([source, other, 'https://video.cdninstagram.com/third.mp4']);
    for (const value of [null, {}, { ...details(), reel: original }, { ...details(), reel: { ...reel, id: 'another-reel' } }, { ...details(), processing: { reason: 'demo' } }, details('not-an-array'), details(['http://video.cdninstagram.com/video', 'https://127.0.0.1/private', 'https://video.cdninstagram.com:443/video'])]) expect(reelPreviewSources(value, reel.id)).toEqual([]);
  });
  it.each([
    { response: () => Response.json({ error: { message: 'Access denied' } }, { status: 403 }), message: 'Access denied' },
    { response: () => new Response('html', { headers: { 'Content-Type': 'text/html' } }), message: '' },
    { response: () => metadata(details([])), message: 'No playable video' },
    { response: () => metadata({ ...details(), reel: original }), message: 'No playable video' },
  ])('does not expose playback sources on failed or invalid reads: $message', async ({ response, message }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const ready = vi.fn(), error = vi.fn();
    const request = startReelPreview('workspace', reel.id, ready, error);
    await request.finished;
    expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0]).toContain(message); expect(ready).not.toHaveBeenCalled();
    request.cancel();
  });
  it('ignores late metadata after cancellation and settles even if fetch ignores abort', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const ready = vi.fn(), error = vi.fn();
    const request = startReelPreview('workspace', reel.id, ready, error);
    request.cancel(); await request.finished;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(metadata()); await Promise.resolve(); await Promise.resolve();
    expect(ready).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('times out stalled metadata without starting a video download or replaying the read', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetcher);
    const ready = vi.fn(), error = vi.fn();
    const request = startReelPreview('workspace', reel.id, ready, error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await request.finished;
    expect(error).toHaveBeenCalledWith('Request timed out. Please try again.');
    expect(ready).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
