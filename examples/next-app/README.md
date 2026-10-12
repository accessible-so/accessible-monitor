# Next.js example app

A minimal Next.js 15 App Router site wired to `@accessible-so/monitor-next`. It
exists to be *driven*, not read: `packages/monitor-next/test/browser/next.browser.test.ts`
builds it, serves it, and asserts on the beacons a real Chromium sends. Running
it by hand is the fastest way to see route patterns and component attribution
arrive in the same shape a customer's site produces.

Three routes, each with a deliberate barrier:

| Route file | URL | Pattern reported | Barrier |
|---|---|---|---|
| `app/page.tsx` | `/` | `/` | none — this is the page the sampling test asserts silence on |
| `app/products/[slug]/page.tsx` | `/products/red-shoes` | `/products/[slug]` | `<img>` with no `alt`, inside `ProductCard` |
| `app/docs/[...parts]/page.tsx` | `/docs/a/b` | `/docs/[...parts]` | `<img>` with no `alt`, in the page itself |

## Running it

The collector bundles must exist (the app loads `/a11y/loader.js` from the
fixture server, not from a CDN), so build them first, then start the fixture
server and the app against it:

```bash
pnpm --filter @accessible-so/monitor build     # dist/loader.js + dist/engine.js
node scripts/build-swc.mjs                    # optional: component attribution
pnpm --filter @accessible-so/monitor-next build

node examples/dev-server.mjs 4173 --verbose   # beacons printed as they arrive

cd examples/next-app
A11Y_SWC=1 \
NEXT_PUBLIC_A11Y_ENDPOINT=http://localhost:4173 \
NEXT_PUBLIC_A11Y_KEY=acc_rum_aaaaaaaaaaaaaaaaaaaaaaaa \
  pnpm build && pnpm start
```

Then open `http://localhost:3000/products/red-shoes` and watch the dev server's
output. The fixture server accepts any site key and serves `sampleRate: 1`, so
every pageview is collected; `POST /__config` changes that, and `GET /__beacons`
replays everything it has recorded.

The site and the endpoint are deliberately different origins, as they are in
any real install — which is the one thing the collector's own same-origin
fixture cannot exercise. Beacons survive that because the transport declares
its `sendBeacon` Blob `text/plain`, a CORS-safelisted type: the request is
"no-cors", is never preflighted, and its response headers are never checked.
(An `application/json` Blob would be preflighted, and `sendBeacon`'s
credentials mode `include` means a wildcard `Access-Control-Allow-Origin` fails
that check — silently, after `sendBeacon` has already returned `true`.)

`createServer` takes `{ cors: 'echo' | 'wildcard' }`, defaulting to `echo`,
which is what the hosted ingest route does. The browser suite flips it to
`wildcard` for one scenario, to prove a beacon lands even against an endpoint
that knows nothing about the caller's origin.

## Component attribution

`next.config.mjs` calls `withAccessible(base, { componentAttribution: process.env.A11Y_SWC === '1' })`.
With the plugin, the outermost host element each component returns is stamped:

```html
<article data-a11y-component="ProductCard" data-a11y-source="components/ProductCard.tsx:8">
```

and the finding on the `<img>` inside it carries
`comp: { id: 'ProductCard', source: 'components/ProductCard.tsx:8' }`. Without
the plugin — no Rust toolchain, no `plugin.wasm` — everything else is
unchanged and `comp` is honestly `null`.

### Turbopack

`withAccessible` registers the plugin by its package specifier
(`@accessible-so/monitor-next/swc`), which is what both bundlers resolve —
an earlier version registered it by an absolute path to `plugin.wasm`, which
webpack's SWC pass accepted but Turbopack refused (`Module not found: Can't
resolve '…/swc/plugin.wasm'`). No extra configuration is needed either way:

```bash
pnpm build            # next build            (webpack)
pnpm build --turbopack # next build --turbopack (Turbopack)
```

The browser suite (`packages/monitor-next/test/browser/next.browser.test.ts`)
builds this app under both and asserts the same component stamp from each.
Route patterns need no plugin at all and work identically either way.
