/**
 * The notice `dist/engine.js` opens with.
 *
 * It lives in its own module because two things need it and neither may pull in
 * the other: `tsup.config.ts` prepends it at build time, and
 * `__tests__/bundle-content.test.ts` asserts the built file really starts with
 * it. (Importing the tsup config from a jsdom test drags esbuild in with it.)
 */
export const BANNER =
  '/*! @accessible-so/monitor — MIT. Bundles axe-core 4.13.0 (MPL-2.0), source: https://github.com/dequelabs/axe-core */';
