import { ADAPTER_SLOT, type CollectorAdapter } from '@accessible-so/monitor-core';
import type { RouteMap } from './route-pattern';

export function createNextAdapter(map: RouteMap): CollectorAdapter {
  return { attribution: { routePattern: (path) => map.get(path) } };
}

/** Publish the adapter where the engine looks for it (see monitor-core ADAPTER_SLOT). */
export function registerAdapter(adapter: CollectorAdapter): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>)[ADAPTER_SLOT] = adapter;
}
