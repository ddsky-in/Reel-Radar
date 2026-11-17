import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Creator } from '../src/lib/types';
import { ApiError } from '../src/lib/server/errors';

const network = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/lib/server/media-transport', () => ({ readMediaResponse: network.read }));
let avatar: typeof import('../src/lib/server/creator-avatar');
const ownerId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const creatorId = '00000000-0000-4000-8000-000000000003';
const source = 'https://images.cdninstagram.com/stored.jpg?token=private';
const creator: Creator = { id: creatorId, username: 'fixture', display_name: null, avatar_url: source,
  followers_count: null, last_profile_fetch_at: null, status: 'active', last_reels_fetch_at: null, last_error: null };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVxkAAAAASUVORK5CYII=', 'base64'));
const webp = new Uint8Array(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
const repository = (value = creator) => ({ creator: vi.fn().mockResolvedValue(value) });
const response = (bytes = jpeg, type = 'image/jpeg', headers = {}) => new Response(new Uint8Array(bytes), {
  headers: { 'Content-Type': type, 'Content-Length': String(bytes.length), ...headers },
});
const read = (repo = repository(), signal?: AbortSignal, owner = ownerId, workspace = workspaceId, id = creatorId) =>
  avatar.readCreatorAvatar(repo, workspace, id, owner, signal, { demoMode: false });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const stalledResponse = (cancel = vi.fn()) => new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'image/jpeg' } });

beforeEach(async () => {
  vi.resetModules(); network.read.mockReset();
  avatar = await import('../src/lib/server/creator-avatar');
  network.read.mockImplementation(() => Promise.resolve(response()));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Global fetch must not be used'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('creator avatar owner authorization and stored-only sources', () => {
  it('authorizes before media or cache access, every time, including warm-cache denials', async () => {
    const repo = repository();
    network.read.mockImplementation(() => {
      expect(repo.creator).toHaveBeenCalledWith(workspaceId, creatorId);
      return response();
    });
    expect((await read(repo)).status).toBe(200);
    expect((await read(repo)).status).toBe(200);
    expect(repo.creator).toHaveBeenCalledTimes(2); expect(network.read).toHaveBeenCalledOnce();
    for (const status of [403, 404, 503]) {
      repo.creator.mockRejectedValueOnce(new ApiError(status, 'DENIED', 'Denied'));
      await expect(read(repo)).rejects.toMatchObject({ status });
    }
    expect(repo.creator).toHaveBeenCalledTimes(5); expect(network.read).toHaveBeenCalledOnce();
  });

  it('awaits current repository authorization before joining an existing in-flight read', async () => {
    const pending = deferred<Response>(); network.read.mockReturnValue(pending.promise);
    const firstRepo = repository(), first = read(firstRepo);
    await tick(); expect(network.read).toHaveBeenCalledOnce();
    const auth = deferred<Creator>(), secondRepo = { creator: vi.fn().mockReturnValue(auth.promise) };
    const second = read(secondRepo), deniedRepo = { creator: vi.fn().mockRejectedValue(new ApiError(403, 'DENIED', 'Denied')) };
    await expect(read(deniedRepo)).rejects.toMatchObject({ status: 403 });
    auth.resolve(creator); await tick(); pending.resolve(response());
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
    expect(secondRepo.creator).toHaveBeenCalledExactlyOnceWith(workspaceId, creatorId);
    expect(network.read).toHaveBeenCalledOnce();
  });

  it('fails closed for demo mode, omitted mode, missing owner, and mismatched creator without outbound fetch', async () => {
    for (const options of [undefined, {}, { demoMode: true }]) {
      const repo = repository();
      await expect(avatar.readCreatorAvatar(repo, workspaceId, creatorId, ownerId, undefined, options)).rejects.toMatchObject({ status: 404 });
      expect(repo.creator).toHaveBeenCalledExactlyOnceWith(workspaceId, creatorId);
    }
    for (const owner of ['', ' ', 'demo', 'x'.repeat(257)]) await expect(read(repository(), undefined, owner)).rejects.toMatchObject({ status: 404 });
    await expect(read(repository({ ...creator, id: 'different' }))).rejects.toMatchObject({ status: 404 });
    expect(network.read).not.toHaveBeenCalled();
  });

  it('does not use cached real-looking avatars in demo mode', async () => {
    await read(); network.read.mockClear();
    const repo = repository();
    await expect(avatar.readCreatorAvatar(repo, workspaceId, creatorId, ownerId, undefined, { demoMode: true })).rejects.toMatchObject({ status: 404 });
    expect(repo.creator).toHaveBeenCalledOnce(); expect(network.read).not.toHaveBeenCalled();
  });

  it.each([null, '', '/demo/avatar.svg', 'data:image/png;base64,AAAA', 'http://images.cdninstagram.com/file',
    'https://127.0.0.1/file', 'https://[::1]/file', 'https://169.254.169.254/file', 'https://2130706433/file',
    'https://localhost/file', 'https://evil.test/file', 'https://cdninstagram.com/file', 'https://images.cdninstagram.com.evil.test/file',
    'https://user:pass@images.cdninstagram.com/file', 'https://images.cdninstagram.com:443/file', 'https://images.cdninstagram.com:8443/file',
    'https://images.cdninstagram.com/file#fragment', 'https://images.cdninstagram.com\\@evil.test/file', 'https://images.cdninstagram.com /file'])('rejects missing or untrusted stored source %s', async value => {
    const repo = repository({ ...creator, avatar_url: value });
    await expect(read(repo)).rejects.toMatchObject({ status: 404, code: 'CREATOR_AVATAR_UNAVAILABLE' });
    expect(repo.creator).toHaveBeenCalledOnce(); expect(network.read).not.toHaveBeenCalled();
  });

  it('keys cache by authenticated owner, workspace, creator and exact normalized stored URL', async () => {
    const repo = repository({ ...creator, avatar_url: 'https://IMAGES.cdninstagram.com/a/../stored.jpg?token=private' });
    await read(repo); await read(); expect(network.read).toHaveBeenCalledOnce();
    expect(network.read.mock.calls[0][0]).toBe(source);
    await read(repository(), undefined, 'other-owner');
    await read(repository(), undefined, ownerId, 'other-workspace');
    await read(repository({ ...creator, id: 'other-creator' }), undefined, ownerId, workspaceId, 'other-creator');
    await read(repository({ ...creator, avatar_url: `${source}&v=2` }));
    expect(network.read).toHaveBeenCalledTimes(5);
    const missing = repository({ ...creator, avatar_url: null });
    await expect(read(missing)).rejects.toMatchObject({ status: 404 });
    expect(network.read).toHaveBeenCalledTimes(5);
  });

  it('authorizes an already-aborted request without cache or media access', async () => {
    await read(); network.read.mockClear();
    const abort = new AbortController(); abort.abort(); const repo = repository();
    await expect(read(repo, abort.signal)).rejects.toMatchObject({ code: 'CREATOR_AVATAR_UNAVAILABLE' });
    expect(repo.creator).toHaveBeenCalledOnce(); expect(network.read).not.toHaveBeenCalled();
  });
});

