import { defineConfig } from 'vitest/config';

/**
 * The Next adapter's browser suite. Node environment — Playwright drives a
 * real Chromium against a real `next start`, so there is no jsdom here. One
 * file at a time, and generously timed: `beforeAll` runs a full `next build`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/browser/**/*.browser.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
