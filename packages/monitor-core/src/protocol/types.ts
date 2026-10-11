export type NavigationMode = 'keyboard-driven' | 'pointer-driven' | 'mixed' | 'unknown';
export type Confidence = 'rule' | 'heuristic';
export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
export type PageTier = 'fast' | 'medium' | 'slow';

export interface TextMetrics { length: number; words: number; knownBad: boolean }
export type AttrValue = string | true | { len: number; words: number } | { refs: number; resolved: number };
export interface RedactedElement {
  tag: string;
  attrs: Record<string, AttrValue>;
  text: TextMetrics | null;
  parent?: RedactedElement | null;     // depth 1, itself without parent/children
  children?: RedactedElement[];        // at most 2, each without parent/children
}
export interface RumContext { vw: number; vh: number; dpr: number; zoom: number; fontPx: number; navigationMode: NavigationMode }
export interface RumFinding {
  sig: string;                          // s1:<32 hex>
  key: string | null;                   // elementKeyOf(el): tag/role/type, attribute
                                        // names, class tokens, landmark path
  rule: string;                         // wcag:1.1.1 | axe:region | obs:spa-focus-loss
  confidence: Confidence;
  impact: Impact | null;
  wcag: string[];                       // canonical criteria, may be empty
  p: string;                            // path, no query/fragment
  r: string | null;                     // route pattern from adapter
  el: RedactedElement;
  comp: { id: string; source?: string } | null;
  n: number;                            // occurrences seen while this finding was still queued
  i: boolean;                           // user interacted with the element
}
export interface RumBeacon {
  v: 1; k: string; s: string; c: string; sent: number;
  ctx: RumContext;
  session?: { started: true };
  routes?: { p: string; r: string | null }[];
  findings?: RumFinding[];
  interactions?: { sig: string; r: string | null }[];
  perf?: {
    scans: number; longTasks: number; maxTaskMs: number; aborted: boolean;
    skipped?: string[];                 // rules deliberately not run on this page
    pending?: string[];                 // rules whose deferred pass has not run yet
    tier?: PageTier;                    // this page view's tier
    idleRuns?: number;                  // tasks run in idle windows
  };
}
export interface RumConfig {
  enabled: boolean; killSwitch: boolean; sampleRate: number;
  boosted: { pattern: string; rate: number }[];
  endpoint: string; minCollector: string;
}

export const PROTOCOL_VERSION = 1 as const;
