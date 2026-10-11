import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  allFindings,
  engineInjected,
  recordedBeacons,
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
import { buildAndPreview, BUILD_TIMEOUT_MS, type AstroSite } from './astro-harness';

const MISSING_ALT = 'wcag:1.1.1';

let browser: Browser;
let server: FixtureServer;
let site: AstroSite;
let shop: AstroSite;
let contexts: BrowserContext[] = [];
let pages: WatchedPage[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  // The fixture server first: its origin is baked into the site at build time.
  server = await startServer();
  site = await buildAndPreview(server.url);
  shop = await buildAndPreview(server.url, '/shop');
}, 2 * BUILD_TIMEOUT_MS + 60_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  await shop?.close();
  await server?.close();
});

beforeEach(async () => {
  contexts = [];
  pages = [];
  await resetServer(server.url);
  await setConfig(server.url, { sampleRate: 1 });
});

afterEach(async () => {
  const errors = pages.flatMap((p) => p.errors);
  const consoleErrors = pages.flatMap((p) => p.consoleErrors);
  for (const context of contexts) await context.close().catch(() => {});
  expect(errors, 'uncaught page exceptions').toEqual([]);
  expect(consoleErrors, 'console.error entries').toEqual([]);
});

async function open(url: string): Promise<WatchedPage> {
  const context = await browser.newContext();
  contexts.push(context);
  const watched = watch(await context.newPage());
  pages.push(watched);
  await watched.page.goto(url, { waitUntil: 'load' });
  return watched;
}

/** Astro's static build serves `/a/` and `/a` alike; compare without the slash. */
const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

function missingAltOn(findings: RumFindingBody[], path: string): RumFindingBody | undefined {
  return findings.find((f) => f.rule === MISSING_ALT && bare(f.p) === path);
}

async function patternFor(target: AstroSite, path: string, fullPath = path): Promise<string | null | undefined> {
  const watched = await open(`${target.url}${path}`);
  await waitForCollector(watched.page);
  const finding = missingAltOn(allFindings(await settle(watched, server.url)), fullPath);
  expect(finding, `a missing-alt finding on ${fullPath}`).toBeDefined();
  return finding!.r;
}

describe('the Astro integration, end to end', () => {
  it('reports the route pattern for a dynamic segment', async () => {
    expect(await patternFor(site, '/products/red-shoes')).toBe('/products/[slug]');
  });

  it("follows Astro's priority: a static route beats the dynamic one beside it", async () => {
    expect(await patternFor(site, '/products/featured')).toBe('/products/featured');
  });

  it('reports a catch-all pattern', async () => {
    expect(await patternFor(site, '/docs/a/b')).toBe('/docs/[...parts]');
  });

  it('keeps reporting patterns across client-router navigation', async () => {
    const watched = await open(`${site.url}/`);
    await waitForCollector(watched.page);
    await watched.page.click('#to-blue');
    await watched.page.waitForURL(/\/products\/blue-shoes\/?$/);
    await watched.page.waitForSelector('h1:text("blue-shoes")');

    const beacons = await settle(watched, server.url);
    const finding = missingAltOn(allFindings(beacons), '/products/blue-shoes');
    expect(finding, 'a missing-alt finding on /products/blue-shoes').toBeDefined();
    expect(finding!.r).toBe('/products/[slug]');
    const routes = beacons.flatMap((b) => b.routes ?? []).map((r) => ({ p: bare(r.p), r: r.r }));
    expect(routes).toContainEqual({ p: '/', r: '/' });
    expect(routes).toContainEqual({ p: '/products/blue-shoes', r: '/products/[slug]' });
  });

  it('reports the app route under a base path, without the base', async () => {
    expect(await patternFor(shop, '/products/red-shoes', '/shop/products/red-shoes')).toBe('/products/[slug]');
  });

  it('sends nothing when the loader is not sampled', async () => {
    await setConfig(server.url, { sampleRate: 0 });
    const watched = await open(`${site.url}/products/red-shoes`);
    const deadline = Date.now() + 15_000;
    while ((await requestCounts(server.url)).config < 1) {
      if (Date.now() > deadline) throw new Error('the loader never fetched the config');
      await watched.page.waitForTimeout(100);
    }
    // Room for the engine injection that must not happen (idle callback, 3s timeout).
    await watched.page.waitForTimeout(5000);
    expect(await engineInjected(watched.page), 'engine <script> injected').toBe(false);
    const counts = await requestCounts(server.url);
    expect(counts.engine).toBe(0);
    expect(counts.ingest).toBe(0);
    expect(await recordedBeacons(server.url)).toEqual([]);
  });
});
