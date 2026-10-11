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
import { DOCUMENT_COST_PARTS, resolveNodeElement, runChunk, runDocumentCost, runPage } from './axe-runner';
import type { AxeLike, AxeNodeLike, AxeViolationLike } from './axe-runner';
import type { SchedulerApi } from './scheduler';
import { INITIAL_RATIOS, pageTier, predictPartMs } from './tier';
import type { DocCostPartName } from './tier';
import type { PageTier } from '../protocol/types';

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
   * Largest document on which the document-cost parts still run at tab-hide.
   * Above it they run only in an idle window whose prediction fits, and are
   * dropped (`perf.skipped`) at drain.
   */
  contrastDeferMaxElements?: number;
  /** Run the page's first `axe.run` only in an idle window (the session already knows this device is slow). */
  firstRunInWindow?: boolean;
  onTier?: (tier: PageTier) => void;
}

export interface EngineApi {
  scanFull(): void;
  /** The once-per-page document-cost pass; also re-run after a client-side route change. */
  scanDocumentCost(): void;
  /** True while a document-cost part that would run at drain is still pending. */
  hasDeferredDocumentCost(): boolean;
  /** Give up on every pending part and report its rules as skipped. True if there was one. */
  abandonDeferredDocumentCost(): boolean;
  /** Predicted cost of a document-cost part, from the first run and what parts have actually cost. */
  predictedPartMs(part: DocCostPartName): number | null;
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
  let firstRunMs: number | null = null;
  let lastChunkMs: number | null = null;
  const ratios: Record<DocCostPartName, number> = { ...INITIAL_RATIOS };
  /** Parts armed for the current view and not yet run, abandoned, or dropped. */
  const pendingParts = new Set<DocCostPartName>();
  /** Whether the current view's parts would run at drain ('first') or be dropped there. */
  let partsAtDrain: 'first' | 'drop' = 'first';
  /** Bumped on every re-arm, so a job queued for an earlier view does nothing. */
  let docGen = 0;

  const chunkPredict = (): number | null => lastChunkMs ?? firstRunMs;
  const partPredict = (part: DocCostPartName): number | null => predictPartMs(firstRunMs, ratios[part]);

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
      lastChunkMs = ms;
      if (!stopped) report(violations);
      return ms;
    }, elements, { predictMs: chunkPredict });
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
      lastChunkMs = ms;
      if (!stopped) report(violations);
      return ms;
    }, countElements(root) + 1, { predictMs: chunkPredict });
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
   * Arm the document-cost parts for the current view.
   *
   * Each part is its own window-only job, predicted as a multiple of the first
   * run, and pending until it runs. At drain, a page up to `contrastDeferMax`
   * runs what is still pending ('first'); a larger one drops it and reports the
   * rules as skipped. In a window even a large page's part runs if its
   * prediction fits.
   */
  function scanDocumentCost(): void {
    if (stopped) return;
    const body = doc.body;
    if (!body) return;
    const gen = ++docGen;
    partsAtDrain = countElements(body) > contrastDeferMax ? 'drop' : 'first';
    for (const part of DOCUMENT_COST_PARTS) {
      pendingParts.add(part.name);
      scheduler.defer(part.rules);
      scheduler.schedule(async () => {
        if (stopped || gen !== docGen || !pendingParts.has(part.name)) return 0;
        const { violations, ms } = await runDocumentCost(axe, doc, part.rules, opts.now);
        // Abandoned or re-armed while it ran: its rules were already reported.
        if (gen !== docGen || !pendingParts.delete(part.name)) return ms;
        scheduler.unskip(part.rules);
        if (firstRunMs !== null && firstRunMs > 0) ratios[part.name] = Math.max(ratios[part.name], ms / firstRunMs);
        debug('document-cost part', part.name, ms, firstRunMs);
        if (!stopped) report(violations);
        return ms;
      }, 0, {
        idleOnly: true,
        exemptFromAbort: true,
        atDrain: partsAtDrain,
        predictMs: () => partPredict(part.name),
        onDrop: () => {
          if (gen === docGen && pendingParts.delete(part.name)) scheduler.skip(part.rules);
        },
      });
    }
    debug('document-cost parts armed', partsAtDrain);
  }

  return {
    scanDocumentCost,
    hasDeferredDocumentCost: (): boolean => !stopped && partsAtDrain === 'first' && pendingParts.size > 0,

    abandonDeferredDocumentCost(): boolean {
      if (pendingParts.size === 0) return false;
      for (const part of DOCUMENT_COST_PARTS) {
        if (pendingParts.delete(part.name)) scheduler.skip(part.rules);
      }
      debug('document-cost parts abandoned');
      return true;
    },
    predictedPartMs: partPredict,

    scanFull(): void {
      if (stopped || fullDone) return;
      fullDone = true;
      // The page-level pass runs once per page, so it is not charged against
      // the element ceiling; that ceiling exists to bound *repeated*
      // element-rule scanning of the same page.
      scheduler.schedule(async () => {
        if (stopped) return 0;
        const { violations, ms } = await runPage(axe, doc, opts.now);
        if (firstRunMs === null) {
          firstRunMs = ms;
          const tier = pageTier(ms, ratios);
          scheduler.setTier(tier);
          debug('calibrated', { firstRunMs: ms, tier });
          try { opts.onTier?.(tier); } catch { /* a callback never breaks a scan */ }
        }
        if (!stopped) report(violations);
        return ms;
      }, 0, opts.firstRunInWindow ? { idleOnly: true } : {});
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
export { IdleGate, IDLE_QUIET_MS } from './idle-gate';
export type { IdleGateApi, IdleGateOptions } from './idle-gate';
export { INITIAL_RATIOS, predictPartMs, pageTier, slower } from './tier';
export type { DocCostPartName } from './tier';
