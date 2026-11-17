import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { reelPlaybackUrl } from '../reel-detail';
import { ApiError } from './errors';

export type MediaReadOptions = { signal: AbortSignal; headers: { Accept: string } };
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
const STREAM_BUFFER_BYTES = 64 * 1024;

export function mediaNetworkUnavailable(): ApiError {
  return new ApiError(502, 'DOWNLOAD_NETWORK_UNAVAILABLE', 'The stored media CDN could not be reached. Please try again. No research data was changed.');
}
function unsafeDestination(): ApiError {
  return new ApiError(409, 'CAROUSEL_MEDIA_UNAVAILABLE', 'Stored carousel media is unavailable, expired, or invalid. No research data was changed.');
}

/** Conservative public IPv4-only policy. IPv6, special-use and malformed addresses fail closed. */
export function isPublicMediaIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}

async function publicAddress(hostname: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // OS DNS work cannot be cancelled, but must not hold the caller beyond its deadline.
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { family: 4, all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(record => record.family !== 4 || !isPublicMediaIPv4(record.address))) throw unsafeDestination();
  return addresses[0].address;
}

/**
 * Isolated, streaming HTTPS GET for already-authorized stored CDN media only.
 * No global agent/DNS changes, proxy, cookies, auth, implicit redirects or retries.
 * The validated A address is pinned; the original hostname remains Host and TLS SNI.
 * Body byte caps and the 15s deadline belong to the carousel capture helper.
 */
export async function readMediaResponse(value: string, options: MediaReadOptions): Promise<Response> {
  const { signal } = options;
  signal.throwIfAborted();
  const validated = reelPlaybackUrl(value);
  if (!validated) throw unsafeDestination();
  const url = new URL(validated);
  let address: string;
  try { address = await publicAddress(url.hostname, signal); }
  catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw mediaNetworkUnavailable();
  }
  signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    let incoming: IncomingMessage | undefined;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      const reason = signal.reason instanceof Error ? signal.reason : new DOMException('Media download aborted', 'AbortError');
      incoming?.destroy(reason);
      req.destroy(reason);
    };
    const req = request(url, {
      method: 'GET',
      agent: false,
      family: 4,
      servername: url.hostname,
      rejectUnauthorized: true,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { Accept: options.headers.Accept, 'Accept-Encoding': 'identity' },
    }, response => {
      incoming = response;
      response.once('close', () => { cleanup(); req.destroy(); });
      try {
        signal.throwIfAborted();
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599) throw mediaNetworkUnavailable();
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        if ([204, 205, 304].includes(status)) {
          response.destroy();
          resolve(new Response(null, { status, headers }));
        } else {
          // Explicit byte accounting avoids toWeb's default one-unit-per-chunk buffering.
          const body = Readable.toWeb(response, { strategy: { highWaterMark: STREAM_BUFFER_BYTES, size: chunk => chunk.byteLength } });
          resolve(new Response(body as ReadableStream<Uint8Array>, { status, headers }));
        }
      } catch (error) {
        response.destroy(); req.destroy(); cleanup();
        reject(signal.aborted ? signal.reason : error instanceof ApiError ? error : mediaNetworkUnavailable());
      }
    });
    req.once('error', () => {
      if (!incoming) cleanup();
      reject(signal.aborted ? signal.reason : mediaNetworkUnavailable());
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else req.end();
  });
}
