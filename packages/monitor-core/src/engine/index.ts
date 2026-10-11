/**
 * The scan engine: what gets scanned, in what order, and never more than once.
 *
 * A page gets one full pass — the page-level rules on the document, then every
 * top-level region of the body split into chunks, visible regions first — plus
 * incremental passes over whatever the dirty tracker reports. A
 * `WeakMap<Element, Set<rule>>` keeps a barrier from being reported twice on
 * one page when overlapping chunks or a re-scan cover the same element.
 */
import { countElements, splitIntoChunks } from './chunks';
import type { Chunk } from './chunks';
import { DOCUMENT_COST_PARTS, DOCUMENT_COST_RULES, resolveNodeElement, runChunk, runDocumentCost, runPage } from './axe-runner';
import type { AxeLike, AxeNodeLike, AxeViolationLike } from './axe-runner';
import type { SchedulerApi } from './scheduler';

export interface EngineOptions {
  doc: Document;
  win: Window;
  axe: AxeLike;
  scheduler: SchedulerApi;
  onViolation: (v: AxeViolationLike, node: AxeNodeLike) => void;
  debug?: (...args: unknown[]) => void;
  /** Clock for the budget measurement; defaults to `performance.now()`. */
  now?: () => number;
  /**
   * Largest document, in elements, on which the document-cost rules
   * (`color-contrast` and friends) are worth running at all. Up to it the pass
   * waits until the tab is hidden, where its task costs nobody an interaction;
   * above it the rules are skipped and named in `perf.skipped`: one run costs
   * over a second on a 5,000-element page and there is nothing to chunk.
   */
  contrastDeferMaxElements?: number;
}

export interface EngineApi {
  scanFull(): void;
  /** The once-per-page document-cost pass; also re-run after a client-side route change. */
  scanDocumentCost(): void;
  /** True while the document-cost pass is waiting for the tab to hide. */
  hasDeferredDocumentCost(): boolean;
  /**
   * Run the deferred pass now, outside the idle queue, and resolve once its
   * findings are recorded. The caller is the teardown path: there is no idle
   * callback left to wait for.
   */
  runDeferredDocumentCost(): Promise<void>;
  /**
   * Give up on the deferred pass and record its rules as not run. Returns true
   * if there was one to give up on.
   */
  abandonDeferredDocumentCost(): boolean;
  scanRoots(roots: Element[]): void;
  stop(): void;
}

const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'base', 'title']);
const ORDER_TIMEOUT_MS = 300;
const CONTRAST_DEFER_MAX_ELEMENTS = 3000;

type IOWindow = Window & { IntersectionObserver?: typeof IntersectionObserver };

