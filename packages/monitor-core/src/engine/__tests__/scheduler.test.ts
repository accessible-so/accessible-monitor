import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../scheduler';

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
