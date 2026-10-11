/**
 * SPA route changes routinely leave focus stranded on <body> because the
 * framework swaps content without ever calling .focus() on anything. That
 * is invisible to axe (a snapshot scan sees a valid, unfocused body) but a
 * screen-reader user is dropped back at the top of an unannounced document.
 * We patch history.pushState/replaceState and listen for popstate, then
 * check where focus landed two animation frames after the transition so
 * frameworks have had a paint cycle to move it themselves.
 */
import type { FindingEmitter, ObserverApi } from './types';

type HistoryMethod = 'pushState' | 'replaceState';

export function attachSpaFocusLoss(
  doc: Document,
  win: Window,
  onFinding: FindingEmitter,
  onRouteChange: (path: string) => void,
): ObserverApi {
  const emitted = new WeakSet<Element>();
  const original: Record<HistoryMethod, History[HistoryMethod]> = {
    pushState: win.history.pushState.bind(win.history),
    replaceState: win.history.replaceState.bind(win.history),
  };
  const patched: Partial<Record<HistoryMethod, History[HistoryMethod]>> = {};
  // `restore` deliberately leaves a later wrapper installed rather than
  // clobbering it (see below) — and that wrapper calls through to ours, so
  // after `detach` our patch can still be invoked. This flag is what makes
  // that call do nothing: a detached observer reports nothing, ever.
  let detached = false;

  function check(): void {
    // Two animation frames after a transition, which may be after `detach`.
    if (detached) return;
    try {
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== doc.documentElement) return;
      const element = doc.querySelector('main') ?? doc.body;
      if (emitted.has(element)) return;
      emitted.add(element);
      onFinding({ observer: 'spa-focus-loss', wcag: '2.4.3', impact: 'serious', element });
    } catch {
      // Never let a diagnostic observer break navigation.
    }
  }

  function afterTransition(): void {
    if (detached) return;
    try {
      onRouteChange(win.location.pathname);
    } catch {
      // ignore
    }
    try {
      win.requestAnimationFrame(() => win.requestAnimationFrame(check));
    } catch {
      // ignore
    }
  }

  function patch(method: HistoryMethod): void {
    const fn = function patchedHistoryMethod(this: History, ...args: Parameters<History[HistoryMethod]>) {
      const result = (original[method] as (...a: Parameters<History[HistoryMethod]>) => unknown).apply(this, args);
      afterTransition();
      return result;
    } as History[HistoryMethod];
    patched[method] = fn;
    win.history[method] = fn;
  }

  patch('pushState');
  patch('replaceState');
  win.addEventListener('popstate', afterTransition, { passive: true });

  function restore(method: HistoryMethod): void {
    // Another script may have wrapped history[method] again after us (e.g.
    // a router). Only undo our own patch — if we are no longer the current
    // value, leave whatever is installed now alone rather than clobbering
    // a later wrapper that calls through to ours.
    if (win.history[method] === patched[method]) {
      win.history[method] = original[method];
    }
  }

  return {
    detach(): void {
      detached = true;
      restore('pushState');
      restore('replaceState');
      win.removeEventListener('popstate', afterTransition);
    },
  };
}
