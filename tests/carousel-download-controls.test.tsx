import { createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarouselDownloadControls } from '../src/components/carousel-download-controls';
import { CarouselDetailView, CarouselGallery } from '../src/components/carousel-detail';
import { createDemoData } from '../src/lib/demo';
import type { Carousel } from '../src/lib/types';

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type HookState = { slots: Slot[]; cursor: number; effects: (() => void)[]; updates: number };
const fixtures = vi.hoisted(() => ({ active: null as HookState | null }));
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  const slot = () => fixtures.active!.slots[fixtures.active!.cursor++] ??= {};
  return { ...react,
    useId: () => fixtures.active ? 'download-fixture-note' : react.useId(),
    useState: (initial: unknown) => {
      if (!fixtures.active) return react.useState(initial);
      const state = fixtures.active, current = slot();
      if (!Object.hasOwn(current, 'value')) current.value = typeof initial === 'function' ? initial() : initial;
      return [current.value, (next: unknown) => { current.value = typeof next === 'function' ? next(current.value) : next; state.updates++; }];
    },
    useRef: (initial: unknown) => fixtures.active ? slot().value ??= { current: initial } : react.useRef(initial),
    useEffect: (callback: EffectCallback, deps?: readonly unknown[]) => {
      if (!fixtures.active) return react.useEffect(callback, deps);
      const current = slot();
      if (!current.deps || !deps || current.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, current.deps![i]))) {
        fixtures.active.effects.push(() => { current.cleanup?.(); current.cleanup = callback() || undefined; });
        current.deps = deps;
      }
    },
  };
});

