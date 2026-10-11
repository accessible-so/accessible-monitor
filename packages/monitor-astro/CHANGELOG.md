# @accessible-so/monitor-astro

## 0.1.0

- `accessibleMonitor({ siteKey, endpoint? })` — the Astro integration. Injects the loader tag into every page's `<head>` (`injectScript('head-inline')`), and serves the site's page routes from `astro:routes:resolved` as a virtual module every page imports, so the browser can map a concrete path to its route pattern. Routes keep Astro's own match priority; endpoints, redirects and `internal` routes are dropped. `base` is stripped before matching. In `astro dev` a route change invalidates the module.
- `createAstroAdapter(routes, base)` and `registerRoutes(routes, base)` (`/client`) — the browser side: a `CollectorAdapter` (`@accessible-so/monitor-core`) whose `attribution.routePattern` tests Astro's own regexes in order, published on `window.__accessibleAdapter`. No component attribution.
- Defaults to `https://app.accessible.so`.
- Peer dependency `astro >=5 <8`. Verified end to end in Chromium against Astro 7.3.6 (dynamic, catch-all and static-over-dynamic routes, `base`, the client router, unsampled pages); Astro 5 and 6 not run in a browser.
