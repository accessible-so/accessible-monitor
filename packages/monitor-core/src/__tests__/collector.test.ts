import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLECTOR_VERSION, startCollector } from '../index';
import type { AxeLike, AxeViolationLike } from '../index';
import { DOCUMENT_COST_RULES } from '../engine/axe-runner';
import type { RumBeacon, RumConfig } from '../protocol/types';

const stub = vi.hoisted(() => ({ observersThrow: false }));

vi.mock('../observers/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observers/index')>();
  return {
    ...actual,
    attachObservers: (ctx: Parameters<typeof actual.attachObservers>[0]) => {
      if (stub.observersThrow) throw new Error('observer wiring blew up');
      return actual.attachObservers(ctx);
    },
  };
});

const CONFIG: RumConfig = {
  enabled: true,
  killSwitch: false,
  sampleRate: 1,
  boosted: [],
  endpoint: 'http://ingest.test',
  minCollector: '0.2.0',
};

interface FakeAxe extends AxeLike {
  calls: { context: Element | Document }[];
}

function fakeAxe(): FakeAxe {
  const calls: { context: Element | Document }[] = [];
  return {
    calls,
    run(context: Element | Document): Promise<{ violations: AxeViolationLike[] }> {
      calls.push({ context });
      if (context === document || context === (document as unknown as Element)) {
        const title: AxeViolationLike = {
          id: 'document-title',
          impact: 'serious',
          tags: ['cat.text-alternatives', 'wcag2a', 'wcag242'],
          nodes: [{ target: ['html'], element: document.documentElement }],
        };
        return Promise.resolve({ violations: [title] });
      }
      const violations: AxeViolationLike[] = [];
      const imgs = Array.from((context as Element).querySelectorAll('img'));
      if (imgs.length > 0) {
        violations.push({
          id: 'image-alt',
          impact: 'critical',
          tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
          nodes: imgs.map((el) => ({ target: [`#${el.id}`], element: el })),
        });
      }
      const buttons = Array.from((context as Element).querySelectorAll('button'));
      if (buttons.length > 0) {
        violations.push({
          id: 'button-name',
          impact: 'critical',
          tags: ['cat.name-role-value', 'wcag2a', 'wcag412'],
          nodes: buttons.map((el) => ({ target: [`#${el.id}`], element: el })),
        });
      }
      return Promise.resolve({ violations });
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

/** Settle without real timers: the whole scan pipeline is microtask-driven. */
async function micro(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

let beacons: RumBeacon[] = [];
let handles: { stop(): void }[] = [];
let originalSendBeacon: unknown;

beforeEach(() => {
  stub.observersThrow = false;
  beacons = [];
  handles = [];
  sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).__accessibleRumStarted;
  document.body.innerHTML = '<main><img id="a"><img id="b"></main>';
  setVisibility('visible');
  originalSendBeacon = (navigator as unknown as Record<string, unknown>).sendBeacon;
  (navigator as unknown as Record<string, unknown>).sendBeacon = undefined;
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    beacons.push(JSON.parse(String(init?.body)) as RumBeacon);
    return Promise.resolve({} as Response);
  });
  (window as unknown as Record<string, unknown>).requestIdleCallback = (cb: (d: unknown) => void) => {
    cb({ didTimeout: false, timeRemaining: () => 50 });
    return 1;
  };
  (window as unknown as Record<string, unknown>).cancelIdleCallback = () => {};
});

afterEach(() => {
  vi.useRealTimers();
  for (const h of handles) h.stop();
  vi.unstubAllGlobals();
  (navigator as unknown as Record<string, unknown>).sendBeacon = originalSendBeacon;
  delete (window as unknown as Record<string, unknown>).requestIdleCallback;
  delete (window as unknown as Record<string, unknown>).cancelIdleCallback;
  document.body.innerHTML = '';
  setVisibility('visible');
});

function start(axe: AxeLike): { stop(): void } {
  const handle = startCollector({
    siteKey: 'sk_test',
    endpoint: 'http://ingest.test',
    config: CONFIG,
    sessionId: 'sess-1',
    axe,
  });
  handles.push(handle);
  return handle;
}

describe('startCollector', () => {
  it('scans the page and sends one beacon with collapsed findings', async () => {
    const axe = fakeAxe();
    start(axe);
    await settle();

    const before = axe.calls.length;
    start(axe);
    await settle();
    expect(axe.calls.length).toBe(before);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(beacons.length).toBe(1);
    const beacon = beacons[0]!;
    expect(beacon.v).toBe(1);
    expect(beacon.k).toBe('sk_test');
    expect(beacon.s).toBe('sess-1');
    expect(beacon.session).toEqual({ started: true });
    expect(beacon.routes).toEqual([{ p: '/', r: null }]);

    const findings = beacon.findings ?? [];
    expect(findings.length).toBe(2);

    const img = findings.find((f) => f.rule === 'wcag:1.1.1')!;
    expect(img).toBeTruthy();
    expect(img.n).toBe(2);
    expect(img.i).toBe(false);
    expect(img.confidence).toBe('rule');
    expect(img.impact).toBe('critical');
    expect(img.wcag).toEqual(['1.1.1']);
    expect(img.p).toBe('/');
    expect(img.r).toBeNull();
    expect(img.el.tag).toBe('img');
    expect(img.el.text).toBeNull();
    expect(typeof img.key).toBe('string');
    expect(img.sig).toMatch(/^s1:[0-9a-f]{32}$/);

    const title = findings.find((f) => f.rule === 'wcag:2.4.2')!;
    expect(title).toBeTruthy();
    expect(title.wcag).toEqual(['2.4.2']);

    for (const f of findings) expect(JSON.stringify(f.el)).not.toContain('"id"');

    expect(beacon.perf).toBeTruthy();
    expect(beacon.perf!.aborted).toBe(false);
    expect(beacon.perf!.scans).toBeGreaterThan(0);
  });

  it('marks a finding as interacted when the user clicks its element', async () => {
    const axe = fakeAxe();
    start(axe);
    await settle();

    document.querySelector<HTMLElement>('#a')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(beacons.length).toBe(1);
    const img = (beacons[0]!.findings ?? []).find((f) => f.rule === 'wcag:1.1.1')!;
    expect(img.i).toBe(true);
    expect(beacons[0]!.interactions ?? []).toEqual([]);
  });

  it('flags a click on an element the parked scan had not reached yet, once the scan reaches it', async () => {
    document.body.innerHTML =
      '<section><img id="a"></section><section><p>text</p></section>' +
      '<section><p>text</p></section><section><button id="x"><span id="glyph"></span></button></section>';
    const axe = fakeAxe();
    let clock = 0;
    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: CONFIG,
        sessionId: 'sess-touch',
        axe,
        now: () => (clock += 60),
      }),
    );
    await settle();

    document.querySelector<HTMLElement>('#glyph')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    const findings = beacons.flatMap((b) => b.findings ?? []);
    const button = findings.find((f) => f.el.tag === 'button');
    expect(button, 'the parked scan never reported the button').toBeDefined();
    expect(button!.i, 'a click before the scan reached the button was lost').toBe(true);
    expect(findings.find((f) => f.el.tag === 'img')!.i).toBe(false);
    // A page-level finding sits on <html>; clicking somewhere is not touching it.
    expect(findings.find((f) => f.el.tag === 'html')!.i).toBe(false);
  });

  it('does nothing when the config is disabled or the kill switch is on, and does not claim the window', async () => {
    const axe = fakeAxe();
    const flag = (): unknown => (window as unknown as Record<string, unknown>).__accessibleRumStarted;

    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: { ...CONFIG, killSwitch: true },
        sessionId: 'sess-2',
        axe,
      }),
    );
    await settle();
    expect(axe.calls.length).toBe(0);
    expect(flag()).toBeUndefined();

    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: { ...CONFIG, enabled: false },
        sessionId: 'sess-3',
        axe,
      }),
    );
    await settle();
    expect(axe.calls.length).toBe(0);
    expect(beacons.length).toBe(0);
    expect(flag()).toBeUndefined();

    // A refused start leaves the window free for a real one.
    start(axe);
    await settle();
    expect(axe.calls.length).toBeGreaterThan(0);
    expect(flag()).toBe(true);
  });

  it('uses the adapter route pattern and component attribution', async () => {
    document.body.innerHTML = '<main data-a11y-component="Gallery"><img id="a"></main>';
    const axe = fakeAxe();
    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: CONFIG,
        sessionId: 'sess-4',
        axe,
        adapter: { attribution: { routePattern: () => '/[slug]' } },
      }),
    );
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    const beacon = beacons[0]!;
    expect(beacon.routes).toEqual([{ p: '/', r: '/[slug]' }]);
    const img = (beacon.findings ?? []).find((f) => f.rule === 'wcag:1.1.1')!;
    expect(img.r).toBe('/[slug]');
    expect(img.comp).toEqual({ id: 'Gallery' });
  });

  it('parks scanning while the page is visible on a slow device, then finishes it when the tab hides', async () => {
    document.body.innerHTML =
      '<section><img id="a"></section><section><img id="b"></section>' +
      '<section><img id="c"></section><section><img id="d"></section>' +
      '<section><img id="e"></section>';
    const axe = fakeAxe();
    let clock = 0;
    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: CONFIG,
        sessionId: 'sess-5',
        axe,
        // Every run reads the clock twice and looks like it took 60ms.
        now: () => (clock += 60),
      }),
    );
    await settle();

    // While the visitor looks: the page-level run is over budget, so scanning
    // parks after it. Nothing document-wide ran: that waits for the tab to
    // hide on every page now.
    expect(axe.calls.length).toBe(1);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    // Hidden: the document-cost pass, then the five sections still queued.
    expect(axe.calls.length).toBe(7);
    // The first beacon left before any of that, and said the page was not
    // fully scanned; the last one went after the drain, and says it was.
    expect(beacons[0]!.perf!.aborted, 'a parked page was reported as fully scanned').toBe(true);
    const last = beacons.at(-1)!.perf!;
    expect(last.aborted).toBe(false);
    expect(last.scans).toBe(7);
    expect(last.longTasks).toBe(7);
    expect(last.pending).toBeUndefined();
  });

  it('sends the final scan state even when the work at tab-hide finds nothing new', async () => {
    // A clean contrast pass used to leave the first beacon's `pending` as the
    // last word, which the server files as rules never checked.
    // Over 250 elements, so the findings in hand go out before the pass.
    document.body.innerHTML = `<main><p>clean</p>${'<span></span>'.repeat(300)}</main>`;
    start(fakeAxe());
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(beacons[0]!.perf!.pending).toEqual(DOCUMENT_COST_RULES);
    expect(beacons.length, 'the final state never went out').toBe(2);
    expect(beacons.at(-1)!.perf!.pending, 'the pass ran, but nothing said so').toBeUndefined();
  });

  it('sends one beacon at tab-hide on a small page, contrast pass included', async () => {
    document.body.innerHTML = '<main><p>clean</p><img id="x"></main>';
    start(fakeAxe());
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(beacons.length, 'a second beacon spent the daily cap for nothing').toBe(1);
    expect(beacons[0]!.perf!.pending).toBeUndefined();
  });

  it('drops queued scanning when the page unloads mid-drain, and says so', async () => {
    document.body.innerHTML = '<section><img id="a"></section><section><img id="b"></section><section><img id="c"></section>';
    const axe = fakeAxe();
    let clock = 0;
    handles.push(
      startCollector({
        siteKey: 'sk_test', endpoint: 'http://ingest.test', config: CONFIG, sessionId: 'sess-6', axe,
        now: () => (clock += 200),
      }),
    );
    await settle();
    // The page-level run was over budget: parked at once.
    expect(axe.calls.length).toBe(1);

    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(axe.calls.length, 'scanned while the page was unloading').toBe(1);
    const last = beacons.at(-1)!.perf!;
    expect(last.aborted, 'dropped work was not reported').toBe(true);
    expect(last.skipped).toEqual(DOCUMENT_COST_RULES);
  });

  it('detaches everything when the page hides: no more scans, no more timers', async () => {
    vi.useFakeTimers();
    const axe = fakeAxe();
    start(axe);
    await micro();
    const afterFullScan = axe.calls.length;
    expect(afterFullScan).toBeGreaterThan(0);

    // Control: while the collector is alive, a mutation re-scans on the
    // dirty tracker's debounce.
    document.querySelector('main')!.appendChild(document.createElement('img'));
    await micro();
    vi.advanceTimersByTime(500);
    await micro();
    expect(axe.calls.length).toBeGreaterThan(afterFullScan);
    const beforeHide = axe.calls.length;

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await micro();
    // One beacon: a small page's document-cost pass runs first, then
    // everything goes out together.
    expect(beacons.length).toBe(1);

    // Treatment: the same mutation now schedules nothing, and no timer of
    // ours (the dirty debounce, the transport's 15s interval) is left.
    document.querySelector('main')!.appendChild(document.createElement('img'));
    await micro();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    await micro();
    expect(axe.calls.length).toBe(beforeHide + 1);
    expect(beacons.length).toBe(1);

    // A click no longer reaches us either, and a second halt is a no-op.
    document.querySelector<HTMLElement>('#a')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    await micro();
    expect(beacons.length).toBe(1);
  });

  it('retries the final beacon before tearing the transport down', async () => {
    vi.useFakeTimers();
    // The first send fails outright (a full beacon queue, a throwing fetch):
    // the transport holds the batch for one retry it can no longer make on
    // its own, because its interval dies with the teardown.
    let failNext = true;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (failNext) { failNext = false; throw new Error('quota exceeded'); }
      beacons.push(JSON.parse(String(init?.body)) as RumBeacon);
      return Promise.resolve({} as Response);
    });

    const axe = fakeAxe();
    start(axe);
    await micro();
    expect(beacons.length).toBe(0);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await micro();

    // Delivered on the retry, with nothing lost from the batch.
    expect(failNext).toBe(false);
    expect(beacons.length).toBe(1);
    expect((beacons[0]!.findings ?? []).length).toBe(2);
    expect(beacons[0]!.session).toEqual({ started: true });
    expect(beacons[0]!.routes).toEqual([{ p: '/', r: null }]);

    // And the teardown still happened: nothing of ours is left ticking.
    // (jsdom queues a 0ms timer per sessionStorage write for its `storage`
    // event; drain those first so the count is only about our own timers.)
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    await micro();
    expect(beacons.length).toBe(1);
  });

  it('leaves nothing attached when the wiring throws part-way through', async () => {
    vi.useFakeTimers();
    stub.observersThrow = true;
    const axe = fakeAxe();
    const handle = startCollector({
      siteKey: 'sk_test',
      endpoint: 'http://ingest.test',
      config: CONFIG,
      sessionId: 'sess-6',
      axe,
    });
    await micro();

    // The transport and its interval were already up when the observers
    // threw: the unwind has to have taken them back down.
    expect(vi.getTimerCount()).toBe(0);
    expect((window as unknown as Record<string, unknown>).__accessibleRumStarted).toBeUndefined();
    expect(axe.calls.length).toBe(0);
    vi.advanceTimersByTime(60_000);
    await micro();
    expect(beacons.length).toBe(0);

    // The handle is inert, and the window is free for a real start.
    expect(() => handle.stop()).not.toThrow();
    stub.observersThrow = false;
    start(axe);
    await micro();
    expect(axe.calls.length).toBeGreaterThan(0);
    expect((window as unknown as Record<string, unknown>).__accessibleRumStarted).toBe(true);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await micro();
    expect(beacons.length).toBe(1);
    expect((beacons[0]!.findings ?? []).length).toBeGreaterThan(0);
  });

  it('reports a route and the session start only once per session, across pageviews', async () => {
    const axe = fakeAxe();
    start(axe);
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(beacons[0]!.routes).toEqual([{ p: '/', r: null }]);
    expect(beacons[0]!.session).toEqual({ started: true });

    handles.pop()!.stop();
    beacons = [];

    // Second pageview, same session storage, with a barrier the first
    // pageview never saw — so this beacon exists for a reason other than the
    // route or the session start.
    document.body.innerHTML = '<main><button id="x"></button></main>';
    setVisibility('visible');
    start(fakeAxe());
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(beacons.length).toBe(1);
    const findings = beacons[0]!.findings ?? [];
    expect(findings.map((f) => f.rule)).toEqual(['wcag:4.1.2']);
    expect(beacons[0]!.routes).toBeUndefined();
    expect(beacons[0]!.session).toBeUndefined();
  });
});

