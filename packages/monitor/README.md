# @accessible-so/monitor

The script-tag collector for Accessible RUM: a dependency-free loader and an
axe-core-backed engine bundle, built for direct `<script>` inclusion on a
customer's page.

## Bundles

- `dist/loader.js` — dependency-free, minified IIFE, target ES2017. Reads
  its own `<script>` tag's attributes, fetches a per-site config, makes a
  once-per-session sampling decision, and (only for sampled sessions)
  injects `dist/engine.js` during browser idle time. Gzipped size is kept
  at or under 2 KB (enforced by `size-limit`, see `.size-limit.json`).
- `dist/engine.js` — `@accessible-so/monitor-core` and `axe-core` inlined
  into a single minified IIFE, target ES2018. Exposes
  `window.__accessibleRum = { start(opts), version }`.

## Install

```html
<script
  async
  src="https://accessible.so/a11y/loader.js"
  data-site-key="acc_rum_xxxxxxxxxxxxxxxxxxxxxxxx"
></script>
```

That is the whole integration. The collector changes nothing on your page — its
entire DOM footprint is the one `<script>` the loader inserts into `<head>` — it
never sends text or form values, and it makes no compliance claims and performs
no assistive-technology detection. The repository README carries the
detection-ceiling statement, and `docs/protocol.md` lists every field a beacon
can contain.

Optional attributes on the loader's `<script>` tag:

| Attribute | Purpose |
|---|---|
| `data-site-key` | Required. Identifies the site to the config endpoint. |
| `data-endpoint` | Overrides the config/beacon origin (defaults to `https://app.accessible.so`). |
| `data-engine` | Overrides the engine bundle URL. Defaults to the version the app's config names when the loader is served from `https://accessible.so`, else a sibling `engine.js` next to the loader. |
| `data-disabled` | Presence disables the loader entirely — no fetch, no injection. |
| `data-sample` | Dev override of the sample rate (0–1), bypassing the server-provided rate. |

Append `?a11y_debug=1` to the page URL to force sampling and injection for a
single visit regardless of the site's sample rate or a previously cached
"not sampled" decision, and to turn on the collector's `console.debug` output.
It is a QA tool for your own team, not a way to opt a visitor in.

An unsampled visitor costs one config request per session and nothing else: the
loader short-circuits before the fetch on every later pageview, and `engine.js`
is never downloaded.

## Documentation

In the `accessible-monitor` repository:

- `docs/protocol.md` — what is sent, field by field.
- `docs/methodology.md` — how it decides: navigation mode, redaction, sampling,
  and the performance budget.

## Build

```bash
pnpm build   # tsup -> dist/loader.js, dist/engine.js
pnpm test    # builds, runs vitest, then checks size-limit
pnpm size    # size-limit only
```

## License

MIT. Bundles axe-core (MPL-2.0) unmodified — see `THIRD_PARTY_NOTICES.md`.

"Accessible" and the Accessible logo are trademarks of L5 Ventures. The license covers the code, not the name: a fork or redistribution may not be called Accessible or presented as ours.