describe('creator avatar raster content and isolated transport', () => {
  it.each([[jpeg, 'image/jpeg'], [png, 'image/png'], [webp, 'image/webp']] as const)('returns an inline %s with only local private headers', async (bytes, type) => {
    network.read.mockResolvedValue(response(bytes, `${type}; charset=binary`, {
      'Set-Cookie': 'upstream=secret', 'Cache-Control': 'public,max-age=999999', 'ETag': 'private-source',
      'Location': source, 'X-Provider-Debug': source,
    }));
    const result = await read();
    expect(result.status).toBe(200);
    expect(Object.fromEntries(result.headers)).toEqual({
      'cache-control': 'no-store, private', 'content-disposition': 'inline', 'content-length': String(bytes.length),
      'content-type': type, 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    });
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    expect(network.read).toHaveBeenCalledWith(source, expect.objectContaining({ signal: expect.any(AbortSignal), headers: { Accept: 'image/jpeg, image/png, image/webp' } }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const again = await read(); expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    expect(network.read).toHaveBeenCalledOnce();
  });

  it('follows at most three independently validated CDN redirects without forwarding cookies', async () => {
    network.read.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/next', 'Set-Cookie': 'secret' } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: '//images.fbcdn.net/next' } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Location: 'https://images.cdninstagram.com/final' } }))
      .mockResolvedValueOnce(response(png, 'image/png'));
    expect((await read()).status).toBe(200);
    expect(network.read.mock.calls.map(([url]) => url)).toEqual([source, 'https://images.cdninstagram.com/next', 'https://images.fbcdn.net/next', 'https://images.cdninstagram.com/final']);
    for (const [, options] of network.read.mock.calls) expect(options.headers).toEqual({ Accept: 'image/jpeg, image/png, image/webp' });
  });

  it.each(['https://127.0.0.1/private', 'https://[::1]/file', 'http://images.fbcdn.net/file', 'https://user@images.fbcdn.net/file',
    'https://images.fbcdn.net:443/file', 'https://images.fbcdn.net:8443/file', '//images.fbcdn.net:443/file', '//evil.test/file',
    'https://images.fbcdn.net/file#fragment', 'https://images.fbcdn.net\\@evil.test/file', 'https://images.fbcdn.net/a b'])('rejects unsafe redirect %s and cancels its body', async location => {
    const cancel = vi.fn();
    network.read.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } }));
    await expect(read()).rejects.toMatchObject({ status: 502, code: 'CREATOR_AVATAR_UNAVAILABLE' });
    expect(network.read).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects redirect loops, missing locations and already-followed or unexpected transport URLs', async () => {
    network.read.mockImplementation(() => new Response(null, { status: 302, headers: { Location: source } }));
    await expect(read()).rejects.toMatchObject({ status: 502 }); expect(network.read).toHaveBeenCalledTimes(4);
    network.read.mockReset().mockResolvedValue(new Response(null, { status: 302 }));
    await expect(read()).rejects.toMatchObject({ status: 502 }); expect(network.read).toHaveBeenCalledOnce();
    for (const field of ['redirected', 'url']) {
      const incoming = response(); Object.defineProperty(incoming, field, { value: field === 'redirected' ? true : `${source}&unexpected=1` });
      network.read.mockReset().mockResolvedValue(incoming);
      await expect(read()).rejects.toMatchObject({ status: 502 }); expect(network.read).toHaveBeenCalledOnce();
    }
  });

  it.each([
    () => new Response(`${source} upstream failure`, { status: 403 }),
    () => new Response(null, { status: 204 }),
    () => response(jpeg, 'image/svg+xml'), () => response(jpeg, 'text/html'), () => response(jpeg, 'application/octet-stream'),
    () => response(jpeg, 'video/mp4'), () => response(png, 'image/jpeg'), () => response(jpeg, 'image/png'), () => response(jpeg, 'image/webp'),
    () => response(new TextEncoder().encode('<html>not an avatar</html>'), 'image/jpeg'),
    () => response(jpeg.slice(0, -2)), () => response(png.slice(0, -12), 'image/png'), () => response(webp.slice(0, -1), 'image/webp'),
    () => response(new Uint8Array()), () => response(jpeg, 'image/jpeg', { 'Content-Length': '999' }),
    () => response(jpeg, 'image/jpeg', { 'Content-Length': '1.2' }), () => response(jpeg, 'image/jpeg', { 'Content-Length': '-1' }),
    () => new Response(jpeg, { status: 206, headers: { 'Content-Type': 'image/jpeg' } }),
  ])('rejects unsupported/partial/invalid MIME or structural signature without failure caching', async fixture => {
    network.read.mockImplementation(fixture);
    await expect(read()).rejects.toMatchObject({ status: 502, code: 'CREATOR_AVATAR_UNAVAILABLE' });
    network.read.mockImplementation(() => response());
    expect((await read()).status).toBe(200); expect(network.read).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid PNG dimensions and WebP RIFF/chunk lengths', async () => {
    const zeroWidth = png.slice(); new DataView(zeroWidth.buffer).setUint32(16, 0);
    const badRiff = webp.slice(); new DataView(badRiff.buffer).setUint32(4, 999, true);
    const badChunk = webp.slice(); new DataView(badChunk.buffer).setUint32(16, 999, true);
    for (const [bytes, type] of [[zeroWidth, 'image/png'], [badRiff, 'image/webp'], [badChunk, 'image/webp']] as const) {
      network.read.mockResolvedValueOnce(response(bytes, type));
      await expect(read()).rejects.toMatchObject({ status: 502 });
    }
  });

  it('sanitizes upstream/native errors, logs no source URLs, and retries transient failure on the next GET', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const failure of [new Error(`${source} cookie=secret`), new ApiError(502, 'DOWNLOAD_NETWORK_UNAVAILABLE', `${source} secret`), new ApiError(409, 'CAROUSEL_MEDIA_UNAVAILABLE', source)]) {
      network.read.mockRejectedValueOnce(failure);
      await expect(read()).rejects.toMatchObject({ status: 502, code: 'CREATOR_AVATAR_UNAVAILABLE', message: expect.not.stringContaining('private') });
    }
    expect((await read()).status).toBe(200); expect(network.read).toHaveBeenCalledTimes(4);
    expect(errorLog).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
});

