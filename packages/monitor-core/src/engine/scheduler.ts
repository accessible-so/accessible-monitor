/**
 * The idle scheduler and its long-task budget.
 *
 * Every scan runs in a `requestIdleCallback` slice, one job at a time, so the
 * collector never competes with the page's own work. The budget is the safety
 * valve, and it is a promise to the visitor: no scan task over `budgetMs` while
 * they are looking at the page, beyond the one that reveals the device is too
 * slow for it.
 *
 * The first run over budget while the visitor is looking **parks** the queue:
 * nothing more runs until `drain()`, which the collector calls when the tab
 * hides. It used to halve the chunk size and try again, up to three times, but
 * most of a run's cost is a floor set by the document and the device — axe
 * rebuilds its view of the whole page on every run — so on a slow device every
 * halving was one more long task that bought nothing. One is the most the
 * visitor pays. While parked the page reports `aborted` — stopped early, so not
 * clean — and a drain that empties the queue clears it again.
 *
 * Chunks are 200 elements: under budget on a fast laptop with room to spare
 * (~17ms on a 1,100-element page), and at a mid-range phone's speed (4x CPU)
 * still under it on pages where 400 was not (~22ms vs ~98ms on 420 elements),
 * so fewer devices ever park.
 *
 * Two more ceilings bound a page that never trips the time budget: a page
 * that mutates `body` forever (toasts, portals) would otherwise re-scan
 * itself every debounce for as long as the tab is open, each chunk cheap and
 * the total unbounded. `maxScans` caps how many jobs one page may run and
 * `maxScannedElements` caps how many elements they may cover; either one
 * aborts exactly like the time budget.
 *
 * While parked, and for jobs marked `idleOnly`, a task may still start in an
 * idle window (`gate`), if its predicted cost fits `idleBudgetMs`. A window
 * task is exempt from parking: it was allowed to be long because nobody was
 * interacting.
 */

import type { IdleGateApi } from './idle-gate';
import type { PageTier } from '../protocol/types';

/** The longest task allowed to start in an idle window. Spec §3.2. */
export const IDLE_BUDGET_MS = 150;

export interface SchedulerPerf {
  scans: number;
  longTasks: number;
  maxTaskMs: number;
  aborted: boolean;
  /** Rules the engine decided not to run at all. Absent when nothing was skipped. */
  skipped?: string[];
  /**
   * Rules whose pass has been put off and has not happened yet — the
   * document-cost set on a mid-size page, waiting for the tab to hide. A rule
   * is never in both lists: it moves to `skipped` if the pass is abandoned and
   * leaves both if the pass runs. Absent when nothing is pending.
   */
  pending?: string[];
  tier?: PageTier;
  idleRuns?: number;
}

export type SchedulerJob = () => Promise<number>;

export interface SchedulerOptions {
  win: Window;
  budgetMs?: number;
  /** Elements per chunk. */
  chunkMax?: number;
  /** Most jobs one page may run before collection stops. */
  maxScans?: number;
  /** Most elements one page's scans may cover before collection stops. */
  maxScannedElements?: number;
  onPerf?: (perf: SchedulerPerf) => void;
  gate?: IdleGateApi;
  idleBudgetMs?: number;
}

export interface ScheduleOptions {
  /**
   * A job run while the visitor is not looking — the document-cost pass and the
   * drain, both at tab-hide. Its time is still reported (`longTasks`,
   * `maxTaskMs`): the page really did pay it, and hiding that would be a lie
   * about the collector's cost. But it says nothing about what fits while
   * someone is looking, so it never parks the queue.
   */
  exemptFromAbort?: boolean;
  /** Runs only in an idle window, or at drain. */
  idleOnly?: boolean;
  /** Predicted cost in ms; null when unknown. A job predicted over idleBudgetMs never starts in a window. */
  predictMs?: () => number | null;
  /** At drain: 'first' runs before everything else; 'run' (default) in queue order; 'drop' is removed, calling onDrop. */
  atDrain?: 'first' | 'run' | 'drop';
  onDrop?: () => void;
}

export interface SchedulerApi {
  /**
   * Queue one job. `elements` is what the job is about to cover, charged
   * against the page's element ceiling when the job is queued.
   */
  schedule(job: SchedulerJob, elements?: number, options?: ScheduleOptions): void;
  /**
   * Account for a job the caller ran itself rather than queueing — the
   * deferred document-cost pass, which has to finish before the last beacon
   * and so cannot wait for an idle callback. The time is reported exactly as a
   * queued job's would be.
   */
  record(ms: number, options?: ScheduleOptions): void;
  /** Record rules the engine chose not to run, so the beacon can say so. */
  skip(rules: readonly string[]): void;
  /**
   * Record rules whose pass has been postponed rather than abandoned. A beacon
   * sent while the visitor is still on the page then says "not yet" rather than
   * saying nothing, which used to read the same as "checked and clean".
   */
  defer(rules: readonly string[]): void;
  /**
   * Take rules back off that list because a later pass did run them — a
   * client-side route change onto a page small enough to afford what the last
   * one was not.
   */
  unskip(rules: readonly string[]): void;
  chunkMax(): number;
  /** True while there is queued work — parked or merely not reached yet. */
  hasWork(): boolean;
  /**
   * Run everything queued, now, one job after another and outside idle
   * callbacks: the visitor has looked away, so there is no interaction to
   * protect. Resolves when the queue is empty or `abandon()`/`stop()` cut it
   * short. An emptied queue un-parks the page.
   */
  /** With { first: true }, runs only the atDrain:'first' jobs (and drops the 'drop' ones). */
  drain(options?: { first?: boolean }): Promise<void>;
  setTier(tier: PageTier): void;
  /** Drop queued work that will not get to run, and say so: the page was not fully scanned. */
  abandon(): void;
  perf(): SchedulerPerf;
  stop(): void;
}

