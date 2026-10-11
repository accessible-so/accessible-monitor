/**
 * "Rage tabbing" — four or more Tab presses in a tight burst with focus
 * never actually moving — usually means the user is stuck: the next
 * focusable element is invisible, off-screen, or focus is being silently
 * suppressed. A single dead Tab press is normal; a sustained burst with no
 * focus change is not.
 */
import { isWithinWindow, KEY_FOCUS_WINDOW_MS, TAB_KEY } from './keyboard-window';
import type { FindingEmitter, ObserverApi } from './types';

const TAB_WINDOW = 4;
const BURST_MS = 2000;

interface Tap {
  at: number;
  moved: boolean;
}

export function attachRageTab(doc: Document, win: Window, onFinding: FindingEmitter): ObserverApi {
  const emitted = new WeakSet<Element>();
  let taps: Tap[] = [];
  let current: Tap | null = null;
  let preTarget: EventTarget | null = null;

  function evaluate(): void {
    try {
      if (taps.length < TAB_WINDOW) return;
      const first = taps[0];
      const last = taps[taps.length - 1];
      if (!first || !last) return;
      const allStill = taps.every((t) => !t.moved);
      if (last.at - first.at <= BURST_MS && allStill) {
        const element = doc.activeElement ?? doc.body;
        taps = [];
        if (emitted.has(element)) return;
        emitted.add(element);
        onFinding({ observer: 'rage-tab', wcag: '2.1.1', impact: 'serious', element });
      }
    } catch {
      // never break the page over a diagnostic check
    }
  }

  function onKeydown(e: Event): void {
    try {
      if ((e as KeyboardEvent).key !== TAB_KEY) return;
      preTarget = doc.activeElement;
      const tap: Tap = { at: Date.now(), moved: false };
      current = tap;
      taps.push(tap);
      if (taps.length > TAB_WINDOW) taps.shift();
      win.setTimeout(evaluate, KEY_FOCUS_WINDOW_MS);
    } catch {
      // ignore
    }
  }

  function onFocusin(e: Event): void {
    try {
      if (!current) return;
      if (isWithinWindow(current.at) && e.target !== preTarget) {
        current.moved = true;
      }
    } catch {
      // ignore
    }
  }

  doc.addEventListener('keydown', onKeydown, { passive: true, capture: true });
  doc.addEventListener('focusin', onFocusin, { passive: true, capture: true });

  return {
    detach(): void {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('focusin', onFocusin, true);
    },
  };
}
