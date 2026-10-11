import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

// `COLLECTOR_VERSION` — the `c` field on every beacon — comes from here rather
// than from a literal in the source, so it cannot drift from the released
// package again.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const define = { __COLLECTOR_VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'signature/index': 'src/signature/index.ts',
      'protocol/index': 'src/protocol/index.ts',
      'redact/index': 'src/redact/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    outDir: 'dist',
    define,
  },
  {
    entry: { 'signature/browser': 'src/signature/browser.ts' },
    format: ['iife'],
    minify: true,
    sourcemap: false,
    target: 'es2018',
    outDir: 'dist',
    outExtension: () => ({ js: '.global.js' }),
    define,
  },
]);
