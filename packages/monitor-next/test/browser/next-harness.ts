/**
 * The Next fixture: a real `next build` + `next start`, driven by Playwright.
 *
 * Two servers are in play and they are deliberately different origins. The
 * Next app serves the pages; the collector's own fixture server (reused
 * wholesale from `@accessible-so/monitor`'s browser harness) serves
 * `/rum/loader.js`, answers `/api/rum/config`, and records the beacons. That
 * split is the honest shape of a real install — the site and the collector
 * endpoint are never the same host — and it means everything the collector
 * harness already knows how to do (`settle`, `allFindings`, `setConfig`) works
 * here unchanged, against the beacon server, while only the page URLs come
 * from Next.
 *
 * Nothing about the app is stubbed: the pages are compiled by Next's own
 * pipeline, with the SWC attribution plugin in it when the wasm exists, and
 * the assertions read the beacons that a browser actually sent.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/monitor-next/test/browser` → the repo root. */
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
export const APP_DIR = join(REPO_ROOT, 'examples', 'next-app');
export const WASM_PATH = join(REPO_ROOT, 'packages', 'monitor-next', 'swc', 'plugin.wasm');

/** A well-formed key. The fixture server accepts any, but the loader needs one. */
export const SITE_KEY = `acc_rum_${'a'.repeat(24)}`;

/**
 * Comfortably above the ~8s this build takes on a warm machine and the minute
 * or two a cold CI runner needs, and comfortably below the suite's 300s
 * `hookTimeout`, so a wedged build surfaces as this error rather than as the
 * hook giving up with nothing to say.
 */
export const BUILD_TIMEOUT_MS = 240_000;

/** The last few lines of a captured stream — enough to say why, not a wall of build log. */
function tail(text: string | null | undefined, lines = 30): string {
  if (!text) return '';
  return `${text.trimEnd().split('\n').slice(-lines).join('\n')}\n`;
}

/** True when `node scripts/build-swc.mjs` has been run. Absence is never a failure. */
export const wasmPresent = existsSync(WASM_PATH);

/** Picks a port the OS says is free, then lets go of it. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => (port ? done(port) : fail(new Error('no free port'))));
    });
  });
}

/**
 * The loader is served from `packages/monitor/dist`, which the collector's
 * own `test:browser` builds. This suite may run first, so build it if it is
 * not there rather than serving a 404 and asserting against silence.
 */
export function ensureCollectorBundles(): void {
  const dist = join(REPO_ROOT, 'packages', 'monitor', 'dist');
  if (existsSync(join(dist, 'loader.js')) && existsSync(join(dist, 'engine.js'))) return;
  const built = spawnSync('pnpm', ['--filter', '@accessible-so/monitor', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (built.status !== 0) throw new Error('could not build @accessible-so/monitor bundles');
}

export interface NextApp {
  /** `http://localhost:<port>` — where the pages live. */
  url: string;
  /** Wall-clock milliseconds `next build` took. */
  buildMs: number;
  /** Whether the build ran with the component-attribution SWC plugin. */
  attribution: boolean;
  /** Which bundler compiled this build. */
  bundler: 'webpack' | 'turbopack';
  close(): Promise<void>;
}

const nextBin = join(APP_DIR, 'node_modules', '.bin', 'next');

/**
 * Builds the example app against a given beacon endpoint and serves it.
 *
 * The endpoint has to be baked in at build time — `NEXT_PUBLIC_*` is inlined
 * by the compiler — so the fixture server must already be listening before
 * this is called, and the app is rebuilt for each run rather than cached.
 *
 * `bundler` picks the compiler `next build` uses. `withAccessible` registers
 * the SWC plugin by its package specifier precisely so this can be either —
 * an absolute path to `plugin.wasm` builds under webpack but Turbopack
 * refuses to resolve it.
 *
 * The Turbopack variant builds into its own `NEXT_DIST_DIR`
 * (`next.config.mjs` reads it) rather than the default `.next`, so a
 * Turbopack build never overwrites the files a concurrently-running webpack
 * `next start` is serving from. The two `NextApp`s this can produce are
 * independent processes on independent ports and may coexist for the whole
 * suite's lifetime — nothing here requires them to be built or closed in any
 * particular order.
 */
export async function buildAndStartNextApp(
  endpoint: string,
  bundler: 'webpack' | 'turbopack' = 'webpack',
): Promise<NextApp> {
  ensureCollectorBundles();

  const attribution = wasmPresent;
  const buildEnv = {
    ...process.env,
    NEXT_PUBLIC_A11Y_ENDPOINT: endpoint,
    NEXT_PUBLIC_A11Y_KEY: SITE_KEY,
    ...(attribution ? { A11Y_SWC: '1' } : {}),
    ...(bundler === 'turbopack' ? { NEXT_DIST_DIR: '.next-turbopack' } : {}),
    NEXT_TELEMETRY_DISABLED: '1',
  };

  // Both bundlers are named explicitly. Turbopack is the default from Next 16
  // on, so a bare `next build` here would quietly make the webpack arm a
  // second Turbopack build — two green runs, one bundler, and the webpack path
  // untested. `--webpack` is still accepted in 16.
  const buildArgs = ['build', bundler === 'turbopack' ? '--turbopack' : '--webpack'];

  const startedAt = Date.now();
  // `spawnSync` blocks this worker's event loop for the whole build, so
  // vitest's `hookTimeout` cannot fire while it runs — the suite would hang
  // forever on a stalled build rather than fail, and the hung child would
  // never be reaped, because the teardown below is not reached until this
  // call returns. The timeout has to live on the call itself, and it has to
  // be SIGKILL: a build wedged on a lock or a socket may well ignore SIGTERM.
  const build = spawnSync(nextBin, buildArgs, {
    cwd: APP_DIR,
    env: buildEnv,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const buildMs = Date.now() - startedAt;
  if (build.error && (build.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(
      `next build exceeded ${BUILD_TIMEOUT_MS}ms and was killed after ${buildMs}ms\n` +
        `${tail(build.stderr)}${tail(build.stdout)}`,
    );
  }
  if (build.status !== 0) {
    throw new Error(`next build --${bundler} failed (${build.status})\n${tail(build.stdout)}${tail(build.stderr)}`);
  }
  // Worth a line: it is most of the suite's runtime, and it says out loud
  // whether the component tests are about to run or skip and which bundler
  // compiled the app.
  console.log(
    `next build (${bundler}) ${(buildMs / 1000).toFixed(1)}s — component attribution ${attribution ? 'on' : 'off (no plugin.wasm)'}`,
  );

  const port = await freePort();
  // `detached` so the whole process group can be signalled: `next start`
  // spawns its own render workers, and killing only the parent leaves them
  // holding the port.
  const child: ChildProcess = spawn(nextBin, ['start', '-p', String(port)], {
    cwd: APP_DIR,
    env: buildEnv,
    detached: true,
    stdio: 'ignore',
  });
  const url = `http://localhost:${port}`;

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const close = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };

  try {
    await waitForServer(url, 60_000, () => exited);
  } catch (err) {
    await close();
    throw err;
  }

  return { url, buildMs, attribution, bundler, close };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Polls the port until the app answers, rather than guessing at a fixed delay. */
async function waitForServer(url: string, timeoutMs: number, dead: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (dead()) throw new Error(`next start exited before ${url} answered`);
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`next start did not answer at ${url} in ${timeoutMs}ms`);
    await sleep(200);
  }
}
