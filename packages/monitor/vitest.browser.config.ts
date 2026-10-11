import { defineConfig } from 'vitest/config';

/**
 * The browser constraint suites. Node environment — Playwright drives a real
 * Chromium; there is no jsdom here. The suites are run one file at a time on
 * purpose: `perf.browser.test.ts` measures per-task milliseconds, and three
 * headless Chromiums competing for the same cores would measure the machine,
 * not the collector.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/browser/**/*.browser.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
