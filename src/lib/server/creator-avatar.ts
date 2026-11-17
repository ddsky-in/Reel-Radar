import type { Repository } from './repository';
import { reelPlaybackUrl } from '../reel-detail';
import { ApiError } from './errors';
import { captureStoredMedia, type CapturedMedia } from './captured-media';

export const MAX_CREATOR_AVATAR_BYTES = 2 * 1024 * 1024;
export const CREATOR_AVATAR_TIMEOUT_MS = 10_000;
export const CREATOR_AVATAR_CACHE_TTL_MS = 5 * 60_000;
export const MAX_CREATOR_AVATAR_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_CREATOR_AVATAR_CACHE_ENTRIES = 256;
export const MAX_CONCURRENT_CREATOR_AVATARS = 3;
export const MAX_QUEUED_CREATOR_AVATARS = 12;
const MAX_FLIGHT_SUBSCRIBERS = 32;
export type CreatorAvatarOptions = { demoMode?: boolean };

type CacheEntry = { media: CapturedMedia; expiresAt: number };
type Flight = { controller: AbortController; promise: Promise<CapturedMedia>; subscribers: number; settled: boolean };
type QueuedCapture = { start: () => void; cancel: () => void; signal: AbortSignal; abort: () => void };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Flight>();
const queue: QueuedCapture[] = [];
let cacheBytes = 0, activeCaptures = 0;

function unavailable(status = 502): ApiError {
  return new ApiError(status, 'CREATOR_AVATAR_UNAVAILABLE', 'The stored creator avatar is unavailable. Please try again later.');
}
function tooLarge(): ApiError {
  return new ApiError(413, 'CREATOR_AVATAR_TOO_LARGE', 'Creator avatars must be no larger than 2 MiB.');
}
function timeout(): ApiError {
  return new ApiError(504, 'CREATOR_AVATAR_TIMEOUT', 'The creator avatar request timed out. Please try again later.');
}
function busy(): ApiError {
  return new ApiError(429, 'CREATOR_AVATAR_BUSY', 'Creator avatar requests are busy. Please try again shortly.');
}

function dropCache(key: string) {
  const entry = cache.get(key);
  if (entry) { cacheBytes -= entry.media.body.size; cache.delete(key); }
}
function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) dropCache(key);
}
function cachedMedia(key: string): CapturedMedia | undefined {
  pruneCache();
  const entry = cache.get(key);
  if (!entry) return;
  // LRU changes eviction order only, never extends the success TTL.
  cache.delete(key); cache.set(key, entry);
  return entry.media;
}
function cacheSuccess(key: string, media: CapturedMedia) {
  pruneCache(); dropCache(key);
  while (cache.size >= MAX_CREATOR_AVATAR_CACHE_ENTRIES || cacheBytes + media.body.size > MAX_CREATOR_AVATAR_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    dropCache(oldest);
  }
  cache.set(key, { media, expiresAt: Date.now() + CREATOR_AVATAR_CACHE_TTL_MS });
  cacheBytes += media.body.size;
}

function acquireCapture(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (activeCaptures < MAX_CONCURRENT_CREATOR_AVATARS) { activeCaptures++; return Promise.resolve(); }
  if (queue.length >= MAX_QUEUED_CREATOR_AVATARS) return Promise.reject(busy());
  return new Promise<void>((resolve, reject) => {
    const pending: QueuedCapture = {
      signal,
      start: resolve,
      cancel: () => reject(signal.reason),
      abort: () => {
        const index = queue.indexOf(pending);
        if (index !== -1) queue.splice(index, 1);
        signal.removeEventListener('abort', pending.abort);
        pending.cancel();
      },
    };
    queue.push(pending);
    signal.addEventListener('abort', pending.abort, { once: true });
    if (signal.aborted) pending.abort();
  });
}
function releaseCapture() {
  activeCaptures--;
  while (queue.length) {
    const pending = queue.shift()!;
    pending.signal.removeEventListener('abort', pending.abort);
    if (pending.signal.aborted) { pending.cancel(); continue; }
    activeCaptures++; pending.start(); break;
  }
}

