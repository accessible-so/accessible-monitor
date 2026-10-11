/**
 * Dirty-region tracking. A `MutationObserver` watches the structural and
 * state-carrying attribute changes that can create or clear a barrier, then
 * a debounce collapses a burst of them into the smallest set of roots worth
 * re-scanning. Nothing here reads text or values — only which element
 * changed.
 */

const WATCHED_ATTRS = [
  'class', 'role', 'aria-hidden', 'aria-expanded', 'hidden',
  'tabindex', 'aria-invalid', 'aria-describedby',
];

export interface DirtyTrackerOptions {
  debounceMs?: number;
  cap?: number;
}

export interface DirtyTrackerApi {
  detach(): void;
}

function isOurs(node: Node | null): boolean {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || el.hasAttribute('data-a11y-collector')) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Drops roots that are detached or already covered by another root, and
 * collapses an over-wide batch (more roots than `cap`) into one fallback
 * root — re-scanning one larger subtree beats scanning twenty small ones.
 *
 * Both steps are O(n) lookups against a `Set`, not O(n²) scans of a list: a
 * page that mutates thousands of distinct elements in one debounce window is
 * exactly the page that can least afford the collector spending milliseconds
 * deciding what to do about it. Coverage is decided by walking each root's
 * ancestors — at most the depth of the document — rather than by asking every
 * other root whether it contains this one.
 */
export function coalesceRoots(roots: Element[], cap: number, fallback: Element): Element[] {
  const connected = new Set<Element>();
  const ordered: Element[] = [];
  for (const root of roots) {
    if (!root || !root.isConnected || connected.has(root)) continue;
    connected.add(root);
    ordered.push(root);
  }
  const kept: Element[] = [];
  for (const root of ordered) {
    let covered = false;
    for (let node = root.parentElement; node; node = node.parentElement) {
      if (connected.has(node)) { covered = true; break; }
    }
    if (!covered) kept.push(root);
  }
  if (kept.length === 0) return [];
  if (kept.length > cap) return [fallback];
  return kept;
}

export function DirtyTracker(
  doc: Document,
  onDirty: (roots: Element[]) => void,
  options: DirtyTrackerOptions = {},
): DirtyTrackerApi {
  const debounceMs = options.debounceMs ?? 500;
  const cap = options.cap ?? 20;
  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const Observer = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;

  // Past this many distinct roots in one window the answer is already the
  // fallback root — `coalesceRoots` collapses anything over `cap` — so there is
  // nothing to learn from the rest of the batch and no reason to hold it.
  const maxRoots = cap * 10;

  let pending: Element[] = [];
  const pendingSet = new Set<Element>();
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearPending(): void {
    pending = [];
    pendingSet.clear();
    overflow = false;
  }

  function fire(): void {
    timer = null;
    const roots = pending;
    const overflowed = overflow;
    clearPending();
    if (stopped || roots.length === 0) return;
    try {
      const fallback = doc.querySelector('main') ?? doc.body;
      if (!fallback) return;
      const coalesced = overflowed ? [fallback] : coalesceRoots(roots, cap, fallback);
      if (coalesced.length > 0) onDirty(coalesced);
    } catch {
      // A dirty batch that cannot be computed is dropped, never thrown.
    }
  }

  let observer: MutationObserver | null = null;
  if (Observer && doc.body) {
    try {
      observer = new Observer((records) => {
        try {
          for (const record of records) {
            const target = record.target;
            if (!(target instanceof Element) || isOurs(target)) continue;
            if (pendingSet.has(target)) continue;
            if (pending.length >= maxRoots) { overflow = true; break; }
            pendingSet.add(target);
            pending.push(target);
          }
          if (pending.length > 0 && timer === null) timer = setTimeout(fire, debounceMs);
        } catch {
          // Never throw into the host's mutation callback.
        }
      });
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: WATCHED_ATTRS,
      });
    } catch {
      observer = null;
    }
  }

  return {
    detach(): void {
      stopped = true;
      clearPending();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      try { observer?.disconnect(); } catch { /* already gone */ }
    },
  };
}
