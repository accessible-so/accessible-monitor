# swc-plugin-accessible

An [SWC](https://swc.rs) plugin that stamps the outermost host element each
function component returns, so a barrier the collector finds in a real session
can be attributed back to the component that rendered it.

```jsx
function ProductCard({ p }) {
  return <article className="card">{p.name}</article>;
}
```

becomes

```jsx
function ProductCard({ p }) {
  return (
    <article
      className="card"
      data-a11y-component="ProductCard"
      data-a11y-source="app/ProductCard.jsx:1"
    >
      {p.name}
    </article>
  );
}
```

It is registered for you by `withAccessible()` from
[`@accessible-so/monitor-next`](../../packages/monitor-next); it is not meant
to be added to `next.config` by hand.

Everything in the adapter works without it. Without the plugin, findings simply
carry no component attribution — never a guessed one.

## What it stamps

| Shape | Stamped |
| --- | --- |
| `function ProductCard() { return <article/> }` | yes |
| `export default function Page() { return <main/> }` | yes |
| `const Price = ({ v }) => <span>{v}</span>` | yes |
| `const Price = function () { return <span/> }` | yes — under the binding's name |
| `export default function () {}` / `export default () => …` | no — no name to attribute to |
| `const handler = function Render() { return <div/> }` | no — the binding is not a component |
| `rows.map(function Row() { return <li/> })` | no — a named callback is not a component |
| `function Page() { return <Layout/> }` | no — composite |
| `function List() { return <><p/></> }` | no — fragment |
| `function helper() { return <div/> }` | no — not PascalCase |
| an element that already has `data-a11y-component` **or** `data-a11y-source` | no |
| anything under a `node_modules` directory | no |

The rules behind that table:

- **Host elements only.** A composite (`<Layout>`, `<Foo.Bar>`, `<svg:circle>`)
  is skipped. Its own definition gets stamped when that file compiles, and an
  unknown prop passed to an arbitrary component may be spread onto some
  unrelated node — or dropped — so stamping it would be a guess about someone
  else's render.
- **The outermost returned element only.** Nested elements are not stamped:
  attribution is about which component owns the subtree, and one marker per
  component keeps the DOM cost to two attributes per render.
- **Top-level `return` statements only.** A `return` inside a branch or a
  callback is not reliably "the component's element", and following them would
  stamp helper closures with their enclosing component's name.
- **Existing stamps win.** A hand-written stamp, or one an inner component
  already applied, is never overwritten — and either attribute alone is enough
  to claim the element, since React keeps the last of a duplicated attribute
  and a second `data-a11y-source` would quietly replace the author's.
- **A name has to mean something.** A component is a `function` declaration, a
  `const` bound to an arrow or a function expression, or the function
  `export default` names — each of them PascalCase. A PascalCase name on a bare
  function *expression* is not evidence of a component: `const handler =
  function Render() {…}` and `rows.map(function Row() {…})` render nothing on
  their own, so attributing an element to them would point at the wrong thing.
- **Purely syntactic.** No imports or types are resolved, so server components
  get exactly the same treatment as client ones. TypeScript is handled the same
  way: `as`, `satisfies` and `!` on a returned element are transparent.

`data-a11y-source` is `<parent dir>/<file>:<line>`, cut back to `<file>:<line>`
when the two-segment form would run past 60 characters — the beacon's attribute
policy caps a value at 64. If there is no file name to report, the attribute is
omitted rather than emitted as a bare `":42"`.

## Known limits

- **Only a top-level `return` is stamped.** An early return
  (`if (!data) return <Empty/>;`), a ternary (`return cond ? <A/> : <B/>`) and a
  wrapped arrow (`const Card = memo(() => <div/>)`) all render fine and all
  carry no attribution. That is why findings from one component can be
  attributed while findings from another are not.
- **The line is the component's declaration, not the element's.** For a
  multi-line component the stamp points at the `function`/`const` line. That is
  the line a reader wants when they open the file, and it stays stable when the
  body is reformatted.
- **No line at all if the host cannot resolve one.** `data-a11y-source` then
  carries the file alone. The plugin never emits a placeholder line such as
  `:0`, because a wrong line costs more to chase than a missing one. Spans that
  a source map cannot cover — a dummy or empty span, typically an identifier
  synthesised by a plugin ordered before this one — are never handed to the
  lookup at all: every source-map call available to a plugin panics on a miss,
  and the release profile aborts on panic, so a miss would take down the whole
  `next build`. One residual case is not guarded: a *positioned* span that
  falls outside this file's own source map, which only an earlier plugin
  re-using or synthesising real byte positions can produce. It has not been
  observed, and there is no non-panicking lookup to defend it with.
- **The path is at most `<parent dir>/<file>`, and sometimes just the file.**
  The parent directory is dropped when the two-segment form would run past the
  beacon's 64-character attribute cap, and also when the compiler hands over an
  absolute path with fewer than three directories above the file — there the
  parent is a top-level or home directory (`/Users/<name>/page.tsx`), and
  `data-a11y-source` is meant to carry a repo-relative fragment and nothing
  else. If even the bare file name would run past the cap, no
  `data-a11y-source` is emitted at all: a truncated path in the DOM would
  disagree with the untruncated `comp.source` on the wire for the same element.
- **Anonymous components are skipped.** `export default function () {}` and
  `export default () => <div/>` have no name to attribute to; the file name
  would be a guess, not a fact. Give the function a name to get attribution.
- **PascalCase is the only signal.** A component named in `camelCase` is
  indistinguishable from a helper here, and is left alone.

## Building

```bash
cargo test --manifest-path crates/swc-plugin-accessible/Cargo.toml
node scripts/build-swc.mjs        # -> packages/monitor-next/swc/plugin.wasm
```

The wasm build needs Rust **1.98 or newer** (swc_core's graph does not
resolve on older stables) and the `wasm32-wasip1` target:

```bash
rustup update stable
rustup target add wasm32-wasip1
```

`.cargo/config.toml` at the repo root passes `--allow-undefined` to the wasm
linker: the plugin reaches its host through plain `extern "C"` declarations,
which resolve to imports only at instantiation time.

The crate tracks `swc_core` **73**, which is the range Next 16 links
(`swc_common` 23.0.2, `swc_ecma_ast` 25.0.0, `swc_plugin_runner` 30.0.1). A
plugin and its host exchange a serialized AST whose layout those versions
fix, so the wasm only loads in a host built against the same window — 70.0.0
through 73.0.0; 74 moves to `swc_common` 24 and breaks it. `withAccessible`
refuses to register the plugin outside Next 16 for exactly this reason.

## Tests

`tests/fixture.rs` runs every `tests/fixture/*/input.js` through the transform
and compares it to the `output.js` beside it, and every
`tests/fixture-ts/*/input.tsx` against its `output.tsx` with the TSX parser —
the TypeScript-only shapes cannot appear in a `.js` fixture at all. To add a
case, write the input, run

```bash
UPDATE=1 cargo test --manifest-path crates/swc-plugin-accessible/Cargo.toml
```

and read the generated `output.js` before committing it — the harness records
whatever the transform did, including whatever it did wrong.
