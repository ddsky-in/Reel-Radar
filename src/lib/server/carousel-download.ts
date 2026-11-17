import type { CarouselSlide } from '../types';
import type { Repository } from './repository';
import { reelPlaybackUrl } from '../reel-detail';
import { ApiError } from './errors';
import { captureStoredMedia, type CapturedMediaType } from './captured-media';
import { checksumStoredBlob, createStoredZip, storedZipOverhead, type StoredZipEntry } from './stored-zip';

export const MAX_CAROUSEL_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CAROUSEL_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_CAROUSEL_ZIP_BYTES = 128 * 1024 * 1024;
export const MAX_CAROUSEL_SLIDES = 20;
export const CAROUSEL_FILE_TIMEOUT_MS = 15_000;
export const CAROUSEL_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;
type DownloadChoice = { slide: number; all?: never } | { all: true; slide?: never };
type MediaType = CapturedMediaType;
const extensions: Record<MediaType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };

function unavailable(status = 409, message = 'Stored carousel media is unavailable, expired, or invalid. No research data was changed.') {
  return new ApiError(status, 'CAROUSEL_MEDIA_UNAVAILABLE', message);
}
function tooLarge() { return new ApiError(413, 'CAROUSEL_TOO_LARGE', 'Carousel downloads allow 16 MiB per image, 64 MiB per video, and 128 MiB per ZIP.'); }
function timeout() { return new ApiError(504, 'DOWNLOAD_TIMEOUT', 'Carousel download timed out. No partial archive was returned.'); }

export function parseCarouselDownloadQuery(params: URLSearchParams): DownloadChoice {
  if (params.size === 1 && params.get('all') === 'true') return { all: true };
  const slide = params.get('slide');
  if (params.size === 1 && slide !== null && /^(?:[1-9]|1[0-9]|20)$/.test(slide)) return { slide: Number(slide) };
  throw new ApiError(400, 'INVALID_QUERY', 'Choose exactly one slide=1–20 or all=true. No other download parameters are accepted.');
}

function capturedMedia(url: string, kind: CarouselSlide['media_type'], maximumBytes: number, requestSignal: AbortSignal): Promise<{ body: Blob; type: MediaType }> {
  return captureStoredMedia(url, kind, {
    maximumBytes, timeoutMs: CAROUSEL_FILE_TIMEOUT_MS, signal: requestSignal,
    errors: { unavailable, tooLarge, timeout },
  });
}

const filenamePart = (value: string, fallback: string, dots = false) => typeof value === 'string' ? value.replace(dots ? /[^a-z0-9._-]/gi : /[^a-z0-9_-]/gi, '').slice(0, 64).replace(/^\.+|\.+$/g, '') || fallback : fallback;

/** Fetches only explicitly chosen, stored media after owner/workspace repository authorization. */
export async function downloadCarousel(repo: Pick<Repository, 'carouselDetail'>, workspaceId: string, carouselId: string, params: URLSearchParams, requestSignal?: AbortSignal): Promise<Response> {
  const choice = parseCarouselDownloadQuery(params);
  const detail = await repo.carouselDetail(workspaceId, carouselId), carousel = detail?.carousel;
  if (!carousel || typeof carousel.provider !== 'string') throw unavailable();
  if (/^(?:mock|demo|synthetic)/i.test(carousel.provider)) throw unavailable(404, 'Synthetic demo carousels have no media to download.');
  if (!Array.isArray(carousel.slides) || carousel.slides.length > MAX_CAROUSEL_SLIDES) throw unavailable();
  if (!carousel.slides.length || !choice.all && choice.slide > carousel.slides.length) throw unavailable(404, 'The requested carousel slide is not stored.');
  const prefix = `${filenamePart(carousel.username, 'creator', true)}_${filenamePart(carousel.shortcode, 'carousel')}`;
  const selected = carousel.slides.map((slide, index) => ({ slide, index })).filter(({ index }) => choice.all || index + 1 === choice.slide);
  const sources = selected.map(({ slide, index }) => {
    if (!slide || slide.position !== index + 1 || !['image', 'video'].includes(slide.media_type)) throw unavailable();
    const stored = slide.media_type === 'video' ? slide.video_url : slide.image_url;
    if (!stored) throw unavailable(404, 'Original media is missing for a requested slide. No thumbnail fallback or partial archive is available.');
    const url = reelPlaybackUrl(stored);
    if (!url) throw unavailable();
    return { url, kind: slide.media_type, name: `${prefix}_slide${String(index + 1).padStart(2, '0')}` };
  });
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) throw new ApiError(429, 'DOWNLOAD_BUSY', 'Two carousel downloads are already active. Please try again shortly.');
  activeDownloads++;
  const deadline = AbortSignal.timeout(CAROUSEL_DOWNLOAD_TIMEOUT_MS), signal = requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline;
  try {
    const entries: StoredZipEntry[] = [];
    let remaining = MAX_CAROUSEL_ZIP_BYTES - storedZipOverhead(sources.map(source => `${source.name}.${source.kind === 'video' ? 'mp4' : 'webp'}`));
    for (const source of sources) {
      signal.throwIfAborted();
      const maximum = Math.min(source.kind === 'video' ? MAX_CAROUSEL_VIDEO_BYTES : MAX_CAROUSEL_IMAGE_BYTES, choice.all ? remaining : MAX_CAROUSEL_VIDEO_BYTES);
      const media = await capturedMedia(source.url, source.kind, maximum, signal);
      remaining -= media.body.size;
      entries.push({ name: `${source.name}.${extensions[media.type]}`, body: media.body, crc32: 0 });
    }
    if (choice.all) {
      // Reject invalid/oversized archives before spending time on their checksums.
      for (const entry of entries) entry.crc32 = await checksumStoredBlob(entry.body, signal);
    }
    signal.throwIfAborted();
    const body = choice.all ? createStoredZip(entries, MAX_CAROUSEL_ZIP_BYTES) : entries[0].body;
    const name = choice.all ? `${prefix}_slides.zip` : entries[0].name;
    return new Response(body, { headers: {
      'Content-Type': body.type,
      'Content-Length': String(body.size),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    } });
  } catch (error) {
    if (deadline.aborted) throw timeout();
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally { activeDownloads--; }
}