const cleanup: (() => void)[] = [];
// Repo-style hook/event harness: run real JSX handlers and persistent hooks without a new renderer dependency.
function harness(render: () => ReactNode) {
  const state: HookState = { slots: [], cursor: 0, effects: [], updates: 0 };
  const dispose = () => state.slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; });
  cleanup.push(dispose);
  return { dispose, state, render() {
    state.cursor = 0; state.effects = []; fixtures.active = state;
    let tree: ReactNode;
    try { tree = render(); } finally { fixtures.active = null; }
    state.effects.forEach(effect => effect());
    return tree;
  } };
}
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return isValidElement<Record<string, unknown>>(tree) ? [tree, ...elements(tree.props.children as ReactNode)] : [];
}
function text(tree: ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children as ReactNode) : '';
}
function find(tree: ReactNode, predicate: (element: Element) => boolean): Element {
  const element = elements(tree).find(predicate);
  if (!element) throw new Error('Missing carousel download control');
  return element;
}
function buttons(tree: ReactNode) { return elements(tree).filter(element => element.type === 'button'); }
function click(element: Element) { (element.props.onClick as () => void)(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

const demo = createDemoData().carousels[0];
const carousel: Carousel = { ...demo, provider: 'apify', shortcode: 'CAPTURED_123', slides: [
  { position: 9, media_type: 'image', image_url: 'https://scontent.cdninstagram.com/private.jpg?token=never-fetch-this', video_url: null },
  { position: 7, media_type: 'video', image_url: 'https://scontent.cdninstagram.com/poster.jpg', video_url: 'https://video.fbcdn.net/private.mp4?token=secret' },
  { position: 4, media_type: 'image', image_url: 'https://scontent.cdninstagram.com/third.webp', video_url: null },
] };
function media(mime = 'image/jpeg', filename = 'reelradar-CAPTURED_123-slide-1.jpg') {
  return new Response('captured media fixture', { headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${filename}"` } });
}
const fetcher = vi.fn<typeof fetch>();
const createUrl = vi.fn(() => 'blob:fixture-download'), revokeUrl = vi.fn();
const links: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }[] = [];
const append = vi.fn();

beforeEach(() => {
  vi.useFakeTimers(); fetcher.mockReset(); createUrl.mockClear(); revokeUrl.mockClear(); append.mockClear(); links.length = 0;
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, location: { href: 'https://fixture.invalid/' } });
  vi.stubGlobal('document', { body: { append }, createElement: vi.fn((tag: string) => {
    expect(tag).toBe('a'); const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }; links.push(link); return link;
  }) });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createUrl);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl);
});
afterEach(() => {
  fixtures.active = null; cleanup.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('carousel detail refresh recovery', () => {
  it('retains the selected research tab and gallery while retrying a failed cached update', () => {
    const retry = vi.fn(), notify = vi.fn();
    const ui = harness(() => CarouselDetailView({ detail: { carousel, snapshots: [] }, workspaceId: 'workspace', notify, error: 'The request timed out.', retry }));
    let tree = ui.render();
    click(find(tree, element => element.props.role === 'tab' && text(element) === 'Notes'));
    tree = ui.render();
    expect(find(tree, element => element.props.role === 'tab' && text(element) === 'Notes').props['aria-selected']).toBe(true);
    expect(find(tree, element => element.type === CarouselGallery).props.carousel).toBe(carousel);
    expect(text(tree)).toContain('Update failed: The request timed out.');
    click(find(tree, element => element.type === 'button' && text(element) === 'Retry details'));
    expect(retry).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    expect(find(ui.render(), element => element.props.role === 'tab' && text(element) === 'Notes').props['aria-selected']).toBe(true);
  });
});

describe('explicit carousel download choices', () => {
  it('renders two labelled choices without eagerly downloading or exposing stored URLs', () => {
    const html = renderToStaticMarkup(createElement(CarouselDownloadControls, { carousel, workspaceId: 'workspace', currentSlide: 2 }));
    expect(html).toContain('aria-label="Download current slide 2 of 3"');
    expect(html).toContain('aria-label="Download all 3 slides as one ZIP"');
    expect(html).toContain('Download current slide (2)'); expect(html).toContain('Download all slides ZIP');
    expect(html).not.toContain('disabled=""'); expect(html).not.toContain('token=');
    expect(html).toContain('128 MB'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('disables synthetic/demo/mock, missing workspace and unavailable original media truthfully', () => {
    for (const provider of ['mock', 'mock-apify', 'synthetic', 'demo']) {
      const ui = harness(() => CarouselDownloadControls({ carousel: { ...carousel, provider }, workspaceId: 'workspace', currentSlide: 1 }));
      const tree = ui.render(); expect(buttons(tree).every(button => button.props.disabled)).toBe(true);
      expect(text(tree)).toContain('not verified Instagram media'); buttons(tree).forEach(click);
    }
    for (const value of [
      { carousel, workspaceId: undefined, currentSlide: 1 },
      { carousel: { ...carousel, slides: [] }, workspaceId: 'workspace', currentSlide: 1 },
      { carousel: { ...carousel, slides: [{ ...carousel.slides[1], video_url: null }] }, workspaceId: 'workspace', currentSlide: 1 },
      { carousel: { ...carousel, slides: [{ ...carousel.slides[0], image_url: 'https://127.0.0.1/private' }] }, workspaceId: 'workspace', currentSlide: 1 },
      { carousel: demo, workspaceId: 'workspace', currentSlide: 1 },
    ]) {
      const ui = harness(() => CarouselDownloadControls(value)), tree = ui.render();
      expect(buttons(tree).every(button => button.props.disabled)).toBe(true); buttons(tree).forEach(click);
    }
    const ui = harness(() => CarouselDownloadControls({ carousel: { ...carousel, slides: [carousel.slides[0], { ...carousel.slides[1], video_url: null }] }, workspaceId: 'workspace', currentSlide: 1 }));
    expect(buttons(ui.render()).map(button => button.props.disabled)).toEqual([false, true]);
    expect(text(ui.render())).toContain('No partial archive'); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'video/mp4'])('saves a validated %s attachment from only the authenticated same-origin endpoint', async mime => {
    fetcher.mockResolvedValue(media(mime, 'captured-slide-2.any'));
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace/a?b', currentSlide: mime === 'video/mp4' ? 2 : 1 }));
    click(buttons(ui.render())[0]); await settle();
    const ordinal = mime === 'video/mp4' ? 2 : 1;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`/api/workspaces/workspace%2Fa%3Fb/carousels/${encodeURIComponent(carousel.id)}/download?slide=${ordinal}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(links).toHaveLength(1); expect(links[0].download).toBe(`captured-slide-2.${{ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' }[mime]}`);
    expect(links[0].click).toHaveBeenCalledOnce(); expect(links[0].remove).toHaveBeenCalledOnce();
    expect(text(ui.render())).toContain(`Slide ${ordinal} download started.`);
    expect(buttons(ui.render()).every(button => !button.props.disabled)).toBe(true);
    vi.advanceTimersByTime(29_999); expect(revokeUrl).not.toHaveBeenCalled();
    ui.dispose(); vi.advanceTimersByTime(1); expect(revokeUrl).toHaveBeenCalledWith('blob:fixture-download');
  });

  it('requests exactly one ZIP and persistently guards both buttons against rapid or stale-handler clicks', async () => {
    const response = deferred<Response>(); fetcher.mockReturnValue(response.promise);
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 1 }));
    const original = buttons(ui.render()); click(original[1]); click(original[1]); click(original[0]);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toContain('/download?all=true');
    const tree = ui.render(); expect(buttons(tree).every(button => button.props.disabled)).toBe(true);
    expect(text(tree)).toContain('Preparing all slides as one ZIP');
    response.resolve(media('application/zip', 'all-slides.zip')); await settle();
    expect(links).toHaveLength(1); expect(links[0].download).toBe('all-slides.zip');
    expect(text(ui.render())).toContain('ZIP download started (3 slides).');
  });

  it('allows gallery movement while pending, retaining the requested 1-based ordinal and filename', async () => {
    const response = deferred<Response>(); fetcher.mockReturnValue(response.promise);
    const gallery = harness(() => CarouselGallery({ carousel, workspaceId: 'workspace' }));
    let galleryTree = gallery.render();
    let props = find(galleryTree, element => element.type === CarouselDownloadControls).props as Parameters<typeof CarouselDownloadControls>[0];
    const ui = harness(() => CarouselDownloadControls(props));
    click(buttons(ui.render())[0]);
    const next = find(galleryTree, element => element.props['aria-label'] === 'Next slide'); expect(next.props.disabled).toBe(false); click(next);
    galleryTree = gallery.render(); props = find(galleryTree, element => element.type === CarouselDownloadControls).props as Parameters<typeof CarouselDownloadControls>[0];
    expect(props.currentSlide).toBe(2); expect(props.workspaceId).toBe('workspace');
    expect(buttons(ui.render())[0].props['aria-label']).toBe('Download current slide 2 of 3');
    expect(text(ui.render())).toContain('Downloading slide 1');
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false);
    response.resolve(media('image/jpeg', 'reelradar-CAPTURED_123-slide-1.jpg')); await settle();
    expect(links[0].download).toBe('reelradar-CAPTURED_123-slide-1.jpg');
    expect(text(ui.render())).toContain('Slide 1 download started'); expect(props.currentSlide).toBe(2);
    expect(fetcher.mock.calls[0][0]).toContain('?slide=1'); // Not slide.position (9).
  });

  it('passes workspace context through the detail view without removing caption or research tabs', () => {
    const ui = harness(() => CarouselDetailView({ detail: { carousel, snapshots: [] }, workspaceId: 'workspace', notify: vi.fn() }));
    const tree = ui.render(); expect(find(tree, element => element.type === CarouselGallery).props.workspaceId).toBe('workspace');
    expect(text(tree)).toContain(carousel.caption); expect(text(tree)).toContain('Overview'); expect(text(tree)).toContain('Notes'); expect(text(tree)).toContain('History');
    const legacy = renderToStaticMarkup(createElement(CarouselGallery, { carousel: demo }));
    expect(legacy).toContain('Next slide'); expect(legacy).toContain('Synthetic carousel');
    expect(legacy).not.toContain('autoPlay');
  });
});

describe('carousel attachment errors and lifecycle', () => {
  it.each([
    () => new Response('<html>expired</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => media('video/mp4'),
    () => new Response('media', { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response('media', { headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline; filename="x.jpg"' } }),
    () => new Response('media', { status: 206, headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="x.jpg"' } }),
    () => new Response('', { headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="x.jpg"' } }),
  ])('does not save HTML, mismatched MIME, non-attachments, partial or empty responses', async response => {
    fetcher.mockResolvedValue(response());
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 1 }));
    click(buttons(ui.render())[0]); await settle();
    expect(createUrl).not.toHaveBeenCalled(); expect(find(ui.render(), element => element.props.role === 'alert')).toBeDefined();
    expect(buttons(ui.render()).every(button => !button.props.disabled)).toBe(true);
  });

  it('rejects non-ZIP all-slide results and oversize bodies without starting a partial download', async () => {
    fetcher.mockResolvedValue(media());
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 1 }));
    click(buttons(ui.render())[1]); await settle(); expect(createUrl).not.toHaveBeenCalled();
    const response = media(); vi.spyOn(response, 'blob').mockResolvedValue({ size: 128 * 1024 * 1024 + 1 } as Blob); fetcher.mockResolvedValue(response);
    click(buttons(ui.render())[0]); await settle(); expect(text(ui.render())).toContain('128 MB limit'); expect(createUrl).not.toHaveBeenCalled();
  });

  it('shows server expiration and authorization errors, retaining the visible selection for retry', async () => {
    const response = deferred<Response>(); fetcher.mockReturnValueOnce(response.promise);
    let currentSlide = 1;
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide }));
    click(buttons(ui.render())[0]); currentSlide = 3; ui.render();
    response.resolve(Response.json({ error: { code: 'MEDIA_EXPIRED', message: 'Captured slide media has expired. Refresh the post before retrying.' } }, { status: 410 })); await settle();
    expect(text(ui.render())).toContain('Captured slide media has expired. Refresh the post before retrying.');
    expect(buttons(ui.render())[0].props['aria-label']).toBe('Download current slide 3 of 3');
    fetcher.mockResolvedValue(Response.json({ error: { message: 'Access denied to this workspace.' } }, { status: 403 }));
    click(buttons(ui.render())[0]); await settle(); expect(text(ui.render())).toContain('Access denied to this workspace.');
    expect(fetcher.mock.calls[1][0]).toContain('?slide=3'); expect(createUrl).not.toHaveBeenCalled();
  });

  it.each(['../../private.jpg', 'https://cdn.test/private.jpg?token=secret', '..\\private.jpg'])('never turns URL or path attachment names into downloaded filenames: %s', async filename => {
    fetcher.mockResolvedValue(media('image/jpeg', filename));
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 1 }));
    click(buttons(ui.render())[0]); await settle(); expect(links[0].download).toBe('reelradar-CAPTURED_123-slide-1.jpg');
  });

  it('sanitizes an encoded attachment filename and forces the validated MIME extension', async () => {
    fetcher.mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/webp; charset=binary', 'Content-Disposition': "attachment; filename*=UTF-8''%20captured%20slide%203.exe" } }));
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 3 }));
    click(buttons(ui.render())[0]); await settle(); expect(links[0].download).toBe('captured-slide-3.webp');
  });

  it('aborts and reports a 65-second timeout, including a late response that ignores abort', async () => {
    const response = deferred<Response>(); fetcher.mockReturnValue(response.promise);
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 1 }));
    click(buttons(ui.render())[0]); const signal = fetcher.mock.calls[0][1]!.signal as AbortSignal;
    vi.advanceTimersByTime(64_999); expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(signal.aborted).toBe(true);
    response.resolve(media()); await settle(); expect(text(ui.render())).toContain('download timed out');
    expect(createUrl).not.toHaveBeenCalled(); expect(buttons(ui.render()).every(button => !button.props.disabled)).toBe(true);
  });

  it.each(['fetch', 'blob'])('aborts on unmount while awaiting %s and suppresses late saving or notices', async stage => {
    const response = deferred<Response>(), body = deferred<Blob>();
    const result = media(); if (stage === 'blob') vi.spyOn(result, 'blob').mockReturnValue(body.promise);
    fetcher.mockReturnValue(response.promise);
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId: 'workspace', currentSlide: 1 }));
    click(buttons(ui.render())[0]); if (stage === 'blob') { response.resolve(result); await settle(); }
    const before = ui.state.updates; ui.dispose();
    expect((fetcher.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
    if (stage === 'fetch') response.resolve(result); else body.resolve(new Blob(['image']));
    await settle(); expect(ui.state.updates).toBe(before); expect(createUrl).not.toHaveBeenCalled(); expect(links).toHaveLength(0);
  });

  it('aborts an old workspace request and suppresses its late feedback after replacement', async () => {
    const response = deferred<Response>(); fetcher.mockReturnValueOnce(response.promise);
    let workspaceId = 'first';
    const ui = harness(() => CarouselDownloadControls({ carousel, workspaceId, currentSlide: 1 }));
    click(buttons(ui.render())[0]); const signal = fetcher.mock.calls[0][1]!.signal as AbortSignal;
    workspaceId = 'second'; ui.render(); expect(signal.aborted).toBe(true);
    fetcher.mockResolvedValue(media()); click(buttons(ui.render())[0]); await settle();
    const before = ui.state.updates; response.resolve(media()); await settle(); expect(ui.state.updates).toBe(before);
    expect(links).toHaveLength(1); expect(fetcher.mock.calls[1][0]).toContain('/workspaces/second/');
  });
});
