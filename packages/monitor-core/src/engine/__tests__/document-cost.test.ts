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
    await runDocumentCost(axe, document);
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
    await runDocumentCost(axe, document);

    expect(axe.calls[0]!.context).toBe(document);
    expect(axe.calls[0]!.options.runOnly).toEqual({ type: 'rule', values: PAGE_LEVEL_RULES });
    expect(axe.calls[1]!.context).toBe(document);
    expect(axe.calls[1]!.options.runOnly).toEqual({ type: 'rule', values: DOCUMENT_COST_RULES });
  });
});

describe('Engine document-cost scheduling', () => {
  function build(axe: AxeLike, contrastDeferMaxElements = 3000, chunkMax?: number) {
    const scheduler = Scheduler({ win: idleWindow(), chunkMax });
    const engine = Engine({
      doc: document,
      win: idleWindow(),
      axe,
      scheduler,
      onViolation: () => {},
      contrastDeferMaxElements,
    });
    return { scheduler, engine };
  }

  const documentCostRuns = (axe: AxeLike & { calls: Call[] }): Call[] =>
    axe.calls.filter((c) => c.options.runOnly?.values === DOCUMENT_COST_RULES);

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

    await engine.runDeferredDocumentCost();
    expect(documentCostRuns(axe)).toHaveLength(1);
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

    await engine.runDeferredDocumentCost();

    expect(documentCostRuns(axe)).toHaveLength(1);
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
        if (runOnly?.values === DOCUMENT_COST_RULES) {
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
    void engine.runDeferredDocumentCost();
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

  it('skips the pass outright above the defer ceiling', async () => {
    document.body.innerHTML = `<main>${'<p>x</p>'.repeat(40)}</main>`;
    const axe = fakeAxe();
    const { scheduler, engine } = build(axe, 20);

    engine.scanFull();
    await micro();

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
    const { scheduler, engine } = build(axe, 20);

    engine.scanFull();
    await micro();
    expect(scheduler.perf().skipped).toEqual(DOCUMENT_COST_RULES);

    // The SPA swaps in a much smaller view: the pass is worth running again,
    // so the rules move from skipped to waiting, then run at tab-hide.
    document.body.innerHTML = '<main><p>small</p></main>';
    engine.scanDocumentCost();
    expect(scheduler.perf().skipped, 'a rule now waiting was still reported as skipped').toBeUndefined();
    expect(scheduler.perf().pending).toEqual(DOCUMENT_COST_RULES);

    await engine.runDeferredDocumentCost();
    expect(documentCostRuns(axe)).toHaveLength(1);
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
    const { engine } = build(axe, 0, 20);

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

    await engine.runDeferredDocumentCost();
    expect(documentCostRuns(axe)).toHaveLength(1);
    expect(scheduler.perf().skipped).toBeUndefined();
  });
});
