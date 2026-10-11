import { defineConfig } from 'vitest/config';

/**
 * The Astro integration's browser suite. Node environment — Playwright drives
 * a real Chromium against a real `astro build` served by `astro preview`. One
 * file at a time, and generously timed: `beforeAll` runs the build.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/browser/**/*.browser.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
