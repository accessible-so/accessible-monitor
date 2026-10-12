# @accessible-so/monitor-core

## 0.5.0

- **Heavy checks run while the visitor is idle, not only when the tab hides.** After a second with no pointer, key, wheel, touch or scroll input, on a visible and loaded page, a task may run up to 150 ms if its predicted cost fits. Any input closes the window. Before, the contrast pass and any parked scanning waited for tab-hide, which on an ordinary link click never came: `pagehide` follows `visibilitychange` immediately and the work was abandoned.
- **Predictions from the page's own first run, scaled by page size.** A part's cost is predicted as `firstRunMs × (base + perThousand × elements / 1000) × learned`, with the grid pass (`color-contrast`, `link-in-text-block`, `target-size`) at 3 / 15 and `region` at 0.5 / 0.8. It grows with the page because contrast builds a grid over the whole document while the first run barely moves. `learned` is a per-part multiplier that only rises, when a part runs longer than predicted, and is kept for the session. `perf.tier` (`fast`/`medium`/`slow`) describes this page on this device (`slow` when even the first run is a long task, `fast` when every part fits a window) and is recomputed on a client-side route change; `perf.idleRuns` counts window tasks. The session remembers only the slowest tier, so a known-slow device's next page runs its first scan in a window too. `saveData` turns windows off.
- **A failed first run no longer calibrates the page.** It used to record the failure's tiny time as the first run, which could label the page `fast` and give finite predictions. Now the page stays uncalibrated (no `perf.tier`), its parts never start in a window, and they run or drop at tab-hide. A chunk prediction is unknown unless it is above 0 ms, and a failed chunk run does not update it.
- **A failed scan run is not reported clean.** A failed page-level or chunk run leaves `perf.aborted` true for the rest of the page (a drain does not clear it), so the unchecked rules are never read as passed.
- **`learned` feeds the tier**, so `fast` means every part's actual prediction fits a window; `windowOverruns` counts only tasks that had a prediction.
- **Learned multipliers persist for the session** (`sessionStorage`, the larger value per part), so a site heavier than the model repeats its misprediction once, not once per page.
- **`perf.windowOverruns`** counts tasks started in an idle window that ran over the 150 ms budget, present only when above 0, so production can see when the model under-predicts.
- **The document-cost pass is two runs**: `color-contrast`, `link-in-text-block`, `target-size` (one grid), then `region`. Each leaves `perf.pending` on its own. After a scheduler abort, parts that can no longer run are reported `skipped` at tab-hide rather than left `pending`.
- **Fixed:** at tab-hide the document-cost pass was started directly while a queued chunk could still be running; axe refuses concurrent runs, so the pass could finish with no results and report the rules as checked. Everything now goes through the scheduler, whose drain is serialised and tracked as in flight: a second drain waits instead of running axe alongside the first, and a `pagehide` mid-drain reports the page unfinished.
- A client-side route change reports the previous view's unrun parts as `skipped` in a beacon of their own before arming the new view, instead of silently re-arming them.
- Pages over 3,000 elements still drop the pass at tab-hide, but a window whose prediction fits now runs it.

## 0.4.0

Never published; 0.5.0 is the first public release.

- **At most one long task while the visitor is looking, on any device.** The scheduler parks on the first scan run over the 50ms budget instead of halving the chunk size and aborting after three: most of a run's cost is a floor set by the document and the device, so on a slow device each halving was another long task. Parked work is finished when the tab hides (`drain()`), and the page reports `perf.aborted: true` until it is. Chunks are 200 elements (was 400, halving to 100).
- **The document-cost pass (contrast, target size, link-in-text-block, region) always waits for the tab to hide**, on every page up to 3,000 elements; the immediate tier for pages under 250 elements is gone. It was measured on a fast laptop (~22ms on 120 elements) and is ~76ms at a mid-range phone's speed. `contrastMaxElements` is removed.
- At tab-hide the collector finishes queued scanning that used to be dropped silently, and drops it with `perf.aborted: true` on `pagehide`. The findings already in hand go out first only when the work ahead is long (a queue, or a page over 250 elements); a small page still sends one beacon.
- A beacon that said `pending` or `aborted` is followed by the final state even when the work after it found nothing new. Before, a clean deferred contrast pass left the earlier `pending` as the last word, which the server files as rules never checked. `TransportApi.lastSentPerf()` is new.
- **A click before the scan reaches its element is no longer lost.** With the scan parked on a slow device, a visitor could click a broken button the scan had not reached, and the finding arrived at tab-hide with `i: false`. Unattributed click and key targets are now held (at most 32) and credited when a recorded element contains them. Page-level findings on `<html>` (a missing title or `lang`) no longer swallow every click on the page.
- The browser budget suite asserts the promise rather than one laptop's timings, and runs under Chromium CPU throttling (`A11Y_PERF_THROTTLE`, default `1,6`); it also passes at 10x.

## 0.3.0

- Adapters may register on `window.__accessibleAdapter`. `startCollector`'s explicit `adapter` option still wins, but a framework component that mounts after a loader has already started the engine can register itself on that slot instead — read lazily on every route-pattern and component lookup, never cached, and never allowed to throw into the collector.
- Every beacon's `c` (collector version) is now substituted from this package's `package.json` at build time instead of a literal in the source, and the suite asserts the two agree. The literal had been left at `0.2.1` through two releases, and a dashboard that compares it against a `minCollector` minimum was reading a version that no longer existed.
- The transport's `sendBeacon` Blob now declares `text/plain;charset=UTF-8` instead of `application/json`. The body is still JSON — an ingest must parse it as such regardless of the declared type — but the safelisted content type keeps the request "no-cors", so it is never preflighted and never CORS-checked, which is what makes delivery work against an endpoint that answers a wildcard `Access-Control-Allow-Origin`. The `fetch` fallback is unchanged.

## 0.2.2

- Export the attribute redaction policy and the element-key validator from `./protocol` so servers validate with the same sets the client redacts with.

## 0.2.1

- The ingest schema now parses `findings[].key` and holds it to the structure `elementKeyOf` produces, instead of accepting any string under 4KB — it was the one free-form string on the wire. A long `href` (up to 2,048 characters) no longer rejects the whole beacon: the string branch of the attribute union is as wide as the widest value the redactor can emit, and each key keeps its own limit.
- `perf.pending` names the rules whose deferred contrast pass has not run yet, so a beacon from a page the visitor is still on says "not yet" rather than nothing; the chunker now scans a container it descended into (with its children excluded) instead of leaving it uncovered; the dirty tracker's debounce is bounded and no longer quadratic; and a detached `spa-focus-loss` observer reports nothing even when a later history wrapper calls through to it.

## 0.2.0

- Added the beacon protocol: zod schemas for every beacon shape, backed by a strict attribute allowlist policy shared with the redaction module.
- Added sampling, session state, navigation-mode detection, and the transport layer that batches and sends beacons.
- Added four behavioral observers and an engine with chunked idle-time scanning, per-page time budgets, and a tiered document-cost contrast pass that reports what it skipped via `perf.skipped`.
