// @vitest-environment jsdom
/**
 * The third rule set: rules that are element-level in meaning but
 * document-level in cost.
 *
 * Two things have to hold, and neither is visible from the outside without
 * looking at what the engine actually asks axe to do: the document-cost rules
 * run exactly once, on the document; and no chunk run may run them again,
 * because that is the whole point — a chunk run that includes `color-contrast`
 * pays axe's whole-page grid cost for a handful of elements.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_COST_NEVER_RUN,
  DOCUMENT_COST_PARTS,
  DOCUMENT_COST_RULES,
  ELEMENT_TAGS,
  PAGE_LEVEL_RULES,
  runChunk,
  runDocumentCost,
  runPage,
} from '../axe-runner';
import type { AxeLike, AxeResultsLike } from '../axe-runner';
import { Engine } from '../index';
import { Scheduler } from '../scheduler';
import { RumBeaconSchema } from '../../protocol/schema';
import type { IdleGateApi } from '../idle-gate';

interface Call {
  context: Element | Document | { include: Element[]; exclude?: Element[] };
  options: {
    runOnly?: { type: string; values: string[] };
    rules?: Record<string, { enabled: false }>;
  };
}

function fakeAxe(): AxeLike & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run(context: Call['context'], options: object): Promise<AxeResultsLike> {
      calls.push({ context, options: options as Call['options'] });
      return Promise.resolve({ violations: [] });
    },
  };
}

/** A window whose idle callback runs synchronously, so the queue drains in microtasks. */
function idleWindow(): Window {
  return {
    requestIdleCallback: (cb: () => void) => { cb(); return 1; },
    cancelIdleCallback: () => {},
    setTimeout: (cb: () => void) => setTimeout(cb, 0) as unknown as number,
    clearTimeout: (h: number) => clearTimeout(h),
  } as unknown as Window;
}

const micro = async (turns = 60): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

describe('the document-cost rule set', () => {
  it('is disjoint from the page-level set, and both are off inside a chunk run', async () => {
    // A rule in both sets would be run twice and reported twice.
    for (const rule of DOCUMENT_COST_RULES) expect(PAGE_LEVEL_RULES).not.toContain(rule);
    expect(DOCUMENT_COST_RULES).toContain('color-contrast');
    // `region` walks every element in the document on every run, which is the
    // same cost shape as the contrast grid.
    expect(DOCUMENT_COST_RULES).toContain('region');

    const axe = fakeAxe();
    const el = document.createElement('div');
    await runChunk(axe, { include: [el] });

    const call = axe.calls[0]!;
    expect(call.context).toBe(el);
    expect(call.options.runOnly).toEqual({ type: 'tag', values: ELEMENT_TAGS });
    for (const rule of [...PAGE_LEVEL_RULES, ...DOCUMENT_COST_RULES]) {
      expect(call.options.rules?.[rule], `${rule} was not disabled in the chunk run`).toEqual({
        enabled: false,
      });
    }
  });

  it('splits into a grid part and a region part that together are the whole set, in order', () => {
    expect(DOCUMENT_COST_PARTS.map((p) => p.name)).toEqual(['grid', 'region']);
    expect(DOCUMENT_COST_PARTS.flatMap((p) => p.rules)).toEqual(DOCUMENT_COST_RULES);
  });

  it('runs one document-cost part by rule id', async () => {
    const axe = fakeAxe();
    await runDocumentCost(axe, document, ['region']);
    expect(axe.calls[0]!.context).toBe(document);
    expect(axe.calls[0]!.options.runOnly).toEqual({ type: 'rule', values: ['region'] });
  });

  it('never asks axe to run an AAA contrast rule, in any of the three shapes', async () => {
    // `runOnly: { type: 'rule' }` force-enables whatever it names, regardless of
    // the rule's own `enabled` flag — so naming `color-contrast-enhanced` would
    // run it. It reports 1.4.6, which the scanner tier never produces, so the
    // same contrast defect would arrive twice under two rule keys.
    expect(DOCUMENT_COST_RULES).not.toContain('color-contrast-enhanced');
    expect(DOCUMENT_COST_NEVER_RUN).toContain('color-contrast-enhanced');

    const axe = fakeAxe();
    const el = document.createElement('div');
    await runPage(axe, document);
    await runDocumentCost(axe, document, DOCUMENT_COST_RULES);
    await runChunk(axe, { include: [el] });

    expect(axe.calls).toHaveLength(3);
    for (const call of axe.calls) {
      for (const rule of DOCUMENT_COST_NEVER_RUN) {
        expect(call.options.runOnly?.values ?? [], `${rule} was asked to run`).not.toContain(rule);
      }
    }
    // But it is still turned off inside a chunk run, so no tag set can pull it in.
    for (const rule of DOCUMENT_COST_NEVER_RUN) {
      expect(axe.calls[2]!.options.rules?.[rule]).toEqual({ enabled: false });
    }
  });

  it('hands axe a group of siblings as one context, so a chunk is one run', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<p></p><p></p><p></p>';
    const siblings = Array.from(host.children);
    const axe = fakeAxe();

    await runChunk(axe, { include: siblings });

    // Three sibling elements, one `axe.run` — which is the whole reason a chunk
    // is a group: every run pays axe's fixed per-document setup again.
    expect(axe.calls).toHaveLength(1);
    expect(axe.calls[0]!.context).toEqual({ include: siblings });
  });

  it('runs page-level and document-cost rules on the document, by rule id', async () => {
    const axe = fakeAxe();
    await runPage(axe, document);
    await runDocumentCost(axe, document, DOCUMENT_COST_RULES);

    expect(axe.calls[0]!.context).toBe(document);
    expect(axe.calls[0]!.options.runOnly).toEqual({ type: 'rule', values: PAGE_LEVEL_RULES });
    expect(axe.calls[1]!.context).toBe(document);
    expect(axe.calls[1]!.options.runOnly).toEqual({ type: 'rule', values: DOCUMENT_COST_RULES });
  });
});

