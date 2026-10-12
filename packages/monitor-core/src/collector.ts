/**
 * `startCollector` — the whole collector, wired.
 *
 * One page, one collector: a scan engine on an idle budget, four behavioral
 * observers, a session-scoped seen-set so a barrier is reported once per route
 * per session, and a beacon transport. Nothing here mutates the host DOM and
 * nothing here throws into the host: every listener, job, and callback body is
 * wrapped, failures are visible only under `debug`, and every piece registers
 * its own teardown as it attaches — so hiding the page, stopping the
 * collector, and a half-finished start all leave the page as they found it.
 */
import { criteriaFromAxeTags, ruleKeyForAxe } from './signature/index';
import { FindingRecorder } from './findings';
import { Lifecycle } from './lifecycle';
import type { LifecycleApi } from './lifecycle';
import { sessionStore } from './session/storage';
import { SeenSet } from './session/seen';
import { NavigationModeTracker } from './session/navigation-mode';
import { Transport } from './transport/index';
import { attachObservers } from './observers/index';
import { DirtyTracker } from './engine/dirty';
import { Scheduler } from './engine/scheduler';
import type { SchedulerPerf } from './engine/scheduler';
import { IdleGate } from './engine/idle-gate';
import { slower } from './engine/tier';
import type { DocCostPartName } from './engine/tier';
import { Engine, countElements } from './engine/index';
import type { AxeLike, AxeNodeLike, AxeViolationLike } from './engine/axe-runner';
import { resolveNodeElement } from './engine/axe-runner';
import type { CollectorAdapter } from './adapter';
import { resolveAdapter } from './adapter';
import type { PageTier, RumConfig, RumContext } from './protocol/types';

/**
 * Above this many elements the document-cost pass at tab-hide is long enough
 * (~66ms on a 420-element page on a fast laptop, ~250ms at a mid-range phone's
 * speed) that the findings already in hand go out before it starts.
 */
const PREFLUSH_ELEMENTS = 250;

/**
 * The version every beacon reports as `c`.
 *
 * Substituted at build time from this package's `package.json` (tsup `define`,
 * the same way the engine bundle stamps `__VERSION__`), because a hand-written
 * copy of a version number is a copy that drifts — this one sat at 0.2.1
 * through two releases, and the dashboard compares it against a minimum. There
 * is no fallback literal on purpose: a missing define is a loud
 * `ReferenceError` in the one test that reads it, not a silently wrong number
 * on every beacon.
 */
declare const __COLLECTOR_VERSION__: string;
export const COLLECTOR_VERSION: string = __COLLECTOR_VERSION__;

const STARTED_FLAG = '__accessibleRumStarted';
const ROUTES_KEY = 'a11y_rum_routes';
const SESSION_SENT_KEY = 'a11y_rum_session_sent';

const TIER_KEY = 'a11y_rum_tier';
const LEARNED_KEY = 'a11y_rum_learned';

/** Whether the last beacon's scan state is out of date: `aborted` flipped either way, or a pending pass finished. */
export function perfChanged(last: SchedulerPerf, now: SchedulerPerf): boolean {
  return last.aborted !== now.aborted || (last.pending?.length ?? 0) > (now.pending?.length ?? 0);
}

export interface StartOptions {
  siteKey: string;
  endpoint: string;
  config: RumConfig;
  sessionId: string;
  adapter?: CollectorAdapter;
  debug?: boolean;
  axe?: AxeLike;
  now?: () => number;
  /** Tests only: the idle gate's quiet period. */
  idleQuietMs?: number;
}

export interface CollectorHandle {
  stop(): void;
}

type Flagged = Record<string, unknown>;
type Debug = (...args: unknown[]) => void;

const NOOP: CollectorHandle = { stop() { /* nothing was started */ } };

function log(...args: unknown[]): void {
  try { console.debug('[accessible-rum]', ...args); } catch { /* no console */ }
}

export function startCollector(opts: StartOptions): CollectorHandle {
  try {
    return start(opts);
  } catch (err) {
    if (opts.debug) log('start failed', err);
    return NOOP;
  }
}

