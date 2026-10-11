import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2019',
    platform: 'browser',
    // `index` now re-exports the two client components, so every emitted
    // file must open with the `'use client'` directive. tsup's `banner`
    // option can end up placed after tsup/esbuild's own CJS/ESM interop
    // helpers, which would silently defeat the directive — so set it via
    // esbuild's own banner instead, which esbuild always emits first.
    esbuildOptions(o) {
      o.banner = { js: "'use client';" };
    },
  },
  {
    // Node-only: the `next.config.js` helper. No `'use client'` banner —
    // this must stay importable from a plain Node process without pulling
    // React (or the `'use client'` directive, which is meaningless there).
    entry: { config: 'src/config.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    // `config.ts` resolves this package's own `package.json` through
    // `createRequire(import.meta.url)`, to check whether `swc/plugin.wasm`
    // was ever built before registering the plugin. So `import.meta.url` has
    // to survive the bundle: es2019 silently empties it out, which would break
    // the resolve at runtime and turn the check into a permanent "missing".
    // node18 covers every supported Next.js/Node version, and `shims` makes
    // tsup polyfill `import.meta.url` in the CJS build too, where it isn't
    // valid syntax.
    target: 'node18',
    platform: 'node',
    shims: true,
  },
]);
