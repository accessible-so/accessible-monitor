/**
 * The Next adapter's end-to-end proof.
 *
 * Everything below runs against a real `next build` of `examples/next-app`,
 * served by `next start`, driven by a headless Chromium, and asserted on the
 * beacons the browser actually sent to the collector's fixture server. Nothing
 * is mocked: the route patterns come out of `AccessibleMonitor` at runtime and
 * the component names come out of the SWC plugin at build time.
 *
 * Two claims are worth stating plainly, because they are what the suite exists
 * to catch:
 *
 *   * A route pattern is not a path. Every pattern assertion also asserts that
 *     `r` differs from `p` — a regression that quietly reported the concrete
 *     URL would otherwise pass.
 *   * Attribution is optional. `plugin.wasm` is a build artefact and may not be
 *     on this machine; the component tests skip rather than fail, and the rest
 *     of the suite still holds, because that is exactly the degradation the
 *     adapter promises.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  allFindings,
  engineInjected,
  recordedBeacons,
  recordedRequests,
  requestCounts,
  resetServer,
  setConfig,
  settle,
  startServer,
  waitForCollector,
  watch,
  type FixtureServer,
  type RumFindingBody,
  type WatchedPage,
} from '../../../monitor/test/browser/harness';
import { buildAndStartNextApp, BUILD_TIMEOUT_MS, wasmPresent, type NextApp } from './next-harness';

/** axe's `image-alt`, the one barrier every fixture page carries on purpose. */
const MISSING_ALT = 'wcag:1.1.1';

let browser: Browser;
let server: FixtureServer;
let app: NextApp;
/**
 * A second, independent build of the same fixture under Turbopack, into its
 * own `NEXT_DIST_DIR` (`examples/next-app/next.config.mjs` reads it) and its
 * own port — never built when there is no wasm to attribute with, since it
 * exists only for the component-attribution test below. Built here, not
 * inside that test, so it coexists with `app` for the whole suite's run and
 * no test's ordering relative to it matters.
 */
let turboApp: NextApp | undefined;

/** Per-test bookkeeping: everything opened is watched, and closed afterwards. */
let contexts: BrowserContext[] = [];
let pages: WatchedPage[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  // The fixture server first: its origin is baked into the app at build time.
  server = await startServer();
  app = await buildAndStartNextApp(server.url);
  if (wasmPresent) turboApp = await buildAndStartNextApp(server.url, 'turbopack');
}, 2 * BUILD_TIMEOUT_MS + 60_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await turboApp?.close();
  await server?.close();
});

beforeEach(async () => {
  contexts = [];
  pages = [];
  await resetServer(server.url);
  // The normal path, not `?a11y_debug=1`: the loader's own sampling gate is
  // what decides, and here it is configured to say yes.
  await setConfig(server.url, { sampleRate: 1 });
});

afterEach(async () => {
  const errors = pages.flatMap((p) => p.errors);
  const consoleErrors = pages.flatMap((p) => p.consoleErrors);
  for (const context of contexts) await context.close().catch(() => {});
  expect(errors, 'uncaught page exceptions').toEqual([]);
  expect(consoleErrors, 'console.error entries').toEqual([]);
});

/** Opens a page of a Next app in its own context, watched from the start. Defaults to the shared `app`. */
async function open(path: string, target: NextApp = app): Promise<WatchedPage> {
  const context = await browser.newContext();
  contexts.push(context);
  const watched = watch(await context.newPage());
  pages.push(watched);
  await watched.page.goto(`${target.url}${path}`, { waitUntil: 'load' });
  return watched;
}

function missingAltOn(findings: RumFindingBody[], path: string): RumFindingBody | undefined {
  return findings.find((f) => f.rule === MISSING_ALT && f.p === path);
}

