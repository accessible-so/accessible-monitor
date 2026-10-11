# The beacon protocol (v1)

This is the whole wire format. There is nothing else — no second channel, no
follow-up request, no cookie. If a field is not in this document, the collector
does not send it.

The types below are the frozen contract, copied from
[`packages/monitor-core/src/protocol/types.ts`](../packages/monitor-core/src/protocol/types.ts).
A zod mirror of them lives at `@accessible-so/monitor-core/protocol` and is what
the server validates against on ingest, so the two sides cannot drift.

```ts
export type NavigationMode = 'keyboard-driven' | 'pointer-driven' | 'mixed' | 'unknown';
export type Confidence = 'rule' | 'heuristic';
export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

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
  };
}

export interface RumConfig {
  enabled: boolean; killSwitch: boolean; sampleRate: number;
  boosted: { pattern: string; rate: number }[];
  endpoint: string; minCollector: string;
}
```

---

## Envelope

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | Protocol version. Field names are frozen at this version. |
| `k` | `string` | The **public** site key from `data-site-key`. It is not a secret; it identifies which site the beacon belongs to and nothing else. |
| `s` | `string` | Session id: 16 random bytes, hex. Generated in the page, stored in `sessionStorage`, used only to deduplicate within one session and to count sessions per day. It is not a user id, is not persisted beyond the tab, and is never correlated across tabs, visits, or sites. |
| `c` | `string` | Collector version (`"0.2.1"`), so the server can tell which redaction policy produced the payload. |
| `sent` | `number` | `Date.now()` at flush. |
| `ctx` | `RumContext` | Below. |

## `ctx`

