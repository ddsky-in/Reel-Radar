import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPublicMediaIPv4, readMediaResponse } from '../src/lib/server/media-transport';

const native = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: native.lookup }));
vi.mock('node:https', () => ({ request: native.request }));
const url = 'https://images.cdninstagram.com/stored.jpg?token=fixture';
const publicIP = '157.240.20.51';
const options = (signal = new AbortController().signal) => ({ signal, headers: { Accept: 'image/jpeg, image/png, image/webp' } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(status = 200, rawHeaders = ['Content-Type', 'image/jpeg'], chunks?: Uint8Array[]) {
  const source = chunks ? Readable.from(chunks, { objectMode: false }) : new Readable({ read() {} });
  const response = Object.assign(source, { statusCode: status, rawHeaders }) as IncomingMessage;
  let callback!: (response: IncomingMessage) => void;
  const socket = { destroy: vi.fn() };
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error?: Error) => { socket.destroy(); if (error) queueMicrotask(() => req.emit('error', error)); }),
  });
  native.request.mockImplementation((_url: URL, _options: RequestOptions, cb: typeof callback) => { callback = cb; return req; });
  return { response, req, socket, headers: () => callback(response) };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.lookup.mockResolvedValue([{ address: publicIP, family: 4 }]);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Global fetch must not be used'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('isolated media HTTPS transport', () => {
  it.each(['0.0.0.0', '0.1.2.3', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '::1', '::ffff:157.240.20.51', '2130706433', '127.1', '0177.0.0.1', 'bogus'])('rejects nonpublic or noncanonical IPv4 %s', address => {
    expect(isPublicMediaIPv4(address)).toBe(false);
  });
  it.each([publicIP, '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1'])('allows public IPv4 %s', address => {
    expect(isPublicMediaIPv4(address)).toBe(true);
  });

  it('validates official HTTPS URLs before any DNS or request work', async () => {
    for (const value of ['http://images.cdninstagram.com/file', 'https://127.0.0.1/file', 'https://evil.test/file', 'https://user@images.fbcdn.net/file', 'https://images.fbcdn.net:443/file', 'https://images.fbcdn.net/file#fragment']) {
      await expect(readMediaResponse(value, options())).rejects.toMatchObject({ status: 409 });
    }
    expect(native.lookup).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled();
  });

  it('rejects empty, private, mixed public/private and IPv6 DNS answers before connecting', async () => {
    for (const records of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: publicIP, family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }]]) {
      native.lookup.mockResolvedValue(records);
      await expect(readMediaResponse(url, options())).rejects.toMatchObject({ status: 409 });
    }
    expect(native.request).not.toHaveBeenCalled();
  });

  it('pins one validated A address while keeping URL hostname for Host and strict TLS SNI', async () => {
    native.lookup.mockResolvedValue([{ address: publicIP, family: 4 }, { address: '157.240.20.52', family: 4 }]);
    const transport = fixture(200, ['Content-Type', 'image/jpeg', 'Content-Length', '5', 'X-CDN-Status', 'hit'], [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]);
    const result = readMediaResponse(url, options());
    await tick();
    expect(native.lookup).toHaveBeenCalledExactlyOnceWith('images.cdninstagram.com', { family: 4, all: true, verbatim: true });
    const [target, config] = native.request.mock.calls[0] as [URL, RequestOptions];
    expect(target.href).toBe(url);
    expect(config).toMatchObject({ method: 'GET', family: 4, servername: 'images.cdninstagram.com', rejectUnauthorized: true, agent: false, maxHeaderSize: 16384 });
    expect(config.headers).toEqual({ Accept: 'image/jpeg, image/png, image/webp', 'Accept-Encoding': 'identity' });
    const callback = vi.fn();
    (config.lookup as (hostname: string, opts: object, done: (error: null, address: string, family: number) => void) => void)('images.cdninstagram.com', { family: 4 }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, publicIP, 4);
    expect(transport.req.end).toHaveBeenCalledOnce();
    transport.headers();
    const response = await result;
    expect(response.status).toBe(200); expect(response.url).toBe(''); expect(response.redirected).toBe(false);
    expect(response.headers.get('content-type')).toBe('image/jpeg'); expect(response.headers.get('x-cdn-status')).toBe('hit');
    expect(response.headers.get('content-length')).toBe('5');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns redirects without following them and closes the body/socket on cancellation', async () => {
    const transport = fixture(302, ['Location', 'https://images.fbcdn.net/next']);
    const pending = readMediaResponse(url, options()); await tick(); transport.headers();
    const response = await pending;
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('https://images.fbcdn.net/next');
    expect(native.lookup).toHaveBeenCalledOnce(); expect(native.request).toHaveBeenCalledOnce();
    await response.body!.cancel(); await tick();
    expect(transport.response.destroyed).toBe(true); expect(transport.socket.destroy).toHaveBeenCalled();
  });

  it.each([403, 404, 500, 503])('preserves CDN HTTP status %s for outer content handling', async status => {
    const transport = fixture(status, ['Content-Type', 'text/plain'], [new TextEncoder().encode('unavailable')]);
    const pending = readMediaResponse(url, options()); await tick(); transport.headers();
    const response = await pending;
    expect(response.status).toBe(status); expect(await response.text()).toBe('unavailable');
  });

  it('does no work when already aborted', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(readMediaResponse(url, options(abort.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.lookup).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled();
  });

  it('bounds a stalled DNS lookup by the caller signal and does not connect after a late answer', async () => {
    let resolve!: (value: { address: string; family: number }[]) => void;
    native.lookup.mockImplementation(() => new Promise(done => { resolve = done; }));
    const abort = new AbortController(), reason = new DOMException('Deadline', 'TimeoutError');
    const pending = readMediaResponse(url, options(abort.signal));
    abort.abort(reason); await expect(pending).rejects.toBe(reason);
    resolve([{ address: publicIP, family: 4 }]); await tick();
    expect(native.request).not.toHaveBeenCalled();
  });

  it('destroys the request socket when aborted before response headers', async () => {
    const abort = new AbortController(), transport = fixture();
    const pending = readMediaResponse(url, options(abort.signal)); await tick();
    abort.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.req.destroy).toHaveBeenCalled(); expect(transport.socket.destroy).toHaveBeenCalled();
  });

  it('destroys the response stream and socket when aborted after headers with a pending body read', async () => {
    const abort = new AbortController(), transport = fixture();
    const pending = readMediaResponse(url, options(abort.signal)); await tick(); transport.headers();
    const response = await pending, reader = response.body!.getReader(), reading = reader.read();
    abort.abort(); await expect(reading).rejects.toMatchObject({ name: 'AbortError' }); await tick();
    expect(transport.response.destroyed).toBe(true); expect(transport.socket.destroy).toHaveBeenCalled();
    reader.releaseLock();
  });

  it('maps DNS failure to a sanitized distinct network error', async () => {
    native.lookup.mockRejectedValue(new Error('private DNS details'));
    await expect(readMediaResponse(url, options())).rejects.toMatchObject({ status: 502, code: 'DOWNLOAD_NETWORK_UNAVAILABLE' });
    expect(native.request).not.toHaveBeenCalled();
  });

  it.each(['ETIMEDOUT', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'])('does not retry or expose native connection/TLS failure %s', async code => {
    const transport = fixture(), pending = readMediaResponse(url, options()); await tick();
    transport.req.emit('error', Object.assign(new Error(`${url} private details`), { code }));
    await expect(pending).rejects.toMatchObject({ status: 502, code: 'DOWNLOAD_NETWORK_UNAVAILABLE', message: expect.not.stringContaining('token=fixture') });
    expect(native.request).toHaveBeenCalledOnce();
  });
});