export function Engine(opts: EngineOptions): EngineApi {
  const { doc, axe, scheduler } = opts;
  const win = opts.win as IOWindow;
  const contrastDeferMax = opts.contrastDeferMaxElements ?? CONTRAST_DEFER_MAX_ELEMENTS;
  const reported = new WeakMap<Element, Set<string>>();
  let observer: IntersectionObserver | null = null;
  let stopped = false;
  let fullDone = false;
  let deferredDocumentCost = false;
  let deferredRunning = false;

  function debug(...args: unknown[]): void {
    try { opts.debug?.(...args); } catch { /* logging never breaks a scan */ }
  }

  function report(violations: AxeViolationLike[]): void {
    for (const violation of violations) {
      for (const node of violation.nodes ?? []) {
        try {
          const el = resolveNodeElement(doc, node);
          if (!el) continue;
          let rules = reported.get(el);
          if (!rules) { rules = new Set<string>(); reported.set(el, rules); }
          if (rules.has(violation.id)) continue;
          rules.add(violation.id);
          opts.onViolation(violation, node);
        } catch (err) {
          debug('violation failed', err);
        }
      }
    }
  }

  /**
   * `elements` charges the scheduler's per-page element ceiling. A chunk
   * spawned by `scanRoot` charges nothing: its root already paid for the
   * whole subtree when it was queued.
   */
  function scanChunk(chunk: Chunk, elements = 0): void {
    scheduler.schedule(async () => {
      if (stopped) return 0;
      const { violations, ms } = await runChunk(axe, chunk, opts.now);
      if (!stopped) report(violations);
      return ms;
    }, elements);
  }

  /** Split at run time, so a shrunken chunk budget applies to work not yet done. */
  function scanRoot(root: Element): void {
    scheduler.schedule(async () => {
      if (stopped || !root.isConnected) return 0;
      const chunks = splitIntoChunks(root, scheduler.chunkMax());
      for (let i = 1; i < chunks.length; i++) scanChunk(chunks[i]!);
      const first = chunks[0];
      if (!first) return 0;
      const { violations, ms } = await runChunk(axe, first, opts.now);
      if (!stopped) report(violations);
      return ms;
    }, countElements(root) + 1);
  }

  function orderVisibleFirst(elements: Element[], done: (ordered: Element[]) => void): void {
    if (elements.length < 2 || typeof win.IntersectionObserver !== 'function') { done(elements); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ordered: Element[]): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try { observer?.disconnect(); } catch { /* already gone */ }
      observer = null;
      done(ordered);
    };
    try {
      observer = new win.IntersectionObserver((entries) => {
        try {
          const visible = new Set<Element>();
          for (const entry of entries) if (entry.isIntersecting) visible.add(entry.target);
          finish([...elements.filter((el) => visible.has(el)), ...elements.filter((el) => !visible.has(el))]);
        } catch {
          finish(elements);
        }
      });
      for (const el of elements) observer.observe(el);
      timer = setTimeout(() => { try { finish(elements); } catch { /* host timer */ } }, ORDER_TIMEOUT_MS);
    } catch {
      finish(elements);
    }
  }

  /**
   * The document-cost rules, once, on the whole document — later, or never.
   *
   * The pass is one indivisible `axe.run` whose cost is the document's times
   * the device's, so there is nothing to chunk:
   *
   * - up to `contrastDeferMax`: hold it until the tab is hidden, where nobody
   *   is waiting on the main thread. It used to run immediately on pages under
   *   250 elements, a threshold measured on a fast laptop — where such a page
   *   costs ~22ms. At a mid-range phone's speed the same page costs ~76ms, over
   *   budget while the visitor is looking, so no size is small enough to run it
   *   then without knowing the device;
   * - beyond that: do not run it, and name the rules in `perf.skipped` so a
   *   large page reads as partly unchecked rather than as clean.
   */
  function scanDocumentCost(): void {
    if (stopped) return;
    const body = doc.body;
    if (!body) return;
    const elements = countElements(body);

    if (elements > contrastDeferMax) {
      scheduler.skip(DOCUMENT_COST_RULES);
      debug('document-cost rules skipped; page too large', elements, DOCUMENT_COST_RULES);
      return;
    }
    deferredDocumentCost = true;
    // Deferred is not skipped and it is not done: the beacon says so.
    scheduler.defer(DOCUMENT_COST_RULES);
    debug('document-cost rules deferred until the tab hides', elements);
  }

  return {
    scanDocumentCost,
    hasDeferredDocumentCost: (): boolean => deferredDocumentCost && !stopped,

    async runDeferredDocumentCost(): Promise<void> {
      if (!deferredDocumentCost || deferredRunning || stopped) return;
      // The pending flag stays set until the pass has actually finished, so a
      // `pagehide` arriving mid-run still finds something to abandon and can
      // report the rules as not run.
      deferredRunning = true;
      try {
        const { violations, ms } = await runDocumentCost(axe, doc, DOCUMENT_COST_RULES, opts.now);
        // Abandoned while we were waiting: its rules have already been reported
        // as not run, so do not also report its findings.
        if (!deferredDocumentCost) return;
        deferredDocumentCost = false;
        scheduler.unskip(DOCUMENT_COST_RULES);
        // Reported like any job — the page paid for it — but it ran while the
        // visitor was not looking, so it says nothing about the budget then.
        scheduler.record(ms, { exemptFromAbort: true });
        if (!stopped) report(violations);
      } catch (err) {
        deferredDocumentCost = false;
        debug('deferred document-cost pass failed', err);
      } finally {
        deferredRunning = false;
      }
    },

    abandonDeferredDocumentCost(): boolean {
      if (!deferredDocumentCost) return false;
      deferredDocumentCost = false;
      scheduler.skip(DOCUMENT_COST_RULES);
      debug('deferred document-cost pass abandoned', DOCUMENT_COST_RULES);
      return true;
    },

    scanFull(): void {
      if (stopped || fullDone) return;
      fullDone = true;
      // The page-level pass runs once per page, so it is not charged against
      // the element ceiling; that ceiling exists to bound *repeated*
      // element-rule scanning of the same page.
      scheduler.schedule(async () => {
        if (stopped) return 0;
        const { violations, ms } = await runPage(axe, doc, opts.now);
        if (!stopped) report(violations);
        return ms;
      });
      scanDocumentCost();
      const body = doc.body;
      if (!body) return;
      const tops = Array.from(body.children).filter((el) => !SKIP_TAGS.has(el.tagName.toLowerCase()));
      if (tops.length === 0) return;
      orderVisibleFirst(tops, (ordered) => {
        if (stopped) return;
        for (const el of ordered) scanRoot(el);
      });
    },
    scanRoots(roots: Element[]): void {
      if (stopped) return;
      for (const root of roots) {
        try { if (root.isConnected) scanRoot(root); } catch { /* skip this root */ }
      }
    },
    stop(): void {
      stopped = true;
      try { observer?.disconnect(); } catch { /* already gone */ }
      observer = null;
    },
  };
}

export { splitIntoChunks, countElements } from './chunks';
export type { Chunk } from './chunks';
export { coalesceRoots, DirtyTracker } from './dirty';
export { Scheduler } from './scheduler';
export { PAGE_LEVEL_RULES, DOCUMENT_COST_RULES, DOCUMENT_COST_PARTS, DOCUMENT_COST_NEVER_RUN, ELEMENT_TAGS, runPage, runChunk, runDocumentCost, resolveNodeElement } from './axe-runner';
export type { AxeLike, AxeNodeLike, AxeViolationLike, AxeResultsLike } from './axe-runner';
export type { SchedulerApi, SchedulerPerf, SchedulerJob, SchedulerOptions } from './scheduler';
export type { DirtyTrackerApi, DirtyTrackerOptions } from './dirty';
