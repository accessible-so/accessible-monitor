/**
 * Shared timing convention: "a key-nav press, then a real focus change
 * within 200ms" is what ../session/navigation-mode.ts calls a
 * keyboard-driven focus move. The observers below (rage-tab, focus-trap,
 * focus-visible) reuse the same 200ms window and Date.now() convention
 * without importing that tracker, since each needs its own bookkeeping.
 */
export const KEY_FOCUS_WINDOW_MS = 200;
export const TAB_KEY = 'Tab';

export function isWithinWindow(markedAt: number | null, windowMs = KEY_FOCUS_WINDOW_MS): boolean {
  return markedAt !== null && Date.now() - markedAt <= windowMs;
}
