import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/lib/demo';
import type { CarouselDetail, CarouselSlide } from '../src/lib/types';
import { ApiError } from '../src/lib/server/errors';
import { downloadCarousel, parseCarouselDownloadQuery, MAX_CAROUSEL_IMAGE_BYTES, MAX_CAROUSEL_VIDEO_BYTES, MAX_CAROUSEL_ZIP_BYTES, CAROUSEL_FILE_TIMEOUT_MS, CAROUSEL_DOWNLOAD_TIMEOUT_MS } from '../src/lib/server/carousel-download';
import { checksumStoredBlob, crc32, createStoredZip, storedZipOverhead } from '../src/lib/server/stored-zip';
import { mp4Fixture } from './mp4-fixture';
import { GET } from '../src/app/api/[...path]/route';

const network = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/lib/server/media-transport', () => ({ readMediaResponse: network.read }));
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, from: vi.fn(), rpc: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => client }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
const demo = createDemoData(), workspaceId = demo.workspaces[0].id;
const carousel = { ...demo.carousels[0], provider: 'apify', username: 'creator.name', shortcode: 'ABC_123' };
const imageUrl = 'https://images.cdninstagram.com/stored.jpg?token=private';
const videoUrl = 'https://video.fbcdn.net/stored.mp4?token=private';
const image: CarouselSlide = { position: 1, media_type: 'image', image_url: imageUrl, video_url: null };
const video: CarouselSlide = { position: 2, media_type: 'video', image_url: imageUrl, video_url: videoUrl };
const detail: CarouselDetail = { carousel: { ...carousel, slides: [image, video] }, snapshots: [] };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVxkAAAAASUVORK5CYII=', 'base64'));
const webp = new Uint8Array(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
const mp4 = mp4Fixture();
const repository = (value = detail) => ({ carouselDetail: vi.fn().mockResolvedValue(value) });
const params = (query = 'slide=1') => new URLSearchParams(query);
const mediaResponse = (bytes: Uint8Array = jpeg, type = 'image/jpeg', headers = {}) => new Response(new Uint8Array(bytes), { headers: { 'content-type': type, 'content-length': String(bytes.length), ...headers } });
const ownerId = '00000000-0000-4000-8000-000000000001';
const origin = 'http://127.0.0.1:3100';
function api(query = 'slide=1', workspace = workspaceId, id = carousel.id) {
  const path = ['workspaces', workspace, 'carousels', id, 'download'];
  return GET(new Request(`${origin}/api/${path.join('/')}?${query}`), { params: Promise.resolve({ path }) });
}
function authorizeOwner() {
  vi.stubEnv('DEMO_MODE', 'false');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test');
  vi.stubEnv('OWNER_USER_ID', ownerId);
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test');
  client.auth.getUser.mockResolvedValue({ data: { user: { id: ownerId, email: 'owner@example.test' } }, error: null });
  client.from.mockImplementation((table: string) => {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: table === 'workspace_members' ? { workspace_id: workspaceId } : demo.workspaces[0], error: null });
    return chain;
  });
  client.rpc.mockResolvedValue({ data: detail, error: null });
}

beforeEach(() => { vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DEMO_MODE', 'false'); vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function unpackStoredZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files: { name: string; bytes: Uint8Array; checksum: number; offset: number }[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 6, true)).toBe(0x0800);
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    expect(view.getUint32(offset + 22, true)).toBe(size);
    const start = offset + 30 + length + extra;
    files.push({ name: new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + length)), bytes: bytes.subarray(start, start + size), checksum: view.getUint32(offset + 14, true), offset });
    offset = start + size;
  }
  const directory = offset;
  for (const file of files) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 8, true)).toBe(0x0800);
    expect(view.getUint16(offset + 10, true)).toBe(0);
    expect(view.getUint32(offset + 16, true)).toBe(file.checksum);
    expect(view.getUint32(offset + 20, true)).toBe(file.bytes.length);
    expect(view.getUint32(offset + 24, true)).toBe(file.bytes.length);
    expect(view.getUint32(offset + 42, true)).toBe(file.offset);
    const length = view.getUint16(offset + 28, true);
    expect(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length))).toBe(file.name);
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  expect(view.getUint32(offset, true)).toBe(0x06054b50);
  expect(view.getUint16(offset + 8, true)).toBe(files.length);
  expect(view.getUint16(offset + 10, true)).toBe(files.length);
  expect(view.getUint32(offset + 12, true)).toBe(offset - directory);
  expect(view.getUint32(offset + 16, true)).toBe(directory);
  expect(offset + 22).toBe(bytes.length);
  return files;
}

