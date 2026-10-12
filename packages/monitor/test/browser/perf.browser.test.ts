/**
 * The performance budget, measured rather than asserted — on more than one
 * device.
 *
 * The promise: no task over 50ms while the visitor is interacting, beyond the
 * one that measures the device; no task over 150ms ever while visible (the
 * heavy document-cost parts run only in idle windows, and only when predicted
 * to fit). What is *not* promised is how long a task takes — that is the
 * device's business — so this suite asserts the promise, not a laptop's
 * timings, and runs the same assertions under Chromium's CPU throttling to
 * stand in for slower devices. `A11Y_PERF_THROTTLE` picks the rates (default
 * `1,6`; CI, whose runners are already several times slower than a laptop,
 * runs `1`).
 *
 * A handful of axe rules — `color-contrast` and `region` above all — are
 * element-level in meaning but document-level in cost. Fast pages check them
 * in idle windows; others at tab hide; pages over 3,000 elements skip what
 * does not fit, named in `perf.skipped` rather than silently missing. See
 * `docs/methodology.md` and the adaptive-collection spec.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { RumBeaconSchema } from '@accessible-so/monitor-core/protocol';
import {
  fixtureSession,
  recordedBeacons,
  resetServer,
  ruleSet,
  setConfig,
  settle,
  startServer,
  waitForBeacon,
  waitForCollector,
  type FixtureServer,
  type FixtureSession,
  type RumBeaconBody,
  type WatchedPage,
} from './harness';

/** Over 5,000 elements: past the size at which the contrast pass is worth running at all. */
const HUGE = '/big.html';
/** ~1,100 elements. */
const MID = '/mid.html';

const BUDGET_MS = 50;

const RATES = (process.env.A11Y_PERF_THROTTLE ?? '1,6').split(',').map(Number).filter((n) => n >= 1);

/**
 * The document-cost rules the engine actually runs, in the order it reports
 * them. `color-contrast-enhanced` is deliberately not among them: it is AAA,
 * the scanner tier never runs it, and running it here would report 1.4.6
 * alongside 1.4.3 for one contrast defect.
 */
const DOCUMENT_COST_RULES = ['color-contrast', 'link-in-text-block', 'target-size', 'region'];

let browser: Browser;
let server: FixtureServer;
let session: FixtureSession;

/**
 * The three tiers produce three different beacon shapes — one with
 * `perf.skipped`, one with `perf.pending`, one with neither — and all three
 * have to be shapes the server would accept. Checking them here is what stops
 * the client and the ingest schema drifting apart on the pages the constraint
 * suite does not visit.
 */
function expectAcceptedByIngest(beacons: RumBeaconBody[]): void {
  expect(beacons.length).toBeGreaterThan(0);
  for (const beacon of beacons) {
    const parsed = RumBeaconSchema.safeParse(beacon);
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      'a beacon the collector sent is not one the server would accept',
    ).toEqual([]);
  }
}

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startServer();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

let rate = 1;

beforeEach(async () => {
  session = fixtureSession(browser, server.url, rate);
  await resetServer(server.url);
});

afterEach(async () => {
  const errors = session.errors();
  const consoleErrors = session.consoleErrors();
  await session.closeAll();
  expect(errors, 'uncaught page exceptions').toEqual([]);
  expect(consoleErrors, 'console.error entries').toEqual([]);
});

/**
 * The beacons once the page says its scan is finished — `aborted` and
 * `pending` both cleared on the last one — or whatever there is after a
 * minute. The drain at tab-hide sends nothing until it is done, and how long
 * that takes is the device's business, so a quiet window that means "done" on
 * a laptop means "still working" on a slow CI runner.
 */
