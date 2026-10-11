/**
 * The browser harness: a fixture server, a page that is watched from the very
 * first byte, and a way to make the collector hand over everything it has.
 *
 * Every scenario gets its own page. The engine tears itself down completely on
 * `visibilitychange` hidden — that is the whole point of `settle()` — so a page
 * that has settled is finished, and reusing it would measure nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { createServer, type BeaconRecord, type FixtureServer, type RequestCounts } from '../../../../examples/dev-server.mjs';

export type { BeaconRecord, FixtureServer, RequestCounts };

export interface RumBeaconBody {
  v: number;
  k: string;
  s: string;
  c: string;
  sent: number;
  ctx: { vw: number; vh: number; dpr: number; zoom: number; fontPx: number; navigationMode: string };
  session?: { started: true };
  routes?: { p: string; r: string | null }[];
  findings?: RumFindingBody[];
  interactions?: { sig: string; r: string | null }[];
  perf?: { scans: number; longTasks: number; maxTaskMs: number; aborted: boolean; skipped?: string[]; pending?: string[] };
}

export interface RedactedEl {
  tag: string;
  attrs: Record<string, unknown>;
  text: { length: number; words: number; knownBad: boolean } | null;
  parent?: RedactedEl | null;
  children?: RedactedEl[];
}

export interface RumFindingBody {
  sig: string;
  key: string | null;
  rule: string;
  confidence: 'rule' | 'heuristic';
  impact: string | null;
  wcag: string[];
  p: string;
  r: string | null;
  el: RedactedEl;
  comp: { id: string; source?: string } | null;
  n: number;
  i: boolean;
}

export interface MutationRecordLite {
  /** `performance.now()` when the record was delivered. */
  t: number;
  phase: DocumentReadyState;
  type: string;
  target: string;
  attr: string | null;
  added: string[];
  removed: string[];
}

export interface WatchedPage {
  page: Page;
  /** Uncaught exceptions on this page. Must stay empty. */
  errors: string[];
  /** `console.error` entries on this page. Must stay empty. */
  consoleErrors: string[];
  /** Every mutation of the host document, tagged with when it was delivered. */
  mutations(): Promise<MutationRecordLite[]>;
  /** Mutations after DOMContentLoaded — everything the parser did is excluded. */
  hostMutations(): Promise<MutationRecordLite[]>;
  /** Resource URLs the page fetched, from its own resource timing. */
  resources(): Promise<string[]>;
  /** Long tasks observed on this page. */
  longTasks(): Promise<{ startTime: number; duration: number }[]>;
}

export const INIT_SCRIPT = readFileSync(
  fileURLToPath(new URL('./page-init.js', import.meta.url)),
  'utf8',
);

/** Starts the fixture dev server on a free port. */
export async function startServer(): Promise<FixtureServer> {
  return createServer(0);
}

/** Beacon bodies recorded by the server, oldest first. */
export async function recordedBeacons(url: string): Promise<RumBeaconBody[]> {
  const res = await fetch(`${url}/__beacons`);
  const records = (await res.json()) as BeaconRecord[];
  return records.map((r) => r.body as unknown as RumBeaconBody);
}

/** The raw records, headers included — the ingest content-type assertion needs them. */
export async function recordedRequests(url: string): Promise<BeaconRecord[]> {
  const res = await fetch(`${url}/__beacons`);
  return (await res.json()) as BeaconRecord[];
}

export async function requestCounts(url: string): Promise<RequestCounts> {
  const res = await fetch(`${url}/__requests`);
  return (await res.json()) as RequestCounts;
}

export async function resetServer(url: string): Promise<void> {
  await fetch(`${url}/__reset`, { method: 'POST' });
}

export async function setConfig(url: string, patch: Record<string, unknown>): Promise<void> {
  await fetch(`${url}/__config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * Waits for the transport's own 15s interval flush — the only beacon that
 * arrives while the visitor is still on the page. Anything asserted about what
 * the collector has *not* done yet has to be asserted against one of these.
 */
export async function waitForBeacon(
  url: string,
  count = 1,
  timeoutMs = 30_000,
): Promise<RumBeaconBody[]> {
  const started = Date.now();
  for (;;) {
    const beacons = await recordedBeacons(url);
    if (beacons.length >= count) return beacons;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waited ${timeoutMs}ms for ${count} beacon(s); got ${beacons.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** All the findings in a batch of beacons, flattened. */
export function allFindings(beacons: RumBeaconBody[]): RumFindingBody[] {
  return beacons.flatMap((b) => b.findings ?? []);
}

export function ruleSet(beacons: RumBeaconBody[]): Set<string> {
  return new Set(allFindings(beacons).map((f) => f.rule));
}

/** `?a11y_debug=1`, appended to whatever query the fixture path already carries. */
export function fixtureUrl(serverUrl: string, path: string, debug: boolean): string {
  if (!debug) return `${serverUrl}${path}`;
  return `${serverUrl}${path}${path.includes('?') ? '&' : '?'}a11y_debug=1`;
}

export interface OpenOptions {
  debug?: boolean;
  /** Reuse an existing context (same tab-less origin) instead of making one. */
  context?: BrowserContext;
  /**
   * Chromium's CPU throttling (DevTools' "4x/6x slowdown"), set before the page
   * loads: how the budget suite stands in for a slower device than the one
   * running the tests.
   */
  cpuThrottle?: number;
}

/**
 * Instruments a context so every page it opens is watched from document start,
 * then returns the watcher for the page it opens.
 */
export async function newWatchedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(INIT_SCRIPT);
  return context;
}

/** Attaches the collectors to a page created from a watched context. */
export function watch(page: Page): WatchedPage {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => errors.push(`${err.name}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  return {
    page,
    errors,
    consoleErrors,
    mutations: () => page.evaluate(() => (window as unknown as { __mutations: MutationRecordLite[] }).__mutations ?? []),
    hostMutations: () =>
      page.evaluate(() => {
        const w = window as unknown as { __mutations?: MutationRecordLite[]; __dclAt?: number };
        return (w.__mutations ?? []).filter((m) => m.t > (w.__dclAt ?? Infinity));
      }),
    resources: () =>
      page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name)),
    longTasks: () =>
      page.evaluate(() => (window as unknown as { __longTasks: { startTime: number; duration: number }[] }).__longTasks ?? []),
  };
}

