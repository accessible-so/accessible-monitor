/**
 * The constraint suite: one assertion per promise the collector makes.
 *
 * Every test here cites the Section 11 row it enforces. These are the claims a
 * customer is entitled to check for themselves — no text leaves the page, the
 * host DOM is untouched, nothing throws, a barrier is reported once per session,
 * an unsampled visitor pays nothing — so they are checked against the shipped
 * bundles in a real browser, not against the source in jsdom.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { RumBeaconSchema } from '@accessible-so/monitor-core/protocol';
import {
  allFindings,
  engineInjected,
  fixtureSession,
  recordedBeacons,
  recordedRequests,
  requestCounts,
  resetServer,
  revisit,
  ruleSet,
  setConfig,
  settle,
  startServer,
  waitForCollector,
  type FixtureServer,
  type FixtureSession,
  type RedactedEl,
  type RumBeaconBody,
  type WatchedPage,
} from './harness';

/**
 * Strings that exist in the fixture and must never appear in a payload: a
 * person's name (in text and in a `title`), an image filename, a call to
 * action, a marketing query parameter, and — the two the redactor drops
 * silently rather than transforming — an element `id` and a class token.
 */
const SENTINELS = [
  'Jane Doe', 'secret.png', 'Add to cart', 'utm', 'zq-sentinel-id', 'zq-sentinel-cls',
];

/**
 * The attribute allowlist, spelled out here rather than imported from the
 * redactor, so widening the policy has to be done twice — deliberately.
 */
const ATTR_ALLOWLIST =
  /^(role|type|tabindex|lang|href|for|alt|title|placeholder|data-a11y-component|data-a11y-source|aria-(hidden|expanded|required|invalid|haspopup|live|current|checked|disabled|selected|pressed|level|modal|atomic|busy|multiline|readonly|sort|orientation|label|description|placeholder|valuetext|roledescription|labelledby|describedby|controls|owns|activedescendant))$/;

const MAX_ATTR_VALUE = 64;

let browser: Browser;
let server: FixtureServer;

/** Everything opened in the current test, so error and cleanup checks are uniform. */
let session: FixtureSession;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startServer();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  session = fixtureSession(browser, server.url);
  await resetServer(server.url);
});

/** Section 11: no uncaught exceptions, no collector console noise — after every scenario. */
afterEach(async () => {
  const errors = session.errors();
  const consoleErrors = session.consoleErrors();
  await session.closeAll();
  expect(errors, 'uncaught page exceptions').toEqual([]);
  expect(consoleErrors, 'console.error entries').toEqual([]);
});

const open = (path: string, debug = true): Promise<WatchedPage> => session.open(path, debug);

/** Walks an element and everything the protocol lets it carry with it. */
function everyElement(el: RedactedEl): RedactedEl[] {
  return [el, ...(el.parent ? [el.parent] : []), ...(el.children ?? [])];
}

/** Opens the fixture, waits for the collector, and settles — the common path. */
async function collect(path = '/'): Promise<{ watched: WatchedPage; beacons: RumBeaconBody[] }> {
  const watched = await open(path);
  await waitForCollector(watched.page);
  return { watched, beacons: await settle(watched, server.url) };
}

/**
 * What every beacon's `c` must say. Read from the package rather than typed in:
 * the engine bundles `@accessible-so/monitor-core`, whose `COLLECTOR_VERSION` is
 * substituted from this same file at build time, and a literal here had already
 * been left two releases behind once.
 */