async function finished(serverUrl: string, timeoutMs = 60_000): Promise<RumBeaconBody[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const beacons = await recordedBeacons(serverUrl);
    const perf = beacons.at(-1)?.perf;
    if ((perf && !perf.aborted && !perf.pending) || Date.now() > deadline) return beacons;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Every task over the active budget is either the one calibration run or a
 * window task, so the count is bounded by 1 + the page's idle runs.
 */
function expectActiveBudget(tasks: { duration: number }[], beacons: RumBeaconBody[]): void {
  const over = tasks.filter((t) => t.duration > BUDGET_MS);
  const idleRuns = beacons.at(-1)?.perf?.idleRuns ?? 0;
  expect(over.length, `tasks over ${BUDGET_MS} ms: ${JSON.stringify(over)} with ${idleRuns} idle runs`).toBeLessThanOrEqual(1 + idleRuns);
}

/** Collects the engine's debug console lines (the harness enables debug). */
function collectDebug(watched: WatchedPage): string[] {
  const lines: string[] = [];
  watched.page.on('console', (m) => { if (m.type() === 'debug') lines.push(m.text()); });
  return lines;
}

/**
 * The window promise, from the engine's own lines logged while the page was
 * still visible: every document-cost part fits 150 ms (+20% timer noise), and
 * a task over that is allowed only if the calibration run itself was.
 */
function expectWindowBudget(path: string, lines: string[], tasks: { duration: number }[], beacons: RumBeaconBody[]): void {
  const limit = 150 * 1.2;
  for (const l of lines) {
    const m = /document-cost part (\S+) ([\d.]+)/.exec(l);
    if (m) expect(Number(m[2]), `${path}: document-cost part ${m[1]} took ${m[2]} ms, over the ${limit} ms window budget`).toBeLessThanOrEqual(limit);
  }
  const first = Number(/calibrated \{firstRunMs: ([\d.]+)/.exec(lines.join('\n'))?.[1] ?? 0);
  const over = tasks.filter((t) => t.duration > limit);
  // The scheduler's own count of window tasks over 150 ms: the model under-predicted. If this fails where the per-part rule above passes, a part landed between 150 and 180 ms and the coefficients need raising.
  expect(beacons.filter((b) => (b.perf?.windowOverruns ?? 0) > 0), `${path}: a window task ran over the window budget`).toEqual([]);
  expect(over.length, `${path}: tasks over ${limit} ms: ${JSON.stringify(over)} (calibration run ${first} ms)`).toBeLessThanOrEqual(first > limit ? 1 : 0);
}

/** Long tasks the browser saw between two moments of the page's own clock. */
async function longTasksBetween(watched: WatchedPage, from: number, to: number) {
  return (await watched.longTasks()).filter((t) => t.startTime >= from && t.startTime < to);
}

/**
 * Opens a page, lets the collector work while it is "visible" for `scanMs`,
 * then hides it and waits for the last beacon. Returns the beacons and the
 * long tasks that happened while the visitor was looking.
 */
async function visit(path: string, scanMs = 3000) {
  const watched = await session.open(path);
  const debug = collectDebug(watched);
  await waitForCollector(watched.page);
  // After the engine has started, so the bundle's own parse — paid once,
  // before any scanning — is not counted against the collector's work.
  const engineAt = await watched.page.evaluate(() => performance.now());
  await watched.page.waitForTimeout(scanMs);
  const hiddenAt = await watched.page.evaluate(() => performance.now());
  const visibleDebug = [...debug];
  await settle(watched, server.url, { scanMs: 0 });
  const beacons = await finished(server.url);
  return { watched, beacons, visibleLongTasks: await longTasksBetween(watched, engineAt, hiddenAt), visibleDebug };
}

describe.each(RATES)('scan performance budget at %ix CPU', (r) => {
  beforeAll(() => { rate = r; });

  it('the fixture really is over 5,000 elements', async () => {
    // Nothing to collect here, and a live collector on a page this size would
    // still be scanning when the next test resets the beacon log.
    await setConfig(server.url, { enabled: false });
    const watched = await session.open(HUGE, false);
    const elements = await watched.page.evaluate(() => document.getElementsByTagName('*').length);
    expect(elements).toBeGreaterThanOrEqual(5000);
  });

  it('a 5,000-element page costs the visitor at most one long task, and is still fully scanned', async () => {
    const { beacons, visibleLongTasks, visibleDebug } = await visit(HUGE, 8000);

    // The promise: every window part fits the window budget; a task over it
    // is allowed only if the calibration run itself was that long.
    expectWindowBudget(HUGE, visibleDebug, visibleLongTasks, beacons);
    expectActiveBudget(visibleLongTasks, beacons);

    const perf = beacons.at(-1)?.perf;
    expect(perf, 'no perf on the last beacon').toBeTruthy();
    // Whatever was parked was finished when the tab hid.
    expect(perf?.aborted, 'the page was left partly unscanned').toBe(false);
    expect(perf?.scans, 'the page was not chunked').toBeGreaterThanOrEqual(5);
    // Per-part honesty: whatever did not run is named, and nothing is pending.
    const skipped = perf?.skipped ?? [];
    for (const rule of skipped) expect(DOCUMENT_COST_RULES, `unknown skipped rule ${rule}`).toContain(rule);
    const grid = ['color-contrast', 'link-in-text-block', 'target-size'];
    expect(new Set(grid.map((r) => skipped.includes(r))).size, `grid rules skipped inconsistently: ${JSON.stringify(skipped)}`).toBe(1);
    expect(perf?.pending, 'a pass that was never started is not pending').toBeUndefined();
    if (!ruleSet(beacons).has('wcag:1.4.3')) expect(skipped, 'contrast went missing without being reported').toContain('color-contrast');

    // Skipping contrast is not giving up: everything else is still found.
    expect(ruleSet(beacons), 'the <img> with no alt was missed').toContain('wcag:1.1.1');
    expectAcceptedByIngest(beacons);
  });

  it('an ordinary page keeps its contrast findings, checked once the tab hides', async () => {
    const { beacons, visibleLongTasks, visibleDebug } = await visit('/');
    expectWindowBudget('/', visibleDebug, visibleLongTasks, beacons);
    expectActiveBudget(visibleLongTasks, beacons);
    expect(ruleSet(beacons), 'the #999-on-#fff text was missed').toContain('wcag:1.4.3');
    const perf = beacons.at(-1)?.perf;
    expect(perf?.aborted).toBe(false);
    expect(perf?.skipped, 'nothing should be skipped on a small page').toBeUndefined();
    expect(perf?.pending, 'the pass ran, so nothing is pending').toBeUndefined();
  });

  /**
   * The promise, seen from the only place it is observable: a beacon from a
   * page the visitor is still on. The transport's 15s interval provides it.
   */
  async function expectCheckedByHide(path: string): Promise<void> {
    const watched = await session.open(path);
    const debug = collectDebug(watched);
    await waitForCollector(watched.page);
    const startedAt = await watched.page.evaluate(() => performance.now());
    const whileVisible = await waitForBeacon(server.url, 1);
    const hiddenAt = await watched.page.evaluate(() => performance.now());
    const visibleTasks = await longTasksBetween(watched, startedAt, hiddenAt);
    const visibleDebug = [...debug];
    const tier = whileVisible.find((b) => b.perf?.tier)?.perf?.tier;
    expect(tier, 'no tier on any beacon').toBeDefined();
    if (tier === 'fast') {
      expect(ruleSet(whileVisible), 'a fast page did not check contrast while the visitor was idle').toContain('wcag:1.4.3');
    } else {
      const pending = whileVisible.at(-1)!.perf!.pending ?? [];
      const checked = ruleSet(whileVisible).has('wcag:1.4.3');
      expect(checked || pending.includes('color-contrast'), 'contrast neither checked nor reported pending').toBe(true);
    }
    await settle(watched, server.url, { scanMs: 500 });
    const beacons = await finished(server.url);
    expect(ruleSet(beacons), 'the contrast findings never arrived').toContain('wcag:1.4.3');
    expect(ruleSet(beacons), 'the parked scanning never finished').toContain('wcag:1.1.1');
    expect(beacons.at(-1)?.perf?.skipped).toBeUndefined();
    expect(beacons.at(-1)?.perf?.pending).toBeUndefined();
    expect(beacons.at(-1)?.perf?.aborted).toBe(false);
    expect(ruleSet(beacons), 'an AAA contrast finding leaked in').not.toContain('wcag:1.4.6');
    expectActiveBudget(visibleTasks, beacons);
    expectWindowBudget(path, visibleDebug, visibleTasks, beacons);
    expectAcceptedByIngest(beacons);
  }

  it('a mid-size page has its contrast checked by the time the tab hides', async () => {
    await expectCheckedByHide(MID);
  });

  it('an ordinary content page too', async () => {
    await expectCheckedByHide('/products.html');
  });

  /** Reads `path` for `readMs` without touching it, then clicks a link to another page. */
  async function readThenClick(path: string, readMs = 5000) {
    const watched = await session.open(path);
    const debugLines = collectDebug(watched);
    await waitForCollector(watched.page);
    const from = await watched.page.evaluate(() => performance.now());
    await watched.page.waitForTimeout(readMs);
    const to = await watched.page.evaluate(() => performance.now());
    const longTasks = await longTasksBetween(watched, from, to);
    const visibleDebug = [...debugLines];
    // Click a link that really changes the URL: on /products.html the plain
    // /products.html link is a self-link, the utm one is not.
    const before = watched.page.url();
    const utm = watched.page.locator('a[href*="utm_source"]');
    const link = (await utm.count()) > 0 ? utm.first() : watched.page.locator('a[href^="/products.html"]').first();
    await Promise.all([watched.page.waitForURL((u) => u.href !== before), link.click()]);
    await watched.page.waitForTimeout(1500); // the pagehide beacon lands; the next page has not flushed yet
    return { beacons: await recordedBeacons(server.url), longTasks, debugLines, visibleDebug };
  }

  for (const path of ['/', '/products.html', MID, HUGE]) {
    it(`a visitor who reads ${path} and clicks a link: what got checked`, async () => {
      const { beacons, longTasks, debugLines, visibleDebug } = await readThenClick(path);
      const tier = beacons.find((b) => b.perf?.tier)?.perf?.tier;
      const last = beacons.at(-1)?.perf;
      const unchecked = [...(last?.skipped ?? []), ...(last?.pending ?? [])];
      // Calibration output for methodology §4 — the ratios are set from these lines.
      console.log(JSON.stringify({ rate, path, tier, unchecked, idleRuns: last?.idleRuns ?? 0, calibration: debugLines.filter((l) => /calibrated|document-cost part/.test(l)) }));

      expect(tier).toBeDefined();
      // Honesty, every tier: a document-cost rule with no result is named as unchecked.
      if (!ruleSet(beacons).has('wcag:1.4.3')) {
        expect(unchecked, 'contrast went missing without being reported').toContain('color-contrast');
      }
      if (path === HUGE) {
        // Honesty per part (same rule as the 5,000-element test).
        const grid = ['color-contrast', 'link-in-text-block', 'target-size'];
        for (const rule of last?.skipped ?? []) expect(DOCUMENT_COST_RULES).toContain(rule);
        expect(new Set(grid.map((r) => (last?.skipped ?? []).includes(r))).size, `grid rules skipped inconsistently: ${JSON.stringify(last?.skipped)}`).toBe(1);
      }
      // The point of this change: a fast page is fully checked before the click.
      if (tier === 'fast') {
        expect(unchecked, `${path} was fast but left rules unchecked at the click`).toEqual([]);
      }
      expectWindowBudget(path, visibleDebug, longTasks, beacons);
      expectActiveBudget(longTasks, beacons);
      expectAcceptedByIngest(beacons);
    });
  }

  it('a visitor who keeps interacting gets no window: at most the one calibration long task', async () => {
    const watched = await session.open(MID);
    await waitForCollector(watched.page);
    // The first wheel goes before `from` is read, so no idle window can have
    // opened before the measured interval starts.
    await watched.page.mouse.wheel(0, 40);
    const from = await watched.page.evaluate(() => performance.now());
    for (let i = 0; i < 20; i++) {
      await watched.page.waitForTimeout(300);
      await watched.page.mouse.wheel(0, 40);
    }
    const to = await watched.page.evaluate(() => performance.now());
    const tasks = await longTasksBetween(watched, from, to);
    expect(tasks.length, `long tasks while interacting: ${JSON.stringify(tasks)}`).toBeLessThanOrEqual(1);
    // The gate is why: hide the page and see that no window ever ran.
    await settle(watched, server.url, { scanMs: 0 });
    const beacons = await finished(server.url);
    expect(beacons.filter((b) => (b.perf?.idleRuns ?? 0) > 0), 'a window ran while the visitor was interacting').toEqual([]);
  });

  it('the floor cost of an axe run scales with the document, not the chunk', async () => {
    // Why the document-cost set exists, and why lowering the engine's
    // `chunkMax` was never the answer: on a 5,000-element document each of
    // these rules costs several times what every other rule group costs on the
    // same tiny context. Stated as ratios, which hold on any device; the
    // absolute numbers are the device's. The collector is off for this one.
    await setConfig(server.url, { enabled: false });
    const watched = await session.open(HUGE, false);
    await watched.page.addScriptTag({ url: `${server.url}/a11y/engine.js` });
    const timings = await watched.page.evaluate(async () => {
      const axe = (window as unknown as {
        axe: { run(ctx: Element | Document, o: object): Promise<unknown> };
      }).axe;
      // A leaf with two elements and some text — as small as a chunk gets.
      const leaf = document.querySelector('#trees li li') as Element;
      // A four-element region with links in it, which is what `target-size`
      // needs before it does any work at all.
      const links = document.querySelector('header') as Element;
      const base = { resultTypes: ['violations'], elementRef: true, iframes: false };
      const time = async (context: Element | Document, values: string[], type: 'tag' | 'rule') => {
        const started = performance.now();
        await axe.run(context, { ...base, runOnly: { type, values } });
        return performance.now() - started;
      };
      await time(leaf, ['wcag2a'], 'tag'); // warm
      return {
        elements: document.getElementsByTagName('*').length,
        leafElements: leaf.getElementsByTagName('*').length,
        linksElements: links.getElementsByTagName('*').length,
        colorContrast: await time(leaf, ['color-contrast'], 'rule'),
        targetSize: await time(links, ['target-size'], 'rule'),
        region: await time(document, ['region'], 'rule'),
        everythingElse: await time(leaf, ['wcag2a', 'wcag21a', 'wcag22a'], 'tag'),
      };
    });

    expect(timings.leafElements, 'the leaf context is meant to be tiny').toBeLessThan(5);
    expect(timings.linksElements, 'the link context is meant to be tiny').toBeLessThan(10);
    const msg = (rule: string) => `${rule} vs everything else on a tiny context of a ${timings.elements}-element page: ${JSON.stringify(timings)}`;
    expect(timings.colorContrast, msg('color-contrast')).toBeGreaterThan(3 * timings.everythingElse);
    expect(timings.targetSize, msg('target-size')).toBeGreaterThan(3 * timings.everythingElse);
    expect(timings.region, msg('region')).toBeGreaterThan(2 * timings.everythingElse);
    // And on a laptop-class device the document-cost rules alone exceed the
    // budget, which is the original reason they cannot share a chunk's task.
    if (r === 1) expect(timings.colorContrast).toBeGreaterThan(BUDGET_MS);
  });
});
