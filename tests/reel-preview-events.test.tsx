import { isValidElement, type EffectCallback, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReelPreviewContent, ReelPreviewDialog } from '../src/components/reel-preview-button';
import { startReelPreview } from '../src/lib/reel-preview';
import { createDemoData } from '../src/lib/demo';

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Hooks = { slots: Slot[]; cursor: number; effects: (() => void)[] };
const fixture = vi.hoisted(() => ({ active: null as Hooks | null }));
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  const slot = () => fixture.active!.slots[fixture.active!.cursor++] ??= {};
  return { ...react,
    useState: (initial: unknown) => {
      if (!fixture.active) return react.useState(initial);
      const current = slot();
      if (!Object.hasOwn(current, 'value')) current.value = initial;
      return [current.value, (next: unknown) => { current.value = typeof next === 'function' ? next(current.value) : next; }];
    },
    useRef: (initial: unknown) => fixture.active ? slot().value ??= { current: initial } : react.useRef(initial),
    useEffect: (callback: EffectCallback, deps?: readonly unknown[]) => {
      if (!fixture.active) return react.useEffect(callback, deps);
      const current = slot();
      if (!current.deps || !deps || current.deps.length !== deps.length || deps.some((value, index) => !Object.is(value, current.deps![index]))) {
        fixture.active.effects.push(() => { current.cleanup?.(); current.cleanup = callback() || undefined; });
        current.deps = deps;
      }
    },
  };
});
vi.mock('../src/lib/reel-preview', () => ({ startReelPreview: vi.fn() }));

type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return isValidElement<Record<string, unknown>>(tree) ? [tree, ...elements(tree.props.children as ReactNode)] : [];
}
function find(tree: ReactNode, type: unknown): Element {
  const found = elements(tree).find(element => element.type === type);
  if (!found) throw new Error('Preview element missing');
  return found;
}
const cleanup: (() => void)[] = [];
// Match the repo's dependency-aware hook/event fixtures without installing a renderer.
function harness(render: () => ReactNode) {
  const state: Hooks = { slots: [], cursor: 0, effects: [] };
  const dispose = () => state.slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; });
  cleanup.push(dispose);
  return { dispose, render(beforeEffects?: (tree: ReactNode) => void) {
    state.cursor = 0; state.effects = []; fixture.active = state;
    let tree: ReactNode;
    try { tree = render(); } finally { fixture.active = null; }
    beforeEffects?.(tree);
    state.effects.forEach(effect => effect());
    return tree;
  } };
}
const original = createDemoData().reels[0];
const reel = { ...original, provider: 'apify' };
const sources = ['https://video.cdninstagram.com/first.mp4', 'https://video.fbcdn.net/second.mp4'];
afterEach(() => { fixture.active = null; cleanup.splice(0).forEach(dispose => dispose()); vi.resetAllMocks(); });

function setup() {
  const cancel = vi.fn(), close = vi.fn();
  let ready!: (sources: string[]) => void;
  vi.mocked(startReelPreview).mockImplementation((_workspace, _id, callback) => { ready = callback; return { cancel, finished: Promise.resolve() }; });
  const ui = harness(() => ReelPreviewDialog({ reel, workspaceId: 'workspace', onClose: close }));
  return { ui, cancel, close, ready: (urls = sources) => ready(urls) };
}

describe('progressive Preview media events', () => {
  it('starts one metadata read, advances stored candidates on error and stops at the final fallback', () => {
    const { ui, ready } = setup();
    ui.render(); ready();
    let props = find(ui.render(), ReelPreviewContent).props;
    expect(props.source).toBe(sources[0]); expect(props.loading).toBe(true);
    (props.onPlaybackError as () => void)();
    props = find(ui.render(), ReelPreviewContent).props;
    expect(props.source).toBe(sources[1]); expect(props.loading).toBe(true);
    (props.onPlaybackError as () => void)();
    props = find(ui.render(), ReelPreviewContent).props;
    expect(props.error).toContain('Stored video links are unavailable');
    expect(props.loading).toBe(false); expect(startReelPreview).toHaveBeenCalledOnce();
  });
  it('shows buffering on waiting/seeking and clears it on readiness, playing and seek completion', () => {
    const { ui, ready } = setup();
    ui.render(); ready();
    const player = () => {
      const props = find(ui.render(), ReelPreviewContent).props as Parameters<typeof ReelPreviewContent>[0];
      return find(ReelPreviewContent(props), 'video');
    };
    (player().props.onLoadedData as () => void)();
    expect(find(ui.render(), ReelPreviewContent).props.loading).toBe(false);
    (player().props.onWaiting as () => void)();
    expect(find(ui.render(), ReelPreviewContent).props.loading).toBe(true);
    (player().props.onPlaying as () => void)();
    expect(find(ui.render(), ReelPreviewContent).props.loading).toBe(false);
    (player().props.onSeeking as () => void)();
    expect(find(ui.render(), ReelPreviewContent).props.loading).toBe(true);
    (player().props.onSeeked as () => void)();
    expect(find(ui.render(), ReelPreviewContent).props.loading).toBe(false);
  });
  it('aborts metadata on close and stops/clears the mounted player on disposal', () => {
    const { ui, ready, cancel, close } = setup();
    ui.render(); ready();
    const video = { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const tree = ui.render(tree => { (find(tree, ReelPreviewContent).props.videoRef as { current: unknown }).current = video; }) as Element;
    (tree.props.onClose as () => void)();
    expect(video.pause).toHaveBeenCalled(); expect(cancel).toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    ui.dispose();
    expect(video.removeAttribute).toHaveBeenCalledWith('src'); expect(video.load).toHaveBeenCalledOnce();
  });
  it('never starts metadata or media requests for synthetic demo Reels', () => {
    const ui = harness(() => ReelPreviewDialog({ reel: original, workspaceId: 'workspace', onClose: () => {} }));
    const props = find(ui.render(), ReelPreviewContent).props;
    expect(props.loading).toBe(false); expect(props.source).toBeNull();
    expect(startReelPreview).not.toHaveBeenCalled();
  });
});