const { version: CORE_VERSION } = JSON.parse(
  readFileSync(new URL('../../../monitor-core/package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('collector constraints', () => {
  it('Section 11 — findings arrive, and they are the barriers the fixture plants', async () => {
    const { beacons } = await collect();

    expect(beacons.length).toBeGreaterThanOrEqual(1);
    const rules = ruleSet(beacons);
    expect(rules, 'an <img> with no alt').toContain('wcag:1.1.1');
    // An icon-only button and an unlabelled email input are both name/role/value.
    expect(
      [...rules].some((r) => r === 'wcag:4.1.2' || r === 'wcag:1.3.1'),
      `no name/role/value finding among ${[...rules].join(', ')}`,
    ).toBe(true);
    expect(rules, '#999 on #fff').toContain('wcag:1.4.3');

    for (const f of allFindings(beacons)) {
      expect(f.sig).toMatch(/^s1:[0-9a-f]{32}$/);
      expect(f.p, 'path carries a query or fragment').not.toMatch(/[?#]/);
      expect(['rule', 'heuristic']).toContain(f.confidence);
      expect(f.n).toBeGreaterThanOrEqual(1);
      // 1.4.6 is AAA. The scanner tier does not run `color-contrast-enhanced`,
      // so neither may this: one contrast defect must not arrive twice under
      // two rule keys that no other tier can reconcile.
      expect(f.rule, 'an AAA contrast finding leaked into the payload').not.toBe('wcag:1.4.6');
      expect(f.wcag).not.toContain('1.4.6');
    }
  });

  it('Section 11 — zero text nodes, allowlisted attributes only, no sentinel leaks', async () => {
    const { beacons } = await collect();
    const findings = allFindings(beacons);
    expect(findings.length).toBeGreaterThan(0);

    for (const f of findings) {
      for (const el of everyElement(f.el)) {
        // Text never leaves the page — only its shape does.
        if (el.text !== null) {
          expect(Object.keys(el.text).sort()).toEqual(['knownBad', 'length', 'words']);
          expect(typeof el.text.length).toBe('number');
          expect(typeof el.text.words).toBe('number');
          expect(typeof el.text.knownBad).toBe('boolean');
        }
        for (const [key, value] of Object.entries(el.attrs)) {
          expect(key, `attribute "${key}" on <${el.tag}>`).toMatch(ATTR_ALLOWLIST);
          if (typeof value === 'string') {
            expect(value.length, `${key}="${value}"`).toBeLessThanOrEqual(MAX_ATTR_VALUE);
            if (key === 'href') {
              expect(value === 'external' || value.startsWith('/'), `href=${value}`).toBe(true);
            }
          }
        }
      }
    }

    const payload = JSON.stringify(await recordedRequests(server.url));
    for (const sentinel of SENTINELS) {
      expect(payload.includes(sentinel), `payload leaked ${JSON.stringify(sentinel)}`).toBe(false);
    }
    // The fixture really does contain all four, so the check above is not vacuous.
    const html = await fetch(`${server.url}/`).then((r) => r.text());
    for (const sentinel of SENTINELS) expect(html, 'fixture lost a sentinel').toContain(sentinel);
  });

  /**
   * The wire format is a contract, and the schema is the server's half of it.
   * Checking the real payloads against it here is what keeps the two from
   * drifting: a redactor that starts emitting something new, or a schema that
   * tightens past what the client can produce, fails on the fixture rather
   * than in production.
   */
  it('every beacon the fixture produces parses under the ingest schema', async () => {
    const { beacons } = await collect();
    expect(beacons.length).toBeGreaterThan(0);

    for (const beacon of beacons) {
      const parsed = RumBeaconSchema.safeParse(beacon);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        'a beacon the collector sent is not one the server would accept',
      ).toEqual([]);
    }

    // Not vacuous: element keys are the field the schema now checks the
    // structure of, and the fixture really does send them.
    const keys = allFindings(beacons).map((f) => f.key).filter((k) => k !== null);
    expect(keys.length, 'no finding carried an element key').toBeGreaterThan(0);
    for (const key of keys) {
      expect(JSON.parse(key!), `key ${key}`).toMatchObject({ v: 1, e: expect.any(String) });
    }
  });

  it('Section 11 — the host DOM is untouched beyond the engine <script>', async () => {
    // Nothing on this page is interacted with, so the fixture's own SPA swap and
    // dialog cannot account for a mutation: whatever is left is the collector's.
    const { watched } = await collect();

    const mutations = await watched.hostMutations();
    expect(mutations, `unexpected host mutations: ${JSON.stringify(mutations)}`).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: 'childList',
      target: 'head',
      added: ['script'],
      removed: [],
    });
  });

  it('Section 11 — a barrier, the session start, and a route are each sent once per session', async () => {
    // Same tab, so sessionStorage survives the navigations: these are further
    // pageviews of one session, not new sessions. The second visit is a
    // different page built from the same card markup, so every barrier on it
    // has a signature the first visit already reported — but its route is new,
    // which is what keeps this test from passing vacuously on an empty beacon.
    const watched = await open('/');
    await waitForCollector(watched.page);
    const first = await settle(watched, server.url);
    const firstSigs = new Set(allFindings(first).map((f) => f.sig));
    expect(firstSigs.size).toBeGreaterThan(0);

    await revisit(watched, server.url, '/products.html');
    await waitForCollector(watched.page);
    const twoPages = await settle(watched, server.url);
    expect(twoPages.length, 'the second pageview sent nothing at all').toBeGreaterThan(first.length);

    const second = twoPages.slice(first.length);
    const repeated = allFindings(second).filter((f) => firstSigs.has(f.sig));
    expect(repeated.map((f) => f.rule), 'signatures resent in the same session').toEqual([]);
    expect(
      second.flatMap((b) => b.routes ?? []).map((r) => r.p),
      'the new route was not reported',
    ).toContain('/products.html');

    // A third pageview of a page the session has fully reported has nothing
    // left to say, and says nothing at all.
    await revisit(watched, server.url, '/');
    await waitForCollector(watched.page);
    const all = await settle(watched, server.url);
    expect(all.length, 'a fully-deduped pageview still sent a beacon').toBe(twoPages.length);

    expect(all.filter((b) => b.session?.started).length, 'session.started beacons').toBe(1);
    const rootRoutes = all.flatMap((b) => b.routes ?? []).filter((r) => r.p === '/');
    expect(rootRoutes, 'route "/" reported more than once').toHaveLength(1);
  });

  it('Section 11 — sampling is sticky per session and the kill switch stops injection', async () => {
    // 1. Not sampled: nothing injected, nothing sent.
    await setConfig(server.url, { sampleRate: 0 });
    const unsampled = await open('/', false);
    await unsampled.page.waitForTimeout(2500);
    expect(await engineInjected(unsampled.page), 'engine injected for an unsampled session').toBe(false);
    expect(await recordedBeacons(server.url)).toEqual([]);

    // 2. Sampled: a fresh session, a fresh decision, beacons arrive.
    await resetServer(server.url);
    await setConfig(server.url, { sampleRate: 1 });
    const sampled = await open('/', false);
    await waitForCollector(sampled.page);
    expect(await engineInjected(sampled.page)).toBe(true);

    // 3. Sticky: the rate drops to zero, but this session already decided.
    await setConfig(server.url, { sampleRate: 0 });
    await revisit(sampled, server.url, '/', false);
    await waitForCollector(sampled.page);
    expect(await engineInjected(sampled.page), 'the sampling decision was not sticky').toBe(true);

    // Settle this pageview before flipping the switch, so its collector has
    // already flushed and torn itself down: navigating away from a live
    // collector fires `pagehide`, and that beacon would otherwise land after
    // the reset below and be mistaken for one the killed pageview sent.
    await settle(sampled, server.url);
    await resetServer(server.url);

    // 4. Kill switch: the same sampled session stops dead.
    await setConfig(server.url, { killSwitch: true });
    await revisit(sampled, server.url, '/', false);
    await sampled.page.waitForTimeout(3000);
    expect(await engineInjected(sampled.page), 'the kill switch did not stop injection').toBe(false);
    expect(await recordedBeacons(server.url), 'beacons after the kill switch').toEqual([]);
  });

  it('Section 11 — an unsampled visitor pays for one config request and nothing else', async () => {
    await setConfig(server.url, { sampleRate: 0 });
    const watched = await open('/', false);
    await watched.page.waitForTimeout(2000);
    expect((await watched.resources()).filter((u) => u.includes('engine.js'))).toEqual([]);

    // A second pageview of the same unsampled session must not even ask again.
    await revisit(watched, server.url, '/', false);
    await watched.page.waitForTimeout(2000);
    expect((await watched.resources()).filter((u) => u.includes('engine.js'))).toEqual([]);

    const counts = await requestCounts(server.url);
    expect(counts.page, 'the fixture really was loaded twice').toBe(2);
    expect(counts.config, 'config requests across two unsampled pageviews').toBe(1);
    expect(counts.engine).toBe(0);
    expect(counts.ingest).toBe(0);
  });

  it('Section 11 — a barrier the user actually touched is flagged', async () => {
    const watched = await open('/');
    await waitForCollector(watched.page);
    // Usually the scan has recorded the button by now. On a slow runner it may
    // have parked first; the click is then held until the scan reaches it.
    await watched.page.waitForTimeout(3000);
    await watched.page.click('#icon-1');
    const beacons = await settle(watched, server.url, { scanMs: 500 });

    const touched = allFindings(beacons).filter((f) => f.i);
    const interactions = beacons.flatMap((b) => b.interactions ?? []);
    expect(
      touched.length + interactions.length,
      'a click on a barrier produced neither i:true nor an interactions entry',
    ).toBeGreaterThan(0);
    const clicked = allFindings(beacons).find((f) => f.el.tag === 'button' && f.rule === 'wcag:4.1.2');
    expect(clicked?.i, 'the clicked icon button was not flagged').toBe(true);
  });

  it('Section 11 — the route pattern is null for a script-tag install', async () => {
    const { beacons } = await collect();
    for (const f of allFindings(beacons)) expect(f.r, `finding ${f.rule}`).toBeNull();
    for (const b of beacons) for (const r of b.routes ?? []) expect(r.r, `route ${r.p}`).toBeNull();
    for (const b of beacons) for (const i of b.interactions ?? []) expect(i.r).toBeNull();
  });

  it('every beacon is a protocol v1 envelope, whatever content-type sendBeacon picked', async () => {
    await collect();

    const records = await recordedRequests(server.url);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      // `text/plain` for a `sendBeacon` Blob (deliberately — it keeps the
      // beacon a CORS-safelisted simple request), `application/json` for the
      // `fetch` fallback. The body is JSON either way and the ingest must
      // parse it without trusting the header.
      expect(record.headers.contentType).toMatch(/^(application\/json|text\/plain)/);
      const body = record.body as unknown as RumBeaconBody;
      expect(body.v).toBe(1);
      expect(body.k).toBe('acc_rum_0123456789abcdef01234567');
      expect(body.s).toMatch(/^[0-9a-f]{32}$/);
      expect(body.c).toBe(CORE_VERSION);
      expect(body.ctx.vw).toBeGreaterThan(0);
      // Every beacon carries the page's scan stats, not only the last one.
      expect(body.perf, 'perf missing from a beacon').toBeTruthy();
    }
  });
});
