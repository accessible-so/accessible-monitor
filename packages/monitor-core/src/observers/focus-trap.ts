/**
 * A focus trap: eight consecutive Tab-driven focus moves that never leave a
 * small cluster of three or fewer elements. That is the signature of a
 * dialog or widget whose tabindex loop forgot an exit, keeping a keyboard
 * user circling forever. Escape is the conventional way out, so an Escape
 * press resets the window — the user may be about to leave the trap on
 * their own.
 */
import { isWithinWindow, KEY_FOCUS_WINDOW_MS, TAB_KEY } from './keyboard-window';
import type { FindingEmitter, ObserverApi } from './types';

const WINDOW_SIZE = 8;
const MAX_DISTINCT = 3;

function ancestorsOf(el: Element): Element[] {
  const chain: Element[] = [];
  let node: Element | null = el;
  while (node) {
    chain.push(node);
    node = node.parentElement;
  }
  return chain;
}

export function commonAncestor(els: Element[]): Element {
  const [head, ...rest] = els;
  if (!head) throw new Error('commonAncestor: no elements given');
  let chain = ancestorsOf(head);
  for (const el of rest) {
    const otherSet = new Set(ancestorsOf(el));
    chain = chain.filter((n) => otherSet.has(n));
  }
  return chain[0] ?? head;
}

export function attachFocusTrap(doc: Document, win: Window, onFinding: FindingEmitter): ObserverApi {
  const emittedFor = new WeakSet<Element>();
  let targets: Element[] = [];
  let lastTabAt: number | null = null;

  function reset(): void {
    targets = [];
  }

  function evaluate(): void {
    try {
      if (targets.length < WINDOW_SIZE) return;
      const distinct = Array.from(new Set(targets));
      if (distinct.length <= MAX_DISTINCT) {
        const ancestor = commonAncestor(distinct);
        reset();
        if (emittedFor.has(ancestor)) return;
        emittedFor.add(ancestor);
        onFinding({ observer: 'focus-trap', wcag: '2.1.2', impact: 'critical', element: ancestor });
      } else {
        targets.shift();
      }
    } catch {
      // never break the page over a diagnostic check
    }
  }

  function onKeydown(e: Event): void {
    try {
      const key = (e as KeyboardEvent).key;
      if (key === 'Escape') {
        reset();
        return;
      }
      if (key !== TAB_KEY) return;
      lastTabAt = Date.now();
    } catch {
      // ignore
    }
  }

  function onFocusin(e: Event): void {
    try {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!isWithinWindow(lastTabAt, KEY_FOCUS_WINDOW_MS)) return;
      lastTabAt = null;
      targets.push(target);
      if (targets.length > WINDOW_SIZE) targets.shift();
      evaluate();
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
