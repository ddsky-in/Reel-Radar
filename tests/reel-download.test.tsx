import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/lib/demo';
import type { ReelDetail } from '../src/lib/types';
import { downloadReel, MAX_REEL_DOWNLOAD_BYTES } from '../src/lib/server/reel-download';
import { ApiError } from '../src/lib/server/errors';
import { ReelDownloadButton } from '../src/components/reel-download-button';
import { mp4Fixture } from './mp4-fixture';

const original = createDemoData().reels[0];
const url = 'https://video.cdninstagram.com/stored.mp4?token=private';
const secondUrl = 'https://video.fbcdn.net/stored.mp4';
const reel = { ...original, provider: 'apify', shortcode: 'ABC_123' };
const detail: ReelDetail = {
  reel, media: { urls: [url], observed_at: null },
  transcript: { reel_id: reel.id, status: 'not_requested', text: null, language: null, segments: [], model: null, completed_at: null, error_message: null },
  processing: { request_allowed: false, reason: null, estimate: null },
};
const mp4 = mp4Fixture();
const mediaResponse = () => new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
const repository = (value = detail) => ({ reelDetail: vi.fn().mockResolvedValue(value) });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('authorized downloads of captured Reel media', () => {
  it('checks repository authorization before requesting any media', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const repo = { reelDetail: vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied')) };
    await expect(downloadReel(repo, 'other-workspace', reel.id)).rejects.toMatchObject({ status: 403 });
    expect(repo.reelDetail).toHaveBeenCalledWith('other-workspace', reel.id);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns an MP4 attachment without exposing the stored URL or forwarding credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(mediaResponse()); vi.stubGlobal('fetch', fetcher);
    const response = await downloadReel(repository(), 'workspace', reel.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="reelradar-ABC_123.mp4"');
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect([...response.headers.values()].join()).not.toContain('token=private');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp4);
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Accept: 'video/mp4, application/octet-stream' });
  });

  it('does not download demo media or missing/unsafe URLs', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const value of [
      { ...detail, reel: original },
      { ...detail, media: { urls: [], observed_at: null } },
      { ...detail, media: { urls: ['https://127.0.0.1/private', 'https://evil.test/video.mp4', 'https://user@video.cdninstagram.com/private', 'https://video.cdninstagram.com:443/video'], observed_at: null } },
    ]) await expect(downloadReel(repository(value), 'workspace', reel.id)).rejects.toMatchObject({ status: 404, code: 'VIDEO_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back only to another stored candidate when a video has expired', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('expired', { status: 403 })).mockResolvedValueOnce(mediaResponse());
    vi.stubGlobal('fetch', fetcher);
    const response = await downloadReel(repository({ ...detail, media: { urls: [url, url, secondUrl], observed_at: null } }), 'workspace', reel.id);
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls.map(([address]) => address)).toEqual([url, secondUrl]);
  });
  it('falls back from a silent variant and reports missing audio instead of downloading it silently', async () => {
    const silent = mp4.slice();
    const handler = new TextDecoder('latin1').decode(silent).indexOf('soun');
    silent.set(new TextEncoder().encode('vide'), handler);
    const noAudio = () => new Response(silent.slice(), { headers: { 'Content-Type': 'video/mp4' } });
    const fetcher = vi.fn().mockResolvedValueOnce(noAudio()).mockResolvedValueOnce(mediaResponse());
    vi.stubGlobal('fetch', fetcher);
    const result = await downloadReel(repository({ ...detail, media: { urls: [url, secondUrl], observed_at: null } }), 'workspace', reel.id);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(mp4);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockResolvedValue(noAudio());
    await expect(downloadReel(repository(), 'workspace', reel.id)).rejects.toMatchObject({ code: 'VIDEO_AUDIO_UNAVAILABLE' });
  });

  it.each([
    () => new Response('redirect', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }),
    () => new Response('<html>expired</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('<html>expired</html>', { headers: { 'Content-Type': 'video/mp4' } }),
    () => new Response(mp4, { status: 206, headers: { 'Content-Type': 'video/mp4' } }),
    () => new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MAX_REEL_DOWNLOAD_BYTES + 1) } }),
    () => new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '999' } }),
  ])('rejects redirected, invalid, partial, oversized or truncated media', async response => {
    const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher);
    await expect(downloadReel(repository(), 'workspace', reel.id)).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds bytes even without a declared length and releases its active-download slot', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_REEL_DOWNLOAD_BYTES + 1)); }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'video/mp4' } })));
    await expect(downloadReel(repository(), 'workspace', reel.id)).rejects.toMatchObject({ status: 413, code: 'VIDEO_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mediaResponse()));
    expect((await downloadReel(repository(), 'workspace', reel.id)).status).toBe(200);
  });

  it('cancels a stalled body when the caller aborts', async () => {
    const cancel = vi.fn();
    const abort = new AbortController();
    let fetched!: () => void;
    const started = new Promise<void>(resolve => { fetched = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => { fetched(); return new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'video/mp4' } }); }));
    const download = downloadReel(repository(), 'workspace', reel.id, abort.signal);
    await started;
    await Promise.resolve();
    abort.abort();
    await expect(download).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
    expect(cancel).toHaveBeenCalled();
  });

  it('renders a labelled download control without eagerly requesting media', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const markup = renderToStaticMarkup(createElement(ReelDownloadButton, { reel, workspaceId: 'workspace' }));
    expect(markup).toContain(`aria-label="Download video by @${reel.username}"`);
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain(url);
    const synthetic = renderToStaticMarkup(createElement(ReelDownloadButton, { reel: original, workspaceId: 'workspace' }));
    expect(synthetic).toContain('disabled=""');
    expect(synthetic).toContain('Synthetic Reel: video download unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
