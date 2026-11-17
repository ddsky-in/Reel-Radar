import type { Repository } from './repository';
import { ApiError } from './errors';
import { reelPlaybackUrl } from '../reel-detail';
import { mp4Duration } from '../../../supabase/functions/_shared/mp4';

export const MAX_REEL_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;

function unavailable() {
  return new ApiError(502, 'VIDEO_UNAVAILABLE', 'The video link is unavailable or expired. Try again after this Reel is refreshed.');
}

async function videoBlob(response: Response, signal: AbortSignal): Promise<Blob> {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const length = response.headers.get('content-length');
  if (!response.ok || response.status !== 200 || response.redirected || !['video/mp4', 'application/octet-stream'].includes(type ?? '') ||
      length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REEL_DOWNLOAD_BYTES)) {
    await response.body?.cancel();
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REEL_DOWNLOAD_BYTES) throw new ApiError(413, 'VIDEO_TOO_LARGE', 'This video exceeds the 100 MB download limit.');
      chunks.push(new Uint8Array(value));
    }
    if (length !== null && Number(length) !== size) throw unavailable();
    const blob = new Blob(chunks, { type: 'video/mp4' });
    try { mp4Duration(new Uint8Array(await blob.arrayBuffer()), 86400); }
    catch (error) {
      if (error instanceof Error && error.message === 'Media audio unavailable') throw new ApiError(502, 'VIDEO_AUDIO_UNAVAILABLE', 'The stored video has no audio track. Refresh all details for this competitor to recover its media.');
      throw unavailable();
    }
    return blob;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only downloads already captured media after the repository authorizes the workspace and Reel. */
export async function downloadReel(repo: Pick<Repository, 'reelDetail'>, workspaceId: string, reelId: string, requestSignal?: AbortSignal): Promise<Response> {
  const detail = await repo.reelDetail(workspaceId, reelId);
  if (detail.reel.provider.startsWith('mock') || detail.processing.reason === 'demo') {
    throw new ApiError(404, 'VIDEO_UNAVAILABLE', 'Synthetic demo Reels have no video to download.');
  }
  const candidates = [...new Set(detail.media.urls.slice(0, 16).map(reelPlaybackUrl).filter((url): url is string => url !== null))].slice(0, 3);
  if (!candidates.length) throw new ApiError(404, 'VIDEO_UNAVAILABLE', 'No downloadable video is stored for this Reel yet.');
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) throw new ApiError(429, 'DOWNLOAD_BUSY', 'Two videos are already downloading. Please try again shortly.');
  activeDownloads++;
  const deadline = AbortSignal.timeout(50_000);
  const signal = requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline;
  let audioError: ApiError | null = null;
  try {
    for (const url of candidates) {
      if (signal.aborted) break;
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal, headers: { Accept: 'video/mp4, application/octet-stream' } });
        if (response.url && response.url !== url) { await response.body?.cancel(); continue; }
        const blob = await videoBlob(response, signal);
        const identity = detail.reel.shortcode.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || reelId.replace(/[^a-z0-9-]/gi, '').slice(0, 36);
        return new Response(blob, { headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(blob.size),
          'Content-Disposition': `attachment; filename="reelradar-${identity}.mp4"`,
          'Cache-Control': 'no-store, private',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'same-origin',
        } });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'VIDEO_TOO_LARGE') throw error;
        if (error instanceof ApiError && error.code === 'VIDEO_AUDIO_UNAVAILABLE') audioError = error;
        // Expired stored candidates may fall back to another stored URL, never to a scraper.
      }
    }
    if (deadline.aborted) throw new ApiError(504, 'DOWNLOAD_TIMEOUT', 'Video download timed out. Please try again.');
    if (audioError) throw audioError;
    throw unavailable();
  } finally { activeDownloads--; }
}
