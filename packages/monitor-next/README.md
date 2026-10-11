# @accessible-so/monitor-next

The Next.js adapter for Accessible RUM. It supplies the two things only a
Next.js app knows and `@accessible-so/monitor-core` cannot: the route
*pattern* behind a concrete pathname (`/blog/[slug]`, not `/blog/hello-world`),
so findings group by route instead of by every distinct URL a route ever
served, and, optionally, which component rendered the element a finding was
raised on.

## Install

```bash
pnpm add @accessible-so/monitor-next
```

Peer dependencies: `next >=13.4 <17`, `react >=18` — this package does not
bundle either. Component attribution (the optional SWC plugin) additionally
requires Next 16; see [Compatibility](#compatibility).

## App Router

Render once, in the root layout:

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

## Pages Router

Render once, in `_app`:

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

Either component registers the route-pattern adapter on
`window.__accessibleAdapter` and keeps it current on every navigation, then
renders the loader `<Script>`. Neither one starts the engine — sampling and
injection stay the loader's decision, made from its own script tag exactly as
they are without Next in the picture.

`basePath`, `trailingSlash` and i18n locale prefixes are all handled: the map
is keyed on `window.location.pathname`, the path the collector itself looks a
pattern up by, rather than on the router's app-relative view of it (which has
`basePath` and the locale prefix already stripped). The *pattern* stays the app
route — `/products/[slug]` under `basePath: '/x'`, not `/x/products/[slug]` —
because that is what your file tree calls it and what findings should group by.

## `withAccessible` (optional — build-time component attribution)

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
plugin — that flag, or simply no Rust toolchain on the machine that ran
`node scripts/build-swc.mjs`, so `swc/plugin.wasm` doesn't exist — everything
else works unchanged and `finding.comp` is honestly `null`, never a guess.
`withAccessible` checks for the wasm before registering anything, and when it
is missing prints one line —
`[accessible] swc/plugin.wasm not found; building without component attribution`
— and hands your config back untouched, rather than letting Next fail the
build on a plugin it cannot resolve.

## Compatibility

| Next | SWC plugin ABI | Rust toolchain | wasm size | Bundlers |
|---|---|---|---|---|
| 16.3.5 | `swc_core` 73 — `swc_common` 23.0.2, `swc_ecma_ast` 25.0.0, `swc_plugin_runner` 30.0.1, which is what Next 16's `next-swc` binary links | 1.98.1, target `wasm32-wasip1`, `-C link-arg=--allow-undefined` (repo `.cargo/config.toml`) | ~764 KB | `next build --webpack` and `next build --turbopack` — both built and stamp-verified by the browser suite |

**Component attribution is Next 16 only, and `withAccessible` enforces it.**
A wasm plugin and its host exchange a serialized AST whose layout is fixed by
the `swc_core` both were built against; Next 15 links `swc_core` 35 against
our 73, so loading this wasm there would fail the build rather than degrade.
`withAccessible` reads the resolved `next/package.json` first and, on any
other major, prints one line and returns your config untouched:

    [accessible] component attribution needs Next 16 (found 15.5.9); building without it

One wasm cannot serve both majors. The components, route patterns and loader
are plain Next API and work across the whole peer range; only `finding.comp`
is lost, and it is `null` rather than guessed.

**Tested:** the App Router example ([`examples/next-app`](../../examples/next-app)),
end to end in a real Chromium, against both `next build --webpack` and
`next build --turbopack`, on Next 16.3.5. Both bundlers are named explicitly:
Turbopack is the default from Next 16 on, so a bare `next build` would
silently make the webpack arm a second Turbopack build.

**Not tested:** Next 13.4–15 and the Pages Router in a browser —
`AccessibleMonitorPages` has unit tests only. The peer range
(`next >=13.4 <17`) is wider than what the suite exercises.

## What the plugin stamps and what it skips

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
[`crates/swc-plugin-accessible/README.md`](../../crates/swc-plugin-accessible/README.md#what-it-stamps).

## Known limits

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

See [`crates/swc-plugin-accessible/README.md`](../../crates/swc-plugin-accessible/README.md#known-limits)
for the complete list.

## What's here

- `routePatternFor(pathname, params)` — rebuilds the route pattern from a
  concrete pathname and the params object Next's router already resolved, by
  substituting each param's value back to `[key]` (or `[...key]` for a
  catch-all) wherever it appears as a whole path segment. It never guesses: a
  param whose value isn't in the path leaves the path unchanged, because a
  wrong pattern corrupts every aggregate built on top of it.
- `RouteMap` — a bounded (default 50) least-recently-used map from concrete
  path to pattern, so a finding raised on a page the user has since navigated
  away from still resolves to a route pattern when the beacon is sent.
- `createNextAdapter(map)` — builds a `CollectorAdapter`
  (`@accessible-so/monitor-core`) whose `attribution.routePattern` reads from
  the map.
- `registerAdapter(adapter)` — publishes the adapter at
  `window[ADAPTER_SLOT]`, the slot the collector engine reads when it starts
  from a `<script>` tag rather than an explicit `start()` call. A no-op
  outside a browser (e.g. during Next's server render).
- `AccessibleMonitor` / `AccessibleMonitorPages` — the App Router and Pages
  Router components documented above.
- `withAccessible` (from `@accessible-so/monitor-next/config`) — the
  `next.config` helper documented above. Imported from a separate entry point
  so importing it never pulls React into a config file.

The full framework-adapter contract — what an adapter may supply, and what it
must never do — is in [docs/adapters.md](../../docs/adapters.md).