describe('the Next adapter, end to end', () => {
  it('reports the route pattern for a dynamic segment', async () => {
    const watched = await open('/products/red-shoes');
    await waitForCollector(watched.page);
    const beacons = await settle(watched, server.url);

    const finding = missingAltOn(allFindings(beacons), '/products/red-shoes');
    expect(finding, 'a missing-alt finding on /products/red-shoes').toBeDefined();
    expect(finding!.r).toBe('/products/[slug]');
    // The pattern is the adapter's work, not an echo of the URL.
    expect(finding!.r).not.toBe(finding!.p);

    expect(beacons.flatMap((b) => b.routes ?? [])).toContainEqual({
      p: '/products/red-shoes',
      r: '/products/[slug]',
    });
  });

  it('reports a catch-all pattern', async () => {
    const watched = await open('/docs/a/b');
    await waitForCollector(watched.page);
    const beacons = await settle(watched, server.url);

    const finding = missingAltOn(allFindings(beacons), '/docs/a/b');
    expect(finding, 'a missing-alt finding on /docs/a/b').toBeDefined();
    expect(finding!.r).toBe('/docs/[...parts]');
    expect(finding!.r).not.toBe(finding!.p);
  });

  it('keeps the pattern for a page after a client-side navigation', async () => {
    const watched = await open('/');
    await waitForCollector(watched.page);

    // A real in-app navigation: no document load, so the pattern can only come
    // from the map `AccessibleMonitor` keeps up to date.
    await watched.page.click('#to-blue');
    await watched.page.waitForURL(`${app.url}/products/blue-shoes`);
    await watched.page.waitForSelector('article img');

    const beacons = await settle(watched, server.url);
    const finding = missingAltOn(allFindings(beacons), '/products/blue-shoes');
    expect(finding, 'a missing-alt finding on /products/blue-shoes').toBeDefined();
    expect(finding!.p).toBe('/products/blue-shoes');
    expect(finding!.r).toBe('/products/[slug]');

    // The landing page was visited too, and it is a different pattern.
    const routes = beacons.flatMap((b) => b.routes ?? []);
    expect(routes).toContainEqual({ p: '/', r: '/' });
    expect(routes).toContainEqual({ p: '/products/blue-shoes', r: '/products/[slug]' });
  });

  /**
   * The plugin is registered by package specifier precisely so it resolves
   * under both bundlers Next ships (`withAccessible`'s only form, since an
   * absolute path to `plugin.wasm` builds under webpack but Turbopack
   * refuses to resolve it). `app` is a webpack build; `turboApp` is the same
   * fixture built under `--turbopack` into its own output directory, built
   * alongside `app` in `beforeAll` so the two `next start` servers coexist —
   * this assertion has no ordering relationship with any other test in the
   * file.
   */
  it.skipIf(!wasmPresent)('attributes the finding to the component the plugin stamped, under webpack and Turbopack', async () => {
    async function assertAttributionOn(target: NextApp): Promise<void> {
      await resetServer(server.url);
      const watched = await open('/products/red-shoes', target);
      await waitForCollector(watched.page);
      const beacons = await settle(watched, server.url);

      const finding = missingAltOn(allFindings(beacons), '/products/red-shoes');
      expect(finding, 'a missing-alt finding on /products/red-shoes').toBeDefined();
      expect(finding!.comp).not.toBeNull();
      // The image is inside <ProductCard>, which is inside <ProductPage>, which
      // is inside <RootLayout>: the nearest stamp wins, or attribution is
      // pointing at a wrapper rather than at the code that has the bug.
      expect(finding!.comp!.id).toBe('ProductCard');
      expect(finding!.comp!.source).toMatch(/^components\/ProductCard\.tsx:\d+$/);
      // A concrete line, not a placeholder: `:0` would mean the plugin gave up
      // on the source map and stamped a guess.
      const line = Number(finding!.comp!.source!.split(':')[1]);
      expect(line).toBeGreaterThan(0);
    }

    await assertAttributionOn(app);
    await assertAttributionOn(turboApp!);
    // Worth knowing, not worth failing over: report it rather than assert a
    // threshold that would make the suite flaky on a loaded CI runner.
    if (turboApp!.buildMs > app.buildMs * 1.5) {
      console.log(
        `Turbopack build (${(turboApp!.buildMs / 1000).toFixed(1)}s) was markedly slower than webpack ` +
          `(${(app.buildMs / 1000).toFixed(1)}s)`,
      );
    }
  });

  /**
   * The one thing a script-tag fixture on its own origin can never check.
   *
   * A customer's site and the ingest host are always different origins, and
   * `navigator.sendBeacon` sends with credentials mode "include" — so a
   * beacon that needed a CORS check would be refused by any endpoint
   * answering a flat `*`, after `sendBeacon` had already returned `true`.
   * The transport avoids the check entirely by declaring the Blob
   * `text/plain`, a CORS-safelisted type: the request is "no-cors", is never
   * preflighted, and its response headers are never inspected. This asserts
   * that, against an endpoint deliberately configured the unhelpful way.
   */
  it('delivers beacons cross-origin to an endpoint that answers a wildcard origin', async () => {
    server.setCors('wildcard');
    // Not a claim about the fixture's internals: the endpoint really does
    // answer `*` to a request that carries an Origin.
    const probe = await fetch(`${server.url}/api/a11y/config`, { headers: { Origin: app.url } });
    expect(probe.headers.get('access-control-allow-origin')).toBe('*');

    const watched = await open('/products/red-shoes');
    await waitForCollector(watched.page);
    const beacons = await settle(watched, server.url);

    expect(beacons.length, 'beacons delivered').toBeGreaterThan(0);
    const finding = missingAltOn(allFindings(beacons), '/products/red-shoes');
    expect(finding, 'a missing-alt finding on /products/red-shoes').toBeDefined();
    expect(finding!.r).toBe('/products/[slug]');

    const records = await recordedRequests(server.url);
    // The page and the endpoint really are different origins...
    expect(records[0]!.headers.origin).toBe(app.url);
    // ...and it was the `sendBeacon` path, not the `fetch` fallback, that
    // carried them: only the Blob declares `text/plain`.
    expect(records.every((r) => (r.headers.contentType ?? '').startsWith('text/plain'))).toBe(true);
  });

  it('sends nothing when the loader is not sampled', async () => {
    await setConfig(server.url, { sampleRate: 0 });
    const watched = await open('/products/red-shoes');

    // Wait for the decision to have been made, not for a fixed delay: the
    // loader always fetches the config, and refuses only after it arrives.
    const deadline = Date.now() + 15_000;
    for (;;) {
      if ((await requestCounts(server.url)).config >= 1) break;
      if (Date.now() > deadline) throw new Error('the loader never fetched the config');
      await watched.page.waitForTimeout(100);
    }
    // Generous room for the engine injection that must not happen: the loader
    // schedules it on an idle callback with a 3s timeout.
    await watched.page.waitForTimeout(5000);

    expect(await engineInjected(watched.page), 'engine <script> injected').toBe(false);
    const counts = await requestCounts(server.url);
    expect(counts.engine, 'engine bundle requests').toBe(0);
    expect(counts.ingest, 'ingest requests').toBe(0);
    expect(await recordedBeacons(server.url)).toEqual([]);
  });
});
