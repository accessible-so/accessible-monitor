/**
 * The fixture dev server.
 *
 * It is two things at once: `node examples/dev-server.mjs 4173 --verbose` for
 * a human who wants to watch beacons arrive, and `createServer(0)` for the
 * Playwright constraint suite, which needs a free port, a resettable beacon
 * log, and a config it can rewrite between scenarios.
 *
 * It serves the fixture site at `/`, the built collector bundles at `/a11y/`,
 * and the two endpoints the collector talks to:
 *
 *   GET  /api/a11y/config   the per-site config the loader fetches
 *   POST /api/a11y/ingest   beacons (204, CORS open)
 *
 * plus three test hooks, all under a `__` prefix so they can never collide
 * with a fixture path:
 *
 *   GET  /__beacons        every beacon recorded since the last reset
 *   GET  /__requests       request counters, including config fetches
 *   POST /__config         merge a partial config over the current one
 *   POST /__reset          clear beacons and counters
 */
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SITE_DIR = resolve(HERE, 'static-site');
const RUM_DIR = resolve(HERE, '..', 'packages', 'monitor', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_CONFIG = {
  enabled: true,
  killSwitch: false,
  sampleRate: 1,
  boosted: [],
  endpoint: '',
  minCollector: '0.2.0',
};

/** A 1x1 transparent GIF, so an <img src> never 404s into the console. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Every response is CORS-open, in one of two ways, because which one is in
 * force decides whether a cross-origin beacon survives:
 *
 *   `echo`     the caller's own `Origin` echoed back, plus
 *              `Access-Control-Allow-Credentials`. What the hosted ingest
 *              route does, and the only thing that works for a *preflighted*
 *              credentialed request.
 *   `wildcard` a flat `*`, which is what a plain CDN-ish endpoint answers and
 *              what a credentialed request is refused against.
 *
 * The collector's beacons are CORS-safelisted simple requests (`text/plain`),
 * so they are never preflighted and never CORS-checked at all — which is
 * precisely why `wildcard` has to be testable: it is the proof that a real
 * customer site can beacon to an endpoint that does not know its origin.
 *
 * `mode` is read per response through a getter the server owns, so a test can
 * flip it between scenarios.
 */
function corsHeaders(res, mode) {
  const origin = res.req?.headers?.origin;
  if (mode === 'wildcard' || !origin) return { 'Access-Control-Allow-Origin': '*' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...corsHeaders(res, res.__corsMode ?? 'echo'),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

/** Reads a request body as text, capped so a runaway client cannot fill memory. */
function readBody(req, limit = 4_000_000) {
  return new Promise((done) => {
    let text = '';
    let over = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (over) return;
      text += chunk;
      if (text.length > limit) { over = true; text = ''; }
    });
    req.on('end', () => done(text));
    req.on('error', () => done(''));
  });
}

/** Keeps a request from escaping its root via `..` or an absolute path. */
function safeJoin(root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = join(root, rel);
  return full.startsWith(root) ? full : null;
}

/**
 * @param {number} [port] 0 (the default) picks a free port.
 * @param {{ verbose?: boolean, cors?: 'echo' | 'wildcard' }} [options]
 */
export function createServer(port = 0, options = {}) {
  const verbose = options.verbose === true;
  const defaultCors = options.cors === 'wildcard' ? 'wildcard' : 'echo';
  let cors = defaultCors;
  /** @type {any[]} */
  const beacons = [];
  const counts = { config: 0, ingest: 0, loader: 0, engine: 0, page: 0 };
  let config = { ...DEFAULT_CONFIG };

  const server = createHttpServer((req, res) => {
    // Stamped per response rather than read from a closure inside `send`,
    // so a mode flipped mid-request cannot give one response two policies.
    res.__corsMode = cors;
    handle(req, res).catch((err) => {
      try { json(res, 500, { error: String(err && err.message) }); } catch { /* socket gone */ }
    });
  });

  function boundPort() {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : port;
  }

  function origin() {
    return `http://localhost:${boundPort()}`;
  }

  async function serveFile(res, root, urlPath, { injectPort = false } = {}) {
    const full = safeJoin(root, urlPath);
    if (!full) return send(res, 403, 'forbidden');
    let buffer;
    try {
      buffer = await readFile(full);
    } catch {
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream';
    // The fixture's <script data-endpoint="http://localhost:PORT"> is a
    // placeholder: only the server knows which port it ended up on.
    const body = injectPort
      ? Buffer.from(String(buffer).split('localhost:PORT').join(`localhost:${boundPort()}`))
      : buffer;
    send(res, 200, body, { 'Content-Type': type });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', origin());
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
      });
    }

    if (path === '/api/a11y/config') {
      counts.config += 1;
      return json(res, 200, { ...config, endpoint: config.endpoint || origin() });
    }

    if (path === '/api/a11y/ingest' && method === 'POST') {
      counts.ingest += 1;
      const raw = await readBody(req);
      // `navigator.sendBeacon` sends a Blob; its type reaches us as the
      // Content-Type, and browsers disagree about what that is for a JSON
      // Blob (`application/json` here, `text/plain` elsewhere). Parse the
      // text either way and record what the browser claimed it was.
      let body = null;
      try { body = JSON.parse(raw); } catch { body = { parseError: true, raw: raw.slice(0, 2000) }; }
      const record = {
        receivedAt: Date.now(),
        headers: {
          origin: req.headers.origin ?? null,
          referer: req.headers.referer ?? null,
          contentType: req.headers['content-type'] ?? null,
        },
        body,
      };
      beacons.push(record);
      if (verbose) {
        const f = Array.isArray(body?.findings) ? body.findings.length : 0;
        const rules = f ? ` [${[...new Set(body.findings.map((x) => x.rule))].join(', ')}]` : '';
        console.log(
          `beacon #${beacons.length} findings=${f} routes=${body?.routes?.length ?? 0} ` +
            `session=${body?.session ? 'started' : '-'} perf=${JSON.stringify(body?.perf ?? null)}${rules}`,
        );
      }
      return send(res, 204, '');
    }

    if (path === '/__beacons') return json(res, 200, beacons);
    if (path === '/__requests') return json(res, 200, counts);
    if (path === '/__config' && method === 'POST') {
      const raw = await readBody(req);
      try { config = { ...config, ...JSON.parse(raw || '{}') }; } catch { /* keep the old config */ }
      return json(res, 200, config);
    }
    if (path === '/__reset' && method === 'POST') {
      beacons.length = 0;
      for (const k of Object.keys(counts)) counts[k] = 0;
      config = { ...DEFAULT_CONFIG };
      cors = defaultCors;
      return json(res, 200, { ok: true });
    }

    if (path.startsWith('/a11y/')) {
      const file = path.slice('/a11y/'.length);
      if (file === 'loader.js') counts.loader += 1;
      if (file === 'engine.js') counts.engine += 1;
      return serveFile(res, RUM_DIR, file);
    }

    if (path === '/favicon.ico' || path.startsWith('/img/')) {
      return send(res, 200, PIXEL, { 'Content-Type': 'image/gif' });
    }

    // Anything without a file extension is a fixture "route": serve the shell
    // so a pushState URL survives a manual reload.
    const file = path === '/' ? 'index.html' : extname(path) ? path : `${path}.html`;
    const isHtml = extname(file) === '.html';
    if (isHtml) counts.page += 1;
    return serveFile(res, SITE_DIR, file, { injectPort: isHtml });
  }

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      done({
        server,
        port: server.address().port,
        url: origin(),
        beacons,
        counts,
        config: () => config,
        cors: () => cors,
        /** Flip the CORS policy between scenarios; `reset()` restores the constructed default. */
        setCors(mode) { cors = mode === 'wildcard' ? 'wildcard' : 'echo'; },
        reset() { beacons.length = 0; for (const k of Object.keys(counts)) counts[k] = 0; config = { ...DEFAULT_CONFIG }; cors = defaultCors; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argPort = Number(process.argv.find((a) => /^\d+$/.test(a))) || 4173;
  const verbose = process.argv.includes('--verbose');
  const started = await createServer(argPort, { verbose });
  console.log(`fixture site   ${started.url}/`);
  console.log(`big page       ${started.url}/big.html`);
  console.log(`debug mode     ${started.url}/?a11y_debug=1`);
  console.log(`collector      ${started.url}/a11y/loader.js`);
  console.log(`beacons        ${started.url}/__beacons`);
}
