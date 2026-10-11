import { withAccessible } from '@accessible-so/monitor-next/config';

/**
 * The component-attribution SWC plugin is a build artefact (`node
 * scripts/build-swc.mjs`), so it is opt-in here: the browser suite sets
 * `A11Y_SWC=1` when `packages/monitor-next/swc/plugin.wasm` is on disk and
 * leaves it unset otherwise. Route patterns do not depend on it — only
 * `finding.comp` does, and without the plugin that is honestly null.
 */
const base = {
  reactStrictMode: true,
  // No ESLint config ships with the fixture; keep `next build` deterministic
  // whether or not one is present in the workspace above it.
  eslint: { ignoreDuringBuilds: true },
  // Lets the browser suite build the same fixture under webpack and under
  // Turbopack into two separate output directories, so both `next start`
  // servers can coexist for the suite's lifetime instead of one bundler's
  // build silently overwriting the files the other bundler's server is
  // reading from.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
};

export default withAccessible(base, {
  componentAttribution: process.env.A11Y_SWC === '1',
});