describe('creator avatar memory, concurrency, cancellation and deadline bounds', () => {
  it('enforces declared and streaming 2 MiB caps, cancels rejected bodies, and accepts the exact cap', async () => {
    for (const declared of [true, false]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(avatar.MAX_CREATOR_AVATAR_BYTES + 1)); }, cancel });
      network.read.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'image/jpeg', ...(declared ? { 'Content-Length': String(avatar.MAX_CREATOR_AVATAR_BYTES + 1) } : {}) } }));
      await expect(read()).rejects.toMatchObject({ status: 413, code: 'CREATOR_AVATAR_TOO_LARGE' });
      expect(cancel).toHaveBeenCalledOnce();
    }
    const full = new Uint8Array(avatar.MAX_CREATOR_AVATAR_BYTES); full.set(jpeg.subarray(0, -2)); full.set(jpeg.slice(-2), full.length - 2);
    network.read.mockResolvedValueOnce(response(full));
    expect((await read()).headers.get('content-length')).toBe(String(avatar.MAX_CREATOR_AVATAR_BYTES));
  });

  it('keeps success TTL fixed rather than extending it with cache hits', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000); const repo = repository();
    await read(repo);
    now.mockReturnValue(1000 + avatar.CREATOR_AVATAR_CACHE_TTL_MS - 1); await read(repo);
    expect(network.read).toHaveBeenCalledOnce();
    now.mockReturnValue(1000 + avatar.CREATOR_AVATAR_CACHE_TTL_MS); await read(repo);
    expect(network.read).toHaveBeenCalledTimes(2); expect(repo.creator).toHaveBeenCalledTimes(3);
  });

  it('evicts LRU entries when the success-entry cap is reached', async () => {
    for (let index = 0; index < avatar.MAX_CREATOR_AVATAR_CACHE_ENTRIES; index++) await read(repository({ ...creator, avatar_url: `${source}&entry=${index}` }));
    const first = repository({ ...creator, avatar_url: `${source}&entry=0` });
    await read(first); expect(network.read).toHaveBeenCalledTimes(avatar.MAX_CREATOR_AVATAR_CACHE_ENTRIES);
    await read(repository({ ...creator, avatar_url: `${source}&extra=1` }));
    await read(first); expect(network.read).toHaveBeenCalledTimes(avatar.MAX_CREATOR_AVATAR_CACHE_ENTRIES + 1);
    await read(repository({ ...creator, avatar_url: `${source}&entry=1` }));
    expect(network.read).toHaveBeenCalledTimes(avatar.MAX_CREATOR_AVATAR_CACHE_ENTRIES + 2);
  });

  it('evicts success bodies against a separate byte cap', async () => {
    const full = new Uint8Array(avatar.MAX_CREATOR_AVATAR_BYTES); full.set(jpeg.subarray(0, -2)); full.set(jpeg.slice(-2), full.length - 2);
    network.read.mockImplementation(() => response(full));
    const capacity = avatar.MAX_CREATOR_AVATAR_CACHE_BYTES / avatar.MAX_CREATOR_AVATAR_BYTES;
    for (let index = 0; index <= capacity; index++) await read(repository({ ...creator, avatar_url: `${source}&large=${index}` }));
    await read(repository({ ...creator, avatar_url: `${source}&large=1` }));
    expect(network.read).toHaveBeenCalledTimes(capacity + 1);
    await read(repository({ ...creator, avatar_url: `${source}&large=0` }));
    expect(network.read).toHaveBeenCalledTimes(capacity + 2);
  });

  it('deduplicates simultaneous captures but returns independently readable responses', async () => {
    const pending = deferred<Response>(); network.read.mockReturnValue(pending.promise);
    const repos = Array.from({ length: 10 }, () => repository()), reads = repos.map(repo => read(repo));
    await tick(); expect(network.read).toHaveBeenCalledOnce(); pending.resolve(response());
    const results = await Promise.all(reads);
    for (const result of results) expect(new Uint8Array(await result.arrayBuffer())).toEqual(jpeg);
    for (const repo of repos) expect(repo.creator).toHaveBeenCalledOnce();
  });

  it('limits captures to three, queues a bounded number, and authorizes even overload rejections', async () => {
    const cancel = vi.fn(), abort = new AbortController(); network.read.mockImplementation(() => stalledResponse(cancel));
    const count = avatar.MAX_CONCURRENT_CREATOR_AVATARS + avatar.MAX_QUEUED_CREATOR_AVATARS;
    const reads = Array.from({ length: count }, (_, index) => read(repository({ ...creator, avatar_url: `${source}&queue=${index}` }), abort.signal));
    const settled = Promise.allSettled(reads);
    await tick(); expect(network.read).toHaveBeenCalledTimes(3);
    const extra = repository({ ...creator, avatar_url: `${source}&overflow=1` });
    await expect(read(extra)).rejects.toMatchObject({ status: 429, code: 'CREATOR_AVATAR_BUSY' });
    expect(extra.creator).toHaveBeenCalledOnce(); expect(network.read).toHaveBeenCalledTimes(3);
    abort.abort();
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    await tick(); expect(cancel).toHaveBeenCalledTimes(3); expect(network.read).toHaveBeenCalledTimes(3);
    network.read.mockImplementation(() => response()); expect((await read()).status).toBe(200);
  });

  it('starts queued captures FIFO as active slots complete', async () => {
    const starts: ReturnType<typeof deferred<Response>>[] = [];
    network.read.mockImplementation(() => { const pending = deferred<Response>(); starts.push(pending); return pending.promise; });
    const reads = Array.from({ length: 5 }, (_, index) => read(repository({ ...creator, avatar_url: `${source}&fifo=${index}` })));
    await tick(); expect(starts).toHaveLength(3);
    starts[0].resolve(response()); await tick(); expect(starts).toHaveLength(4);
    starts[1].resolve(response()); await tick(); expect(starts).toHaveLength(5);
    for (const pending of starts.slice(2)) pending.resolve(response());
    expect((await Promise.all(reads)).every(result => result.status === 200)).toBe(true);
    expect(network.read.mock.calls.map(([url]) => url)).toEqual(Array.from({ length: 5 }, (_, index) => `${source}&fifo=${index}`));
  });

  it('does not let one aborted deduplicated caller cancel another authorized caller', async () => {
    const cancel = vi.fn(), controller = new AbortController(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    network.read.mockImplementation(() => new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; }, cancel }), { headers: { 'Content-Type': 'image/jpeg' } }));
    const first = read(repository(), controller.signal), firstOutcome = Promise.allSettled([first]);
    const second = read(); await tick(); controller.abort();
    expect((await firstOutcome)[0].status).toBe('rejected'); expect(cancel).not.toHaveBeenCalled();
    stream.enqueue(jpeg); stream.close(); expect((await second).status).toBe(200);
    expect(network.read).toHaveBeenCalledOnce();
  });

  it('bounds subscriber counts for one stalled deduplicated flight', async () => {
    const abort = new AbortController(); network.read.mockImplementation(() => stalledResponse());
    const reads = Array.from({ length: 32 }, () => read(repository(), abort.signal)), outcomes = Promise.allSettled(reads);
    await tick(); await expect(read()).rejects.toMatchObject({ status: 429 });
    expect(network.read).toHaveBeenCalledOnce(); abort.abort(); await outcomes; await tick();
  });

  it('cancels stalled body capture when all callers abort and never caches it', async () => {
    const cancel = vi.fn(), abort = new AbortController(); network.read.mockImplementation(() => stalledResponse(cancel));
    const pending = read(repository(), abort.signal); await tick(); abort.abort();
    await expect(pending).rejects.toMatchObject({ status: 502 }); await tick();
    expect(cancel).toHaveBeenCalledOnce();
    network.read.mockImplementation(() => response()); expect((await read()).status).toBe(200); expect(network.read).toHaveBeenCalledTimes(2);
  });

  it('bounds queued wait and stalled capture by the same 10 second flight deadline', async () => {
    const deadlines: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal;
    });
    const cancel = vi.fn(); network.read.mockImplementation(() => stalledResponse(cancel));
    const reads = Array.from({ length: 4 }, (_, index) => read(repository({ ...creator, avatar_url: `${source}&deadline=${index}` })));
    const outcomes = Promise.allSettled(reads);
    await tick(); expect(network.read).toHaveBeenCalledTimes(3);
    expect(deadlines.every(item => item.ms === 10_000)).toBe(true); expect(deadlines).toHaveLength(7);
    // First four deadlines are created during authorization, including the queued flight.
    for (const item of deadlines.slice(0, 4).reverse()) item.controller.abort(new DOMException('Deadline', 'TimeoutError'));
    const results = await outcomes;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 504, code: 'CREATOR_AVATAR_TIMEOUT' });
    }
    expect(cancel).toHaveBeenCalledTimes(3); expect(network.read).toHaveBeenCalledTimes(3);
    network.read.mockImplementation(() => response()); expect((await read()).status).toBe(200);
  });

  it('does not mutate the creator or invoke any paid/DB mutation method', async () => {
    const stored = structuredClone(creator), repo = { ...repository(stored), addCreator: vi.fn(), removeCreator: vi.fn(), refresh: vi.fn(), requestCreatorSourceRefresh: vi.fn() };
    await read(repo); await read(repo);
    expect(stored).toEqual(creator); expect(repo.creator).toHaveBeenCalledTimes(2);
    for (const method of [repo.addCreator, repo.removeCreator, repo.refresh, repo.requestCreatorSourceRefresh]) expect(method).not.toHaveBeenCalled();
  });
});
