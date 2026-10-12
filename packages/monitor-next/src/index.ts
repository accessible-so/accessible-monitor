/**
 * The Next.js adapter's public surface: route-pattern logic, the adapter
 * factory, and the two client components that wire them into a Next app.
 * `withAccessible` (the `next.config` helper) is deliberately not
 * re-exported here — it is Node-only and lives at the `@accessible-so/monitor-next/config`
 * entry so importing it never pulls React into a config file.
 */
export { routePatternFor, RouteMap } from './route-pattern';
export { createNextAdapter, registerAdapter } from './adapter';
export type { CollectorAdapter } from '@accessible-so/monitor-core';
export { AccessibleMonitor, DEFAULT_ENDPOINT, DEFAULT_LOADER_SRC, type AccessibleMonitorProps } from './monitor';
export { AccessibleMonitorPages } from './monitor-pages';
