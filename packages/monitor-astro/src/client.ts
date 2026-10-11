import { ADAPTER_SLOT, type CollectorAdapter } from '@accessible-so/monitor-core';

/**
 * One page route from Astro's route table, as the integration serialises it
 * into the page bundle: the pattern to report (`/products/[slug]`) and the
 * regex Astro itself matches a URL with, split into source and flags because
 * a RegExp does not survive JSON.
 */
export interface SerializedRoute {
  pattern: string;
  source: string;
  flags: string;
}

interface CompiledRoute {
  pattern: string;
  re: RegExp;
}

/**
 * The adapter: route-pattern attribution and nothing else. Astro renders to
 * plain HTML, so there is no component to attribute an element to.
 *
 * Routes are tried in the order given, which is Astro's own match priority
 * (the integration keeps it), so `/products/featured` wins over
 * `/products/[slug]` exactly as Astro's router decides it.
 *
 * `base` is stripped before matching because Astro's route regexes do not
 * include it, while the collector passes the browser's full path. A path
 * outside `base`, or one no route matches, reports no pattern: absent is
 * better than wrong.
 */
export function createAstroAdapter(routes: readonly SerializedRoute[], base: string): CollectorAdapter {
  const compiled: CompiledRoute[] = [];
  for (const r of routes) {
    try {
      compiled.push({ pattern: r.pattern, re: new RegExp(r.source, r.flags) });
    } catch {
      // A regex this engine cannot compile is a route we cannot attribute.
    }
  }
  const prefix = base.replace(/\/+$/, '');

  return {
    attribution: {
      routePattern(path: string): string | null {
        let p = path;
        if (prefix) {
          if (p !== prefix && !p.startsWith(`${prefix}/`)) return null;
          p = p.slice(prefix.length) || '/';
        }
        for (const r of compiled) if (r.re.test(p)) return r.pattern;
        return null;
      },
    },
  };
}

/** Called by the generated module on every page. Idempotent: the core re-reads the slot on every lookup. */
export function registerRoutes(routes: readonly SerializedRoute[], base: string): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>)[ADAPTER_SLOT] = createAstroAdapter(routes, base);
}
