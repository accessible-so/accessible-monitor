import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// The same substitution tsup makes for the bundles (see tsup.config.ts), so
// the suite reads the real package version rather than an undefined global.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: { __COLLECTOR_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
