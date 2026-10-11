/**
 * The framework adapter contract.
 *
 * A framework package (Next.js, Remix, …) supplies only what it alone knows:
 * how a concrete path maps to a route *pattern*, which component owns an
 * element, and where its own endpoints live. Everything else — sampling,
 * scanning, redaction, transport — stays in the core so every adapter sends
 * the same beacon. Every hook is optional and every hook may return null;
 * the collector falls back to the `data-a11y-*` build stamps and a null route
 * pattern.
 */
export interface CollectorAdapter {
  attribution?: {
    /** The route pattern for a concrete path, e.g. `/blog/[slug]`. */
    routePattern?(path: string): string | null;
    /** The component that owns an element, when the framework can tell. */
    componentOf?(el: Element): { id: string; source?: string } | null;
  };
  transport?: {
    endpoint?: string;
    configEndpoint?: string;
  };
}

/** Where a framework component registers its adapter when the loader, not the app, starts the engine. */
export const ADAPTER_SLOT = '__accessibleAdapter' as const;

/**
 * The adapter in force right now. The explicit start option wins; otherwise
 * the window slot, read on every call so a component that mounts after the
 * engine started still counts. Never throws: a slot holding garbage is the
 * same as no adapter.
 */
export function resolveAdapter(explicit: CollectorAdapter | undefined, win: Window): CollectorAdapter | null {
  if (explicit) return explicit;
  try {
    const slot = (win as unknown as Record<string, unknown>)[ADAPTER_SLOT];
    return slot && typeof slot === 'object' ? (slot as CollectorAdapter) : null;
  } catch {
    return null;
  }
}