/**
 * Opens a fixture page in a watched context and waits for it to load.
 *
 * `debug` appends `?a11y_debug=1`, which forces the loader to sample this
 * pageview regardless of the configured rate — every scenario that needs
 * findings uses it, and every scenario that tests sampling does not.
 */
export async function openPage(
  browser: Browser,
  serverUrl: string,
  path: string,
  options: OpenOptions = {},
): Promise<{ watched: WatchedPage; context: BrowserContext; ownsContext: boolean }> {
  const debug = options.debug ?? true;
  const context = options.context ?? (await newWatchedContext(browser));
  const watched = watch(await context.newPage());
  if (options.cpuThrottle && options.cpuThrottle > 1) {
    const cdp = await context.newCDPSession(watched.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottle });
  }
  await revisit(watched, serverUrl, path, debug);
  return { watched, context, ownsContext: options.context === undefined };
}

/** Navigates an already-watched page again, in the same tab (same sessionStorage). */
export async function revisit(
  watched: WatchedPage,
  serverUrl: string,
  path: string,
  debug = true,
): Promise<void> {
  await watched.page.goto(fixtureUrl(serverUrl, path, debug), { waitUntil: 'load' });
}

/** Resolves once the engine bundle has loaded and `startCollector` has claimed the page. */
export async function waitForCollector(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __accessibleRumStarted?: boolean }).__accessibleRumStarted === true,
    undefined,
    { timeout },
  );
}

/** True if the loader injected the engine <script> — the sampling gate's only visible effect. */
export async function engineInjected(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('script[src*="engine.js"]') !== null);
}

/**
 * Makes the collector hand over everything and stop.
 *
 * `scanMs` is the quiet period the scan engine gets first: it runs one axe
 * chunk per idle callback, and hiding the page mid-pass would measure how fast
 * we hit Ctrl-W rather than what the collector found. After that the page is
 * marked hidden, which is what the engine treats as the end of the session:
 * one final flush (with its one inline retry) and a full teardown. Then we
 * wait for `/__beacons` to stop growing.
 */
export async function settle(
  watched: WatchedPage,
  serverUrl: string,
  options: { scanMs?: number; quietMs?: number; timeoutMs?: number } = {},
): Promise<RumBeaconBody[]> {
  const scanMs = options.scanMs ?? 3000;
  const quietMs = options.quietMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const { page } = watched;

  await page.waitForTimeout(scanMs);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    const beacons = await recordedBeacons(serverUrl);
    if (beacons.length !== last) {
      last = beacons.length;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return beacons;
    }
    if (Date.now() - started > timeoutMs) return beacons;
    await page.waitForTimeout(100);
  }
}

/**
 * Per-test bookkeeping shared by the three suites: every page a test opens is
 * watched, every context it opens is closed afterwards, and the "nothing threw
 * anywhere" row is checked over all of them at once.
 */
export interface FixtureSession {
  open(path: string, debug?: boolean): Promise<WatchedPage>;
  pages: WatchedPage[];
  errors(): string[];
  consoleErrors(): string[];
  closeAll(): Promise<void>;
}

export function fixtureSession(browser: Browser, serverUrl: string, cpuThrottle = 1): FixtureSession {
  const pages: WatchedPage[] = [];
  const contexts: BrowserContext[] = [];
  return {
    pages,
    async open(path, debug = true) {
      const context = await newWatchedContext(browser);
      contexts.push(context);
      const { watched } = await openPage(browser, serverUrl, path, { debug, context, cpuThrottle });
      pages.push(watched);
      return watched;
    },
    errors: () => pages.flatMap((p) => p.errors),
    consoleErrors: () => pages.flatMap((p) => p.consoleErrors),
    async closeAll() {
      for (const context of contexts) await context.close().catch(() => {});
    },
  };
}
