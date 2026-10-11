/**
 * Behavioral-only navigation mode inference. Watches how a session moves
 * focus (Tab / Shift+Tab / arrow-key presses immediately followed by a real
 * focus change) versus how it interacts with interactive elements via
 * pointer or touch, and classifies the session's mode from those counts
 * alone.
 *
 * Behavioral only. This never inspects user agent, media queries, timing, or
 * any signal about the person; it describes how this session drove the page.
 */
import type { NavigationMode } from '../protocol/types';

const KEY_FOCUS_WINDOW_MS = 200;
const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [role=button], [role=link], [tabindex]';
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export interface NavigationModeTrackerApi {
  mode(): NavigationMode;
  detach(): void;
}

export function NavigationModeTracker(target: EventTarget): NavigationModeTrackerApi {
  let keyboardMoves = 0;
  let pointerCount = 0;
  let lastKeyNavAt: number | null = null;
  let lastFocused: EventTarget | null = null;

  function onKeydown(e: Event): void {
    if (NAV_KEYS.has((e as KeyboardEvent).key)) lastKeyNavAt = Date.now();
  }

  function onFocusin(e: Event): void {
    const t = e.target;
    if (lastKeyNavAt !== null && Date.now() - lastKeyNavAt <= KEY_FOCUS_WINDOW_MS && t !== lastFocused) {
      keyboardMoves++;
      lastKeyNavAt = null;
    }
    lastFocused = t;
  }

  function onPointer(e: Event): void {
    const t = e.target;
    if (t instanceof Element && t.closest(INTERACTIVE_SELECTOR)) pointerCount++;
  }

  target.addEventListener('keydown', onKeydown, true);
  target.addEventListener('focusin', onFocusin, true);
  target.addEventListener('pointerdown', onPointer, true);
  target.addEventListener('touchstart', onPointer, true);

  return {
    mode(): NavigationMode {
      if (keyboardMoves >= 5 && pointerCount === 0) return 'keyboard-driven';
      if (pointerCount > 0 && keyboardMoves < 2) return 'pointer-driven';
      if (pointerCount > 0 && keyboardMoves >= 2) return 'mixed';
      return 'unknown';
    },
    detach(): void {
      target.removeEventListener('keydown', onKeydown, true);
      target.removeEventListener('focusin', onFocusin, true);
      target.removeEventListener('pointerdown', onPointer, true);
      target.removeEventListener('touchstart', onPointer, true);
    },
  };
}
