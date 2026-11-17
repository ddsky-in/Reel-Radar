import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Avatar } from '../src/components/ui';
import { creatorAvatarPath, validCreatorAvatarPath } from '../src/lib/creator-avatar';

const fixtures = vi.hoisted(() => ({ hooks: null as null | {
  state: (initial: unknown) => unknown;
  effect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => void;
  ref: (initial: unknown) => unknown;
} }));
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) => fixtures.hooks ? fixtures.hooks.state(initial) : react.useState(initial),
    useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => fixtures.hooks ? fixtures.hooks.effect(callback, dependencies) : react.useEffect(callback, dependencies),
    useRef: (initial: unknown) => fixtures.hooks ? fixtures.hooks.ref(initial) : react.useRef(initial),
  };
});

type AvatarProps = Parameters<typeof Avatar>[0];
type Element = ReactElement<Record<string, unknown>>;
const workspaceId = '11111111-1111-4111-8111-111111111111';
const creatorId = '22222222-2222-4222-8222-222222222222';
const fallback = `/api/workspaces/${workspaceId}/creators/${creatorId}/avatar`;
const source = 'https://images.cdninstagram.com/stored.jpg?token=a%2Fb%3D&signature=One+Two&expires=123&token=last';
let browser: EventTarget;
const mounted: { dispose: () => void }[] = [];

