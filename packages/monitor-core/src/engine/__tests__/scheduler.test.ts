import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../scheduler';
import type { IdleGateApi } from '../idle-gate';

/** A window whose idle callback runs synchronously. */
function idleWindow(): Window {
  const win = {
    requestIdleCallback: (cb: () => void) => { cb(); return 1; },
    cancelIdleCallback: () => {},
    setTimeout: (cb: () => void) => setTimeout(cb, 0) as unknown as number,
    clearTimeout: (h: number) => clearTimeout(h),
  };
  return win as unknown as Window;
}

const micro = async (turns = 40): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

let originalRIC: unknown;

beforeEach(() => {
  originalRIC = (window as unknown as Record<string, unknown>).requestIdleCallback;
});

afterEach(() => {
  (window as unknown as Record<string, unknown>).requestIdleCallback = originalRIC;
});

describe('Scheduler', () => {
  it('runs queued jobs one at a time and counts them', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    const order: number[] = [];
    for (let i = 0; i < 3; i++) scheduler.schedule(() => { order.push(i); return Promise.resolve(1); });
    await micro();
    expect(order).toEqual([0, 1, 2]);
    expect(scheduler.perf()).toEqual({ scans: 3, longTasks: 0, maxTaskMs: 1, aborted: false });
  });

  it('parks on the first run over budget, whatever the margin', async () => {
    // Most of a run's cost is a floor set by the document and the device, so a
    // smaller chunk would only buy another long task: the visitor pays one.
    for (const ms of [51, 120]) {
      const scheduler = Scheduler({ win: idleWindow() });
      let second = false;
      scheduler.schedule(() => Promise.resolve(ms));
      scheduler.schedule(() => { second = true; return Promise.resolve(1); });
      await micro();
      expect(second, `a parked queue kept running after a ${ms}ms task`).toBe(false);
      expect(scheduler.hasWork()).toBe(true);
      // Stopped early, so not clean: parked reads as aborted until a drain finishes.
      expect(scheduler.perf()).toEqual({ scans: 1, longTasks: 1, maxTaskMs: ms, aborted: true });
    }
  });

  it('keeps one chunk size: 200 elements unless told otherwise', () => {
    expect(Scheduler({ win: idleWindow() }).chunkMax()).toBe(200);
    expect(Scheduler({ win: idleWindow(), chunkMax: 50 }).chunkMax()).toBe(50);
  });

  it('an exempt job is reported but never parks the queue', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    let next = false;
    scheduler.schedule(() => Promise.resolve(900), 0, { exemptFromAbort: true });
    scheduler.schedule(() => { next = true; return Promise.resolve(1); });
    await micro();
    expect(next).toBe(true);
    expect(scheduler.perf()).toEqual({ scans: 2, longTasks: 1, maxTaskMs: 900, aborted: false });
  });

  it('drain() runs the parked queue to the end and clears the abort', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    const ran: string[] = [];
    scheduler.schedule(() => { ran.push('a'); return Promise.resolve(150); });
    scheduler.schedule(() => { ran.push('b'); return Promise.resolve(150); });
    scheduler.schedule(() => { ran.push('c'); return Promise.resolve(150); });
    await micro();
    expect(ran).toEqual(['a']);
    expect(scheduler.perf().aborted).toBe(true);

    await scheduler.drain();
    // Every job ran, each over budget — while hidden, which does not park
    // again — and the page is fully scanned after all.
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(scheduler.hasWork()).toBe(false);
    expect(scheduler.perf()).toEqual({ scans: 3, longTasks: 3, maxTaskMs: 150, aborted: false });
  });

  it('drain() waits for a job an idle callback already started', async () => {
    let release: ((ms: number) => void) | undefined;
    const scheduler = Scheduler({ win: idleWindow() });
    const ran: string[] = [];
    scheduler.schedule(() => { ran.push('slow'); return new Promise<number>((r) => (release = r)); });
    scheduler.schedule(() => { ran.push('next'); return Promise.resolve(1); });
    await micro();
    const drained = scheduler.drain();
    await micro();
    expect(ran, 'the drain overtook a job still running').toEqual(['slow']);
    release!(10);
    await drained;
    expect(ran).toEqual(['slow', 'next']);
    expect(scheduler.perf().scans).toBe(2);
  });

  it('abandon() drops queued work and says the page was not fully scanned', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    let ran = 0;
    scheduler.schedule(() => { ran++; return Promise.resolve(150); });
    scheduler.schedule(() => { ran++; return Promise.resolve(1); });
    await micro();
    scheduler.abandon();
    await scheduler.drain();
    expect(ran).toBe(1);
    expect(scheduler.hasWork()).toBe(false);
    expect(scheduler.perf().aborted).toBe(true);
  });

  it('abandon() with nothing left to do changes nothing', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    scheduler.schedule(() => Promise.resolve(1));
    await micro();
    scheduler.abandon();
    expect(scheduler.perf().aborted).toBe(false);
  });

  it('reports skipped rules once, and omits the field when nothing was skipped', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    expect(scheduler.perf().skipped).toBeUndefined();
    expect('skipped' in scheduler.perf()).toBe(false);

    scheduler.skip(['color-contrast', 'region']);
    scheduler.skip(['color-contrast']);
    expect(scheduler.perf().skipped).toEqual(['color-contrast', 'region']);
    expect('pending' in scheduler.perf(), 'skipping is not pending').toBe(false);
  });

  /**
   * `pending` and `skipped` are the two halves of one honest answer, and a rule
   * may only ever be in one of them: "we have not run this yet" and "we are not
   * going to" are different claims, and a rule that is in both is a beacon
   * contradicting itself.
   */
  it('moves rules between pending and skipped, never holding a rule in both', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    expect('pending' in scheduler.perf()).toBe(false);

    scheduler.defer(['color-contrast', 'region']);
    expect(scheduler.perf().pending).toEqual(['color-contrast', 'region']);
    expect(scheduler.perf().skipped, 'a postponed pass is not a skipped one').toBeUndefined();

    // Given up on: it moves across, it does not appear twice.
    scheduler.skip(['color-contrast', 'region']);
    expect(scheduler.perf().skipped).toEqual(['color-contrast', 'region']);
    expect(scheduler.perf().pending).toBeUndefined();

    // A later route change runs them after all: neither list mentions them.
    scheduler.unskip(['color-contrast', 'region']);
    expect(scheduler.perf().skipped).toBeUndefined();
    expect(scheduler.perf().pending).toBeUndefined();

    // And deferring a rule that had been given up on takes it back off `skipped`.
    scheduler.skip(['region']);
    scheduler.defer(['region']);
    expect(scheduler.perf().pending).toEqual(['region']);
    expect(scheduler.perf().skipped).toBeUndefined();
  });

  it('stops after the per-page scan ceiling and drops the rest of the queue', async () => {
    const scheduler = Scheduler({ win: idleWindow(), maxScans: 200 });
    let ran = 0;
    for (let i = 0; i < 250; i++) scheduler.schedule(() => { ran++; return Promise.resolve(1); });
    await micro(600);

    expect(ran).toBe(200);
    const perf = scheduler.perf();
    expect(perf.scans).toBe(200);
    expect(perf.aborted).toBe(true);
    expect(perf.longTasks).toBe(0);

    // The queue is cleared and nothing new is accepted.
    scheduler.schedule(() => { ran++; return Promise.resolve(1); });
    await micro();
    expect(ran).toBe(200);
  });

  it('stops once the per-page element ceiling is exceeded', async () => {
    const scheduler = Scheduler({ win: idleWindow(), maxScannedElements: 1000 });
    let ran = 0;
    const job = (): Promise<number> => { ran++; return Promise.resolve(1); };
    scheduler.schedule(job, 600);
    scheduler.schedule(job, 300);
    await micro();
    expect(ran).toBe(2);
    expect(scheduler.perf().aborted).toBe(false);

    // 600 + 300 + 200 is over the 1,000 ceiling: this one is refused and
    // collection stops for the page.
    scheduler.schedule(job, 200);
    await micro();
    expect(ran).toBe(2);
    expect(scheduler.perf().aborted).toBe(true);
  });

  it('falls back to setTimeout when requestIdleCallback is missing', async () => {
    const win = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
    const scheduler = Scheduler({ win: win as unknown as Window });
    let ran = false;
    scheduler.schedule(() => { ran = true; return Promise.resolve(1); });
    expect(ran).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ran).toBe(true);
    scheduler.stop();
  });

  it('never lets a throwing job escape, and keeps draining', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    let ran = false;
    scheduler.schedule(() => { throw new Error('boom'); });
    scheduler.schedule(() => Promise.reject(new Error('boom')));
    scheduler.schedule(() => { ran = true; return Promise.resolve(1); });
    await micro();
    expect(ran).toBe(true);
    expect(scheduler.perf().scans).toBe(3);
  });

  it('stop() clears the queue without reporting an abort', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    let ran = 0;
    scheduler.schedule(() => { ran++; scheduler.stop(); return Promise.resolve(1); });
    scheduler.schedule(() => { ran++; return Promise.resolve(1); });
    await micro();
    expect(ran).toBe(1);
    expect(scheduler.perf().aborted).toBe(false);
  });
});


