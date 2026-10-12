'use client';
import { useEffect, useRef } from 'react';
import Script from 'next/script';
import { useRouter } from 'next/router';
import type { CollectorAdapter } from '@accessible-so/monitor-core';
import { createNextAdapter, registerAdapter } from './adapter';
import { basePrefix, pathKey, pathOnly } from './path-key';
import { RouteMap } from './route-pattern';
import { loaderAttributes, type AccessibleMonitorProps } from './monitor';

/**
 * Pages Router counterpart to `AccessibleMonitor`. Render once in `_app`.
 * The Pages Router hands us the pattern directly — `router.pathname` *is* the
 * route pattern (e.g. `/products/[slug]`) — so there is no segment-matching to
 * do; `router.asPath` is the concrete app-relative path, minus its query string
 * and hash, and `path-key.ts` reconciles that with the browser's path.
 *
 * Renders the loader either way. `useRouter()` from `next/router` returns null
 * outside a Pages Router context — this component pasted into an App Router
 * app — and reading `.pathname` off that would throw into the host's render.
 * There, the loader still loads and findings simply carry no route pattern.
 */
export function AccessibleMonitorPages(props: AccessibleMonitorProps) {
  const router = useRouter() as { pathname: string; asPath: string } | null;
  const map = useRef<RouteMap | null>(null);
  const adapter = useRef<CollectorAdapter | null>(null);
  const prefix = useRef<string | null>(null);

  if (typeof window !== 'undefined' && router) {
    // Synchronous, during render: see AccessibleMonitor.
    const appPath = pathOnly(router.asPath);
    const m = (map.current ??= new RouteMap());
    prefix.current ??= basePrefix(window.location.pathname, appPath);
    m.set(pathKey(prefix.current, appPath), router.pathname);
    registerAdapter((adapter.current ??= createNextAdapter(m)));
  }

  useEffect(() => {
    if (!router) return;
    const m = (map.current ??= new RouteMap());
    m.set(window.location.pathname, router.pathname);
  });

  return (
    <Script {...loaderAttributes(props)} strategy="afterInteractive" />
  );
}
