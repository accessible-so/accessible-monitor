/**
 * A focused element with no visible focus indicator is invisible to axe
 * (the DOM state is valid; it's the rendered outline that's missing) but
 * strands a sighted keyboard user with no idea where they are. We look at
 * the same 200ms "was this focus a keyboard move" window used elsewhere,
 * then read the computed style. jsdom returns empty strings for every one
 * of these properties, so the observer itself is inert in tests — Task 6
 * exercises it in a real browser. `decideFocusVisible` is the pure
 * decision and is what Step 1 actually tests here.
 */
import { isWithinWindow, KEY_FOCUS_WINDOW_MS } from './keyboard-window';
import type { FindingEmitter, ObserverApi } from './types';

const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export interface FocusVisibleInput {
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
  borderChanged: boolean;
}

export function decideFocusVisible(input: FocusVisibleInput): boolean {
  const outlineStyle = input.outlineStyle || 'none';
  const boxShadow = input.boxShadow || 'none';
  if (outlineStyle === 'auto') return true;
  if (outlineStyle !== 'none' && parseFloat(input.outlineWidth) > 0) return true;
  if (boxShadow !== 'none') return true;
  return input.borderChanged;
}

function borderKey(cs: CSSStyleDeclaration): string {
  return `${cs.borderStyle}|${cs.borderWidth}|${cs.borderColor}`;
}

export function attachFocusVisible(doc: Document, win: Window, onFinding: FindingEmitter): ObserverApi {
  const emitted = new WeakSet<Element>();
  const lastBorder = new WeakMap<Element, string>();
  let lastKeyAt: number | null = null;

  function onKeydown(e: Event): void {
    try {
      if (NAV_KEYS.has((e as KeyboardEvent).key)) lastKeyAt = Date.now();
    } catch {
      // ignore
    }
  }

  function onFocusout(e: Event): void {
    try {
      const el = e.target;
      if (!(el instanceof Element)) return;
      const view = doc.defaultView ?? win;
      lastBorder.set(el, borderKey(view.getComputedStyle(el)));
    } catch {
      // ignore
    }
  }

  function onFocusin(e: Event): void {
    try {
      const el = e.target;
      if (!(el instanceof Element)) return;
      if (el.getAttribute('tabindex') === '-1') return;
      if (!isWithinWindow(lastKeyAt, KEY_FOCUS_WINDOW_MS)) return;
      lastKeyAt = null;
      if (emitted.has(el)) return;

      const view = doc.defaultView ?? win;
      const cs = view.getComputedStyle(el);
      const prevBorder = lastBorder.get(el);
      const borderChanged = prevBorder !== undefined && prevBorder !== borderKey(cs);
      const visible = decideFocusVisible({
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
        borderChanged,
      });
      if (!visible) {
        emitted.add(el);
        onFinding({ observer: 'focus-not-visible', wcag: '2.4.7', impact: 'serious', element: el });
      }
    } catch {
      // never break the page over a diagnostic check
    }
  }

  doc.addEventListener('keydown', onKeydown, { passive: true, capture: true });
  doc.addEventListener('focusout', onFocusout, { passive: true, capture: true });
  doc.addEventListener('focusin', onFocusin, { passive: true, capture: true });

  return {
    detach(): void {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('focusout', onFocusout, true);
      doc.removeEventListener('focusin', onFocusin, true);
    },
  };
}
