import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface WithAccessibleOptions {
  /**
   * Registers the build-time SWC plugin that annotates elements with the
   * source component/file they came from, for attribution in findings.
   * Everything else works without it; attribution is simply null.
   * Defaults to `true`.
   */
  componentAttribution?: boolean;
  /**
   * Test seam: reports whether this package's `swc/plugin.wasm` is on disk.
   * Defaults to a real filesystem check. Not part of the supported API.
   * @internal
   */
  pluginExists?: () => boolean;
  /**
   * Test seam: the version of the `next` the host project will build with,
   * or null when it cannot be determined. Defaults to reading the resolved
   * `next/package.json`. Not part of the supported API.
   * @internal
   */
  nextVersion?: () => string | null;
}

/**
 * The plugin is registered by its package specifier, not an absolute path.
 * Webpack's SWC pass will resolve either form, but Turbopack only accepts a
 * module specifier — an absolute path to `plugin.wasm` fails there with
 * `Module not found`. The specifier form was verified to build and to stamp
 * correctly under both `next build --webpack` and `next build --turbopack` on
 * Next 16.3.5 and 16.4.1, so it is the only form `withAccessible` emits.
 */
const SWC_PLUGIN_SPECIFIER = '@accessible-so/monitor-next/swc';

/**
 * The Next release line `swc/plugin.wasm` is built for: stable 16.4.x.
 *
 * An SWC plugin is a wasm module that exchanges a serialized AST with its
 * host, and the layout of that AST is fixed by the exact `swc_core` the two
 * sides were compiled against. Ours is built against `swc_core` 79
 * (`swc_common` 26, `swc_ecma_ast` 29, `swc_plugin_runner` 34), which is what
 * Next 16.4.0–16.4.3 link. Next moves that AST between minors, not just
 * majors — 16.3 links `swc_ecma_ast` 25, 16.2 links 20 — and loading this
 * wasm on any of them does not degrade, it fails the user's build.
 *
 * So the version is checked before the plugin is registered at all, and
 * every other version gets the same graceful path a missing wasm gets: every
 * other part of the adapter works there and only attribution does not.
 * Prereleases are refused too, since a 16.4 canary can predate the bump.
 */
const SUPPORTED_NEXT = '16.4';
const SUPPORTED_NEXT_VERSION = /^\s*16\.4\.\d+\s*$/;

/**
 * The version of `next` the host project will build with.
 *
 * Resolved the same way as the wasm: through this module's own `require`, so
 * it finds the `next` that is actually linked beside this package — which is
 * the one whose SWC will be asked to load the plugin. Returns null rather
 * than throwing when there is no resolvable `next` at all, which is the
 * answer for a config being linted outside a Next project.
 */
function hostNextVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const { version } = req('next/package.json') as { version?: string };
    return version ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the wasm actually on disk?
 *
 * It has to be asked. The wasm is a build artefact — gitignored, produced by
 * `node scripts/build-swc.mjs`, which needs a Rust toolchain — so a tarball
 * packed on a machine without Rust ships without it. Next resolves every
 * `experimental.swcPlugins` entry with `require.resolve`, so registering the
 * specifier when the file is missing fails the whole `next build` with
 * `Cannot find module`, which is the opposite of the graceful degradation this
 * package promises everywhere else.
 *
 * Resolved through this package's own `exports` map (Node's package
 * self-reference), the same route the consumer's Next takes, so a layout that
 * resolves here resolves there too.
 */
function pluginWasmExists(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve('@accessible-so/monitor-next/package.json');
    return existsSync(join(dirname(pkg), 'swc', 'plugin.wasm'));
  } catch {
    return false;
  }
}

/** Wrap `next.config` to enable build-time component attribution. Without it everything else works; attribution is null. */
export function withAccessible<T extends object>(nextConfig: T, options?: WithAccessibleOptions): T;
export function withAccessible<A extends unknown[], R extends object>(
  nextConfig: (...args: A) => R | Promise<R>,
  options?: WithAccessibleOptions,
): (...args: A) => Promise<R>;
export function withAccessible(
  nextConfig: object | ((...args: never[]) => unknown),
  options: WithAccessibleOptions = {},
): unknown {
  // Next also accepts a function config (`export default (phase) => ({...})`).
  // Spreading a function yields `{}` — silently discarding the user's entire
  // config — so call it and re-enter with what it returns instead.
  if (typeof nextConfig === 'function') {
    return (...args: never[]) =>
      Promise.resolve(nextConfig(...args)).then((cfg) => withAccessible(cfg as object, options));
  }

  if (options.componentAttribution === false) return nextConfig;

  const exists = options.pluginExists ?? pluginWasmExists;
  if (!exists()) {
    console.warn('[accessible] swc/plugin.wasm not found; building without component attribution');
    return nextConfig;
  }

  // Checked second, so a machine with no wasm at all reports that rather than
  // its Next version — the missing artefact is the more actionable of the two.
  const version = (options.nextVersion ?? hostNextVersion)();
  if (version === null || !SUPPORTED_NEXT_VERSION.test(version)) {
    console.warn(
      `[accessible] component attribution needs Next ${SUPPORTED_NEXT}.x ` +
        `(found ${version ?? 'no resolvable next'}); building without it`,
    );
    return nextConfig;
  }

  const cfg = nextConfig as { experimental?: { swcPlugins?: [string, Record<string, unknown>][] } };
  const existing = cfg.experimental?.swcPlugins ?? [];
  return {
    ...cfg,
    experimental: {
      ...(cfg.experimental ?? {}),
      swcPlugins: [...existing, [SWC_PLUGIN_SPECIFIER, {}]],
    },
  };
}