/**
 * The three tiers of the document-cost pass, seen from where it matters: what
 * the beacon says. A contrast finding that arrives is coverage; a contrast
 * finding that never arrives with nothing in `perf.skipped` would be a page
 * quietly claiming to have been checked.
 */
describe('the document-cost pass, by page size', () => {
  type Context = Element | Document | { include: Element[] };

  interface TieredAxe extends AxeLike {
    calls: { context: Context; values: string[] | undefined }[];
  }

  /** A chunk may be a group of siblings, so unwrap `{ include }` the way axe does. */
  function imagesIn(context: Context): HTMLImageElement[] {
    const roots =
      context instanceof Element
        ? [context]
        : 'include' in (context as { include?: Element[] })
          ? (context as { include: Element[] }).include
          : [];
    const out: HTMLImageElement[] = [];
    for (const root of roots) {
      if (root.tagName === 'IMG') out.push(root as HTMLImageElement);
      out.push(...Array.from(root.querySelectorAll('img')));
    }
    return out;
  }

  /** Distinguishes the three run shapes, and only ever reports contrast from the document-cost one. */
  function tieredAxe(): TieredAxe {
    const calls: TieredAxe['calls'] = [];
    return {
      calls,
      run(context: Context, options: object): Promise<{ violations: AxeViolationLike[] }> {
        const runOnly = (options as { runOnly?: { type: string; values: string[] } }).runOnly;
        calls.push({ context, values: runOnly?.values });
        if (runOnly?.values === DOCUMENT_COST_RULES) {
          const el = document.getElementById('low');
          return Promise.resolve({
            violations: el
              ? [{
                  id: 'color-contrast',
                  impact: 'serious' as const,
                  tags: ['cat.color', 'wcag2aa', 'wcag143'],
                  nodes: [{ target: ['#low'], element: el }],
                }]
              : [],
          });
        }
        if (context === document) return Promise.resolve({ violations: [] });
        const imgs = imagesIn(context);
        return Promise.resolve({
          violations: imgs.length
            ? [{
                id: 'image-alt',
                impact: 'critical' as const,
                tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
                nodes: imgs.map((el) => ({ target: [`#${el.id}`], element: el })),
              }]
            : [],
        });
      },
    };
  }

  const documentCostRuns = (axe: TieredAxe): number =>
    axe.calls.filter((c) => c.values === DOCUMENT_COST_RULES).length;

  /** A page of roughly `filler` spans, plus one low-contrast paragraph and one image. */
  function page(filler: number): void {
    document.body.innerHTML =
      `<main><p id="low">helper</p><img id="a">${'<span></span>'.repeat(filler)}</main>`;
  }

  const rules = (): string[] => (beacons[0]?.findings ?? []).map((f) => f.rule);

  it('waits for the tab to hide even when the page is small', async () => {
    // ~22ms on a fast laptop, ~76ms on a mid-range phone: no page is small
    // enough to run it while the visitor is looking without knowing the device.
    page(20);
    const axe = tieredAxe();
    start(axe);
    await settle();
    expect(documentCostRuns(axe), 'the pass ran while the page was visible').toBe(0);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(documentCostRuns(axe)).toBe(1);
    expect(beacons.flatMap((b) => b.findings ?? []).map((f) => f.rule)).toContain('wcag:1.4.3');
    expect(beacons.at(-1)!.perf!.skipped).toBeUndefined();
  });

  it('waits for the tab to hide on a mid-size page, then sends the findings second', async () => {
    page(700);
    const axe = tieredAxe();
    start(axe);
    await settle();

    // Nothing yet: the visitor is still looking at the page.
    expect(documentCostRuns(axe), 'the pass ran while the page was visible').toBe(0);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(documentCostRuns(axe), 'hiding the tab did not run the deferred pass').toBe(1);
    // Two beacons, in this order and for this reason: everything the collector
    // already had goes out before a 250ms scan is started in a tab the browser
    // is free to freeze, and the contrast findings follow as their own beacon.
    expect(beacons.length, 'the contrast findings were not a second beacon').toBe(2);
    const first = beacons[0]!.findings ?? [];
    const second = beacons[1]!.findings ?? [];
    expect(first.map((f) => f.rule)).toContain('wcag:1.1.1');
    expect(first.map((f) => f.rule), 'contrast rode the first beacon').not.toContain('wcag:1.4.3');
    expect(second.map((f) => f.rule), 'the deferred findings never arrived').toEqual(['wcag:1.4.3']);
    // The first beacon goes out before the pass has run, and says so: `pending`
    // is the difference between "not yet" and a page that looks checked and
    // clean. The second is sent after the pass, so it says neither.
    expect(beacons[0]!.perf!.pending, 'the postponed pass was not reported').toEqual(DOCUMENT_COST_RULES);
    expect(beacons[1]!.perf!.pending, 'a pass that ran is still pending').toBeUndefined();
    for (const beacon of beacons) {
      expect(beacon.perf!.skipped, 'a pass that ran was reported as skipped').toBeUndefined();
      expect(beacon.perf!.aborted).toBe(false);
    }
  });

  it('sends the ordinary findings even when the deferred pass never finishes', async () => {
    page(700);
    const axe = tieredAxe();
    // A document-cost run that never resolves: a frozen tab, a hung rule.
    const stuck = { ...axe, run: (context: Context, options: object) => {
      const runOnly = (options as { runOnly?: { values: string[] } }).runOnly;
      if (runOnly?.values === DOCUMENT_COST_RULES) return new Promise<never>(() => {});
      return axe.run(context, options);
    } } as unknown as AxeLike;
    start(stuck);
    await settle();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    // The first flush went out before the pass was ever started, so the page's
    // real findings are safe whatever happens next.
    expect(beacons.length).toBe(1);
    expect((beacons[0]!.findings ?? []).map((f) => f.rule)).toContain('wcag:1.1.1');
    expect(beacons[0]!.perf!.skipped, 'the pass was still pending, not skipped').toBeUndefined();
    expect(beacons[0]!.perf!.pending, 'the pending pass was not named').toEqual(DOCUMENT_COST_RULES);

    // The tab then unloads with the pass still hanging: teardown happens anyway,
    // and giving up is itself news — a second beacon carries nothing but the
    // stats, because "these rules were not checked" is the whole point of the
    // skip list and there is no other beacon left to put it on.
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(beacons.length, 'giving up on the pass was never reported').toBe(2);
    expect(beacons[1]!.findings, 'the second beacon should carry only the stats').toBeUndefined();
    expect(beacons[1]!.perf!.skipped).toEqual(DOCUMENT_COST_RULES);
    expect(beacons[1]!.perf!.pending, 'an abandoned pass is skipped, not pending').toBeUndefined();

    // Nothing of ours is still attached, and nothing more will be sent.
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(beacons.length).toBe(2);
  });

  it('picks the tier from the shipped default, not from the caller', async () => {
    // 3,000 is the number the collector ships with: above it the pass is not
    // worth running at all. The tiers are meaningless if it drifts unnoticed.
    page(2900);
    const mid = tieredAxe();
    start(mid);
    await settle();
    expect(documentCostRuns(mid), 'no page runs it while visible').toBe(0);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(documentCostRuns(mid), 'a 2,900-element page should defer, then run').toBe(1);
    for (const h of handles) h.stop();
    handles = [];
    beacons = [];
    delete (window as unknown as Record<string, unknown>).__accessibleRumStarted;
    sessionStorage.clear();

    page(3100);
    const big = tieredAxe();
    setVisibility('visible');
    start(big);
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(documentCostRuns(big), 'a 3,100-element page should skip').toBe(0);
    expect(beacons.at(-1)!.perf!.skipped).toEqual(DOCUMENT_COST_RULES);
  });

  it('gives up on the deferred pass when the page is unloading, and says so', async () => {
    page(700);
    const axe = tieredAxe();
    start(axe);
    await settle();

    // `pagehide` is not the moment to start a 300ms task: the page is leaving.
    window.dispatchEvent(new Event('pagehide'));
    await settle();

    expect(documentCostRuns(axe)).toBe(0);
    expect(beacons.length).toBe(1);
    expect(rules()).not.toContain('wcag:1.4.3');
    expect(beacons[0]!.perf!.skipped).toEqual(DOCUMENT_COST_RULES);
    expect(beacons[0]!.perf!.pending, 'an abandoned pass is skipped, not pending').toBeUndefined();
    // The rest of the page was still scanned and still reported.
    expect(rules()).toContain('wcag:1.1.1');
  });

  it('never runs the pass on a very large page, and says so from the start', async () => {
    page(3200);
    const axe = tieredAxe();
    start(axe);
    await settle();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(documentCostRuns(axe)).toBe(0);
    expect(rules()).not.toContain('wcag:1.4.3');
    expect(beacons[0]!.perf!.skipped).toEqual(DOCUMENT_COST_RULES);
    expect(beacons[0]!.perf!.pending, 'a pass that was never started is not pending').toBeUndefined();
  });

  it('runs the pass on a small page at tab-hide and finally reports it as neither pending nor skipped', async () => {
    page(20);
    const axe = tieredAxe();
    start(axe);
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(beacons.at(-1)!.perf!.pending).toBeUndefined();
    expect(beacons.at(-1)!.perf!.skipped).toBeUndefined();
  });
});

