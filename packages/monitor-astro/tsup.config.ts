import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // The integration itself: runs in Astro's Node process, never in a page.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    platform: 'node',
    external: ['astro', 'vite'],
  },
  {
    // What the generated module imports in the browser. Kept separate so a
    // page bundles only the matcher, not the integration.
    entry: { client: 'src/client.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    target: 'es2019',
    platform: 'browser',
  },
]);
