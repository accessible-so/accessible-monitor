/**
 * The performance budget, measured rather than asserted — on more than one
 * device.
 *
 * The promise is that the collector never becomes the reason a page is slow
 * to respond: no scan task over 50ms while the visitor is looking, beyond the
 * one that reveals the device is too slow for it. After that one the engine
 * parks and finishes when the tab hides (see `scheduler.ts`). What is *not*
 * promised is how long a task takes — that is the device's business — so this
 * suite asserts the promise, not a laptop's timings, and runs the same
 * assertions under Chromium's CPU throttling to stand in for slower devices.
 * `A11Y_PERF_THROTTLE` picks the rates (default `1,6`; CI, whose runners are
 * already several times slower than a laptop, runs `1`).
 *
 * A handful of axe rules — `color-contrast` and `region` above all — are
 * element-level in meaning but document-level in cost: axe rebuilds a spatial
 * grid of the whole page for the first and walks every element for the second,
 * on every `axe.run`, whatever context it is handed. They run once per page,
 * when the tab hides, on any page up to 3,000 elements, and above that not at
 * all — named in `perf.skipped` rather than silently missing. See
 * `docs/methodology.md`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { RumBeaconSchema } from '@accessible-so/monitor-core/protocol';
import {
  allFindings,
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
  await waitForCollector(watched.page);
  // After the engine has started, so the bundle's own parse — paid once,
  // before any scanning — is not counted against the collector's work.
  const engineAt = await watched.page.evaluate(() => performance.now());
  await watched.page.waitForTimeout(scanMs);
  const hiddenAt = await watched.page.evaluate(() => performance.now());
  await settle(watched, server.url, { scanMs: 0 });
  const beacons = await finished(server.url);
  return { watched, beacons, visibleLongTasks: await longTasksBetween(watched, engineAt, hiddenAt) };
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
    const { beacons, visibleLongTasks } = await visit(HUGE, 8000);

    // The promise: at most the one task that showed this device too slow,
    // then nothing more while the visitor was looking.
    expect(visibleLongTasks.length, `long tasks while visible: ${JSON.stringify(visibleLongTasks)}`).toBeLessThanOrEqual(1);

    const perf = beacons.at(-1)?.perf;
    expect(perf, 'no perf on the last beacon').toBeTruthy();
    // Whatever was parked was finished when the tab hid.
    expect(perf?.aborted, 'the page was left partly unscanned').toBe(false);
    expect(perf?.scans, 'the page was not chunked').toBeGreaterThanOrEqual(5);
    // Too large for the document-cost pass at all — and the beacon names every
    // rule rather than letting the page look clean.
    expect(perf?.skipped, 'the skipped rules were not reported exactly').toEqual(DOCUMENT_COST_RULES);
    expect(perf?.pending, 'a pass that was never started is not pending').toBeUndefined();

    // Skipping contrast is not giving up: everything else is still found.
    const findings = allFindings(beacons);
    expect(ruleSet(beacons), 'the <img> with no alt was missed').toContain('wcag:1.1.1');
    expect(findings.map((f) => f.rule)).not.toContain('wcag:1.4.3');
    expectAcceptedByIngest(beacons);
  });

  it('an ordinary page keeps its contrast findings, checked once the tab hides', async () => {
    const { beacons, visibleLongTasks } = await visit('/');
    expect(visibleLongTasks.length, `long tasks while visible: ${JSON.stringify(visibleLongTasks)}`).toBeLessThanOrEqual(1);
    expect(ruleSet(beacons), 'the #999-on-#fff text was missed').toContain('wcag:1.4.3');
    const perf = beacons.at(-1)?.perf;
    expect(perf?.aborted).toBe(false);
    expect(perf?.skipped, 'nothing should be skipped on a small page').toBeUndefined();
    expect(perf?.pending, 'the pass ran, so nothing is pending').toBeUndefined();
  });

  /**
   * The deferral, seen from the only place it is observable: a beacon from a
   * page the visitor is still on. The transport's 15s interval provides it.
   */
  async function expectDeferral(path: string): Promise<void> {
    const watched = await session.open(path);
    await waitForCollector(watched.page);
    const elements = await watched.page.evaluate(() => document.getElementsByTagName('*').length);
    expect(elements, `${path} must be under the skip threshold`).toBeLessThanOrEqual(3000);

    const whileVisible = await waitForBeacon(server.url, 1);
    expect(
      ruleSet(whileVisible),
      'contrast was checked while the visitor was still looking at the page',
    ).not.toContain('wcag:1.4.3');
    for (const beacon of whileVisible) {
      const perf = beacon.perf!;
      expect(perf.longTasks, 'more than one long task while the visitor was looking').toBeLessThanOrEqual(1);
      expect(perf.skipped, 'a deferred pass is not a skipped pass').toBeUndefined();
      // "Not yet" rather than "checked and clean".
      expect(perf.pending, 'a postponed pass was not reported').toEqual(DOCUMENT_COST_RULES);
      // A device fast enough to keep scanning has found the image by now; one
      // that parked says the page is not fully scanned yet.
      if (!perf.aborted) expect(ruleSet(whileVisible), 'nothing was scanned at all').toContain('wcag:1.1.1');
    }

    // Hiding the tab is the moment it was waiting for — and the last one.
    await settle(watched, server.url, { scanMs: 500 });
    const beacons = await finished(server.url);
    const last = beacons.at(-1);
    expect(beacons.length).toBeGreaterThan(whileVisible.length);
    expect(ruleSet(beacons), 'the deferred contrast findings never arrived').toContain('wcag:1.4.3');
    expect(ruleSet(beacons), 'the parked scanning never finished').toContain('wcag:1.1.1');
    expect(last?.perf?.skipped, 'a pass that ran was reported as skipped').toBeUndefined();
    expect(last?.perf?.pending, 'a pass that ran was still reported as pending').toBeUndefined();
    expect(last?.perf?.aborted).toBe(false);
    expect(ruleSet(beacons), 'an AAA contrast finding leaked in').not.toContain('wcag:1.4.6');
    expectAcceptedByIngest(beacons);
  }

  it('a mid-size page defers its contrast pass until the visitor stops looking', async () => {
    await expectDeferral(MID);
  });

  it('an ordinary content page defers it too', async () => {
    await expectDeferral('/products.html');
  });

  it('the floor cost of an axe run scales with the document, not the chunk', async () => {
    // Why the document-cost set exists, and why lowering the engine's
    // `chunkMax` was never the answer: on a 5,000-element document each of
    // these rules costs several times what every other rule group costs on the
    // same tiny context. Stated as ratios, which hold on any device; the
    // absolute numbers are the device's. The collector is off for this one.
    await setConfig(server.url, { enabled: false });
    const watched = await session.open(HUGE, false);
    await watched.page.addScriptTag({ url: `${server.url}/rum/engine.js` });
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