interface QueuedJob {
  job: SchedulerJob;
  exempt: boolean;
  idleOnly: boolean;
  predictMs?: () => number | null;
  atDrain: 'first' | 'run' | 'drop';
  onDrop?: () => void;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function Scheduler(options: SchedulerOptions): SchedulerApi {
  const win = options.win as IdleWindow;
  const budgetMs = options.budgetMs ?? 50;
  const maxScans = options.maxScans ?? 200;
  const maxScannedElements = options.maxScannedElements ?? 50_000;

  const chunk = options.chunkMax ?? 200;
  let queue: QueuedJob[] = [];
  let handle: number | null = null;
  let usedTimeout = false;
  let running = false;
  let stopped = false;
  let aborted = false;
  let parked = false;
  const gate = options.gate;
  const idleBudgetMs = options.idleBudgetMs ?? IDLE_BUDGET_MS;
  let draining = false;
  let drainDepth = 0;
  let drainTail: Promise<void> = Promise.resolve();
  let waitingForWindow = false;
  let idleRuns = 0;
  let tier: PageTier | undefined;
  let current: Promise<void> | null = null;
  let scans = 0;
  let overBudget = 0;
  let maxTaskMs = 0;
  let scannedElements = 0;
  const skipped = new Set<string>();
  const pending = new Set<string>();

  function abort(): void {
    aborted = true;
    queue = [];
  }

  function perf(): SchedulerPerf {
    const unfinished = parked && (queue.length > 0 || current !== null);
    const stats: SchedulerPerf = { scans, longTasks: overBudget, maxTaskMs, aborted: aborted || unfinished };
    if (skipped.size > 0) stats.skipped = Array.from(skipped);
    if (pending.size > 0) stats.pending = Array.from(pending);
    if (tier) stats.tier = tier;
    if (idleRuns > 0) stats.idleRuns = idleRuns;
    return stats;
  }

  function idle(cb: () => void): void {
    // The callback may run synchronously (a stubbed rIC in tests, or a host
    // that drains immediately), so only remember a handle the callback has
    // not already consumed — otherwise we would hold a stale id forever.
    let fired = false;
    const wrapped = (): void => {
      fired = true;
      handle = null;
      // The host owns this callback's stack (rIC / setTimeout): nothing may
      // escape it.
      try { cb(); } catch { running = false; }
    };
    try {
      if (typeof win.requestIdleCallback === 'function') {
        usedTimeout = false;
        const h = win.requestIdleCallback(wrapped, { timeout: 2000 });
        if (!fired) handle = h;
        return;
      }
    } catch {
      // Safari and any host that throws here fall through to setTimeout.
    }
    usedTimeout = true;
    const h = win.setTimeout(wrapped, 50) as unknown as number;
    if (!fired) handle = h;
  }

  function cancelIdle(): void {
    if (handle === null) return;
    try {
      if (usedTimeout) win.clearTimeout(handle);
      else if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(handle);
    } catch {
      // nothing to undo
    }
    handle = null;
  }

  /** The bookkeeping every completed job goes through, queued or not. */
  function account(ms: number, exempt: boolean): void {
    try {
      scans++;
      if (typeof ms === 'number' && Number.isFinite(ms)) {
        if (ms > maxTaskMs) maxTaskMs = ms;
        if (ms > budgetMs) {
          // Always reported: the page paid for this task either way.
          overBudget++;
          // Only a run made while the visitor is looking says anything about
          // what fits while they are looking. See ScheduleOptions.
          if (!exempt) {
            parked = true;
          }
        }
      }
      if (scans >= maxScans) abort();
      options.onPerf?.(perf());
    } catch {
      // Perf bookkeeping never breaks the pump.
    }
  }

  function finish(ms: number, exempt: boolean): void {
    running = false;
    account(ms, exempt);
    pump();
  }

  /** One job, never throwing; resolves with its reported time (0 if it failed). */
  function runJob(job: SchedulerJob): Promise<number> {
    try {
      return Promise.resolve(job()).then((ms) => ms, () => 0);
    } catch {
      return Promise.resolve(0);
    }
  }

  function fitsWindow(j: QueuedJob): boolean {
    let predicted: number | null = null;
    try { predicted = j.predictMs?.() ?? null; } catch { predicted = null; }
    return predicted === null || predicted <= idleBudgetMs;
  }

  /** The next job to start now, and whether it starts in an idle window. */
  function pick(): { index: number; inWindow: boolean } | null {
    if (!parked) {
      const index = queue.findIndex((j) => !j.idleOnly);
      if (index !== -1) return { index, inWindow: false };
    }
    let open = false;
    try { open = gate?.isOpen() === true; } catch { open = false; }
    if (open) {
      const index = queue.findIndex(fitsWindow);
      if (index !== -1) return { index, inWindow: true };
    }
    return null;
  }

  /** Nothing can start now: ask the gate to call back, if a window could run anything. */
  function waitForWindow(): void {
    if (!gate || waitingForWindow || stopped || aborted) return;
    if (!queue.some(fitsWindow)) return; // only drain can run what is left
    waitingForWindow = true;
    try {
      gate.whenOpen(() => { waitingForWindow = false; pump(); });
    } catch {
      waitingForWindow = false;
    }
  }

  function pump(): void {
    if (stopped || aborted || running || draining || queue.length === 0) return;
    if (!pick()) { waitForWindow(); return; }
    running = true;
    idle(() => {
      if (stopped || aborted || draining) { running = false; return; }
      // Picked again inside the callback: the window may have closed while we waited for it.
      const choice = pick();
      if (!choice) { running = false; waitForWindow(); return; }
      const [next] = queue.splice(choice.index, 1);
      if (choice.inWindow) idleRuns++;
      current = runJob(next!.job).then((ms) => {
        current = null;
        finish(ms, next!.exempt || choice.inWindow);
      });
    });
  }

  /** Drains run one after another: a second call waits for the first, so axe never runs twice at once. */
  function drain(drainOptions: { first?: boolean } = {}): Promise<void> {
    drainDepth++;
    draining = true;
    const run = drainTail.then(() => doDrain(drainOptions)).finally(() => {
      if (--drainDepth === 0) { draining = false; pump(); }
    });
    drainTail = run.catch(() => {});
    return run;
  }

  async function doDrain(drainOptions: { first?: boolean }): Promise<void> {
    // Whatever an idle callback already started finishes first — axe must
    // never run twice at once — and nothing new starts from one again.
    parked = true;
    cancelIdle();
    if (current) await current;
    running = false;
    for (const j of queue.filter((q) => q.atDrain === 'drop')) {
      try { j.onDrop?.(); } catch { /* bookkeeping never throws */ }
    }
    queue = queue.filter((q) => q.atDrain !== 'drop');
    const take = (): QueuedJob | undefined => {
      let index = queue.findIndex((q) => q.atDrain === 'first');
      if (index === -1 && !drainOptions.first) index = queue.length > 0 ? 0 : -1;
      return index === -1 ? undefined : queue.splice(index, 1)[0];
    };
    for (let next = take(); next && !stopped && !aborted; next = take()) {
      const job = next.job;
      current = runJob(job).then((ms) => { current = null; account(ms, true); });
      await current;
    }
    if (!stopped && !aborted && queue.length === 0) {
      parked = false;
      try { options.onPerf?.(perf()); } catch { /* bookkeeping never throws */ }
    }
  }

  return {
    schedule(job: SchedulerJob, elements = 0, options: ScheduleOptions = {}): void {
      if (stopped || aborted) return;
      if (elements > 0) {
        if (scannedElements + elements > maxScannedElements) { abort(); return; }
        scannedElements += elements;
      }
      queue.push({
        job,
        exempt: options.exemptFromAbort === true,
        idleOnly: options.idleOnly === true,
        predictMs: options.predictMs,
        atDrain: options.atDrain ?? 'run',
        onDrop: options.onDrop,
      });
      pump();
    },
    record(ms: number, options: ScheduleOptions = {}): void {
      account(ms, options.exemptFromAbort === true);
    },
    skip(rules: readonly string[]): void {
      // Giving up on a postponed pass is the one way out of `pending`: the two
      // lists are disjoint by construction, here and in `defer`.
      for (const rule of rules) { pending.delete(rule); skipped.add(rule); }
    },
    defer(rules: readonly string[]): void {
      for (const rule of rules) { skipped.delete(rule); pending.add(rule); }
    },
    unskip(rules: readonly string[]): void {
      // The pass ran: the rules are neither unchecked nor waiting.
      for (const rule of rules) { skipped.delete(rule); pending.delete(rule); }
    },
    chunkMax: () => chunk,
    hasWork: (): boolean => !stopped && !aborted && (queue.length > 0 || current !== null),
    drain,
    abandon(): void {
      if (stopped) return;
      if (queue.length > 0 || current !== null || parked) abort();
    },
    perf,
    setTier(next: PageTier): void { tier = next; },
    stop(): void {
      stopped = true;
      queue = [];
      cancelIdle();
    },
  };
}