describe('lazy adapter slot', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__accessibleAdapter;
  });

  it('uses an adapter registered on the window after start', async () => {
    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: CONFIG,
        sessionId: 'sess-slot-1',
        axe: fakeAxe(),
        adapter: undefined,
      }),
    );
    (window as unknown as Record<string, unknown>).__accessibleAdapter = {
      attribution: { routePattern: () => '/products/[slug]' },
    };
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    const beacon = beacons[0]!;
    expect((beacon.findings ?? [])[0]?.r).toBe('/products/[slug]');
  });

  it('prefers the explicit start option over the slot', async () => {
    (window as unknown as Record<string, unknown>).__accessibleAdapter = {
      attribution: { routePattern: () => '/slot' },
    };
    handles.push(
      startCollector({
        siteKey: 'sk_test',
        endpoint: 'http://ingest.test',
        config: CONFIG,
        sessionId: 'sess-slot-2',
        axe: fakeAxe(),
        adapter: { attribution: { routePattern: () => '/explicit' } },
      }),
    );
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    const beacon = beacons[0]!;
    expect((beacon.findings ?? [])[0]?.r).toBe('/explicit');
  });

  it('survives a slot that is not an object', async () => {
    (window as unknown as Record<string, unknown>).__accessibleAdapter = 42;
    start(fakeAxe());
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    const beacon = beacons[0]!;
    expect((beacon.findings ?? [])[0]?.r).toBeNull();
  });

  it('survives a slot that throws when it is read', async () => {
    // The reason `resolveAdapter` reads the slot inside a try/catch: another
    // script on the page can install a getter there, and a throw on read must
    // cost a route pattern, not the whole collector.
    Object.defineProperty(window, '__accessibleAdapter', {
      configurable: true,
      get() {
        throw new Error('slot getter blew up');
      },
    });

    start(fakeAxe());
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    const beacon = beacons[0]!;
    expect(beacon.findings?.length).toBeGreaterThan(0);
    expect((beacon.findings ?? [])[0]?.r).toBeNull();
  });
});

describe('the reported collector version', () => {
  it('is the package version, on every beacon', async () => {
    // `c` is what the dashboard stores and compares against `minCollector`, so
    // a hand-maintained literal that drifts from the release is a wrong answer
    // to a question a customer asks. Substituted at build time; asserted here.
    // `process.cwd()` rather than `import.meta.url`: the jsdom environment
    // gives modules an http:// URL, which `readFileSync` cannot open.
    const { version } = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    expect(COLLECTOR_VERSION).toBe(version);

    start(fakeAxe());
    await settle();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(beacons.length).toBeGreaterThan(0);
    for (const beacon of beacons) expect(beacon.c).toBe(version);
  });
});
