/**
 * The four behavioural observers, driven by real input in a real browser.
 *
 * These are the findings a static scan cannot produce: a Tab loop with no exit,
 * a burst of Tab presses that move nothing, a route change that strands focus
 * on <body>, and a control that takes focus without showing it. All four are
 * heuristics and say so — `confidence: 'heuristic'` is part of every assertion
 * here, because a heuristic reported as a rule is a lie about how sure we are.
 *
 * jsdom cannot exercise any of them honestly: it has no layout, so
 * `focus-not-visible` reads empty strings from `getComputedStyle` and can never
 * fire. This file is the only place that observer has ever run for real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  allFindings,
  fixtureSession,
  resetServer,
  settle,
  startServer,
  waitForCollector,
  type FixtureServer,
  type FixtureSession,
  type RumBeaconBody,
  type RumFindingBody,
  type WatchedPage,
} from './harness';

let browser: Browser;
let server: FixtureServer;
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

afterEach(async () => {
  const errors = session.errors();
  const consoleErrors = session.consoleErrors();
  await session.closeAll();
  expect(errors, 'uncaught page exceptions').toEqual([]);
  expect(consoleErrors, 'console.error entries').toEqual([]);
});

/**
 * Opens the fixture, lets the first scan pass finish, runs `act`, then settles.
 *
 * The scan has to be out of the way first for the same reason a real session
 * does not start with a keyboard trap: the observers share the main thread with
 * axe, and a finding recorded mid-scan is harder to reason about than one
 * recorded after it.
 */
async function drive(
  act: (page: Page) => Promise<void>,
  path = '/',
): Promise<{ watched: WatchedPage; beacons: RumBeaconBody[]; findings: RumFindingBody[] }> {
  const watched = await session.open(path);
  await waitForCollector(watched.page);
  await watched.page.waitForTimeout(3000);
  await act(watched.page);
  const beacons = await settle(watched, server.url, { scanMs: 1000 });
  return { watched, beacons, findings: allFindings(beacons) };
}

function observed(findings: RumFindingBody[], rule: string): RumFindingBody {
  const hit = findings.find((f) => f.rule === rule);
  expect(hit, `no ${rule} among [${findings.map((f) => f.rule).join(', ')}]`).toBeTruthy();
  return hit as RumFindingBody;
}

describe('behavioural observers in Chromium', () => {
  it('obs:focus-trap — eight Tab presses that never leave three controls', async () => {
    const { findings, beacons } = await drive(async (page) => {
      await page.click('#open-dialog');
      for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
      await page.waitForTimeout(500);
    });

    const trap = observed(findings, 'obs:focus-trap');
    expect(trap.confidence).toBe('heuristic');
    expect(trap.wcag).toEqual(['2.1.2']);
    expect(trap.impact).toBe('critical');
    // The finding is attributed to the common ancestor of the trapped controls.
    expect(trap.el.tag).toBe('div');
    expect(trap.el.attrs.role).toBe('dialog');

    // A click plus keyboard navigation is a mixed session, and the mode is
    // inferred from behaviour alone — never from the user agent.
    expect(beacons.at(-1)?.ctx.navigationMode).toBe('mixed');
  });

  it('obs:rage-tab — four Tab presses that move focus nowhere', async () => {
    const { findings } = await drive(async (page) => {
      await page.focus('#dead');
      for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
      await page.waitForTimeout(800);
    });

    const rage = observed(findings, 'obs:rage-tab');
    expect(rage.confidence).toBe('heuristic');
    expect(rage.wcag).toEqual(['2.1.1']);
    expect(rage.impact).toBe('serious');
    expect(rage.el.tag).toBe('div');
    expect(rage.el.attrs.tabindex).toBe('0');
  });

  it('obs:spa-focus-loss — a pushState route change that leaves focus on <body>', async () => {
    const { findings, beacons } = await drive(async (page) => {
      await page.click('#go-products');
      await page.waitForTimeout(1500);
    });

    const lost = observed(findings, 'obs:spa-focus-loss');
    expect(lost.confidence).toBe('heuristic');
    expect(lost.wcag).toEqual(['2.4.3']);
    expect(lost.impact).toBe('serious');
    expect(lost.el.tag).toBe('main');

    // The client-side route change is reported as a route, with a null pattern
    // because a script-tag install has no framework adapter to supply one.
    const routes = beacons.flatMap((b) => b.routes ?? []);
    expect(routes).toContainEqual({ p: '/products', r: null });
  });

  it('obs:focus-not-visible — a control that takes focus with no visible indicator', async () => {
    const { findings, watched } = await drive(async (page) => {
      await page.focus('#before-nofocus');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);
    });

    // The fixture must really have removed the indicator, or the assertion below
    // proves nothing about the observer.
    const style = await watched.page.evaluate(() => {
      const el = document.getElementById('nofocus') as HTMLElement;
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
    });
    expect(style.outlineStyle).toBe('none');
    expect(style.boxShadow).toBe('none');

    const invisible = observed(findings, 'obs:focus-not-visible');
    expect(invisible.confidence).toBe('heuristic');
    expect(invisible.wcag).toEqual(['2.4.7']);
    expect(invisible.impact).toBe('serious');
    expect(invisible.el.tag).toBe('button');
  });

  it('navigationMode — a session driven only from the keyboard says so', async () => {
    const { beacons } = await drive(async (page) => {
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(60);
      }
    });

    expect(beacons.at(-1)?.ctx.navigationMode).toBe('keyboard-driven');
  });

  it('navigationMode — a session with no input at all stays unknown', async () => {
    const { beacons } = await drive(async () => {});
    expect(beacons.at(-1)?.ctx.navigationMode).toBe('unknown');
  });
});
