import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Builds examples/astro-site with the fixture server as its endpoint and
 * serves the output: the real integration, the real build, a real browser.
 * One build per `base`, each in its own outDir.
 *
 * Served by a few lines of node:http rather than `astro preview`, which in
 * Astro 7 is a single background daemon per project: a second build's preview
 * (the `base` case) refuses to start, and a crashed run leaves one behind.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
export const SITE_DIR = join(REPO_ROOT, 'examples', 'astro-site');
export const SITE_KEY = `acc_rum_${'a'.repeat(24)}`;
export const BUILD_TIMEOUT_MS = 180_000;

const astroBin = join(SITE_DIR, 'node_modules', '.bin', 'astro');

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export interface AstroSite {
  /** Origin plus base, without a trailing slash: append `/products/...`. */
  url: string;
  origin: string;
  close(): Promise<void>;
}

function tail(text: string | null | undefined, lines = 30): string {
  return text ? `${text.trimEnd().split('\n').slice(-lines).join('\n')}\n` : '';
}

function ensureCollectorBundles(): void {
  const dist = join(REPO_ROOT, 'packages', 'monitor', 'dist');
  if (existsSync(join(dist, 'loader.js')) && existsSync(join(dist, 'engine.js'))) return;
  const built = spawnSync('pnpm', ['--filter', '@accessible-so/monitor', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (built.status !== 0) throw new Error('could not build @accessible-so/monitor bundles');
}


export async function buildAndPreview(endpoint: string, base = '/'): Promise<AstroSite> {
  ensureCollectorBundles();
  const outDir = base === '/' ? 'dist' : `dist-${base.replace(/\W+/g, '')}`;
  const env = { ...process.env, A11Y_ENDPOINT: endpoint, A11Y_KEY: SITE_KEY, A11Y_BASE: base, A11Y_OUT_DIR: outDir, ASTRO_TELEMETRY_DISABLED: '1' };

  const build = spawnSync(astroBin, ['build'], { cwd: SITE_DIR, env, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (build.status !== 0) throw new Error(`astro build failed (${build.status})\n${tail(build.stdout)}${tail(build.stderr)}`);

  // `base` maps onto outDir; a directory serves its index.html, as on any static host.
  const root = join(SITE_DIR, outDir);
  const prefix = base.replace(/\/+$/, '');
  const http = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return void res.writeHead(404).end();
    let file = join(root, path.slice(prefix.length));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url: `${origin}${prefix}`,
    origin,
    close: () => new Promise<void>((done) => http.close(() => done())),
  };
}
