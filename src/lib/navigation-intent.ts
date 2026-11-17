'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';

export type NavigationIntent = { epoch: number; href: string };

/** Route hooks serialize query values differently from browser history (e.g. %20 vs +). */
export function canonicalNavigationTarget(href: string) {
  const url = new URL(href, 'http://navigation.invalid');
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? '?' + query : ''}`;
}

/** Synchronous intent, not just the pathname that Next commits later. */
export function createNavigationIntent(pathname: string, url: string) {
  let epoch = 0;
  let currentPath = pathname;
  let currentUrl = canonicalNavigationTarget(url);
  let pending: NavigationIntent | null = null;
  let intentSource = currentUrl;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => epoch,
    getServerSnapshot: () => 0,
    getPending: () => pending,
    begin(href: string) {
      href = canonicalNavigationTarget(href);
      epoch += 1;
      intentSource = currentUrl;
      pending = href === currentUrl ? null : { epoch, href };
      publish();
      return epoch;
    },
    observe(nextPath: string, nextUrl: string) {
      nextUrl = canonicalNavigationTarget(nextUrl);
      if (nextUrl === currentUrl && nextPath === currentPath) return;
      const pathChanged = nextPath !== currentPath;
      currentPath = nextPath;
      currentUrl = nextUrl;
      // An intermediate commit must not release a newer intent.
      if (pending && pending.href !== nextUrl) return;
      if (!pending && !pathChanged) return;
      pending = null;
      epoch += 1;
      publish();
    },
    cancelLink(intentEpoch: number, browserUrl: string) {
      // pending=false means history settled, not that route hooks committed.
      // Only release a cancelled Link still at its original observed source. A
      // successful history update must wait for observe(), including query-only moves.
      if (pending?.epoch !== intentEpoch || currentUrl !== intentSource || canonicalNavigationTarget(browserUrl) !== intentSource) return;
      pending = null;
      epoch += 1;
      publish();
    },
    finish(intentEpoch: number) {
      if (pending?.epoch !== intentEpoch) return;
      pending = null;
      epoch += 1;
      publish();
    },
    canCommit(sourcePath: string, sourceEpoch: number) {
      return sourceEpoch === epoch && !pending && sourcePath === currentPath;
    },
  };
}

export type NavigationIntentController = ReturnType<typeof createNavigationIntent>;
export const NavigationIntentContext = createContext<NavigationIntentController | null>(null);
const idleSubscribe = () => () => {};
const idleSnapshot = () => 0;

export function useNavigationIntentEpoch(controller: NavigationIntentController | null) {
  return useSyncExternalStore(controller?.subscribe ?? idleSubscribe, controller?.getSnapshot ?? idleSnapshot, controller?.getServerSnapshot ?? idleSnapshot);
}

/** Each render gives callbacks a lease; superseded delayed callbacks stay invalid. */
export function useNavigationQueryGuard(pathname: string) {
  const controller = useContext(NavigationIntentContext);
  const epoch = useNavigationIntentEpoch(controller);
  return {
    epoch,
    canCommit: () => (!controller || controller.canCommit(pathname, epoch))
      && (typeof window === 'undefined' || window.location.pathname === pathname),
  };
}
