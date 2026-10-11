# Framework adapters

What an adapter is, where it lives, and what it is never allowed to do.

---

## 1. One repository per package-registry family

The rule, amended from the original spec, is about where code ships, not what
language it is written in:

> Everything that publishes to **npm** as a JavaScript framework adapter lives
> in **this** repository, as `packages/monitor-<framework>` — sharing the
> same core types (`@accessible-so/monitor-core`), the same size-limit budget,
> the same Playwright browser harness, and one release train, so `monitor`,
> `monitor-core`, and every `monitor-<framework>` are versioned and tagged
> together. The build-time SWC plugin is the one exception that still lives
> here despite not being JavaScript: it is a Rust **crate**
> (`crates/swc-plugin-accessible`) compiled to wasm and shipped *inside* the
> npm package that needs it (`@accessible-so/monitor-next`'s `swc/plugin.wasm`),
> because it has no independent existence outside that package's build step.
>
> Everything that publishes to a **different** registry, or has no registry at
> all, gets its **own** repository, pinning a published version of
> `@accessible-so/monitor` the way any third-party integrator would:
> WordPress (PHP, distributed through wordpress.org), Shopify (a theme app
> extension, shipped through the Shopify CLI), and server-side language
> helpers — Rails, Django, Laravel — that render the `<script>` tag from
> whatever templating the framework already uses. None of those ecosystems
> share this repo's toolchain, its release cadence, or its reviewers, and
> forcing them in would make every one of those releases wait on a Next.js
> minor bump it has nothing to do with.

`monitor-next` was the first `packages/monitor-<framework>` under this rule
and `monitor-astro` the second. Remix, SvelteKit, Nuxt, and anything else that
resolves at the npm registry follow the same shape.

## 2. The contract

An adapter supplies exactly the three things a plain `<script>` install cannot
know on its own, and nothing else:

- **The route pattern behind a concrete path** — `/blog/[slug]`, not
  `/blog/hello-world` — because only the framework's router knows which
  segments are static and which are parameters.
- **Which component owns an element**, when the framework (or a build step
  it controls) can say so.
- **Where its own config/ingest endpoints are**, if they differ from the
  script tag's defaults.

Everything else — sampling, scanning, redaction, the beacon shape, the
transport, the performance budget — lives in `@accessible-so/monitor-core` and
is identical no matter which adapter, or no adapter, is in play. An adapter
that tried to duplicate any of that would drift from the beacon every other
tier of testing (a static scan, a journey test) already agrees on.

The contract is one interface,
[`CollectorAdapter`](../packages/monitor-core/src/adapter.ts):

```ts
interface CollectorAdapter {
  attribution?: {
    routePattern?(path: string): string | null;
    componentOf?(el: Element): { id: string; source?: string } | null;
  };
  transport?: {
    endpoint?: string;
    configEndpoint?: string;
  };
}
```

Every hook is optional and every hook may return `null`. A collector with no
adapter, or an adapter that answers `null` for a given path or element, falls
back to the `data-a11y-*` build stamps and a null route pattern — never to a
guess.

## 3. How to write an adapter

The whole surface a framework package needs to touch is registration. This is
the entire pattern, at the size an adapter's core logic actually is:

```ts
// packages/monitor-<framework>/src/adapter.ts
import { ADAPTER_SLOT, type CollectorAdapter } from '@accessible-so/monitor-core';

// 1. Whatever your framework's router already resolved — a bounded map from
//    concrete path to pattern is enough; it does not need to be a Map.
export class RouteMap {
  private entries = new Map<string, string>();
  set(path: string, pattern: string) {
    this.entries.set(path, pattern);
  }
  get(path: string): string | null {
    return this.entries.get(path) ?? null;
  }
}

// 2. Build the adapter object. Optional hooks may be omitted entirely.
export function createFrameworkAdapter(map: RouteMap): CollectorAdapter {
  return { attribution: { routePattern: (path) => map.get(path) } };
}

// 3. Publish it on the slot the engine reads lazily, on every lookup — never
//    cached, so a component that mounts after the loader already started the
//    engine is still picked up. Never throw into the caller: this runs during
//    your framework's render, where an uncaught error is the user's outage,
//    not the collector's.
export function registerAdapter(adapter: CollectorAdapter): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>)[ADAPTER_SLOT] = adapter;
}
```

A real adapter's component wrapper (a root-layout component, an `_app`
override, a root plugin — whatever your framework's "runs once, everywhere"
hook is) calls `registerAdapter(createFrameworkAdapter(map))` once, and keeps
`map` current on every navigation the framework's own router already tells it
about. It never imports or calls anything from the engine itself: the loader
decides sampling and injection, on its own schedule, from its own script tag.

If your framework also wants build-time component attribution, that is a
separate, optional concern — a build plugin that stamps `data-a11y-component`
/`data-a11y-source` onto rendered host elements, the way
[`crates/swc-plugin-accessible`](../crates/swc-plugin-accessible) does for
Next.js. Nothing in the runtime contract requires it; a `componentOf` hook or
no attribution at all are both honest answers.

## 4. What an adapter must never do

- **No text.** Not from the DOM, not from a route param, not from a component
  name inferred off of prop values — an adapter's `id`/`source` are the
  developer's own naming, never content a visitor typed or read.
- **No URLs beyond a route pattern.** A concrete path with its params
  substituted back to `[param]` is fine; a query string, a fragment, or a
  full origin is not — the core layer already strips those before an
  adapter's hooks are consulted.
- **No user data.** No cookies, no session identifiers beyond the one the core
  layer already manages, no request headers, no IP address. An adapter has no
  reason to see any of it and must not go looking.
- **No assistive-technology detection.** An adapter must not inspect the user
  agent, media features, or timing to guess whether a visitor uses a screen
  reader or has a disability, in service of "smarter" attribution or anything
  else. `navigationMode` is the one signal about how a session was driven, and
  it lives in the core, defined the same way for every adapter.
- **Never start the engine.** An adapter registers itself and waits. Sampling,
  injection timing, and the decision to scan at all belong to the loader,
  which reads its own script tag's configuration — an adapter that started
  scanning eagerly would defeat the sampling contract the loader promises
  every visitor.
- **Never widen the beacon.** An adapter's hooks return the three things
  listed in §2 and nothing else. If a hook is tempted to smuggle an extra
  field onto the wire, that field belongs in `@accessible-so/monitor-core`'s
  protocol instead, reviewed and tested the same way every other field on the
  beacon is.
