/**
 * Beacon transport. Queues findings, routes, interactions, and perf stats,
 * then flushes them as one `RumBeacon` — on an explicit `flush(reason)`, once
 * 50 findings are queued, or every 15s while something is waiting. A beacon
 * over the byte budget is trimmed to a prefix of findings that fits (order
 * preserved) and the remainder stays queued for the next flush. `send` never
 * throws out of this module and a failed send is retried exactly once before
 * the batch is dropped.
 */
import type { RumBeacon, RumContext, RumFinding } from '../protocol/types';

type Perf = NonNullable<RumBeacon['perf']>;
type Route = { p: string; r: string | null };
type Interaction = { sig: string; r: string | null };
type SendFn = (url: string, body: string) => boolean;

export interface TransportOptions {
  endpoint: string;
  siteKey: string;
  sessionId: string;
  version: string;
  ctx: () => RumContext;
  /**
   * Perf supplier, read when each beacon is built. Every beacon carries the
   * page's scan stats — including the interval and batch-full flushes the
   * caller never sees — so the server can tell a clean page from one that
   * gave up scanning.
   */
  perf?: () => Perf | null | undefined;
  send?: SendFn;
  flushIntervalMs?: number;
  maxFindings?: number;
  maxBytes?: number;
}

export interface TransportApi {
  queueFinding(f: RumFinding): void;
  queueRoute(p: string, r: string | null): void;
  queueInteraction(sig: string, r: string | null): void;
  markSessionStart(): void;
  setPerf(p: Perf): void;
  /** The scan stats on the last beacon that went out, or null before the first. */
  lastSentPerf(): Perf | null;
  /**
   * Sends whatever is queued. Returns `true` when there was nothing to send
   * or the send succeeded, `false` when it failed — the batch is still held
   * (a first failure) or has just been dropped (a second). A caller about to
   * tear the transport down should retry once on `false`, because the
   * interval that would otherwise carry the retry is about to stop.
   */
  flush(reason: string): boolean;
  detach(): void;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The Blob's type is `text/plain`, and that is load-bearing rather than sloppy.
 *
 * `navigator.sendBeacon` sends a request whose mode is "no-cors" — unless the
 * content type is not CORS-safelisted, in which case it becomes a CORS request
 * and is preflighted. A beacon is cross-origin by definition (the site is not
 * the ingest host), and `sendBeacon` always sends with credentials mode
 * "include", for which a wildcard `Access-Control-Allow-Origin` is rejected
 * outright. So an `application/json` Blob makes every beacon depend on the
 * ingest endpoint echoing the caller's exact `Origin` back on both the
 * preflight and the POST — and when it does not, the browser drops the beacon
 * after `sendBeacon` has already returned `true`, so nothing here can even
 * notice, let alone retry.
 *
 * `text/plain` is safelisted: no preflight, no CORS response check, no
 * dependency on the endpoint's header policy. The payload is still JSON and
 * the ingest parses it as JSON regardless of what the content type claims —
 * it has always had to, because browsers disagree about the type a JSON Blob
 * arrives as. The `fetch` fallback below is a same-code-path request nobody
 * reads either, but it is not a beacon and states `application/json` honestly.
 */
const BEACON_CONTENT_TYPE = 'text/plain;charset=UTF-8';

function defaultSend(url: string, body: string): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      // A `false` return (queue full, over the browser's beacon budget) is a
      // refusal, not a send: fall through to fetch exactly as a throw does.
      if (navigator.sendBeacon(url, new Blob([body], { type: BEACON_CONTENT_TYPE }))) return true;
    } catch {
      // fall through to fetch
    }
  }
  if (typeof fetch === 'function') {
    fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'content-type': 'application/json' } }).catch(() => {});
    return true;
  }
  return false;
}

export function Transport(opts: TransportOptions): TransportApi {
  const url = `${opts.endpoint}/api/a11y/ingest`;
  const maxFindings = opts.maxFindings ?? 50;
  const maxBytes = opts.maxBytes ?? 60_000;
  const sendFn = opts.send ?? defaultSend;

  let findings: RumFinding[] = [];
  let routes: Route[] = [];
  let interactions: Interaction[] = [];
  const routeKeys = new Set<string>();
  const interactionKeys = new Set<string>();
  let perf: Perf | null = null;
  let sessionPending = false;
  let retried = false;

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (hasQueued()) flush('interval');
  }, opts.flushIntervalMs ?? 15_000);

  function livePerf(): Perf | null {
    try {
      return opts.perf?.() ?? null;
    } catch {
      return null;
    }
  }

  function hasQueued(): boolean {
    return findings.length > 0 || routes.length > 0 || interactions.length > 0 || perf !== null || sessionPending;
  }

  function buildBeacon(findingsSlice: RumFinding[], stats: Perf | null): RumBeacon {
    const beacon: RumBeacon = { v: 1, k: opts.siteKey, s: opts.sessionId, c: opts.version, sent: Date.now(), ctx: opts.ctx() };
    if (sessionPending) beacon.session = { started: true };
    if (routes.length) beacon.routes = routes;
    if (findingsSlice.length) beacon.findings = findingsSlice;
    if (interactions.length) beacon.interactions = interactions;
    if (stats) beacon.perf = stats;
    return beacon;
  }

  function fitFindings(stats: Perf | null): RumFinding[] {
    let n = findings.length;
    while (n > 0) {
      if (n === 1 || byteLength(JSON.stringify(buildBeacon(findings.slice(0, n), stats))) <= maxBytes) return findings.slice(0, n);
      n = Math.floor(n / 2);
    }
    return [];
  }

  function clearSent(count: number): void {
    // routeKeys/interactionKeys are NOT cleared here: dedupe is for the
    // life of this transport instance (the page), not just the batch that
    // was just sent, so a route or interaction already flushed once is
    // never queued again.
    findings = findings.slice(count);
    routes = [];
    interactions = [];
    perf = null;
    sessionPending = false;
    retried = false;
  }

  function dedupePush<T>(list: T[], keys: Set<string>, key: string, item: T): void {
    if (keys.has(key)) return;
    keys.add(key);
    list.push(item);
  }

  let lastSent: Perf | null = null;

  function flush(_reason: string): boolean {
    if (!hasQueued()) return true;
    // Read the perf supplier once per beacon, not once per byte-fitting pass.
    const stats = perf ?? livePerf();
    const sent = fitFindings(stats);
    const body = JSON.stringify(buildBeacon(sent, stats));
    let ok: boolean;
    try {
      ok = sendFn(url, body);
    } catch {
      ok = false;
    }
    if (ok && stats) lastSent = stats;
    if (ok || retried) clearSent(sent.length);
    else retried = true;
    return ok;
  }

  return {
    queueFinding(f) {
      findings.push(f);
      if (findings.length >= maxFindings) flush('batch-full');
    },
    queueRoute(p, r) { dedupePush(routes, routeKeys, `${p}|${r ?? ''}`, { p, r }); },
    queueInteraction(sig, r) { dedupePush(interactions, interactionKeys, `${sig}|${r ?? ''}`, { sig, r }); },
    markSessionStart() { sessionPending = true; },
    setPerf(p) { perf = p; },
    lastSentPerf: () => lastSent,
    flush,
    detach() { clearInterval(timer); },
  };
}