function start(opts: StartOptions): CollectorHandle {
  const win = (typeof window === 'undefined' ? undefined : window) as (Window & Flagged) | undefined;
  const doc = win?.document;
  if (!win || !doc) return NOOP;
  if (win[STARTED_FLAG]) return NOOP;
  if (opts.config.enabled === false || opts.config.killSwitch) return NOOP;

  const debug: Debug = opts.debug ? log : () => {};
  win[STARTED_FLAG] = true;
  const life = Lifecycle(debug);
  life.add(() => { delete win[STARTED_FLAG]; });
  try {
    return wire(opts, win, doc, life, debug);
  } catch (err) {
    // A half-wired collector is worse than none: unwind everything that did
    // attach, release the flag, and leave the page untouched.
    debug('start failed; unwinding', err);
    life.run();
    return NOOP;
  }
}

function wire(opts: StartOptions, win: Window & Flagged, doc: Document, life: LifecycleApi, debug: Debug): CollectorHandle {
  // Resolved per call, not cached: a framework component may register on
  // `window.__accessibleAdapter` after the loader has already started the
  // engine, so `pattern()` and `componentOf()` (in findings.ts) each read
  // the slot fresh.
  const adapter = () => resolveAdapter(opts.adapter, win);
  const axe = opts.axe ?? (win as Flagged).axe as AxeLike | undefined;

  let storage: Storage | null = null;
  try { storage = win.sessionStorage; } catch { storage = null; }
  const store = sessionStore(storage);
  const seen = SeenSet(store);
  const nav = NavigationModeTracker(win);
  life.add(() => nav.detach());

  // The transport calls this from its own interval, so it must never throw.
  function ctx(): RumContext {
    let fontPx = 16;
    let zoom = 1;
    try { fontPx = parseFloat(win.getComputedStyle(doc.documentElement).fontSize) || 16; } catch { /* default */ }
    try { zoom = win.visualViewport?.scale ?? 1; } catch { /* default */ }
    try {
      return {
        vw: win.innerWidth || 0,
        vh: win.innerHeight || 0,
        dpr: win.devicePixelRatio || 1,
        zoom,
        fontPx,
        navigationMode: nav.mode(),
      };
    } catch {
      return { vw: 0, vh: 0, dpr: 1, zoom, fontPx, navigationMode: 'unknown' };
    }
  }

  // The visitor asked for less: no work in idle windows, everything waits for tab-hide as before.
  let saveData = false;
  try { saveData = (win.navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true; } catch { saveData = false; }
  const gate = saveData ? undefined : IdleGate({ win, doc, quietMs: opts.idleQuietMs });
  if (gate) life.add(() => gate.detach());
  const scheduler = Scheduler({ win, gate });
  // The endpoint is read once, here, at start: the transport is created once
  // and a slot registered later cannot redirect it.
  const transport = Transport({
    endpoint: adapter()?.transport?.endpoint ?? opts.endpoint,
    siteKey: opts.siteKey,
    sessionId: opts.sessionId,
    version: COLLECTOR_VERSION,
    ctx,
    // Every beacon carries the page's scan stats, including the ones the
    // transport sends on its own interval or when a batch fills up.
    perf: () => scheduler.perf(),
  });
  life.add(() => transport.detach());
  life.add(() => scheduler.stop());

  const path = (): string => { try { return win.location.pathname || '/'; } catch { return '/'; } };
  const pattern = (): string | null => {
    try { return adapter()?.attribution?.routePattern?.(path()) ?? null; } catch { return null; }
  };

  const findings = FindingRecorder({ transport, seen, adapter, path, pattern, debug });

  const engine = Engine({
    doc,
    win,
    axe: axe ?? { run: () => Promise.resolve({ violations: [] }) },
    scheduler,
    now: opts.now,
    debug,
    firstRunInWindow: store.get<PageTier>(TIER_KEY) === 'slow' && gate !== undefined,
    learned: store.get<Partial<Record<DocCostPartName, number>>>(LEARNED_KEY) ?? undefined,
    onLearned: (learned) => {
      try {
        // The largest multiplier any page of the session has needed: a larger one only defers work to tab-hide.
        const stored = store.get<Partial<Record<DocCostPartName, number>>>(LEARNED_KEY) ?? {};
        const merged: Record<string, number> = {};
        for (const part of Object.keys(learned) as DocCostPartName[]) {
          const old = stored[part];
          merged[part] = typeof old === 'number' && Number.isFinite(old) ? Math.max(old, learned[part]) : learned[part];
        }
        store.set(LEARNED_KEY, merged);
      } catch (err) { debug('learned store failed', err); }
    },
    onTier: (tier: PageTier) => {
      try {
        const kept = slower(store.get<PageTier>(TIER_KEY), tier);
        if (kept) store.set(TIER_KEY, kept);
      } catch (err) { debug('tier store failed', err); }
    },
    onViolation: (v: AxeViolationLike, node: AxeNodeLike) => {
      try {
        const el = resolveNodeElement(doc, node);
        if (!el) return;
        findings.record(el, ruleKeyForAxe(v.id, v.tags), v.impact ?? null, criteriaFromAxeTags(v.tags), 'rule');
      } catch (err) {
        debug('onViolation failed', err);
      }
    },
  });
  life.add(() => engine.stop());

  const sentRoutes = new Set<string>(store.get<string[]>(ROUTES_KEY) ?? []);
  function reportRoute(): void {
    const p = path();
    const r = pattern();
    const key = `${p}|${r ?? ''}`;
    if (sentRoutes.has(key)) return;
    sentRoutes.add(key);
    store.set(ROUTES_KEY, Array.from(sentRoutes));
    transport.queueRoute(p, r);
  }

  const detachObservers = attachObservers({
    doc,
    win,
    onFinding: (f) => {
      try { findings.record(f.element, `obs:${f.observer}`, f.impact, [f.wcag], 'heuristic'); }
      catch (err) { debug('observer finding failed', err); }
    },
    onRouteChange: () => {
      try {
        // The old view's unrun parts go out as skipped, under the old view,
        // before the new view is queued and re-armed (spec 3.6).
        // If this beacon fails to send, the old view's gap is lost (the re-arm moves the rules back to pending): accepted, rare.
        if (engine.abandonDeferredDocumentCost()) flush('route');
        reportRoute();
        const root = doc.querySelector('main') ?? doc.body;
        if (root) engine.scanRoots([root]);
        // A client-side route change replaces the page's content, so the
        // once-per-page contrast pass has a new page to look at.
        engine.scanDocumentCost();
      } catch (err) { debug('route change failed', err); }
    },
  });
  life.add(() => detachObservers());

  const dirty = DirtyTracker(doc, (roots) => {
    try { engine.scanRoots(roots); } catch (err) { debug('dirty scan failed', err); }
  });
  life.add(() => dirty.detach());

  function onInteract(event: Event): void {
    try { findings.interact(event.target); } catch (err) { debug('interaction failed', err); }
  }

  function flush(reason: string): boolean {
    try {
      const ok = transport.flush(reason);
      debug('flush', reason, ok);
      return ok;
    } catch (err) {
      debug('flush failed', err);
      return true;
    }
  }

  let halting = false;

  /**
   * Gives up on a pending document-cost pass and makes sure the giving-up is
   * *sent*. The rules land in `perf.skipped`, but by this point the ordinary
   * findings may already have been flushed, leaving nothing queued and so no
   * beacon to carry the news — which would be exactly the silence the skip
   * list exists to prevent. Handing the transport the stats explicitly gives
   * it something to send.
   */
  function abandonDeferred(): void {
    if (!engine.abandonDeferredDocumentCost()) return;
    try { transport.setPerf(scheduler.perf()); } catch (err) { debug('setPerf failed', err); }
  }

  /**
   * The same for queued scan work that will not get to run — a parked queue,
   * or chunks an idle callback had not reached yet. Dropping it is honest only
   * if the beacon says the page was not fully scanned.
   */
  function abandonQueued(): void {
    if (!scheduler.hasWork()) return;
    scheduler.abandon();
    try { transport.setPerf(scheduler.perf()); } catch (err) { debug('setPerf failed', err); }
  }

  /**
   * A beacon already sent may have said "pending" or "not fully scanned"
   * (`aborted`). If the work since then found nothing new there is nothing
   * queued and no beacon would follow, leaving that the last word — which the
   * server files as rules never checked. So send the final state, but only
   * then: every beacon counts against the site's daily cap.
   */
  function settlePerf(): void {
    try {
      const last = transport.lastSentPerf();
      if (!last) return;
      const now = scheduler.perf();
      const stale = perfChanged(last, now);
      if (stale) transport.setPerf(now);
    } catch (err) {
      debug('settlePerf failed', err);
    }
  }

  /**
   * The work the idle windows did not get to, run when the visitor looks away:
   * the document-cost parts left, then whatever scanning is still queued — parked because the device
   * was too slow to scan while they were looking, or simply not reached yet.
   * The contrast findings go out as soon as they exist, before the drain,
   * because a hidden tab can be frozen at any point.
   */
  async function runHiddenWork(reason: string): Promise<string> {
    let finished = reason;
    if (engine.hasDeferredDocumentCost()) {
      await scheduler.drain({ first: true });
      // A dead scheduler (abort) ran nothing: those rules will never run.
      if (engine.hasDeferredDocumentCost()) engine.abandonDeferredDocumentCost();
      finished = `${reason}-contrast`;
    }
    if (scheduler.hasWork()) {
      if (finished !== reason) flush(finished);
      await scheduler.drain();
      finished = `${reason}-drain`;
    }
    settlePerf();
    return finished;
  }

  /**
   * The transport's own retry rides its 15s interval, and by the time these
   * calls matter that interval is about to be cleared — so a beacon gets its
   * one retry here or never.
   */
  function flushWithRetry(reason: string): void {
    if (!flush(reason)) flush(`${reason}-retry`);
  }

  /** The last beacon, then nothing left attached. */
  function finishHalt(reason: string): void {
    if (life.done()) return;
    flushWithRetry(reason);
    life.run();
    debug('halted', reason);
  }

  /**
   * One way out, whoever calls it.
   *
   * Whatever the idle windows did not get to (document-cost parts, and on a
   * slow device the rest of the scanning) runs now: hiding the tab is the last
   * moment there is. But a hidden tab may be frozen or discarded at any point, so the
   * ordinary findings go out *first*, before that work is started: losing the
   * contrast findings is a great deal better than losing the whole beacon
   * because a 250ms scan was in front of it. The contrast findings then follow
   * as their own second beacon.
   *
   * `pagehide` is not that moment: the page is going away and there is no time,
   * so the pass is abandoned and its rules are named in `perf.skipped`, and any
   * queued scanning is dropped with `perf.aborted` set, rather than either
   * going silently missing. A `pagehide` arriving while the hidden work is
   * still running takes the same way out.
   */
  function halt(reason: string): void {
    if (life.done()) return;
    if (halting) {
      // A second teardown signal during the hidden work: stop waiting for it.
      abandonDeferred();
      abandonQueued();
      finishHalt(reason);
      return;
    }
    halting = true;
    if (reason === 'hidden' && (engine.hasDeferredDocumentCost() || scheduler.hasWork())) {
      // What the collector already has goes out first when the work ahead is
      // long enough for the browser to freeze the tab in the middle of it: a
      // queue to drain, or a document-cost pass on a page past a few hundred
      // elements. A small page's pass is a few tens of ms, and a second beacon
      // for it would only spend the site's daily cap.
      if (scheduler.hasWork() || countElements(doc.body ?? doc.documentElement) > PREFLUSH_ELEMENTS) {
        flushWithRetry(reason);
      }
      runHiddenWork(reason).then(
        (finished) => finishHalt(finished),
        () => finishHalt(`${reason}-contrast`),
      );
      return;
    }
    abandonDeferred();
    abandonQueued();
    finishHalt(reason);
  }

  const onVisibility = (): void => { try { if (doc.visibilityState === 'hidden') halt('hidden'); } catch { /* ignore */ } };
  const onPageHide = (): void => halt('pagehide');
  const listen = { capture: true, passive: true } as const;
  doc.addEventListener('click', onInteract, listen);
  doc.addEventListener('keydown', onInteract, listen);
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  life.add(() => {
    doc.removeEventListener('click', onInteract, listen);
    doc.removeEventListener('keydown', onInteract, listen);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
  });

  if (!store.get<boolean>(SESSION_SENT_KEY)) {
    store.set(SESSION_SENT_KEY, true);
    transport.markSessionStart();
  }
  reportRoute();
  if (axe && typeof axe.run === 'function') engine.scanFull();
  else debug('no axe present; observers only');
  debug('started', { siteKey: opts.siteKey, sessionId: opts.sessionId, version: COLLECTOR_VERSION });

  return { stop: (): void => halt('stop') };
}
