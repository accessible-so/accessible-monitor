'use client';
import { useEffect, useRef } from 'react';
import Script from 'next/script';
import { useParams, usePathname } from 'next/navigation';
import type { CollectorAdapter } from '@accessible-so/monitor-core';
import { createNextAdapter, registerAdapter } from './adapter';
import { basePrefix, pathKey } from './path-key';
import { RouteMap, routePatternFor } from './route-pattern';

export const DEFAULT_ENDPOINT = 'https://app.accessible.so';
export const DEFAULT_LOADER_SRC = 'https://accessible.so/a11y/loader.js';

export interface AccessibleMonitorProps {
  siteKey: string;
  /** Where config is read and beacons are sent. Defaults to Accessible's app. */
  endpoint?: string;
  /**
   * The loader's URL, to self-host it (the engine is read from `engine.js` next
   * to it). Defaults to Accessible's copy, or `<endpoint>/a11y/loader.js` when
   * `endpoint` is set.
   */
  src?: string;
}

/** The loader tag's attributes; `data-endpoint` only when it is not the loader's own default. */
export function loaderAttributes({ siteKey, endpoint = DEFAULT_ENDPOINT, src }: AccessibleMonitorProps) {
  const custom = endpoint !== DEFAULT_ENDPOINT;
  return {
    src: src ?? (custom ? `${endpoint}/a11y/loader.js` : DEFAULT_LOADER_SRC),
    'data-site-key': siteKey,
    ...(custom ? { 'data-endpoint': endpoint } : {}),
  };
}

/**
 * App Router. Render once in the root layout. Registers the Next adapter on the
 * window slot before the loader script runs, then keeps the path→pattern map
 * current on every navigation. The loader decides sampling; this component
 * never starts the engine itself.
 *
 * The map is keyed on the browser's path — what the collector core passes to
 * `routePattern()` — rather than on `usePathname()`, which has `basePath` and
 * any i18n locale prefix already stripped off it. See `path-key.ts` for how the
 * two are reconciled. The *pattern* stays the app route (`/products/[slug]`,
 * never `/x/products/[slug]`): that is what the app's own file tree calls it,
 * and what aggregates should group by.
 */
export function AccessibleMonitor(props: AccessibleMonitorProps) {
  const pathname = usePathname();
  const params = useParams() as Record<string, string | string[]> | null;
  const map = useRef<RouteMap | null>(null);
  const adapter = useRef<CollectorAdapter | null>(null);
  const prefix = useRef<string | null>(null);
  const pattern = routePatternFor(pathname, params);

  if (typeof window !== 'undefined') {
    // During render, on purpose. The slot has to be filled before the loader
    // tag below can inject the engine — `next/script` injects from its own
    // effect, which React flushes before its parent's — and the map has to hold
    // the new page before the URL changes, because the collector records its
    // `routes[]` entry the instant it sees the navigation, which is after this
    // render and before any effect of ours. Assignment is idempotent and the
    // core re-reads the slot on every lookup, so repeating this per render is
    // free of consequence.
    const m = (map.current ??= new RouteMap());
    prefix.current ??= basePrefix(window.location.pathname, pathname);
    m.set(pathKey(prefix.current, pathname), pattern);
    registerAdapter((adapter.current ??= createNextAdapter(m)));
  }

  // And again after the commit, with the URL the browser actually settled on.
  // The render-time key is a prediction from a prefix measured once; this is
  // the fact. They agree on every app that has no basePath at all.
  useEffect(() => {
    const m = (map.current ??= new RouteMap());
    m.set(window.location.pathname, pattern);
  });

  return (
    <Script {...loaderAttributes(props)} strategy="afterInteractive" />
  );
}