// Same dependency-aware hook/event runner as competitor-paging-ui: execute real
// JSX callbacks and effects without a DOM renderer or another dependency.
function harness(initial: AvatarProps = { username: 'synthetic_creator', url: source, fallbackUrl: fallback }) {
  const slots: unknown[] = [];
  const effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  let props = initial, cursor = 0, effectCursor = 0, dirty = false, disposed = false;
  let pending: (() => void)[] = [];
  const updates = vi.fn();
  const hooks = {
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => {
        updates(disposed);
        const value = typeof next === 'function' ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; }
      }];
    },
    ref(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    effect(callback: () => void | (() => void), dependencies?: readonly unknown[]) {
      const index = effectCursor++, previous = effects[index];
      if (previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        effects[index] = { dependencies, cleanup: cleanup || undefined };
      });
    },
  };
  const ui = {
    updates,
    render(next?: Partial<AvatarProps>): ReactNode {
      if (disposed) throw new Error('Cannot render an unmounted avatar');
      props = { ...props, ...next };
      for (let iteration = 0; iteration < 20; iteration++) {
        dirty = false; cursor = 0; effectCursor = 0; pending = [];
        fixtures.hooks = hooks;
        let tree: ReactNode;
        try { tree = Avatar(props); } finally { fixtures.hooks = null; }
        pending.forEach(effect => effect());
        if (!dirty) return tree;
      }
      throw new Error('Avatar did not settle');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      effects.forEach(effect => effect.cleanup?.());
    },
  };
  mounted.push(ui);
  return ui;
}
function elements(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children as ReactNode) : '';
}
function image(tree: ReactNode): Element {
  const result = elements(tree).find(element => element.type === 'img');
  if (!result) throw new Error(`Avatar image missing: ${text(tree)}`);
  return result;
}
function fail(tree: ReactNode) { (image(tree).props.onError as () => void)(); }
function expectInitials(tree: ReactNode, unavailable = false) {
  expect(elements(tree).filter(element => element.type === 'img')).toHaveLength(0);
  expect(elements(tree).find(element => element.props['aria-hidden'] === 'true')?.props.children).toBe('SC');
  const announcement = elements(tree).find(element => element.props.className === 'sr-only');
  if (unavailable) {
    expect(text(announcement)).toBe('Profile photo unavailable for @synthetic_creator');
    expect(elements(tree)[0].props.title).toBe('@synthetic_creator · Profile photo unavailable. Existing research is preserved.');
  } else {
    expect(announcement).toBeUndefined();
    expect(elements(tree)[0].props.title).toBe('@synthetic_creator');
  }
}
function failBoth(ui: ReturnType<typeof harness>): ReactNode {
  const direct = ui.render(); expect(image(direct).props.src).toBe(source); fail(direct);
  const stored = ui.render(); expect(image(stored).props.src).toBe(fallback); fail(stored);
  const tree = ui.render(); expectInitials(tree, true); return tree;
}
function triggerRetry(trigger: 'timer' | 'focus' | 'online') {
  if (trigger === 'timer') vi.advanceTimersByTime(2_000);
  else { vi.setSystemTime(Date.now() + 2_000); browser.dispatchEvent(new Event(trigger)); }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
  browser = new EventTarget(); vi.stubGlobal('window', browser);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Avatar recovery must not request collection or fetch data'); }));
});
afterEach(() => {
  mounted.splice(0).forEach(ui => ui.dispose());
  fixtures.hooks = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('creator avatar recovery', () => {
  it.each([undefined, null, '', 'not a URL', '/avatars/local.jpg', '//images.cdninstagram.com/avatar.jpg',
    'http://images.cdninstagram.com/avatar.jpg', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
    'https://user:password@images.cdninstagram.com/avatar.jpg'])('shows initials without unavailable warnings for missing/invalid direct source %s', url => {
    expectInitials(harness({ username: 'synthetic_creator', url }).render());
    expect(vi.getTimerCount()).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('passes the exact signed source and privacy/accessibility attributes to the direct image', () => {
    const tree = harness().render();
    expect(image(tree).props).toMatchObject({ src: source, alt: 'Profile picture of @synthetic_creator', loading: 'lazy', referrerPolicy: 'no-referrer' });
    expect(vi.getTimerCount()).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('switches only after direct failure to the validated stored fallback, then accessible initials after fallback failure', () => {
    const ui = harness(); failBoth(ui);
    expect(vi.getTimerCount()).toBe(1); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('can display and recover a validated fallback when no direct source exists', () => {
    const ui = harness({ username: 'synthetic_creator', url: null, fallbackUrl: fallback });
    const first = ui.render(); expect(image(first).props.src).toBe(fallback); fail(first);
    expectInitials(ui.render(), true);
    vi.advanceTimersByTime(2_000);
    const retry = ui.render(); expect(image(retry).props.src).toBe(fallback); expect(image(retry).key).not.toBe(image(first).key);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timer', 'focus', 'online'] as const)('makes at most two recovery attempts via %s, preserving both URLs and remounting the image', trigger => {
    const ui = harness();
    const keys = [image(ui.render()).key];
    for (let attempt = 0; attempt < 2; attempt++) {
      failBoth(ui);
      vi.setSystemTime(Date.now() + 1_999);
      browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('online'));
      expectInitials(ui.render(), true);
      // Reset the wall clock so timer and event triggers both exercise 2 seconds.
      vi.setSystemTime(Date.now() - 1_999);
      triggerRetry(trigger);
      const retried = ui.render(); expect(image(retried).props.src).toBe(source);
      keys.push(image(retried).key);
      expect(vi.getTimerCount()).toBe(0);
      browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('online'));
      expect(image(ui.render()).key).toBe(keys.at(-1));
    }
    expect(new Set(keys).size).toBe(3);
    failBoth(ui);
    for (let event = 0; event < 5; event++) {
      vi.advanceTimersByTime(10_000);
      browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('online'));
      expectInitials(ui.render(), true);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shares a two-attempt budget across queued focus/online events and timer races', () => {
    const ui = harness(); failBoth(ui);
    vi.setSystemTime(Date.now() + 2_000);
    browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(2_000); // Let the still-registered timer race before effects clean up.
    const firstRetry = ui.render(); expect(image(firstRetry).props.src).toBe(source);
    failBoth(ui); triggerRetry('timer');
    const secondRetry = ui.render(); expect(image(secondRetry).key).not.toBe(image(firstRetry).key);
    failBoth(ui); triggerRetry('online'); expectInitials(ui.render(), true);
  });

  it('does not let duplicate errors from the removed direct image restart the failed fallback stage', () => {
    const ui = harness(), direct = ui.render(); fail(direct);
    const stored = ui.render(); expect(image(stored).props.src).toBe(fallback);
    fail(stored); expectInitials(ui.render(), true);
    vi.advanceTimersByTime(1_000);
    fail(direct); expectInitials(ui.render(), true);
    vi.advanceTimersByTime(999); expectInitials(ui.render(), true);
    vi.advanceTimersByTime(1); expect(image(ui.render()).props.src).toBe(source);
  });

  it('resets exhausted failures and the retry budget immediately when a new signed source arrives', () => {
    const ui = harness();
    for (let attempt = 0; attempt < 2; attempt++) { failBoth(ui); triggerRetry('timer'); ui.render(); }
    failBoth(ui);
    const nextSource = `${source}&replacement=1`;
    let tree = ui.render({ url: nextSource });
    expect(image(tree).props.src).toBe(nextSource); expect(text(tree)).not.toContain('unavailable');
    expect(vi.getTimerCount()).toBe(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      fail(tree); tree = ui.render(); expect(image(tree).props.src).toBe(fallback);
      fail(tree); expectInitials(ui.render(), true);
      triggerRetry('timer'); tree = ui.render(); expect(image(tree).props.src).toBe(nextSource);
    }
    fail(tree); fail(ui.render()); expectInitials(ui.render(), true);
    triggerRetry('timer'); expectInitials(ui.render(), true);
  });

  it('resets failure on a changed fallback and cancels recovery when sources disappear', () => {
    const ui = harness(); failBoth(ui);
    const nextFallback = `/api/workspaces/${workspaceId}/creators/33333333-3333-4333-8333-333333333333/avatar`;
    let tree = ui.render({ fallbackUrl: nextFallback }); expect(image(tree).props.src).toBe(source);
    expect(vi.getTimerCount()).toBe(0);
    fail(tree); tree = ui.render(); expect(image(tree).props.src).toBe(nextFallback);
    fail(tree); expectInitials(ui.render(), true);
    expectInitials(ui.render({ url: null, fallbackUrl: null }));
    expect(vi.getTimerCount()).toBe(0);
    browser.dispatchEvent(new Event('online')); vi.advanceTimersByTime(10_000);
    expectInitials(ui.render());
  });

  it('ignores old-source errors after a replacement arrives', () => {
    const ui = harness(), old = ui.render();
    const nextSource = `${source}&replacement=1`;
    let tree = ui.render({ url: nextSource });
    fail(old); tree = ui.render();
    expect(image(tree).props.src).toBe(nextSource);
    fail(tree); tree = ui.render(); expect(image(tree).props.src).toBe(fallback);
    fail(old); expect(image(ui.render()).props.src).toBe(fallback);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores errors from a previous retry version of the same source', () => {
    const ui = harness(), oldDirect = ui.render(); fail(oldDirect);
    const oldFallback = ui.render(); fail(oldFallback); expectInitials(ui.render(), true);
    triggerRetry('timer');
    const retried = ui.render(); expect(image(retried).key).not.toBe(image(oldDirect).key);
    fail(oldFallback); fail(oldDirect);
    expect(image(ui.render()).props.src).toBe(source); expect(vi.getTimerCount()).toBe(0);
    fail(retried); expect(image(ui.render()).props.src).toBe(fallback);
  });

  it('clears its recovery timer and both browser listeners on unmount without later state updates', () => {
    const add = vi.spyOn(browser, 'addEventListener'), remove = vi.spyOn(browser, 'removeEventListener');
    const ui = harness(); failBoth(ui);
    expect(vi.getTimerCount()).toBe(1);
    expect(add.mock.calls.map(([event]) => event)).toEqual(['online', 'focus']);
    ui.updates.mockClear(); ui.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls).toEqual(add.mock.calls);
    browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('online')); vi.advanceTimersByTime(10_000);
    expect(ui.updates).not.toHaveBeenCalled();
  });
});

const invalidFallbacks = [undefined, null, '', '/avatars/arbitrary.jpg', `api/workspaces/${workspaceId}/creators/${creatorId}/avatar`,
  `https://example.invalid${fallback}`, `//example.invalid${fallback}`, `/${fallback}`, `${fallback}/`, `${fallback}?url=https://evil.invalid/avatar`,
  `${fallback}#fragment`, `${fallback}/extra`, fallback.replace(workspaceId, 'not-a-uuid'), fallback.replace(creatorId, '../avatar'),
  fallback.replace('/creators/', '/reels/'), fallback.replace('/avatar', '/source-refresh'), fallback.replace('/api/', '/other/'), ` ${fallback}`];
describe('strict creator avatar fallback paths', () => {
  it('accepts only the UUID-scoped workspace/creator avatar route', () => {
    expect(creatorAvatarPath(workspaceId, creatorId)).toBe(fallback);
    expect(validCreatorAvatarPath(fallback)).toBe(fallback);
    expect(creatorAvatarPath('fixture-workspace', creatorId)).toBeNull();
    expect(creatorAvatarPath(workspaceId, 'fixture-creator')).toBeNull();
  });

  it.each(invalidFallbacks)('does not render or switch to arbitrary fallback %s', fallbackUrl => {
    expect(validCreatorAvatarPath(fallbackUrl)).toBeNull();
    expectInitials(harness({ username: 'synthetic_creator', fallbackUrl }).render());
    const ui = harness({ username: 'synthetic_creator', url: source, fallbackUrl });
    const tree = ui.render(); expect(image(tree).props.src).toBe(source); fail(tree);
    expectInitials(ui.render(), true); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