/** A gate the test opens and closes by hand. */
function manualGate(): IdleGateApi & { open(): void; close(): void } {
  let open = false;
  let waiters: (() => void)[] = [];
  return {
    isOpen: () => open,
    whenOpen(cb) { waiters.push(cb); if (open) this.open(); },
    detach() { waiters = []; },
    open() { open = true; const w = waiters; waiters = []; for (const cb of w) cb(); },
    close() { open = false; },
  };
}

describe('Scheduler idle windows', () => {
  it('resumes a parked queue in an idle window, one task at a time', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    const ran: string[] = [];
    scheduler.schedule(() => { ran.push('long'); return Promise.resolve(80); });
    scheduler.schedule(() => { ran.push('a'); return Promise.resolve(20); }, 0, { predictMs: () => 20 });
    scheduler.schedule(() => { ran.push('b'); return Promise.resolve(20); }, 0, { predictMs: () => 20 });
    await micro();
    expect(ran).toEqual(['long']);
    gate.open();
    await micro();
    expect(ran).toEqual(['long', 'a', 'b']);
    expect(scheduler.perf().idleRuns).toBe(2);
    expect(scheduler.perf().aborted).toBe(false);
  });

  it('counts window tasks that ran over the idle budget as windowOverruns, and nothing else', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    scheduler.schedule(() => Promise.resolve(120), 0, { idleOnly: true, predictMs: () => 100 });
    gate.open();
    await micro();
    expect(scheduler.perf().idleRuns).toBe(1);
    expect('windowOverruns' in scheduler.perf(), 'absent while none overran').toBe(false);
    scheduler.schedule(() => Promise.resolve(200), 0, { idleOnly: true, predictMs: () => 100 });
    await micro();
    expect(scheduler.perf().windowOverruns).toBe(1);
    // A drain job over the budget was not started in a window.
    gate.close();
    scheduler.schedule(() => Promise.resolve(400), 0, { idleOnly: true });
    await scheduler.drain();
    expect(scheduler.perf().windowOverruns).toBe(1);
  });

  it('never starts a task in a window when it is predicted over the idle budget', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    let big = false;
    let small = false;
    scheduler.schedule(() => { big = true; return Promise.resolve(400); }, 0, { idleOnly: true, predictMs: () => 400 });
    scheduler.schedule(() => { small = true; return Promise.resolve(30); }, 0, { idleOnly: true, predictMs: () => 30 });
    gate.open();
    await micro();
    expect(big, 'a 400 ms prediction ran in a 150 ms window').toBe(false);
    expect(small, 'a task behind it was blocked').toBe(true);
    expect(scheduler.hasWork()).toBe(true);
  });

  it('runs an idleOnly job only in a window, never in an ordinary idle callback', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    let ran = false;
    scheduler.schedule(() => { ran = true; return Promise.resolve(10); }, 0, { idleOnly: true });
    await micro();
    expect(ran).toBe(false);
    gate.open();
    await micro();
    expect(ran).toBe(true);
  });

  it('stops starting tasks the moment the window closes', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    const ran: number[] = [];
    scheduler.schedule(() => Promise.resolve(80));
    for (let i = 0; i < 3; i++) {
      scheduler.schedule(() => { ran.push(i); if (i === 0) gate.close(); return Promise.resolve(20); }, 0, { predictMs: () => 20 });
    }
    await micro();
    gate.open();
    await micro();
    expect(ran).toEqual([0]);
  });

  it('a window task over the active budget does not park the queue', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    gate.open();
    const ran: string[] = [];
    scheduler.schedule(() => { ran.push('window'); return Promise.resolve(120); }, 0, { idleOnly: true, predictMs: () => 120 });
    scheduler.schedule(() => { ran.push('next'); return Promise.resolve(10); });
    await micro();
    expect(ran).toEqual(['window', 'next']);
    expect(scheduler.perf().longTasks).toBe(1);
    expect(scheduler.perf().aborted).toBe(false);
  });

  it('without a gate, behaves exactly as before: parked until drain', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    let second = false;
    scheduler.schedule(() => Promise.resolve(80));
    scheduler.schedule(() => { second = true; return Promise.resolve(1); });
    await micro();
    expect(second).toBe(false);
    await scheduler.drain();
    expect(second).toBe(true);
  });

  it('works with the setTimeout fallback when there is no requestIdleCallback', async () => {
    const gate = manualGate();
    const win = { setTimeout: (cb: () => void) => setTimeout(cb, 0), clearTimeout: (h: number) => clearTimeout(h) } as unknown as Window;
    const scheduler = Scheduler({ win, gate });
    let ran = false;
    scheduler.schedule(() => { ran = true; return Promise.resolve(10); }, 0, { idleOnly: true });
    gate.open();
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(true);
  });
});

