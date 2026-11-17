import { reelPlaybackUrl } from '../reel-detail';
import { ApiError } from './errors';
import { readMediaResponse } from './media-transport';

export type CapturedMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';
export type CapturedMedia = { body: Blob; type: CapturedMediaType };
type CaptureErrors = { unavailable: () => ApiError; tooLarge: () => ApiError; timeout: () => ApiError };
type CaptureOptions = { maximumBytes: number; timeoutMs: number; signal: AbortSignal; errors: CaptureErrors };
const MAX_REDIRECTS = 3;

async function mediaResponse(url: string, signal: AbortSignal, kind: 'image' | 'video' | 'unknown', unavailable: CaptureErrors['unavailable']): Promise<Response> {
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    const response = await readMediaResponse(url, { signal, headers: { Accept: kind === 'video' ? 'video/mp4' : 'image/jpeg, image/png, image/webp' } });
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    if (response.redirected || response.url && response.url !== url) {
      await response.body?.cancel();
      throw unavailable();
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS || /[\\\s]/.test(location)) throw unavailable();
      let next: string | null;
      try { next = reelPlaybackUrl(location.startsWith('https://') ? location : location.startsWith('//') ? `https:${location}` : new URL(location, url).href); } catch { next = null; }
      if (!next) throw unavailable();
      url = next;
      continue;
    }
    return response;
  }
  throw unavailable();
}

const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
async function validSignature(blob: Blob, type: CapturedMediaType, signal: AbortSignal): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  signal.throwIfAborted();
  if (type === 'image/jpeg') {
    const tail = new Uint8Array(await blob.slice(-2).arrayBuffer());
    return blob.size >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && tail[0] === 0xff && tail[1] === 0xd9;
  }
  if (type === 'image/png') {
    if (blob.size < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => head[index] === byte)) return false;
    const view = new DataView(head.buffer), tail = new Uint8Array(await blob.slice(-12).arrayBuffer());
    return view.getUint32(8) === 13 && ascii(head, 12, 4) === 'IHDR' && view.getUint32(16) > 0 && view.getUint32(20) > 0
      && ascii(tail, 0, 12) === '\0\0\0\0IEND\xaeB`\x82';
  }
  if (type === 'image/webp') {
    return blob.size >= 20 && ascii(head, 0, 4) === 'RIFF' && new DataView(head.buffer).getUint32(4, true) === blob.size - 8
      && ascii(head, 8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(head, 12, 4))
      && new DataView(head.buffer).getUint32(16, true) > 0 && new DataView(head.buffer).getUint32(16, true) <= blob.size - 20;
  }
  // Carousel clips may be silent: verify the MP4 container, not an audio/duration requirement.
  if (blob.size < 32 || ascii(head, 4, 4) !== 'ftyp') return false;
  let offset = 0, boxes = 0, movie = false, media = false;
  while (offset < blob.size && boxes++ < 4096) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + 16).arrayBuffer());
    if (bytes.length < 8) return false;
    const view = new DataView(bytes.buffer), kind = ascii(bytes, 4, 4);
    let size = view.getUint32(0), header = 8;
    if (size === 1) {
      if (bytes.length < 16) return false;
      const large = view.getBigUint64(8);
      if (large > BigInt(blob.size)) return false;
      size = Number(large); header = 16;
    } else if (size === 0) size = blob.size - offset;
    if (size < header || size > blob.size - offset) return false;
    if (offset === 0) {
      if (size < header + 8 || size > 4096 || (size - header) % 4) return false;
      const brands = new Uint8Array(await blob.slice(header, size).arrayBuffer());
      const allowed = /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/;
      let compatible = allowed.test(ascii(brands, 0, 4));
      for (let at = 8; at < brands.length; at += 4) compatible ||= allowed.test(ascii(brands, at, 4));
      if (!compatible) return false;
    }
    if (kind === 'moov' && size > header) movie = true;
    if (kind === 'mdat' && size > header) media = true;
    offset += size;
  }
  return offset === blob.size && movie && media;
}

/** Bounded capture of an already-authorized stored CDN source; never forwards upstream headers. */
export async function captureStoredMedia(url: string, kind: 'image' | 'video' | 'unknown', options: CaptureOptions): Promise<CapturedMedia> {
  const { maximumBytes, errors: { unavailable, tooLarge, timeout } } = options;
  const deadline = AbortSignal.timeout(options.timeoutMs), signal = AbortSignal.any([deadline, options.signal]);
  try {
    const response = await mediaResponse(url, signal, kind, unavailable);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const accepted = kind === 'video' ? type === 'video/mp4' : ['image/jpeg', 'image/png', 'image/webp'].includes(type ?? '');
    const length = response.headers.get('content-length');
    if (response.status !== 200 || !accepted || !response.body || length !== null && !/^\d+$/.test(length)) {
      await response.body?.cancel(); throw unavailable();
    }
    if (length !== null && Number(length) > maximumBytes) { await response.body.cancel(); throw tooLarge(); }
    const reader = response.body.getReader(), chunks: BlobPart[] = [];
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
        if (size > maximumBytes) throw tooLarge();
        chunks.push(new Uint8Array(value));
      }
      if (!size || length !== null && Number(length) !== size) throw unavailable();
      const body = new Blob(chunks, { type });
      if (!await validSignature(body, type as CapturedMediaType, signal)) throw unavailable();
      signal.throwIfAborted();
      return { body, type: type as CapturedMediaType };
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (deadline.aborted) throw timeout();
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}