describe('Engine document-cost scheduling', () => {
  function build(
    axe: AxeLike,
    o: { contrastDeferMaxElements?: number; chunkMax?: number; gate?: IdleGateApi; now?: () => number; firstRunInWindow?: boolean; learned?: Record<string, number>; onLearned?: (l: Record<string, number>) => void } = {},
  ) {
    const scheduler = Scheduler({ win: idleWindow(), chunkMax: o.chunkMax, gate: o.gate });
    const engine = Engine({
      doc: document,
      win: idleWindow(),
      axe,
      scheduler,
      onViolation: () => {},
      contrastDeferMaxElements: o.contrastDeferMaxElements ?? 3000,
      now: o.now,
      firstRunInWindow: o.firstRunInWindow,
      learned: o.learned,
      onLearned: o.onLearned as never,
    });
    return { scheduler, engine };
  }

  const documentCostRuns = (axe: AxeLike & { calls: Call[] }): Call[] =>
    axe.calls.filter((c) => DOCUMENT_COST_PARTS.some((p) => p.rules === c.options.runOnly?.values));

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

  /** Every run advances `clock.t` by a cost chosen from what it was asked to run. */
  function costedAxe(cost: { page: number; grid: number; region: number; chunk: number }) {
    const clock = { t: 0 };
    const base = fakeAxe();
    const axe = {
      calls: base.calls,
      run(context: Element | Document, options: Parameters<AxeLike['run']>[1]) {
        const runOnly = (options as Call['options'] | undefined)?.runOnly;
        const values = runOnly?.type === 'rule' ? runOnly.values : null;
        clock.t += values === PAGE_LEVEL_RULES ? cost.page
          : values?.includes('region') ? cost.region
          : values?.includes('color-contrast') ? cost.grid
          : cost.chunk;
        return base.run(context, options);
      },
    };
    return { axe, now: () => clock.t };
  }

  it('defers the pass even on a small page, and runs it on the document when asked', async () => {
    // A 120-element page costs ~22ms on a fast laptop and ~76ms on a mid-range
    // phone: no size is small enough to run it while the visitor is looking.
    document.body.innerHTML = '<main><p>small</p></main>';
    const axe = fakeAxe();
    const { scheduler, engine } = build(axe);

    engine.scanFull();
    await micro();
    expect(documentCostRuns(axe), 'ran while the visitor was looking').toHaveLength(0);
    expect(engine.hasDeferredDocumentCost()).toBe(true);
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);

    await scheduler.drain({ first: true });
    expect(documentCostRuns(axe).map((c) => c.options.runOnly!.values)).toEqual([DOCUMENT_COST_PARTS[0]!.rules, DOCUMENT_COST_PARTS[1]!.rules]);
    expect(documentCostRuns(axe)[0]!.context).toBe(document);
    expect(engine.hasDeferredDocumentCost()).toBe(false);
    expect(scheduler.perf().pending, 'a pass that ran is not pending').toBeUndefined();
    expect(scheduler.perf().skipped, 'nothing was skipped, so the field is absent').toBeUndefined();
  });

  it('defers the pass between the thresholds, and runs it when asked', async () => {
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(40)}</main>`;
    const axe = fakeAxe();
    // The page sits above the immediate threshold and below the defer ceiling.
    const { scheduler, engine } = build(axe);

    engine.scanFull();
    await micro();

    // Nothing ran while the visitor was looking, and nothing is claimed as skipped:
    // the pass has not been given up on, only postponed.
    expect(documentCostRuns(axe)).toHaveLength(0);
    expect(engine.hasDeferredDocumentCost()).toBe(true);
    expect(scheduler.perf().skipped).toBeUndefined();
    expect(scheduler.perf().pending, 'a postponed pass says so').toEqual(DOCUMENT_COST_RULES);

    await scheduler.drain({ first: true });

    expect(documentCostRuns(axe)).toHaveLength(2);
    expect(engine.hasDeferredDocumentCost()).toBe(false);
    expect(scheduler.perf().skipped, 'a pass that ran is not a pass that was skipped').toBeUndefined();
    expect(scheduler.perf().pending, 'a pass that ran is not still pending').toBeUndefined();
    // Its time is accounted for exactly as a queued job's would be.
    expect(scheduler.perf().scans).toBeGreaterThan(0);
  });

  it('names the rules when a deferred pass is abandoned', async () => {
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(40)}</main>`;
    const axe = fakeAxe();
    const { scheduler, engine } = build(axe);

    engine.scanFull();
    await micro();
    expect(engine.abandonDeferredDocumentCost()).toBe(true);

    expect(documentCostRuns(axe)).toHaveLength(0);
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);
    expect(scheduler.perf().pending, 'an abandoned pass is skipped, not pending').toBeUndefined();
    // Abandoning twice is a no-op, and a pass that already ran cannot be abandoned.
    expect(engine.abandonDeferredDocumentCost()).toBe(false);
  });

  it('keeps the pass abandonable while it is still running, and drops its late result', async () => {
    document.body.innerHTML = '<main><p>x</p></main>';
    let release: ((r: AxeResultsLike) => void) | undefined;
    const stuck = {
      run: (_c: unknown, options: object) => {
        const runOnly = (options as { runOnly?: { values: string[] } }).runOnly;
        if (DOCUMENT_COST_PARTS.some((p) => p.rules === runOnly?.values)) {
          return new Promise<AxeResultsLike>((resolve) => { release = resolve; });
        }
        return Promise.resolve({ violations: [] });
      },
    } as unknown as AxeLike;
    const reported: string[] = [];
    const scheduler = Scheduler({ win: idleWindow() });
    const engine = Engine({
      doc: document,
      win: idleWindow(),
      axe: stuck,
      scheduler,
      onViolation: (v) => reported.push(v.id),
      contrastDeferMaxElements: 3000,
    });

    engine.scanDocumentCost();
    expect(engine.hasDeferredDocumentCost()).toBe(true);
    void scheduler.drain({ first: true });
    await micro();

    // Still pending: the flag is not cleared until the pass has actually run,
    // so an unloading page can still say the rules were not checked.
    expect(engine.abandonDeferredDocumentCost()).toBe(true);
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);

    // The pass then finishes, too late. Its findings must not be reported after
    // the beacon has already said those rules did not run.
    release?.({
      violations: [{
        id: 'color-contrast',
        impact: 'serious',
        tags: ['cat.color', 'wcag2aa', 'wcag143'],
        nodes: [{ target: ['#late'], element: document.querySelector('p') }],
      }],
    });
    await micro();
    expect(reported, 'a late deferred result was reported after being abandoned').toEqual([]);
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);
  });

  it('skips the pass at drain above the defer ceiling', async () => {
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(40)}</main>`;
    const axe = fakeAxe();
    const { scheduler, engine } = build(axe, { contrastDeferMaxElements: 20 });

    engine.scanFull();
    await micro();
    await scheduler.drain();

    expect(documentCostRuns(axe)).toHaveLength(0);
    expect(engine.hasDeferredDocumentCost(), 'too large to be worth deferring').toBe(false);
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);
    expect(scheduler.perf().pending, 'nothing is waiting; it was never started').toBeUndefined();
    // The rest of the page is still scanned: skipping contrast is not giving up.
    expect(axe.calls.length).toBeGreaterThan(1);
  });

  it('takes rules back off the skipped list when a later route does run them', async () => {
    // A big page skips the pass; a client-side route change onto a small one
    // runs it. The beacon must not still claim those rules went unchecked.
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(40)}</main>`;
    const axe = fakeAxe();
    const { scheduler, engine } = build(axe, { contrastDeferMaxElements: 20 });

    engine.scanFull();
    await micro();
    await scheduler.drain();
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);

    // The SPA swaps in a much smaller view: the pass is worth running again,
    // so the rules move from skipped to waiting, then run at tab-hide.
    document.body.innerHTML = '<main><p>small</p></main>';
    engine.scanDocumentCost();
    expect(scheduler.perf().skipped, 'a rule now waiting was still reported as skipped').toBeUndefined();
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);

    await scheduler.drain({ first: true });
    expect(documentCostRuns(axe)).toHaveLength(2);
    expect(scheduler.perf().skipped).toBeUndefined();
    expect(scheduler.perf().pending).toBeUndefined();
  });

  /**
   * A container that chunking descends into used to be scanned by nothing: the
   * chunks under it cover its children, and no chunk covered it. This asserts
   * the engine really does hand axe that container, with its children excluded.
   */
  it('scans a container it descended into, with its children excluded', async () => {
    document.body.innerHTML = '<main><select>' + '<option></option>'.repeat(40) + '</select></main>';
    const axe = fakeAxe();
    // A chunk budget small enough that <main> and <select> are both split, and
    // large enough that the <select>'s subtree still affords a container chunk.
    const { engine } = build(axe, { contrastDeferMaxElements: 0, chunkMax: 20 });

    engine.scanFull();
    await micro();

    const select = document.querySelector('select')!;
    const options = Array.from(select.children);
    const contexts = axe.calls.map((c) => c.context);
    const container = contexts.find(
      (c) => typeof c === 'object' && c !== null && 'include' in c && c.include[0] === select,
    ) as { include: Element[]; exclude?: Element[] } | undefined;

    expect(container, 'the <select> was never handed to axe').toBeTruthy();
    expect(container!.include).toEqual([select]);
    expect(container!.exclude, 'its options would be scanned twice').toEqual(options);
    // The options are still covered by chunks of their own.
    const optionChunks = contexts.filter(
      (c) => typeof c === 'object' && c !== null && 'include' in c && c.include[0]?.tagName === 'OPTION',
    );
    expect(optionChunks.length).toBeGreaterThan(0);
  });

  it('keeps one pass waiting across a client-side route change, for the view showing at tab-hide', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const axe = fakeAxe();
    const { scheduler, engine } = build(axe);

    engine.scanFull();
    await micro();
    engine.scanDocumentCost();
    await micro();
    expect(documentCostRuns(axe), 'a route change must not run it while the visitor is looking').toHaveLength(0);

    await scheduler.drain({ first: true });
    expect(documentCostRuns(axe)).toHaveLength(2);
    expect(scheduler.perf().skipped).toBeUndefined();
  });

  it('queues the two parts as window-only jobs, pending until they run', async () => {
    const axe = fakeAxe();
    const { engine, scheduler } = build(axe);
    engine.scanFull();
    await micro();
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);
    expect(documentCostRuns(axe)).toHaveLength(0);
    expect(engine.hasDeferredDocumentCost()).toBe(true);
    await scheduler.drain();
    expect(scheduler.perf().pending).toBeUndefined();
    expect(documentCostRuns(axe).map((c) => c.options.runOnly!.values)).toEqual([DOCUMENT_COST_PARTS[0]!.rules, DOCUMENT_COST_PARTS[1]!.rules]);
  });

  it('runs both parts in an idle window when their predictions fit: a fast page', async () => {
    // First run 12 ms on a tiny page: grid ~36, region ~6 — both within 150.
    document.body.innerHTML = '<main><p>small</p></main>';
    const { axe, now } = costedAxe({ page: 12, grid: 30, region: 20, chunk: 5 });
    const gate = manualGate();
    const { engine, scheduler } = build(axe, { gate, now });
    engine.scanFull();
    await micro();
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);
    gate.open();
    await micro();
    expect(scheduler.perf().pending).toBeUndefined();
    expect(scheduler.perf().tier).toBe('fast');
  });

  it('leaves a part for tab-hide when its prediction does not fit a window: a medium page', async () => {
    // First run 20 ms on 1,500 elements: grid predicted 20 x 25.5 = 510 (does not fit), region 20 x 1.7 = 34 (fits).
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(1500)}</main>`;
    const { axe, now } = costedAxe({ page: 20, grid: 40, region: 20, chunk: 5 });
    const gate = manualGate();
    const { engine, scheduler } = build(axe, { gate, now });
    engine.scanFull();
    await micro();
    gate.open();
    await micro();
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_PARTS[0]!.rules);
    expect(scheduler.perf().tier).toBe('medium');
  });

  it('with no measurement the factor is exactly 1: a part that overruns its model is still predicted by the model until measured', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const { axe, now } = costedAxe({ page: 10, grid: 20, region: 60, chunk: 5 });
    const { engine } = build(axe, { gate: manualGate(), now });
    engine.scanFull();
    await micro();
    expect(engine.predictedPartMs('grid')).toBeCloseTo(10 * (3 + (15 * 2) / 1000), 5); // firstRun x model, no factor
    expect(engine.predictedPartMs('region')).toBeCloseTo(10 * (0.5 + (0.8 * 2) / 1000), 5);
  });

  it('first page: grid actual 80 against a 200 model reports 0.4; a second engine seeded with it predicts 100 and runs it in a window', async () => {
    // Pick elements so firstRun x model = 200: firstRun 40, model factor 5 -> n = 133.
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(130)}</main>`;
    const n = document.body.getElementsByTagName('*').length;
    const firstRun = 200 / (3 + (15 * n) / 1000);
    const cost = { page: firstRun, grid: 80, region: 1, chunk: 5 };
    expect(firstRun).toBeLessThan(50);
    const c1 = costedAxe(cost);
    const seen: Record<string, number>[] = [];
    const first = build(c1.axe, { gate: manualGate(), now: c1.now, onLearned: (l) => seen.push(l) });
    first.engine.scanFull();
    await micro();
    expect(first.engine.predictedPartMs('grid')).toBeCloseTo(200, 5);
    expect(documentCostRuns(c1.axe), 'over the window: waits for tab-hide').toHaveLength(0);
    await first.scheduler.drain();
    expect(seen.at(-1)!.grid).toBeCloseTo(0.4, 5);
    first.engine.stop();

    const c2 = costedAxe(cost);
    const gate = manualGate();
    const second = build(c2.axe, { gate, now: c2.now, learned: { grid: 0.4 } });
    second.engine.scanFull();
    await micro();
    expect(second.engine.predictedPartMs('grid')).toBeCloseTo(200 * 0.4 * 1.25, 5);
    gate.open();
    await micro();
    expect(documentCostRuns(c2.axe).some((c) => c.options.runOnly?.values?.includes('color-contrast')), 'grid ran in the window').toBe(true);
  });

  it('floors the ratio at 0.25 before the headroom', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const c = costedAxe({ page: 10, grid: 20, region: 60, chunk: 5 });
    const { engine } = build(c.axe, { gate: manualGate(), now: c.now, learned: { grid: 0.05 } });
    engine.scanFull();
    await micro();
    expect(engine.predictedPartMs('grid')).toBeCloseTo(10 * (3 + 30 / 1000) * 0.25 * 1.25, 5);
  });

  it('a heavier later measurement raises the maximum; a lighter one leaves it', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const model = 10 * (3 + 30 / 1000);
    const seen: Record<string, number>[] = [];
    const run = async (grid: number, learned?: Record<string, number>) => {
      const c = costedAxe({ page: 10, grid, region: 1, chunk: 5 });
      const gate = manualGate();
      const { engine } = build(c.axe, { gate, now: c.now, learned: { region: 5, ...learned }, onLearned: (l) => seen.push(l) });
      engine.scanFull();
      await micro();
      gate.open();
      await micro();
      return engine;
    };
    await run(0.4 * model);
    expect(seen.at(-1)!.grid).toBeCloseTo(0.4, 5);
    const calls = seen.length;
    const heavier = await run(0.9 * model, { grid: 0.4 });
    expect(seen.at(-1)!.grid).toBeCloseTo(0.9, 5);
    expect(heavier.predictedPartMs('grid')).toBeCloseTo(model * 0.9 * 1.25, 5);
    const n = seen.length;
    const lighter = await run(0.2 * model, { grid: 0.4 });
    expect(seen.length, 'a lighter measurement changes nothing and reports nothing').toBe(n);
    expect(lighter.predictedPartMs('grid')).toBeCloseTo(model * 0.4 * 1.25, 5);
    expect(calls).toBeGreaterThan(0);
  });

  it('a failed first run leaves the page uncalibrated: no tier, parts never run in a window, still run at drain', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const base = fakeAxe();
    const axe = {
      calls: base.calls,
      run(context: Element | Document, options: Parameters<AxeLike['run']>[1]) {
        const runOnly = (options as Call['options'] | undefined)?.runOnly;
        if (runOnly?.values === PAGE_LEVEL_RULES) return Promise.reject(new Error('boom'));
        return base.run(context, options);
      },
    };
    const gate = manualGate();
    const tiers: string[] = [];
    const scheduler = Scheduler({ win: idleWindow(), gate });
    const engine = Engine({ doc: document, win: idleWindow(), axe, scheduler, onViolation: () => {}, onTier: (t) => tiers.push(t) });
    engine.scanFull();
    await micro();
    expect(scheduler.perf().tier).toBeUndefined();
    expect(tiers).toEqual([]);
    gate.open();
    await micro();
    expect(documentCostRuns(base), 'a part ran in a window on an uncalibrated page').toHaveLength(0);
    await scheduler.drain();
    expect(documentCostRuns(base)).toHaveLength(2);
  });

  it('a first run measured at 0 ms gives no chunk prediction, and a failed chunk run does not change it', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const zero = build(fakeAxe(), { now: () => 0 });
    zero.engine.scanFull();
    await micro();
    expect(zero.engine.predictedChunkMs()).toBeNull();

    const clock = { t: 0 };
    let failChunks = false;
    const base = fakeAxe();
    const axe = {
      calls: base.calls,
      run(context: Element | Document, options: Parameters<AxeLike['run']>[1]) {
        const runOnly = (options as Call['options'] | undefined)?.runOnly;
        if (runOnly?.type === 'rule') { clock.t += 10; return base.run(context, options); }
        clock.t += failChunks ? 50 : 5;
        return failChunks ? Promise.reject(new Error('boom')) : base.run(context, options);
      },
    };
    const { engine } = build(axe, { now: () => clock.t });
    engine.scanFull();
    await micro();
    expect(engine.predictedChunkMs()).toBe(5);
    failChunks = true;
    engine.scanRoots([document.querySelector('main')!]);
    await micro();
    expect(engine.predictedChunkMs()).toBe(5);
  });

  it('starts from measured ratios, ignoring invalid ones (not finite or not above 0)', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const cost = { page: 10, grid: 20, region: 60, chunk: 5 };
    const plain = costedAxe(cost);
    const base = build(plain.axe, { gate: manualGate(), now: plain.now });
    base.engine.scanFull();
    await micro();
    const regionBase = base.engine.predictedPartMs('region')!;

    const two = costedAxe(cost);
    const d = build(two.axe, { gate: manualGate(), now: two.now, learned: { region: 2 } });
    d.engine.scanFull();
    await micro();
    expect(d.engine.predictedPartMs('region')).toBeCloseTo(regionBase * 2 * 1.25, 5);

    const half = costedAxe(cost);
    const h = build(half.axe, { gate: manualGate(), now: half.now, learned: { region: 0.5 } });
    h.engine.scanFull();
    await micro();
    expect(h.engine.predictedPartMs('region'), 'below 1 is a measurement now').toBeCloseTo(regionBase * 0.5 * 1.25, 5);

    for (const bad of [0, NaN, Infinity, -1]) {
      const c = costedAxe(cost);
      const b = build(c.axe, { gate: manualGate(), now: c.now, learned: { region: bad } });
      b.engine.scanFull();
      await micro();
      expect(b.engine.predictedPartMs('region'), `${bad} was not ignored`).toBeCloseTo(regionBase, 5);
    }
  });

  it('calibrates as medium when persisted multipliers push a part over the window', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const { axe, now } = costedAxe({ page: 10, grid: 20, region: 20, chunk: 5 });
    const fast = build(axe, { gate: manualGate(), now });
    fast.engine.scanFull();
    await micro();
    expect(fast.scheduler.perf().tier).toBe('fast');
    const c = costedAxe({ page: 10, grid: 20, region: 20, chunk: 5 });
    const slowish = build(c.axe, { gate: manualGate(), now: c.now, learned: { grid: 10 } });
    slowish.engine.scanFull();
    await micro();
    expect(slowish.scheduler.perf().tier).toBe('medium');
  });

  it('a failed page-level run leaves the page not fully scanned, and its beacon still validates', async () => {
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(40)}</main>`;
    const base = fakeAxe();
    const axe = {
      calls: base.calls,
      run(context: Element | Document, options: Parameters<AxeLike['run']>[1]) {
        if ((options as Call['options']).runOnly?.values === PAGE_LEVEL_RULES) return Promise.reject(new Error('boom'));
        return base.run(context, options);
      },
    };
    const { scheduler, engine } = build(axe, { contrastDeferMaxElements: 20 });
    engine.scanFull();
    await micro();
    await scheduler.drain();
    const perf = scheduler.perf();
    expect(perf.aborted).toBe(true);
    expect(perf.skipped).toEqual(DOCUMENT_COST_RULES);
    const beacon = {
      v: 1, k: 'acc_rum_' + 'a'.repeat(24), s: 'b'.repeat(32), c: '0.2.0', sent: 1,
      ctx: { vw: 1280, vh: 800, dpr: 2, zoom: 1, fontPx: 16, navigationMode: 'unknown' }, perf,
    };
    expect(RumBeaconSchema.safeParse(beacon).success).toBe(true);
  });

  it('a failed chunk run leaves the page not fully scanned, even after a full drain', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const base = fakeAxe();
    const axe = {
      calls: base.calls,
      run(context: Element | Document, options: Parameters<AxeLike['run']>[1]) {
        if ((options as Call['options']).runOnly?.type === 'tag') return Promise.reject(new Error('boom'));
        return base.run(context, options);
      },
    };
    const { scheduler, engine } = build(axe);
    engine.scanFull();
    await micro();
    await scheduler.drain();
    expect(scheduler.perf().aborted).toBe(true);
  });

  it('recomputes the tier when a route change re-arms on a bigger page', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const { axe, now } = costedAxe({ page: 12, grid: 30, region: 20, chunk: 5 });
    const { engine, scheduler } = build(axe, { gate: manualGate(), now });
    engine.scanFull();
    await micro();
    expect(scheduler.perf().tier).toBe('fast');
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(1500)}</main>`;
    engine.scanDocumentCost();
    expect(scheduler.perf().tier).toBe('medium');
  });

  it('drops the parts at drain on a page over the element ceiling, reporting them skipped', async () => {
    const axe = fakeAxe();
    const { engine, scheduler } = build(axe, { contrastDeferMaxElements: 1 });
    engine.scanFull();
    await micro();
    expect(engine.hasDeferredDocumentCost(), 'a part that can only be dropped is not deferred work').toBe(false);
    await scheduler.drain();
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);
    expect(scheduler.perf().pending).toBeUndefined();
  });

  it('a re-arm abandons nothing on its own; abandon reports the pending parts as skipped', async () => {
    const axe = fakeAxe();
    const { engine, scheduler } = build(axe);
    engine.scanFull();
    await micro();
    expect(engine.abandonDeferredDocumentCost()).toBe(true);
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);
    expect(engine.abandonDeferredDocumentCost()).toBe(false);
    engine.scanDocumentCost();
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);
    expect(scheduler.perf().skipped).toBeUndefined();
  });

  it('with firstRunInWindow, the first run waits for a window', async () => {
    const axe = fakeAxe();
    const gate = manualGate();
    const { engine } = build(axe, { gate, firstRunInWindow: true });
    engine.scanFull();
    await micro();
    expect(axe.calls, 'something ran before a window').toHaveLength(0);
    gate.open();
    await micro();
    expect(axe.calls.some((c) => c.context === document && c.options.runOnly?.values === PAGE_LEVEL_RULES)).toBe(true);
  });

  it('abandons parts a dead scheduler cannot run, reporting them skipped', async () => {
    document.body.innerHTML = '<main><p>x</p></main>';
    const axe = fakeAxe();
    const scheduler = Scheduler({ win: idleWindow(), maxScans: 1 });
    const engine = Engine({ doc: document, win: idleWindow(), axe, scheduler, onViolation: () => {} });
    engine.scanFull();
    await micro();
    await scheduler.drain({ first: true });
    expect(engine.hasDeferredDocumentCost()).toBe(true);
    expect(engine.abandonDeferredDocumentCost()).toBe(true);
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);
    expect(scheduler.perf().pending).toBeUndefined();
  });

  it('treats a first run measured at 0 ms as unmeasured: no part fits a window, and the tier is not fast', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const { axe, now } = costedAxe({ page: 0, grid: 0, region: 0, chunk: 0 });
    const gate = manualGate();
    const { engine, scheduler } = build(axe, { gate, now });
    engine.scanFull();
    await micro();
    gate.open();
    await micro();
    expect(documentCostRuns(axe)).toHaveLength(0);
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);
    expect(scheduler.perf().tier).not.toBe('fast');
  });

  it('reports the rules of a part whose axe.run rejected as skipped, not checked', async () => {
    document.body.innerHTML = '<main><p>small</p></main>';
    const base = fakeAxe();
    const axe = {
      calls: base.calls,
      run(context: Element | Document, options: Parameters<AxeLike['run']>[1]) {
        const runOnly = (options as Call['options'] | undefined)?.runOnly;
        if (runOnly?.values === DOCUMENT_COST_PARTS[0]!.rules) return Promise.reject(new Error('boom'));
        return base.run(context, options);
      },
    };
    const { engine, scheduler } = build(axe);
    engine.scanFull();
    await micro();
    await scheduler.drain({ first: true });
    const perf = scheduler.perf();
    for (const r of DOCUMENT_COST_PARTS[0]!.rules) expect(perf.skipped).toContain(r);
    for (const r of DOCUMENT_COST_PARTS[0]!.rules) expect(perf.pending ?? []).not.toContain(r);
    for (const r of DOCUMENT_COST_PARTS[1]!.rules) expect(perf.skipped ?? []).not.toContain(r);
  });
});