describe('Scheduler drain order', () => {
  it('runs first-jobs first, drops drop-jobs, then the rest; drain({ first }) stops after the first-jobs', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    const ran: string[] = [];
    const dropped: string[] = [];
    scheduler.schedule(() => Promise.resolve(80)); // parks
    scheduler.schedule(() => { ran.push('chunk'); return Promise.resolve(10); });
    scheduler.schedule(() => { ran.push('grid'); return Promise.resolve(10); }, 0, { idleOnly: true, atDrain: 'first' });
    scheduler.schedule(() => { ran.push('huge'); return Promise.resolve(10); }, 0, { idleOnly: true, atDrain: 'drop', onDrop: () => dropped.push('huge') });
    await micro();
    await scheduler.drain({ first: true });
    expect(ran).toEqual(['grid']);
    expect(dropped).toEqual(['huge']);
    expect(scheduler.hasWork()).toBe(true);
    await scheduler.drain();
    expect(ran).toEqual(['grid', 'chunk']);
    expect(scheduler.hasWork()).toBe(false);
    expect(scheduler.perf().aborted).toBe(false);
  });

  it('waits for an in-flight window task before running anything, so axe never runs twice at once', async () => {
    const gate = manualGate();
    const scheduler = Scheduler({ win: idleWindow(), gate });
    let inFlight = 0;
    let overlapped = false;
    let release!: () => void;
    const job = (hold: boolean) => async () => {
      if (inFlight > 0) overlapped = true;
      inFlight++;
      if (hold) await new Promise<void>((r) => { release = r; });
      inFlight--;
      return 10;
    };
    scheduler.schedule(job(true), 0, { idleOnly: true });
    scheduler.schedule(job(false), 0, { idleOnly: true, atDrain: 'first' });
    gate.open();
    await micro();
    gate.close();
    const draining = scheduler.drain();
    await micro();
    release();
    await draining;
    expect(overlapped).toBe(false);
    expect(scheduler.hasWork()).toBe(false);
  });

  it('reports the page tier once set, and idleRuns only when there were any', () => {
    const scheduler = Scheduler({ win: idleWindow() });
    expect(scheduler.perf().tier).toBeUndefined();
    expect('idleRuns' in scheduler.perf()).toBe(false);
    scheduler.setTier('medium');
    expect(scheduler.perf().tier).toBe('medium');
  });
});

