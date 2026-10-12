# @accessible-so/monitor-astro

The Astro integration for Accessible RUM. It adds the loader to every page and
supplies the one thing a plain script tag cannot know on its own: the route
*pattern* behind a concrete URL (`/blog/[slug]`, not `/blog/hello-world`), so
findings group by route instead of by every distinct URL a route ever served.
The patterns come straight from Astro's own route table, so they are exactly
what your `src/pages` tree calls them.

## Install

```bash
pnpm add @accessible-so/monitor-astro
```

Peer dependency: `astro >=5 <8` (the `astro:routes:resolved` hook it reads
arrived in Astro 5).

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import accessibleMonitor from '@accessible-so/monitor-astro';

export default defineConfig({
  integrations: [accessibleMonitor({ siteKey: 'acc_rum_xxxxxxxxxxxxxxxxxxxxxxxx' })],
});
```

Copy the key from your domain's Install snippet in Accessible. That's all:
there is nothing to add per page or per layout.

| Option | Default | |
|---|---|---|
| `siteKey` | (required) | Your site's `acc_rum_…` key. Public by design, and bound to your domain's origin. |
| `endpoint` | `https://app.accessible.so` | Where config is read and beacons are sent. Set it only to point at another Accessible environment. |
| `src` | `https://accessible.so/a11y/loader.js` | The loader's URL, to self-host it (the engine is read from `engine.js` next to it). With a custom `endpoint` it defaults to `<endpoint>/a11y/loader.js`. |

## What it does

- **Adds the loader** to the `<head>` of every page, exactly as the script tag
  does: the loader still decides sampling and whether the engine downloads at
  all. Nothing extra runs for a visitor who is not sampled.
- **Reports route patterns.** At build time Astro hands integrations its
  resolved route table; this integration keeps the site's page routes, in
  Astro's own match priority, and ships them to the browser (under 1 KB
  gzipped with the matcher). A finding on `/products/red-shoes` reports
  `/products/[slug]`; on `/products/featured`, a static page beside it,
  `/products/featured` — the same decision Astro's router makes.
- **Handles `base`.** Under `base: '/shop'` the pattern is still
  `/products/[slug]`, never `/shop/products/[slug]`.
- **Works with the client router.** `<ClientRouter />` navigations report the
  new page's pattern; there is no per-navigation state to keep.

## Known limits

- **No component attribution.** Astro renders to plain HTML, so there is no
  component left in the page to attribute an element to; findings carry no
  component rather than a guessed one.
- **Endpoints, redirects and Astro's own internal routes are left out.** They
  never render a page a visitor can hit a barrier on.
- **A URL no page route matches reports no pattern** (your 404 page, a path
  outside `base`). The finding is still reported, by its path.
- **The route table loads with the page's scripts, the loader tag in the
  head.** A finding recorded before the page's module scripts run would carry
  no pattern; in practice the engine is fetched later than that.

## Compatibility

Verified end to end in Chromium against Astro 7.3.6 with static output:
dynamic and catch-all routes, static-over-dynamic priority, `base`, the client
router, and the unsampled path. Astro 5 and 6 are in the peer range on the
strength of the hooks used (`astro:routes:resolved` and `injectScript`, both
unchanged since 5.0) but have not been run in a browser.

## What's here

- `accessibleMonitor(options)` (default export) — the integration.
- `@accessible-so/monitor-astro/client` — `createAstroAdapter(routes, base)` and
  `registerRoutes(routes, base)`, what the generated module calls in the
  browser. Publishes the adapter at `window[ADAPTER_SLOT]`, the slot the
  engine reads on every attribution lookup.

The framework-adapter contract is in [docs/adapters.md](../../docs/adapters.md).

## License

MIT.

"Accessible" and the Accessible logo are trademarks of L5 Ventures. The license covers the code, not the name: a fork or redistribution may not be called Accessible or presented as ours.
