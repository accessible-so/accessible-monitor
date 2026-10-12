# accessible-monitor

The open-source browser collector behind Accessible's real user monitoring. It
watches real sessions on your site for accessibility barriers and reports what it
found — the structure of the broken element, which WCAG criterion it fails, and
whether anybody actually ran into it.

It is open source because you should not have to take our word for what a script
on your page is doing. Every claim on this page is checked by a test in this
repository, against the bundle we ship, in a real browser.

    pnpm install
    pnpm build
    pnpm test          # unit
    pnpm test:browser  # Playwright, against the built bundles
    pnpm demo          # the fixture site + a beacon-printing dev server

Requires Node 22 and pnpm 9.15.

---

## What it does

- Runs [axe-core](https://github.com/dequelabs/axe-core) against the page a real
  visitor is looking at — including states a crawler never reaches: the dialog
  they opened, the form they submitted, the tab they switched to.
- Adds four **behavioural** observers for barriers a snapshot scan structurally
  cannot see: a keyboard trap, a burst of Tab presses that move nothing, a
  client-side route change that strands focus, and a control that takes focus
  without showing it.
- Reports whether a visitor **interacted** with the broken element, so a barrier
  in someone's way can be told apart from a barrier nobody met.
- Gives every defect a stable structural **signature**, so the same barrier found
  by a scan, by monitoring, and by a manual journey test collapses into one issue
  rather than three.

## What it does not do

- **No remediation.** It changes nothing on your page. It does not inject ARIA,
  rewrite the DOM, or "fix" anything. It only reads, and its DOM footprint is one
  `<script>` inserted into `<head>` — there is a test for exactly that.
- **No overlay, no toolbar, no widget.** Your visitors see nothing.
- **No compliance claims.** Nothing here certifies, guarantees, or attests
  conformance to WCAG, the ADA, the EAA, Section 508, or anything else. Automated
  tooling cannot do that, and a vendor who says otherwise is selling you risk.
- **No assistive-technology detection.** There is no code path that inspects the
  user agent, media features, or timing to guess whether a visitor uses a screen
  reader or has a disability. `navigationMode` describes *input* — keyboard,
  pointer, mixed — and is inferred from behaviour alone. A test fails the build if
  the shipped bundle so much as contains the strings `JAWS`, `NVDA`, `VoiceOver`,
  `TalkBack`, `Narrator`, `speechSynthesis`, or `forced-colors`.
- **No personal data.** No text, no form values, no cookies, no cross-site or
  cross-visit identifier. See [what is sent](#what-is-sent).

---

## The detection ceiling

Automated testing finds a minority of accessibility barriers, and you should size
your expectations accordingly.

The figure quoted most often in the industry is that automation catches roughly
**30–40%** of WCAG issues. Deque, who make axe-core — the engine this collector
runs — publish a higher number for their own tooling, around **57%**, counting
issues by occurrence with their full rule set. Independent studies generally land
lower than either.

These numbers do not measure the same thing. They differ in what counts as an
"issue" (a rule, a criterion, a failing element), in which corpus of pages was
tested, in whether "needs review" results count as caught, and in whether the
denominator is every WCAG failure or only the ones a human auditor found. Treat
the range as a statement about a ceiling, not as a score anyone can hold to two
significant figures.

What this means in practice: **a clean report is not a claim your site is
accessible.** It means the automated rules found nothing on the pages that were
sampled. Real-user monitoring widens what gets tested — real states, real journeys, real interaction — but it does not raise that ceiling. Manual testing with real assistive technology, by the people who use it, remains the only thing that does.

The collector is also honest about its limits in the other direction. On a
device too slow to scan inside its performance budget it stops after one long
task, finishes when the tab is hidden, and until then the page is reported as
**unmeasured** (`perf.aborted: true`), never as clean. **Never in the way of a
visitor's input.** Heavy checks run only while the visitor is idle; a visitor
who is interacting never waits on more than 50 ms of collector work, beyond the
one run that measures their device. The contrast and target-size rules are too
expensive to run while the visitor is interacting, so they run in an idle window
when they are predicted to fit one, otherwise wait until the tab is hidden, and
if that never comes they are **named in the beacon** (`perf.skipped`) rather
than quietly producing no findings. See
[methodology §4](./docs/methodology.md#4-the-performance-budget) for the
measurements.

---

## Install

```html
<script
  async
  src="https://cdn.example.com/rum/loader.js"
  data-site-key="acc_rum_xxxxxxxxxxxxxxxxxxxxxxxx"
></script>
```

That is the whole integration. The loader is a dependency-free IIFE under 2KB
gzipped (enforced by `size-limit`). It reads its own tag, asks your configured
endpoint for a sampling rate, makes one sticky decision for the session, and — for
sampled sessions only — injects the engine bundle during browser idle time.

| Attribute | Purpose |
|---|---|
| `data-site-key` | Required. A **public** key identifying the site. |
| `data-endpoint` | Config and beacon origin. Defaults to the loader script's own origin. |
| `data-engine` | Engine bundle URL. Defaults to a sibling `engine.js`. Set this explicitly if your CDN uses hashed filenames. |
| `data-sample` | Local override of the sample rate (0–1), for development. |
| `data-disabled` | Presence disables the loader entirely: no fetch, no storage, no injection. |

An unsampled visitor pays for one config request per session and nothing else —
no engine download, no scanning, no beacon. There is a test for that too.

### `?a11y_debug=1`

Append it to any page URL to force this pageview to be sampled regardless of the
configured rate or a cached "not sampled" decision, and to turn on `console.debug`
output from the collector. It is a QA tool for your own team; it is not a way to
opt a visitor in.

---

## Adapters

Framework packages supply the one thing a plain script tag cannot know on its
own: how a concrete URL maps to a route *pattern*, and, optionally, which
component owns an element. Everything else — sampling, scanning, redaction,
the beacon shape — is identical whether an adapter is present or not. The
contract, how to write one, and what an adapter must never do are in
[docs/adapters.md](./docs/adapters.md).

### `@accessible-so/monitor-next`

The Next.js adapter. Supplies route-pattern attribution for both routers and,
optionally, build-time component attribution via an SWC plugin.

```bash
pnpm add @accessible-so/monitor-next
```

Peer dependencies: `next >=13.4 <17`, `react >=18`. Component attribution
(the optional SWC plugin below) additionally requires Next 16 — see
[Compatibility](#compatibility).

**App Router** — render once, in the root layout:

```tsx
// app/layout.tsx
import { AccessibleMonitor } from '@accessible-so/monitor-next';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <AccessibleMonitor siteKey="acc_rum_xxxxxxxxxxxxxxxxxxxxxxxx" />
      </body>
    </html>
  );
}
```

**Pages Router** — render once, in `_app`:

```tsx
// pages/_app.tsx
import type { AppProps } from 'next/app';
import { AccessibleMonitorPages } from '@accessible-so/monitor-next';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <AccessibleMonitorPages siteKey="acc_rum_xxxxxxxxxxxxxxxxxxxxxxxx" />
    </>
  );
}
```

Either component registers the route-pattern adapter and renders the loader
`<Script>`. Neither one starts the engine — sampling and injection stay the
loader's decision, made from its own script tag exactly as they are without
Next in the picture. `basePath` and i18n locale prefixes are handled: the
adapter is keyed on `window.location.pathname`, and the pattern it reports is
the app route (`/products/[slug]`, not `/x/products/[slug]`).

**`withAccessible`** (optional — build-time component attribution):

```js
// next.config.mjs
import { withAccessible } from '@accessible-so/monitor-next/config';

export default withAccessible({
  // your existing config
});
```

Registers the SWC plugin that stamps the outermost host element a named
function component returns with `data-a11y-component`/`data-a11y-source`, so
a finding can be attributed back to the component that rendered it. It
registers the plugin by its package specifier
(`@accessible-so/monitor-next/swc`) rather than an absolute path to the wasm
file — the specifier is the only form that resolves under both bundlers Next
ships; an absolute path builds fine under webpack but Turbopack refuses to
resolve it.

Pass `{ componentAttribution: false }` to skip it entirely. Without the
plugin — that flag, a Next major other than 16, or simply no Rust toolchain on
the machine that ran `node scripts/build-swc.mjs`, so `swc/plugin.wasm`
doesn't exist — everything else works unchanged and `finding.comp` is honestly
`null`, never a guess.
`withAccessible` checks for the wasm before registering anything, and when it
is missing prints one line —
`[accessible] swc/plugin.wasm not found; building without component attribution`
— and hands your config back untouched, rather than letting Next fail the
build on a plugin it cannot resolve.

#### Compatibility

| Next | SWC plugin ABI | Rust toolchain | wasm size | Bundlers |
|---|---|---|---|---|
| 16.3.5 | `swc_core` 73 — `swc_common` 23.0.2, `swc_ecma_ast` 25.0.0, `swc_plugin_runner` 30.0.1, which is what Next 16's `next-swc` binary links | 1.98.1, target `wasm32-wasip1`, `-C link-arg=--allow-undefined` (repo `.cargo/config.toml`) | ~764 KB | `next build --webpack` and `next build --turbopack` — both built and stamp-verified by the browser suite |

**Component attribution is Next 16 only, and `withAccessible` enforces that
itself.** An SWC plugin exchanges a serialized AST with its host, and the
layout of that AST is fixed by the `swc_core` both sides were compiled
against. Next 15 links `swc_core` 35 — nine majors of AST layout from ours —
so loading this wasm there would not degrade, it would fail the build. So
`withAccessible` reads the resolved `next/package.json` before registering
anything and, on any other major, prints one line and hands your config back
untouched, exactly as it does when the wasm is missing:

    [accessible] component attribution needs Next 16 (found 15.5.9); building without it

One wasm cannot serve both majors. Everything else in the adapter — the
components, route patterns, the loader — is plain Next API and keeps working
across the whole peer range; only `finding.comp` is lost, and it is honestly
`null` rather than guessed.

**Tested:** the App Router example (`examples/next-app`), end to end in a
real Chromium, against both `next build --webpack` and `next build
--turbopack`, on Next 16.3.5. Both bundlers are named explicitly in the
harness: Turbopack is the default from Next 16 on, so a bare `next build`
would silently make the webpack arm a second Turbopack build.

**Not tested:** Next 13.4–15 and the Pages Router in a browser —
`AccessibleMonitorPages` has unit tests only. The peer range
(`next >=13.4 <17`) is wider than what the suite exercises.

#### What the plugin stamps and what it skips

| Shape | Stamped |
| --- | --- |
| `function ProductCard() { return <article/> }` | yes |
| `export default function Page() { return <main/> }` | yes |
| `const Price = ({ v }) => <span>{v}</span>` | yes |
| `const Price = function () { return <span/> }` | yes — under the binding's name |
| `export default function () {}` / `export default () => …` | no — no name to attribute to |
| `const handler = function Render() { return <div/> }` | no — the binding is not a component |
| `rows.map(function Row() { return <li/> })` | no — a named callback is not a component |
| `function Page() { return <Layout/> }` | no — composite (a `<Layout>` gets its own stamp when *its* file compiles) |
| `function List() { return <><p/></> }` | no — fragment |
| `function helper() { return <div/> }` | no — not PascalCase |
| an element that already has `data-a11y-component` **or** `data-a11y-source` | no — existing stamps always win |
| anything under a `node_modules` directory | no |

Purely syntactic: no imports or types are resolved, so server components get
the same treatment as client ones, and TypeScript's `as`/`satisfies`/`!` on a
returned element are transparent. The full rule table and rationale live in
[`crates/swc-plugin-accessible/README.md`](./crates/swc-plugin-accessible/README.md#what-it-stamps).

#### Known limits

- **Only a top-level `return` is stamped.** An early return
  (`if (!data) return <Empty/>;`), a ternary, and a wrapped arrow
  (`const Card = memo(() => <div/>)`) all render fine and all carry no
  attribution.
- **The line is the component's declaration, not the element's.** For a
  multi-line component the stamp points at the `function`/`const` line, which
  stays stable when the body is reformatted.
- **No line at all if the host cannot resolve one**, and never a placeholder
  such as `:0` — a wrong line costs more to chase than a missing one.
- **Anonymous components are skipped.** `export default function () {}` and
  `export default () => <div/>` have no name to attribute to.
- **PascalCase is the only signal.** A component named in `camelCase` is
  indistinguishable from a helper and is left alone.

See [`crates/swc-plugin-accessible/README.md`](./crates/swc-plugin-accessible/README.md#known-limits)
for the complete list.

---

### `@accessible-so/monitor-astro`

The Astro integration (Astro 5 and up). Adds the loader to every page and
supplies route-pattern attribution from Astro's own route table; no component
attribution, because Astro ships no components to the browser.

```bash
pnpm add @accessible-so/monitor-astro
```

```js
// astro.config.mjs
import accessibleMonitor from '@accessible-so/monitor-astro';

export default defineConfig({
  integrations: [accessibleMonitor({ siteKey: 'acc_rum_xxxxxxxxxxxxxxxxxxxxxxxx' })],
});
```

Patterns keep Astro's own match priority, `base` is stripped, and the client
router needs nothing extra. See the
[package README](./packages/monitor-astro/README.md) for options and limits.

## What is sent

Beacons are `POST`ed to `/api/rum/ingest` with `navigator.sendBeacon`, falling
back to `fetch(keepalive)`. The `fetch` fallback sets `credentials: 'omit'`, so
no cookies are attached. `sendBeacon` has no such option — it is fire-and-forget
and takes only a URL and a body — so a beacon it sends carries whatever the
browser would normally attach to a same-site POST to the endpoint. Point
`data-endpoint` at a host that sets no cookies and there are none to send; the
collector never reads, writes, or looks at a cookie itself. The `sendBeacon`
body declares `text/plain;charset=UTF-8` rather than `application/json` so a
cross-origin beacon needs no CORS response headers at all — the body is still
JSON either way, and an ingest must parse it as such regardless of the
declared type (see [docs/protocol.md](./docs/protocol.md)).

- **No text.** A text node becomes `{ length, words, knownBad }` — two counts and
  a flag — or nothing at all.
- **Attributes by allowlist.** `id`, `name`, `value`, `src`, `style`, event
  handlers, and all `data-*` outside the `data-a11y-` prefix are dropped. `alt`,
  `title`, `aria-label` and friends become `{ len, words }`. `href` becomes a
  same-origin path or the literal string `external`.
- **Paths only.** Query strings and fragments never leave the page.
- **A session id and nothing more.** 16 random bytes in `sessionStorage`, used to
  deduplicate within one tab's session. It is not persisted beyond the tab and is
  never correlated across visits or sites.

Four `sessionStorage` keys, all of them cleared when the tab closes, and none of
them holding anything about the person:

| Key | Written by | Holds |
|---|---|---|
| `a11y_rum` | the loader | `{ s, d }` — the session id and the sampling decision as one bit. Written for an unsampled session too (`d: 0`), which is what makes "not sampled" stick for the rest of the session instead of being re-rolled on every pageview. |
| `a11y_rum_seen` | the collector | `{ f, i }` — the `signature\|route` pairs already sent as findings and as interactions, so a barrier is reported once per route per session across pageviews. Signatures, not elements or text. |
| `a11y_rum_routes` | the collector | The `path\|pattern` pairs already reported, so a route is announced once per session. |
| `a11y_rum_session_sent` | the collector | `true` once the `session: { started: true }` marker has been sent, so a session counts once. |

The complete wire format, field by field, is in
**[docs/protocol.md](./docs/protocol.md)**. How each decision is made — navigation
mode, redaction, sampling, the performance budget — is in
**[docs/methodology.md](./docs/methodology.md)**.

---

## Running the demo

```bash
pnpm build
pnpm demo
```

Then open <http://localhost:4173/?a11y_debug=1>. The fixture site in
[`examples/static-site`](./examples/static-site) is deliberately broken: images
with no alt text, an icon-only button with no accessible name, an unlabelled email
field, low-contrast helper text, a dialog whose Tab loop has no exit and ignores
Escape, a client-side route change that strands focus on `<body>`, and an element
that swallows Tab entirely.

The dev server prints one line per beacon to stdout and keeps them all at
<http://localhost:4173/__beacons>, so you can read exactly what left the page.
Also served:

| Path | |
|---|---|
| `/` | the fixture storefront |
| `/products.html` | the same shell with 40 cards |
| `/mid.html` | ~1,100 elements — the page size whose contrast pass waits for the tab to hide |
| `/big.html` | over 5,000 elements — where the scan budget is tested (`?sections=N` resizes it) |
| `/__beacons` | every beacon recorded, with its request headers |
| `/__requests` | request counters, including config fetches |
| `POST /__config` | merge a partial config (`{"sampleRate":0}`, `{"killSwitch":true}`) |
| `POST /__reset` | clear beacons and counters |

To see the Next.js adapter the same way, point [`examples/next-app`](./examples/next-app)
at the same fixture server instead of the static site:

```bash
pnpm demo   # the fixture server, on :4173

# in a second terminal
NEXT_PUBLIC_A11Y_ENDPOINT=http://localhost:4173 \
NEXT_PUBLIC_A11Y_KEY=acc_rum_aaaaaaaaaaaaaaaaaaaaaaaa \
  pnpm --filter @accessible-so/example-next-app dev
```

Then open <http://localhost:3000/products/red-shoes?a11y_debug=1> and watch
the fixture server's stdout the same way. The example's route patterns
(`/products/[slug]`, `/docs/[...parts]`) come from `AccessibleMonitor` at
runtime; `withAccessible` in `next.config.mjs` adds component attribution when
`node scripts/build-swc.mjs` has produced `packages/monitor-next/swc/plugin.wasm`.

---

## Packages

| Package | |
|---|---|
| [`packages/monitor`](./packages/monitor) | `@accessible-so/monitor` — the script-tag loader (≤2KB gz) and the axe-backed engine bundle. |
| [`packages/monitor-core`](./packages/monitor-core) | `@accessible-so/monitor-core` — the barrier signature, the beacon protocol and its schema, redaction, sampling, session state, the scan engine, the behavioural observers, and the framework adapter contract. |
| [`packages/monitor-next`](./packages/monitor-next) | `@accessible-so/monitor-next` — the Next.js adapter: route-pattern attribution for the App and Pages Routers, and an optional build-time SWC plugin for component attribution. See [Adapters](#adapters). |
| [`packages/monitor-astro`](./packages/monitor-astro) | `@accessible-so/monitor-astro` — the Astro integration: injects the loader and supplies route-pattern attribution from Astro's route table. See [Adapters](#adapters). |

The **barrier signature** is public by design: given a DOM element and a rule key
it returns a stable, structural identity for a defect that is the same across
pages, deploys, and the tools that found it — so Accessible's own scanner runs
this exact module in the browser and a defect found by a static scan, by
real-user monitoring, and by a journey test collapse to one issue. It reads tag
names, attribute names, normalised class tokens, and landmark ancestry. It never
reads text content, layout, or URLs, and no attribute values other than `role`,
`type`, and the build-stamped `data-a11y-component` identifier (a developer-chosen
component name, never user data); the accessible name of a landmark enters only as
a word-count bucket (0, 1-3, 4-8, 9+), never the text itself. The rule key is
criterion-namespaced whenever the finding maps to a WCAG success criterion
(`wcag:1.1.1`), so every tier that finds the same element under the same criterion
agrees on one identity; `axe:<ruleId>` is only for best-practice rules that fail no
criterion, and `obs:<observerId>` for behavioural observers.

What the backend does with signatures — clustering, exposure, prioritisation — is
not in this repository.

---

## How the guarantees are tested

`pnpm test:browser` drives the built bundles against the fixture site in real
Chromium and asserts, per constraint:

| Constraint | Test |
|---|---|
| Zero text nodes; allowlisted attributes only; no fixture string leaks | `constraints.browser.test.ts` |
| No host DOM mutation beyond the engine `<script>` | `constraints.browser.test.ts`, via a `MutationObserver` installed before any page script runs |
| No uncaught exceptions, no console noise | every scenario in all three suites, and in each adapter's own suite |
| Route patterns for each framework (dynamic, catch-all, priority, base path, client navigation) | `packages/monitor-next/test/browser`, `packages/monitor-astro/test/browser` |
| One barrier, one session start, one route per session | `constraints.browser.test.ts` |
| Sticky sampling; kill switch; unsampled visitors do no work | `constraints.browser.test.ts` |
| The four observers, with `confidence: 'heuristic'` and the right criteria | `observers.browser.test.ts` |
| At most one task over 50ms while the visitor is looking, on any device (run at 1x and under 6x CPU throttling), the scan still finished at tab-hide, and the rules skipped to hold it | `perf.browser.test.ts` |

---

## License

MIT for our code. `@accessible-so/monitor` bundles axe-core (MPL-2.0) unmodified —
see [`THIRD_PARTY_NOTICES.md`](./packages/monitor/THIRD_PARTY_NOTICES.md).
