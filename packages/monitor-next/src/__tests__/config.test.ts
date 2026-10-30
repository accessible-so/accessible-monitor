import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAccessible } from '../config';

const present = () => true;
const missing = () => false;
/** A Next the shipped wasm is built against; see SUPPORTED_NEXT. */
const supported = () => '16.4.1';

/** Every case that expects registration needs both gates open. */
const ok = { pluginExists: present, nextVersion: supported };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withAccessible', () => {
  it('registers the wasm plugin under experimental.swcPlugins and keeps existing plugins', () => {
    const cfg = withAccessible(
      { reactStrictMode: true, experimental: { swcPlugins: [['other', {}]] } },
      ok,
    );
    expect(cfg.reactStrictMode).toBe(true);
    const plugins = (cfg as any).experimental.swcPlugins as [string, unknown][];
    expect(plugins[0]).toEqual(['other', {}]);
    // A package specifier, not an absolute path: Turbopack only resolves the
    // plugin this way, and webpack resolves it fine too.
    expect(plugins[1]).toEqual(['@accessible-so/monitor-next/swc', {}]);
  });

  it('does nothing when component attribution is off', () => {
    const cfg = withAccessible({}, { componentAttribution: false, ...ok });
    expect((cfg as any).experimental).toBeUndefined();
  });

  it('warns once and leaves the config alone when the wasm was never built', () => {
    // Next resolves every swcPlugins entry with `require.resolve`, so
    // registering a plugin whose wasm is absent fails the entire `next build`.
    // The package promises the opposite: everything else keeps working and
    // `finding.comp` is honestly null.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = { reactStrictMode: true };

    const cfg = withAccessible(base, { pluginExists: missing, nextVersion: supported });

    expect(cfg).toBe(base);
    expect((cfg as any).experimental).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('swc/plugin.wasm not found');
  });

  it('does not warn when attribution was switched off deliberately', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withAccessible({}, { componentAttribution: false, pluginExists: missing, nextVersion: supported });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['15.5.9', '16.3.5', '17.0.0'])('refuses to register the plugin on Next %s, which it was not built for', (version) => {
    // The wasm exchanges a serialized AST with its host, and that layout is
    // fixed by the swc_core both sides were built against. Next 16.3 links
    // swc_ecma_ast 25 against our 29: loading it there does not degrade, it fails
    // the user's build. `pluginExists` answers yes here precisely so that the
    // version is the only thing that can stop it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = { reactStrictMode: true };

    const cfg = withAccessible(base, { pluginExists: present, nextVersion: () => version });

    expect(cfg).toBe(base);
    expect((cfg as any).experimental).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(version);
  });

  it('skips attribution rather than guessing when no next resolves', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = {};

    const cfg = withAccessible(base, { pluginExists: present, nextVersion: () => null });

    expect(cfg).toBe(base);
    expect(warn.mock.calls[0]![0]).toContain('no resolvable next');
  });

  it('accepts every stable 16.4 patch', () => {
    const cfg = withAccessible({}, { pluginExists: present, nextVersion: () => '16.4.3' }) as any;
    expect(cfg.experimental.swcPlugins).toEqual([['@accessible-so/monitor-next/swc', {}]]);
  });

  it('refuses a 16.4 canary, which can predate the swc bump', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = {};
    expect(withAccessible(base, { pluginExists: present, nextVersion: () => '16.4.0-canary.3' })).toBe(base);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports a missing wasm ahead of an unsupported Next, as the more actionable of the two', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withAccessible({}, { pluginExists: missing, nextVersion: () => '15.5.9' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('swc/plugin.wasm not found');
  });

  it('wraps a function config instead of spreading it away', async () => {
    // `export default (phase) => ({...})` is a config shape Next supports.
    // Spreading a function yields {}, which would discard the whole config.
    const fn = vi.fn((phase: string) => ({ reactStrictMode: true, phase }));

    const wrapped = withAccessible(fn, ok);
    expect(typeof wrapped).toBe('function');

    const cfg = await wrapped('phase-production-build');
    expect(fn).toHaveBeenCalledWith('phase-production-build');
    expect(cfg.reactStrictMode).toBe(true);
    expect(cfg.phase).toBe('phase-production-build');
    expect((cfg as any).experimental.swcPlugins).toEqual([['@accessible-so/monitor-next/swc', {}]]);
  });

  it('awaits an async function config', async () => {
    const wrapped = withAccessible(async () => ({ reactStrictMode: true }), ok);
    const cfg = await wrapped();
    expect(cfg.reactStrictMode).toBe(true);
    expect((cfg as any).experimental.swcPlugins).toEqual([['@accessible-so/monitor-next/swc', {}]]);
  });

  it('resolves the real wasm path when no checker is injected', () => {
    // The default checker resolves this package's own package.json through its
    // exports map and looks for swc/plugin.wasm beside it. The wasm is a build
    // artefact, so assert only that the check runs and answers a boolean —
    // never that it throws.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = withAccessible({ reactStrictMode: true }) as any;
    const registered = cfg.experimental?.swcPlugins?.length === 1;
    expect(registered).toBe(warn.mock.calls.length === 0);
  });
});