| Field | Type | Notes |
|---|---|---|
| `vw`, `vh` | `number` | `innerWidth` / `innerHeight`. Viewport size, not screen size. |
| `dpr` | `number` | `devicePixelRatio`. |
| `zoom` | `number` | `visualViewport.scale`, defaulting to 1. |
| `fontPx` | `number` | Computed `font-size` of `<html>` in px — the visitor's browser font-size setting, which matters for 1.4.4 and 1.4.12. |
| `navigationMode` | `NavigationMode` | Behavioural only. See [methodology §1](./methodology.md#1-navigation-mode). This is **not** assistive-technology detection and must never be read as one. |

## Optional sections

Each is present only when it has something to say. A beacon with nothing new to
report is not sent at all.

| Field | When | Notes |
|---|---|---|
| `session` | Once per session | `{ started: true }`. Marks the first beacon of a session so daily session counts do not need to guess. |
| `routes` | Once per `(path, pattern)` per session | Tells the server this route exists and was visited. `p` is a path only; `r` is `null` unless a framework adapter supplied a pattern. |
| `findings` | New barriers | At most 200 per beacon; a batch over 60KB is trimmed to a prefix that fits and the rest waits for the next flush. |
| `interactions` | The visitor touched an element whose barrier was already reported | `{ sig, r }`. Nothing about what they did — only that the element mattered to somebody. |
| `perf` | Always | The page's scan statistics, on **every** beacon. |

## `findings[]`

| Field | Type | Notes |
|---|---|---|
| `sig` | `s1:<32 hex>` | The barrier signature: one identity for one defect, the same whether a static scan, a journey test, or a real session found it. Computed from structure only. |
| `key` | `string \| null` | The element key: `{ v, e, l, c }` as JSON, where `e` is itself the JSON tuple `[tag, role, type, allowlisted attribute *names*, normalised class tokens]`, `l` is the landmark path (`["main#1-3", "ul"]`), and `c` is the `data-a11y-component` id or `null`. It lets a tier that learns the rule later recompute the same `sig`. **It is not opaque** — it carries structure, and structure is what a class token is. It carries no text, no attribute *values* beyond `role` and `type`, and no URLs, and the ingest schema parses it and rejects anything that is not this shape. |
| `rule` | `string` | `wcag:<criterion>` when the finding maps to a success criterion, `axe:<ruleId>` for best-practice rules that fail no criterion, `obs:<observerId>` for the behavioural observers. |
| `confidence` | `'rule' \| 'heuristic'` | `rule` for axe findings, `heuristic` for the four behavioural observers. A heuristic is never reported as a rule. |
| `impact` | `Impact \| null` | axe's impact, or the observer's, passed through unchanged. |
| `wcag` | `string[]` | Canonical criteria (`"1.1.1"`). May be empty for best-practice rules. |
| `p` | `string` | `location.pathname`. Never contains `?` or `#`. |
| `r` | `string \| null` | Route pattern (`/products/[slug]`). **Always `null` for a script-tag install** — only a framework adapter can know it. |
| `el` | `RedactedElement` | The redacted element, one parent, up to two children. See [methodology §2](./methodology.md#2-redaction). |
| `comp` | `{ id, source? } \| null` | From `data-a11y-component` / `data-a11y-source`, or from an adapter. A component name and a source path — code identifiers, not user data. |
| `n` | `number` | Occurrences observed **while the finding was still queued in this pageview**. Eight identical broken cards found by one scan are one finding with `n: 8`. It is not a session-wide or route-wide total: once the beacon carrying the finding has been flushed, later occurrences of the same signature raise nothing — the barrier has already been reported and the transport has let go of it. Treat `n` as "at least this many", never as a count. |
| `i` | `boolean` | The visitor clicked or keyed into this element. This is what separates "a barrier exists" from "a barrier is in someone's way". |

## `perf`

| Field | Type | Notes |
|---|---|---|
| `scans` | `number` | Idle-callback scan jobs run on this page. |
| `longTasks` | `number` | Scan jobs that exceeded the 50ms budget, including work done after the tab hid (the document-cost run, a finished queue). At most one of them happened while the visitor was looking. |
| `maxTaskMs` | `number` | The longest single scan job. |
| `aborted` | `boolean` | `true` while the engine has stopped scanning early: parked after a task over the 50ms budget while the visitor was looking (cleared on a later beacon if the rest is finished when the tab hides), 200 scans, 50,000 elements covered, or queued work dropped because the page unloaded. **An aborted page is unmeasured, not clean.** |
| `pending` | `string[]` (optional) | Rules whose pass has been **postponed and has not happened yet** — the document-cost set on a mid-size page, waiting for the tab to hide. Present on every beacon sent while the pass is still waiting. **A rule listed here has not been checked yet**; it is not a skipped rule and not a clean one. At most 16 ids of at most 64 characters. |
| `skipped` | `string[]` (optional) | Rules the engine did not run, for cost — the document-cost set on a page too large to afford it, or a pass that was deferred to the tab-hidden moment and never got one (the page unloaded instead). At most four ids, and a rule leaves the list if a later pass on the same page does run it. **A rule listed here was not checked; its absence from `findings` says nothing.** See [methodology §4.1](./methodology.md#41-contrast-on-large-pages). |

`skipped` and `pending` are disjoint: a rule is in at most one of them. It moves
from `pending` to `skipped` when the pass is given up on, and leaves both when
the pass runs, so a beacon sent after a completed pass carries neither.

On a mid-size page the deferred pass's findings arrive as a **second beacon**
sent immediately after the first, so a single beacon is not the whole visit: the
first says `pending`, the second says nothing. A tab that is never hidden and
never unloaded leaves `pending` unresolved — visible, but still not an answer.

`skipped` and `pending` are the two additions made to this contract after it was
first written,
and it was made because the alternative was worse: without it, a page whose
contrast rules were too expensive to run would have looked like a page with no
contrast problems. It is bounded at 16 entries of at most 64 characters. The
contract is otherwise frozen at `v: 1`.

---

## Config (`GET /api/rum/config?k=<site key>`)

Fetched by the loader on every pageview of a sampled session, and once for an
unsampled one. `credentials: 'omit'` — no cookies are sent.

| Field | Type | Notes |
|---|---|---|
| `enabled` | `boolean` | `false` stops everything before the engine is injected. |
| `killSwitch` | `boolean` | Same effect, separate flag, so a site owner can stop collection without changing their configuration. |
| `sampleRate` | `number` | 0–1. The decision is made once per session and is sticky. |
| `boosted` | `{ pattern, rate }[]` | Per-route-pattern rates that may **raise** the base rate for matching paths. |
| `endpoint` | `string` | Where beacons go. |
| `minCollector` | `string` | The oldest collector version the server will accept. |

## Ingest (`POST /api/rum/ingest`)

One `RumBeacon` as JSON, sent with `navigator.sendBeacon` (a `Blob`) and falling
back to `fetch(..., { keepalive: true, credentials: 'omit' })`. The response is
`204` and its body is ignored.

**The body is JSON; the `Content-Type` is not, and a receiver must not trust it.**
The `sendBeacon` Blob declares `text/plain;charset=UTF-8`, and the `fetch`
fallback declares `application/json`. The `text/plain` is deliberate and it is
what makes cross-origin collection work at all: `sendBeacon` sends with
credentials mode "include", and a request whose content type is not
CORS-safelisted is preflighted and CORS-checked — which an endpoint answering a
wildcard `Access-Control-Allow-Origin` fails, silently, *after* `sendBeacon` has
returned `true`. A safelisted type makes the beacon a "no-cors" simple request:
no preflight, no response check, no dependency on the ingest host's header
policy. Every site that installs the collector is cross-origin to the ingest
host by definition, so this is the ordinary case, not an edge one.

An ingest implementation therefore parses the body as JSON regardless of the
declared type, and needs no CORS response headers for beacons to arrive.

There is no retry beyond one. A beacon that cannot be delivered is dropped
silently — nothing is logged to the host's console unless `?a11y_debug=1` is set.
