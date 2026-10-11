/**
 * The collector's public surface. Everything reachable from here is
 * zod-free on purpose: this is the module the browser bundle imports, and
 * the beacon schema (`@accessible-so/monitor-core/protocol`) is a server-side
 * concern that must never ship to a page.
 */
export { startCollector, COLLECTOR_VERSION } from './collector';
export type { StartOptions, CollectorHandle } from './collector';
export type { CollectorAdapter } from './adapter';
export { ADAPTER_SLOT, resolveAdapter } from './adapter';
export type { AxeLike, AxeNodeLike, AxeViolationLike, AxeResultsLike } from './engine/axe-runner';
export { PAGE_LEVEL_RULES, ELEMENT_TAGS } from './engine/axe-runner';
export type {
  AttrValue,
  Confidence,
  Impact,
  NavigationMode,
  RedactedElement,
  RumBeacon,
  RumConfig,
  RumContext,
  RumFinding,
  TextMetrics,
} from './protocol/types';
export { PROTOCOL_VERSION } from './protocol/types';