describe('Scheduler mid-drain', () => {
  function heldJobs() {
    let inFlight = 0;
    let overlapped = false;
    let starts = 0;
    let release!: () => void;
    const held = async () => {
      if (inFlight > 0) overlapped = true;
      inFlight++; starts++;
      await new Promise<void>((r) => { release = r; });
      inFlight--;
      return 10;
    };
    return { held, release: () => release(), state: () => ({ overlapped, starts }) };
  }

  it('counts the last drained job as in flight, and abandon() marks the page unfinished', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    const h = heldJobs();
    scheduler.schedule(() => Promise.resolve(80)); // parks
    scheduler.schedule(h.held);
    await micro();
    const draining = scheduler.drain();
    await micro();
    expect(h.state().starts).toBe(1);
    expect(scheduler.hasWork()).toBe(true);
    expect(scheduler.perf().aborted).toBe(true);
    scheduler.abandon();
    h.release();
    await draining;
    expect(scheduler.perf().aborted).toBe(true);
  });

  it('a second drain during a held job does not run anything alongside it', async () => {
    const scheduler = Scheduler({ win: idleWindow() });
    const h = heldJobs();
    scheduler.schedule(() => Promise.resolve(80));
    scheduler.schedule(h.held);
    scheduler.schedule(h.held);
    await micro();
    const first = scheduler.drain();
    await micro();
    const second = scheduler.drain();
    await micro();
    h.release();
    await micro();
    h.release();
    await Promise.all([first, second]);
    expect(h.state()).toEqual({ overlapped: false, starts: 2 });
    expect(scheduler.hasWork()).toBe(false);
  });
});

describe('Scheduler.hasWork and window-only parts', () => {
  it('does not count a drain-first or drop window-only job as queued scanning', () => {
    const scheduler = Scheduler({ win: idleWindow(), gate: manualGate() });
    scheduler.schedule(() => Promise.resolve(1), 0, { idleOnly: true, atDrain: 'first' });
    scheduler.schedule(() => Promise.resolve(1), 0, { idleOnly: true, atDrain: 'drop' });
    expect(scheduler.hasWork()).toBe(false);
    scheduler.schedule(() => Promise.resolve(1), 0, { idleOnly: true });
    expect(scheduler.hasWork()).toBe(true);
  });

  it('is not aborted when parked with only window-only parts left, and is when scanning is left', async () => {
    const scheduler = Scheduler({ win: idleWindow(), gate: manualGate() });
    scheduler.schedule(() => Promise.resolve(80)); // over budget: parks the queue
    scheduler.schedule(() => Promise.resolve(1), 0, { idleOnly: true, atDrain: 'first' });
    await micro();
    expect(scheduler.perf().aborted).toBe(false);
    scheduler.schedule(() => Promise.resolve(1));
    expect(scheduler.perf().aborted).toBe(true);
  });
});