function createFlight(key: string, source: string): Flight {
  const controller = new AbortController(), deadline = AbortSignal.timeout(CREATOR_AVATAR_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, deadline]);
  const flight: Flight = { controller, subscribers: 0, settled: false, promise: Promise.resolve().then(async () => {
    let acquired = false;
    try {
      // The flight deadline includes its bounded queue wait and all redirects/body reads.
      await acquireCapture(signal); acquired = true;
      signal.throwIfAborted();
      const media = await captureStoredMedia(source, 'image', {
        maximumBytes: MAX_CREATOR_AVATAR_BYTES, timeoutMs: CREATOR_AVATAR_TIMEOUT_MS, signal,
        errors: { unavailable, tooLarge, timeout },
      });
      signal.throwIfAborted();
      cacheSuccess(key, media);
      return media;
    } catch (error) {
      if (deadline.aborted) throw timeout();
      if (error instanceof ApiError) {
        if (error.code === 'CREATOR_AVATAR_TOO_LARGE') throw tooLarge();
        if (error.code === 'CREATOR_AVATAR_TIMEOUT') throw timeout();
        if (error.code === 'CREATOR_AVATAR_BUSY') throw busy();
      }
      // Native/transport errors and their URLs, cookies or provider details never escape.
      throw unavailable();
    } finally {
      flight.settled = true;
      if (inFlight.get(key) === flight) inFlight.delete(key);
      if (acquired) releaseCapture();
    }
  }) };
  inFlight.set(key, flight);
  return flight;
}

function subscribe(key: string, flight: Flight, signal?: AbortSignal): Promise<CapturedMedia> {
  if (flight.subscribers >= MAX_FLIGHT_SUBSCRIBERS) return Promise.reject(busy());
  flight.subscribers++;
  return new Promise<CapturedMedia>((resolve, reject) => {
    let finished = false;
    const finish = (media?: CapturedMedia, error?: unknown) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      flight.subscribers--;
      if (media) resolve(media); else reject(error);
      // One cancelled browser must not cancel another authorized subscriber.
      if (!flight.subscribers && !flight.settled) {
        if (inFlight.get(key) === flight) inFlight.delete(key);
        flight.controller.abort();
      }
    };
    const abort = () => finish(undefined, unavailable());
    flight.promise.then(media => finish(media), error => finish(undefined, error));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function inlineResponse(media: CapturedMedia): Response {
  return new Response(media.body, { headers: {
    'Content-Type': media.type,
    'Content-Length': String(media.body.size),
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store, private',
    'Referrer-Policy': 'same-origin',
  } });
}

/**
 * Owner scope must come from the authenticated server session, never a query/header.
 * Authorization is repeated before every cache/in-flight lookup, including demo/aborted calls.
 * Network access requires explicit demoMode:false; demo avatars remain UI-local/synthetic.
 * Only the repository's currently stored avatar_url is accepted. This GET performs no mutations.
 */
export async function readCreatorAvatar(
  repo: Pick<Repository, 'creator'>,
  workspaceId: string,
  creatorId: string,
  ownerId: string,
  requestSignal?: AbortSignal,
  options?: CreatorAvatarOptions,
): Promise<Response> {
  const creator = await repo.creator(workspaceId, creatorId);
  if (options?.demoMode !== false || typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 256 || ownerId === 'demo') throw unavailable(404);
  if (!creator || creator.id !== creatorId) throw unavailable(404);
  const source = reelPlaybackUrl(creator.avatar_url);
  if (!source) throw unavailable(404);
  if (requestSignal?.aborted) throw unavailable();
  const key = JSON.stringify([ownerId, workspaceId, creatorId, source]);
  const cached = cachedMedia(key);
  if (cached) return inlineResponse(cached);
  const media = await subscribe(key, inFlight.get(key) ?? createFlight(key, source), requestSignal);
  if (requestSignal?.aborted) throw unavailable();
  return inlineResponse(media);
}
