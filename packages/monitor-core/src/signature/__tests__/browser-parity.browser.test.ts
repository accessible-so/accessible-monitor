// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSignature } from '../index';
import { buildCorpus } from './corpus';

/*
 * The signature is layout-independent by construction. This proves it: the
 * same DOM hashed in jsdom and in real Chromium (through the shipped browser
 * bundle) must agree on every probe. Run with `pnpm test:browser` after
 * `pnpm build` and `npx playwright install chromium`.
 */
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

describe('browser parity', () => {
  it('produces identical signatures in Chromium and jsdom for every corpus probe', async () => {
    const html = buildCorpus('A');
    const source = readFileSync(join(__dirname, '..', '..', '..', 'dist', 'signature', 'browser.global.js'), 'utf8');

    document.body.innerHTML = html;
    const expected = Object.fromEntries(
      Array.from(document.querySelectorAll('[data-probe]')).map((el) => [el.getAttribute('data-probe'), computeSignature(el, 'axe:probe')]),
    );

    const page = await browser.newPage();
    await page.addInitScript(source);
    // `addInitScript` only takes effect on the next navigation; the page
    // created by `newPage()` is already sitting on its initial about:blank,
    // and `setContent()` alone does not count as one. Navigate explicitly
    // first so the init script actually runs before we set the corpus HTML.
    await page.goto('about:blank');
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    const actual = await page.evaluate(() =>
      Object.fromEntries(
        Array.from(document.querySelectorAll('[data-probe]')).map((el) => [
          el.getAttribute('data-probe'),
          (globalThis as any).AccessibleSignature.computeSignature(el, 'axe:probe'),
        ]),
      ),
    );
    await page.close();

    expect(Object.keys(actual)).toHaveLength(Object.keys(expected).length);
    expect(actual).toEqual(expected);
  });
});