describe('carousel download selection and authorization', () => {
  it('requires one explicit choice and rejects unknown, mixed, repeated, or noncanonical values', () => {
    expect(parseCarouselDownloadQuery(params('slide=1'))).toEqual({ slide: 1 });
    expect(parseCarouselDownloadQuery(params('slide=20'))).toEqual({ slide: 20 });
    expect(parseCarouselDownloadQuery(params('all=true'))).toEqual({ all: true });
    for (const query of ['', 'slide=0', 'slide=21', 'slide=-1', 'slide=1.0', 'slide=01', 'slide=1e0', 'slide=%201', 'slide=+1', 'all=false', 'all=1', 'all=True', 'all=true&slide=1', 'slide=1&slide=1', 'all=true&all=true', 'slide=1&url=https://evil.test', 'mode=all']) {
      expect(() => parseCarouselDownloadQuery(params(query)), query).toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_QUERY' }));
    }
  });

  it('authorizes repository access before requesting any media', async () => {
    const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    for (const status of [403, 404]) {
      const repo = { carouselDetail: vi.fn().mockRejectedValue(new ApiError(status, 'FORBIDDEN', 'Denied')) };
      await expect(downloadCarousel(repo, 'other-workspace', carousel.id, params())).rejects.toMatchObject({ status });
      expect(repo.carouselDetail).toHaveBeenCalledWith('other-workspace', carousel.id);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid selection before repository work', async () => {
    const repo = repository();
    await expect(downloadCarousel(repo, workspaceId, carousel.id, params('url=https://evil.test'))).rejects.toMatchObject({ status: 400 });
    expect(repo.carouselDetail).not.toHaveBeenCalled();
  });

  it('fails clearly without network calls for synthetic media, missing slides, originals, or unsupported kinds', async () => {
    const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    const values = [
      { ...detail, carousel: { ...detail.carousel, provider: 'mock:synthetic' } },
      { ...detail, carousel: { ...detail.carousel, slides: [] } },
      { ...detail, carousel: { ...detail.carousel, slides: [{ ...image, image_url: null }] } },
      { ...detail, carousel: { ...detail.carousel, slides: [{ ...video, position: 1, video_url: null }] } },
      { ...detail, carousel: { ...detail.carousel, slides: [{ ...image, image_url: '' }] } },
    ];
    for (const value of values) await expect(downloadCarousel(repository(value), workspaceId, carousel.id, params('all=true'))).rejects.toMatchObject({ status: 404 });
    await expect(downloadCarousel(repository(), workspaceId, carousel.id, params('slide=3'))).rejects.toMatchObject({ status: 404 });
    await expect(downloadCarousel(repository({ ...detail, carousel: { ...carousel, slides: [{ ...image, media_type: 'unknown' }] } }), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks every selected source before fetching an all-slides archive and bounds stored slide counts', async () => {
    const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    for (const slides of [[image, { ...video, video_url: null }], [image, { ...video, position: 1 }], Array.from({ length: 21 }, (_, index) => ({ ...image, position: index + 1 }))]) {
      await expect(downloadCarousel(repository({ ...detail, carousel: { ...carousel, slides } }), workspaceId, carousel.id, params('all=true'))).rejects.toBeInstanceOf(ApiError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed through the production API when auth configuration is missing', async () => {
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OWNER_EMAIL', 'OWNER_USER_ID']) vi.stubEnv(name, '');
    const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    const response = await api();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CONFIG_REQUIRED' } });
    expect(client.auth.getUser).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects anonymous and non-owner sessions through real authenticatedClient before repository/media reads', async () => {
    authorizeOwner(); const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    for (const [user, status] of [[null, 401], [{ id: 'other', email: 'owner@example.test' }, 403], [{ id: ownerId, email: 'other@example.test' }, 403]] as const) {
      client.auth.getUser.mockResolvedValue({ data: { user }, error: null });
      expect((await api()).status).toBe(status);
    }
    expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the current owner-authorized repository RPC and rejects foreign workspace membership', async () => {
    authorizeOwner(); const fetcher = vi.fn().mockResolvedValue(mediaResponse()); network.read.mockImplementation(fetcher);
    const response = await api();
    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith('get_carousel_detail', { p_workspace_id: workspaceId, p_carousel_id: carousel.id });
    const membership = client.from.mock.results[0].value;
    expect(membership.eq).toHaveBeenCalledWith('user_id', ownerId);
    fetcher.mockClear(); client.rpc.mockClear();
    client.from.mockImplementation(() => { const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }; chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); return chain; });
    expect((await api('all=true', demo.workspaces[1].id)).status).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects foreign carousel access and invalid query/IDs through the API without any media calls', async () => {
    authorizeOwner(); const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    client.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await api()).status).toBe(403);
    for (const query of ['', 'all=true&slide=1', 'slide=1&slide=2', 'url=https://evil.test', 'all=true&other=1']) expect((await api(query)).status).toBe(400);
    expect((await api('slide=1', workspaceId, 'not-an-id')).status).toBe(400);
    expect(errorLog).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('delivers one ZIP through the authenticated production GET endpoint without collection calls', async () => {
    authorizeOwner();
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(url === videoUrl ? mediaResponse(mp4, 'video/mp4') : mediaResponse())); network.read.mockImplementation(fetcher);
    const response = await api('all=true');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(unpackStoredZip(new Uint8Array(await response.arrayBuffer())).map(file => file.name)).toEqual(['creator.name_ABC_123_slide01.jpg', 'creator.name_ABC_123_slide02.mp4']);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('get_carousel_detail', { p_workspace_id: workspaceId, p_carousel_id: carousel.id });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([imageUrl, videoUrl]);
  });

  it('limits the API to ten requests per owner and minute before additional repository or media work', async () => {
    authorizeOwner();
    const alternateOwner = '00000000-0000-4000-8000-000000000009';
    vi.stubEnv('OWNER_USER_ID', alternateOwner);
    client.auth.getUser.mockResolvedValue({ data: { user: { id: alternateOwner, email: 'owner@example.test' } }, error: null });
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(mediaResponse())); network.read.mockImplementation(fetcher);
    for (let index = 0; index < 10; index++) expect((await api()).status).toBe(200);
    const response = await api('all=true');
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(client.rpc).toHaveBeenCalledTimes(10); expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('keeps the real demo API synthetic and preserves other carousel query rules', async () => {
    vi.stubEnv('DEMO_MODE', 'true'); vi.stubEnv('ALLOW_LOCAL_DEMO', 'true'); vi.stubGlobal('__reelradarDemo', undefined);
    const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    const response = await api('all=true');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'CAROUSEL_MEDIA_UNAVAILABLE', message: expect.stringContaining('Synthetic') } });
    const path = ['workspaces', workspaceId, 'carousels', carousel.id];
    const existing = await GET(new Request(`${origin}/api/${path.join('/')}?slide=1`), { params: Promise.resolve({ path }) });
    expect(existing.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('captured carousel media and attachment safety', () => {
  it.each([[jpeg, 'image/jpeg', 'jpg'], [png, 'image/png', 'png'], [webp, 'image/webp', 'webp']] as const)('downloads the selected image with MIME-derived extension, not the signed URL path', async (bytes, type, extension) => {
    const fetcher = vi.fn().mockResolvedValue(mediaResponse(bytes, `${type}; charset=binary`)); network.read.mockImplementation(fetcher);
    const response = await downloadCarousel(repository(), workspaceId, carousel.id, params());
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="creator.name_ABC_123_slide01.${extension}"`);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect([...response.headers.values()].join()).not.toContain('token=private');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith(imageUrl, expect.objectContaining({ signal: expect.any(AbortSignal), headers: { Accept: 'image/jpeg, image/png, image/webp' } }));
  });

  it('downloads a selected silent video as MP4 without image fallback or audio requirements', async () => {
    const silent = mp4.slice(), handler = new TextDecoder('latin1').decode(silent).indexOf('soun');
    silent.set(new TextEncoder().encode('vide'), handler);
    const fetcher = vi.fn().mockResolvedValue(mediaResponse(silent, 'video/mp4')); network.read.mockImplementation(fetcher);
    const response = await downloadCarousel(repository(), workspaceId, carousel.id, params('slide=2'));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(silent);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="creator.name_ABC_123_slide02.mp4"');
    expect(fetcher).toHaveBeenCalledWith(videoUrl, expect.objectContaining({ headers: { Accept: 'video/mp4' } }));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('creates one deterministic ZIP with every slide ordered, including duplicate stored URLs', async () => {
    const value = { ...detail, carousel: { ...carousel, slides: [image, video, { ...image, position: 3 }] } };
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(url === videoUrl ? mediaResponse(mp4, 'video/mp4') : mediaResponse())); network.read.mockImplementation(fetcher);
    const first = await downloadCarousel(repository(value), workspaceId, carousel.id, params('all=true'));
    const bytes = new Uint8Array(await first.arrayBuffer()), files = unpackStoredZip(bytes);
    expect(first.headers.get('content-type')).toBe('application/zip');
    expect(first.headers.get('content-disposition')).toBe('attachment; filename="creator.name_ABC_123_slides.zip"');
    expect(Number(first.headers.get('content-length'))).toBe(bytes.length);
    expect(files.map(file => file.name)).toEqual(['creator.name_ABC_123_slide01.jpg', 'creator.name_ABC_123_slide02.mp4', 'creator.name_ABC_123_slide03.jpg']);
    expect(files.map(file => file.bytes)).toEqual([jpeg, mp4, jpeg]);
    expect(files.map(file => file.checksum)).toEqual([crc32(jpeg), crc32(mp4), crc32(jpeg)]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([imageUrl, videoUrl, imageUrl]);
    expect(new Uint8Array(await (await downloadCarousel(repository(value), workspaceId, carousel.id, params('all=true'))).arrayBuffer())).toEqual(bytes);
  });

  it('sanitizes attachment and archive names without traversal or response-header injection', async () => {
    network.read.mockImplementation(vi.fn().mockResolvedValue(mediaResponse()));
    const value = { ...detail, carousel: { ...carousel, username: '../../name\r\nX-Header: injected', shortcode: '../ABC/evil\\path', slides: [image] } };
    const response = await downloadCarousel(repository(value), workspaceId, carousel.id, params('all=true'));
    const file = unpackStoredZip(new Uint8Array(await response.arrayBuffer()))[0];
    expect(file.name).toBe('nameX-Headerinjected_ABCevilpath_slide01.jpg');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="nameX-Headerinjected_ABCevilpath_slides.zip"');
  });

  it('rejects unsafe captured hosts, credentials, explicit ports, URL normalization tricks and missing originals', async () => {
    const fetcher = vi.fn(); network.read.mockImplementation(fetcher);
    for (const url of ['http://images.cdninstagram.com/file', 'https://127.0.0.1/file', 'https://[::1]/file', 'https://169.254.169.254/file', 'https://2130706433/file', 'https://localhost/file', 'https://evil.test/file', 'https://cdninstagram.com/file', 'https://images.cdninstagram.com.evil.test/file', 'https://user:password@images.cdninstagram.com/file', 'https://images.cdninstagram.com:443/file', 'https://images.cdninstagram.com:8443/file', 'https://images.cdninstagram.com/file#fragment', 'https://images.cdninstagram.com\\@evil.test/file', 'https://images.cdninstagram.com /file', '/demo/carousel-1.svg']) {
      const value = { ...detail, carousel: { ...carousel, slides: [{ ...image, image_url: url }] } };
      await expect(downloadCarousel(repository(value), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 409 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('follows only validated bounded CDN redirects without cookies or authorization', async () => {
    const next = 'https://images.fbcdn.net/resolved.png';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } })).mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: next } })).mockResolvedValueOnce(mediaResponse(png, 'image/png'));
    network.read.mockImplementation(fetcher);
    expect((await downloadCarousel(repository(), workspaceId, carousel.id, params())).status).toBe(200);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([imageUrl, 'https://images.cdninstagram.com/next', next]);
    for (const [, options] of fetcher.mock.calls) { expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.headers).toEqual({ Accept: 'image/jpeg, image/png, image/webp' }); }
  });

  it('rejects private, credentialed, port-bearing and unsupported redirect destinations before requesting them', async () => {
    for (const location of ['https://127.0.0.1/private', 'http://images.fbcdn.net/file', 'https://user@images.fbcdn.net/file', 'https://images.fbcdn.net:443/file', 'https://images.fbcdn.net:8443/file', '//images.fbcdn.net:443/file', '//evil.test/file', 'https://images.fbcdn.net/file#fragment', 'https://images.fbcdn.net\\@evil.test/file']) {
      const cancel = vi.fn(), fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location } }));
      network.read.mockImplementation(fetcher);
      await expect(downloadCarousel(repository(), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 409 });
      expect(fetcher).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('limits redirect loops and rejects a fetch result that already followed a redirect', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 302, headers: { location: imageUrl } }))); network.read.mockImplementation(fetcher);
    await expect(downloadCarousel(repository(), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const response = mediaResponse(); Object.defineProperty(response, 'redirected', { value: true });
    fetcher.mockReset().mockResolvedValue(response);
    await expect(downloadCarousel(repository(), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves a distinct sanitized transport failure instead of claiming the stored media expired', async () => {
    authorizeOwner();
    network.read.mockRejectedValue(new ApiError(502, 'DOWNLOAD_NETWORK_UNAVAILABLE', 'The stored media CDN could not be reached. Please try again. No research data was changed.'));
    const response = await api();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'DOWNLOAD_NETWORK_UNAVAILABLE' } });
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('get_carousel_detail', { p_workspace_id: workspaceId, p_carousel_id: carousel.id });
  });

  it.each([
    () => new Response('expired', { status: 403 }),
    () => mediaResponse(jpeg, 'text/html'),
    () => mediaResponse(jpeg, 'image/svg+xml'),
    () => mediaResponse(jpeg, 'application/octet-stream'),
    () => mediaResponse(jpeg, 'video/mp4'),
    () => mediaResponse(new TextEncoder().encode('<html>not media</html>'), 'image/jpeg'),
    () => mediaResponse(png, 'image/jpeg'),
    () => mediaResponse(jpeg, 'image/png'),
    () => mediaResponse(jpeg, 'image/webp'),
    () => new Response(jpeg, { status: 206, headers: { 'content-type': 'image/jpeg' } }),
    () => mediaResponse(jpeg, 'image/jpeg', { 'content-length': '999' }),
    () => mediaResponse(jpeg, 'image/jpeg', { 'content-length': '1.2' }),
    () => mediaResponse(jpeg.slice(0, -2), 'image/jpeg'),
    () => mediaResponse(png.slice(0, -12), 'image/png'),
    () => mediaResponse(webp.slice(0, -1), 'image/webp'),
    () => mediaResponse(new Uint8Array(), 'image/jpeg'),
  ])('rejects expired, unsupported, partial, truncated, MIME-mismatched or invalid-signature images', async fixture => {
    network.read.mockImplementation(vi.fn().mockResolvedValue(fixture()));
    await expect(downloadCarousel(repository(), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 409, code: 'CAROUSEL_MEDIA_UNAVAILABLE' });
  });

  it('validates MP4 ftyp brands, complete box bounds, moov and media payloads', async () => {
    const noMovie = mp4.slice(); noMovie.set(new TextEncoder().encode('free'), 20);
    const invalidBrand = mp4.slice(); invalidBrand.set(new TextEncoder().encode('heic'), 8);
    const oversizedBox = mp4.slice(); new DataView(oversizedBox.buffer).setUint32(0, mp4.length + 1);
    for (const bytes of [jpeg, new TextEncoder().encode('<html>video</html>'), mp4.slice(0, -1), mp4.slice(0, 16), noMovie, invalidBrand, oversizedBox]) {
      network.read.mockImplementation(vi.fn().mockResolvedValue(mediaResponse(bytes, 'video/mp4')));
      await expect(downloadCarousel(repository(), workspaceId, carousel.id, params('slide=2'))).rejects.toMatchObject({ status: 409 });
    }
  });

  it('fails the whole archive if a later slide is expired, without falling back to its thumbnail or mutating data', async () => {
    const before = structuredClone(detail), repo = repository();
    const fetcher = vi.fn().mockResolvedValueOnce(mediaResponse()).mockResolvedValueOnce(new Response('expired', { status: 403 })); network.read.mockImplementation(fetcher);
    await expect(downloadCarousel(repo, workspaceId, carousel.id, params('all=true'))).rejects.toMatchObject({ status: 409 });
    expect(detail).toEqual(before); expect(fetcher).toHaveBeenCalledTimes(2); expect(repo.carouselDetail).toHaveBeenCalledOnce();
  });
});

describe('carousel download resource bounds and ZIP checksums', () => {
  it('checks declared per-format sizes before reading body bytes', async () => {
    for (const [query, type, maximum] of [['slide=1', 'image/jpeg', MAX_CAROUSEL_IMAGE_BYTES], ['slide=2', 'video/mp4', MAX_CAROUSEL_VIDEO_BYTES]] as const) {
      const cancel = vi.fn();
      network.read.mockImplementation(vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': type, 'content-length': String(maximum + 1) } })));
      await expect(downloadCarousel(repository(), workspaceId, carousel.id, params(query))).rejects.toMatchObject({ status: 413 });
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('bounds streaming media without Content-Length and releases the slot after rejection', async () => {
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_CAROUSEL_IMAGE_BYTES + 1)); }, cancel });
    network.read.mockImplementation(vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'image/jpeg' } })));
    await expect(downloadCarousel(repository(), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    network.read.mockImplementation(vi.fn().mockResolvedValue(mediaResponse()));
    expect((await downloadCarousel(repository(), workspaceId, carousel.id, params())).status).toBe(200);
  });

  it('counts ZIP headers against the total cap and refuses a partial archive when aggregate bytes overflow', async () => {
    const large = new Uint8Array(MAX_CAROUSEL_VIDEO_BYTES); large.set(mp4);
    new DataView(large.buffer).setUint32(mp4.length - 11, large.length - (mp4.length - 11));
    const value = { ...detail, carousel: { ...carousel, slides: [{ ...video, position: 1 }, video] } };
    const cancel = vi.fn(), fetcher = vi.fn().mockResolvedValueOnce(mediaResponse(large, 'video/mp4')).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_CAROUSEL_VIDEO_BYTES) } }));
    network.read.mockImplementation(fetcher);
    await expect(downloadCarousel(repository(value), workspaceId, carousel.id, params('all=true'))).rejects.toMatchObject({ status: 413 });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a stalled stream when the caller aborts', async () => {
    const cancel = vi.fn(), abort = new AbortController(); let fetched!: () => void;
    const started = new Promise<void>(resolve => { fetched = resolve; });
    network.read.mockImplementation(vi.fn().mockImplementation(() => { fetched(); return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/jpeg' } }); }));
    const downloading = downloadCarousel(repository(), workspaceId, carousel.id, params(), abort.signal);
    await started; await Promise.resolve(); abort.abort();
    await expect(downloading).rejects.toMatchObject({ status: 409 }); expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds file and overall deadlines and cancels stalled response bodies', async () => {
    const timeoutSignals: { milliseconds: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => { const controller = new AbortController(); timeoutSignals.push({ milliseconds, controller }); return controller.signal; });
    for (const deadline of [CAROUSEL_FILE_TIMEOUT_MS, CAROUSEL_DOWNLOAD_TIMEOUT_MS]) {
      timeoutSignals.length = 0;
      const cancel = vi.fn(); let fetched!: () => void; const started = new Promise<void>(resolve => { fetched = resolve; });
      network.read.mockImplementation(vi.fn().mockImplementation(() => { fetched(); return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/jpeg' } }); }));
      const downloading = downloadCarousel(repository(), workspaceId, carousel.id, params());
      await started; await Promise.resolve();
      expect(timeoutSignals.map(item => item.milliseconds)).toEqual([CAROUSEL_DOWNLOAD_TIMEOUT_MS, CAROUSEL_FILE_TIMEOUT_MS]);
      timeoutSignals.find(item => item.milliseconds === deadline)!.controller.abort();
      await expect(downloading).rejects.toMatchObject({ status: 504, code: 'DOWNLOAD_TIMEOUT' }); expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('limits concurrent carousel requests and releases slots after cancellation', async () => {
    const abort = new AbortController(); let count = 0, fetched!: () => void;
    const started = new Promise<void>(resolve => { fetched = resolve; });
    const fetcher = vi.fn().mockImplementation(() => { if (++count === 2) fetched(); return new Response(new ReadableStream(), { headers: { 'content-type': 'image/jpeg' } }); }); network.read.mockImplementation(fetcher);
    const first = downloadCarousel(repository(), workspaceId, carousel.id, params(), abort.signal), second = downloadCarousel(repository(), workspaceId, carousel.id, params(), abort.signal);
    await started;
    await expect(downloadCarousel(repository(), workspaceId, carousel.id, params())).rejects.toMatchObject({ status: 429, code: 'DOWNLOAD_BUSY' });
    expect(fetcher).toHaveBeenCalledTimes(2); abort.abort();
    await Promise.all([expect(first).rejects.toMatchObject({ status: 409 }), expect(second).rejects.toMatchObject({ status: 409 })]);
    fetcher.mockReset().mockResolvedValue(mediaResponse());
    expect((await downloadCarousel(repository(), workspaceId, carousel.id, params())).status).toBe(200);
  });

  it('checksums bounded blocks with standard CRC32 and yields to cancellation', async () => {
    const bytes = new Uint8Array(192 * 1024).fill(7), body = new Blob([bytes]);
    expect(await checksumStoredBlob(body, new AbortController().signal)).toBe(crc32(bytes));
    const abort = new AbortController(), reason = new DOMException('Cancelled during checksum', 'AbortError');
    const reading = vi.spyOn(body, 'slice');
    setImmediate(() => abort.abort(reason));
    await expect(checksumStoredBlob(body, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(reading.mock.calls.length).toBeLessThan(3);
    expect(reading.mock.calls.every(([start, end]) => end! - start! <= 64 * 1024)).toBe(true);
  });

  it('uses standard incremental CRC32 and writes valid UTF-8 local and central directory entries', async () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
    expect(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4)))).toBe(0xcbf43926);
    const entry = { name: 'créateur_slide01.jpg', body: new Blob([bytes]), crc32: crc32(bytes) }, size = bytes.length + storedZipOverhead([entry.name]);
    const archive = createStoredZip([entry], size);
    expect(archive.size).toBe(size);
    const files = unpackStoredZip(new Uint8Array(await archive.arrayBuffer()));
    expect(files[0]).toMatchObject({ name: entry.name, checksum: 0xcbf43926, bytes });
    expect(() => createStoredZip([entry], size - 1)).toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => createStoredZip([{ ...entry, body: { size: MAX_CAROUSEL_ZIP_BYTES } as Blob }], MAX_CAROUSEL_ZIP_BYTES)).toThrowError(expect.objectContaining({ status: 413 }));
    for (const name of ['../secret', '/secret', 'folder\\file', 'C:secret', '..', '.', 'bad\r\nheader']) expect(() => createStoredZip([{ ...entry, name }], 1000)).toThrow('Invalid ZIP filename');
    expect(() => createStoredZip([entry, entry], 1000)).toThrow('Invalid ZIP entries');
  });
});
