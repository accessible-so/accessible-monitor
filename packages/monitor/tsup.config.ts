import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { BANNER } from './src/banner';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig([
  {
    entry: { loader: 'src/loader.ts' },
    format: ['iife'],
    target: 'es2017',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    clean: true,
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
  },
  {
    entry: { engine: 'src/engine-entry.ts' },
    format: ['iife'],
    target: 'es2018',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    clean: false,
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
    noExternal: ['axe-core', '@accessible-so/monitor-core'],
    define: { __VERSION__: JSON.stringify(version) },
    // The bundle inlines axe-core, which is MPL-2.0. A minified IIFE with no
    // notice in it is a licence problem wherever it is served from, and this
    // one is served from the customer's own origin — so the notice travels
    // with the file rather than living only in THIRD_PARTY_NOTICES.md.
    banner: { js: BANNER },
  },
]);
