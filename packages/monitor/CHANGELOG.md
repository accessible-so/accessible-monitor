# @accessible-so/monitor

## 0.5.0

- **Paths renamed from `rum` to `a11y`:** the loader fetches `/api/a11y/config`, the hosted engine is `/a11y/<version>/engine.js`, and the hosted loader is `https://accessible.so/a11y/loader.js`. Generic "RUM" block-list rules no longer match them.
- Built against @accessible-so/monitor-core 0.5.0 (idle-window collection; see its changelog).
- **The loader defaults to `https://app.accessible.so` for config and beacons** (was the loader's own origin), so the hosted loader at `https://accessible.so/rum/loader.js` needs only `data-site-key`. Served from `https://accessible.so`, it loads the engine version the app's config names (`minCollector`, `/rum/<version>/engine.js`), so a hosted engine always matches what ingest accepts. Self-hosted, the engine is still the sibling `engine.js`, and `data-engine` still wins.

## 0.4.0

Never published; 0.5.0 is the first public release.

- Rebuilt on core 0.4.0: the engine bundle now costs the visitor at most one scan task over 50ms while they are looking, on any device — it parks after that one and finishes when the tab hides — and runs the contrast/target-size pass at tab-hide on every page. Beacons are unchanged in shape; `perf.aborted` is true while scanning is parked and is cleared on a later beacon if the rest finishes. The loader is unchanged.

## 0.3.0

- Rebuilt on core 0.3.0: the adapter slot (`window.__accessibleAdapter`) a framework component can register on after the engine has already started, and beacons whose `sendBeacon` Blob now declares `text/plain;charset=UTF-8` so cross-origin delivery needs no CORS response headers at all — the body is still JSON, and an ingest must parse it as such regardless of the declared type.

## 0.2.2

- Rebuilt against collector-core 0.2.2; no behaviour change.

## 0.2.1

- `dist/engine.js` now carries an MPL-2.0 notice for the axe-core it inlines, and both packages ship a `LICENSE` file. `axe-core` moved to `devDependencies` — it is bundled, not resolved — so the published package has no dependencies at all.
- Picks up the collector-core 0.2.1 engine and protocol changes: validated element keys, `perf.pending`, container chunks, and a bounded dirty tracker.

## 0.2.0

- Added a script-tag loader that stays under 2KB gzipped.
- Added an engine bundle that inlines axe-core 4.13.0 and `@accessible-so/monitor-core` so hosts need only the one script.
- Added a fixture site, a dev server, and a Playwright constraint suite that proves the collector's guarantees.
