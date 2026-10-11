# Methodology

What the collector measures, how it decides, and what it refuses to do. Everything
here is verifiable against the source in this repository; where a rule is a
judgement call, the judgement is written down rather than hidden in a threshold.

---

## 1. Navigation mode

`ctx.navigationMode` describes **how this session drove the page**. It is the one
field that comes close to describing a person, so it is defined narrowly and
behaviourally, and the definition is reproduced here verbatim from the design:

> Navigation mode is session-level and behavioral only: `keyboard-driven` when ≥5
> focus moves came from Tab, Shift+Tab, or arrow keys and no `pointerdown` or
> `touchstart` landed on an interactive element; `pointer-driven` when pointer
> interactions exist and fewer than 2 keyboard focus moves; otherwise `mixed`;
> `unknown` before either threshold. Field name is `navigationMode` everywhere.
> **There is no code path that inspects user agent, media features, or timing to
> infer assistive technology or disability, and the test suite asserts the bundle
> contains no reference to known AT identifiers.**

A "keyboard focus move" is one navigation keypress followed within 200ms by a
`focusin` on a different element than the one previously focused. A pointer
interaction counts only when the event target, or an ancestor of it, matches
`a[href], button, input, select, textarea, summary, [role=button], [role=link],
[tabindex]`.

Source: [`packages/monitor-core/src/session/navigation-mode.ts`](../packages/monitor-core/src/session/navigation-mode.ts).
The prohibition is enforced by a bundle-content test: `dist/engine.js` must not
contain `JAWS`, `NVDA`, `VoiceOver`, `TalkBack`, `Narrator`, `speechSynthesis`,
or `forced-colors`.

**`keyboard-driven` is not "a screen reader user".** It is a description of input,
nothing more. Sighted keyboard users, people testing their own site, and people
whose mouse just died all land in the same bucket.

---

## 2. Redaction

Redaction runs in the page, before anything is queued for sending, and the same
policy is re-applied on the server at ingest. Element snippets are structured
JSON — never HTML strings.

### Text

**Never captured.** A text node becomes three numbers and a boolean or nothing at
all:

```json
{ "length": 10, "words": 2, "knownBad": true }
```

`knownBad` matches a fixed list of uninformative link text: `click here`,
`read more`, `here`, `learn more`, `link`, `more`, `this`.

### Attributes

Everything not in this table is dropped — including `id`, `name`, `value`, `src`,
`style`, event handlers, and every `data-*` attribute outside the `data-a11y-`
prefix.

| Policy | Attributes | What is sent |
|---|---|---|
| Value kept verbatim (max 64 chars) | `role`, `type`, `tabindex`, `lang`, `data-a11y-component`, `data-a11y-source`, and the token-valued ARIA attributes: `aria-hidden` `aria-expanded` `aria-required` `aria-invalid` `aria-haspopup` `aria-live` `aria-current` `aria-checked` `aria-disabled` `aria-selected` `aria-pressed` `aria-level` `aria-modal` `aria-atomic` `aria-busy` `aria-multiline` `aria-readonly` `aria-sort` `aria-orientation` | the string |
| Presence only | `for` | `true` |
| Text metrics | `alt`, `title`, `placeholder`, `aria-label`, `aria-description`, `aria-placeholder`, `aria-valuetext`, `aria-roledescription` | `{ len, words }` |
| Reference counts | `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-activedescendant` | `{ refs, resolved }` |
| Path only | `href` | same-origin: the path, query and fragment stripped. Anything else: the literal string `external` |
| Dropped | everything else | nothing |

`data-a11y-component` and `data-a11y-source` are build-time stamps a developer or
bundler put on the element (`"BuyButton"`, `"src/Buy.tsx:12"`). They are kept
verbatim because they name code, not people. If your build stamps user data into
them, do not use them.

### Node budget

A finding carries the failing element, at most one parent, and at most two
children. Parents and children carry no relatives of their own. Every one of them
is redacted by the same policy.

### URLs

`p` is `location.pathname`. Query strings and fragments never leave the page.
`r` is the route *pattern* (`/products/[slug]`) and is only ever non-null when a
framework adapter supplies one — a script-tag install always sends `null`.

Source: [`packages/monitor-core/src/redact/index.ts`](../packages/monitor-core/src/redact/index.ts)
and [`protocol/attr-policy.ts`](../packages/monitor-core/src/protocol/attr-policy.ts).

---

## 3. Sampling

- The decision is made **once per session** and stored in `sessionStorage` under
  `a11y_rum` as `{ s: <session id>, d: 0 | 1 }`. It is sticky: lowering the rate
  mid-session does not stop a session that was already sampled, and raising it
  does not start one that was not.
- **An unsampled session is stored too**, as `{ s, d: 0 }` — and that write is
  what makes the decision sticky in the direction that matters. Without it every
  pageview would roll the dice again, and a 5% rate would sample roughly 5% of
  *pageviews* rather than 5% of *sessions*; a visitor reading twenty pages would
  be near-certain to be collected on one of them. The record is a session id and
  one bit, it lives in `sessionStorage`, and it is gone when the tab closes.
- The rate comes from `GET /api/rum/config`. A `boosted` entry whose `pattern`
  matches the current path can **raise** the rate for that path, never lower it.
  Patterns use `[param]` for one non-empty segment and `[...rest]`, only as the
  last segment, for one or more.
- The loader fetches the config on **every pageview of a sampled session**, so a
  kill switch takes effect on the next navigation. It fetches **nothing at all**
  on later pageviews of an unsampled session: one config request per unsampled
  session, and no engine download, ever.
- `enabled: false` or `killSwitch: true` in the config stops everything: no
  engine injection, no scanning, no beacon.
- `?a11y_debug=1` on the page URL forces this pageview to be sampled regardless
  of the rate or a cached "not sampled" decision, and turns on `console.debug`
  output. It is a QA tool; it is not a way to opt a visitor in.
- `data-sample="0.25"` on the script tag overrides the server's rate locally, for
  development.

Source: [`packages/monitor/src/loader.ts`](../packages/monitor/src/loader.ts)
and [`session/sampling.ts`](../packages/monitor-core/src/session/sampling.ts).

---

## 4. The performance budget

The rule the collector holds itself to: **never be the reason a page is slow.**

- The loader defers injecting the engine to `requestIdleCallback` (3s timeout,
  1.5s `setTimeout` fallback).
- The engine runs **one `axe.run` per idle callback**, never more than one at a
  time. `axe.run` is not interruptible, so the budget is met by scoping, not by
  slicing: a full pass is one run for the page-level rules, one for the
  document-cost rules (§4.1), and then the body split into chunks of at most 200
  elements, visible regions first.
- **A chunk is a group of siblings, not one element.** Every `axe.run` pays a
  fixed setup cost before it looks at anything — 13-20ms on a 5,000-element page
  — so splitting is worth doing only to keep one run inside the budget, never
  for its own sake. Small siblings are packed back together up to the chunk
  size; only a subtree too big to fit on its own is descended into.
- Chunks are **200** elements. After each run made while the visitor is
  looking: if it took more than **50ms**, scanning **parks** — nothing more runs
  until the tab is hidden, when the parked queue is finished (see *The order on
  the way out*). The visitor pays at most that one long task. The engine used to
  halve the chunk size and try again, up to three times, but most of a run's
  cost is a floor set by the document and the device (axe rebuilds its view of
  the whole page on every run: ~22ms for any chunk of the 5,300-element fixture
  on a fast laptop, ~54ms at a mid-range phone's speed), so on a slow device
  every halving was one more long task that bought nothing.
- Two further ceilings bound a page that mutates forever: at most **200 scans**
  and at most **50,000 elements** covered per page. Either one stops collection
  the same way.
- While scanning is parked, and when collection stops for any of those
  reasons, the beacon says so: `perf.aborted: true`, alongside `scans`,
  `longTasks` (over-budget runs), and `maxTaskMs`. **A page not fully scanned is
  reported as unmeasured, never as clean.** A parked page whose queue is then
  finished at tab-hide reports `aborted: false` on its last beacon. Every beacon
  carries `perf`, not just the last one.
- Hiding the tab (`visibilitychange` to hidden) or leaving it (`pagehide`)
  flushes one final beacon — with one inline retry, because the interval that
  would otherwise carry the retry is about to be cleared — and then tears
  everything down: no listeners, no observers, no timers.

### 4.1 Contrast on large pages

A handful of axe rules are element-level in *meaning* — each names one failing
element — but document-level in *cost*. `color-contrast` and `link-in-text-block`
make axe build a spatial grid of the whole page; `target-size` uses the same
grid; `region` walks every element in the document. axe rebuilds all of that on
**every** `axe.run`, whatever context it is handed.

Those four are the document-cost set, and they are the four `perf.skipped`
names. A fifth rule with the same cost, `color-contrast-enhanced`, is **never
run at all**: it is the AAA rule for 1.4.6, the static scanner does not run it
either, and reporting it here would produce a second finding under a rule key no
other tier can reconcile for the one contrast defect `color-contrast` already
found. Naming a rule in axe's `runOnly` turns it on whether or not it is enabled
by default, so the only way not to run it is not to name it — it is kept in the
list that chunk runs disable, and nowhere else.

Measured on a 5,345-element fixture page, per single run:

| Rule | Context | Cost |
|---|---|---|
| `color-contrast` | a 2-element leaf | ~145 ms |
| `target-size` | a 4-element header with links | ~141 ms |
| `region` | the document | ~75 ms |
| every other rule under our tag set | same contexts | 13–20 ms |
| the whole remaining page-level pass | the document | 17–19 ms |

Run once per chunk, as they were, those rules made the floor cost of *any*
scan scale with the page rather than with the chunk — so no chunk size could
meet the 50ms budget, and a 5,000-element page aborted after three strikes
having reported nothing at all. Rebuilding the collector with `chunkMax: 25`
changed `maxTaskMs` by nothing.

So they are their own pass, `DOCUMENT_COST_RULES`, run at most once per page
and disabled inside every chunk run. It is one indivisible `axe.run` — there is
nothing to chunk — so the only question is *when*:

| Document elements | What happens | Why |
|---|---|---|
| **≤ 3,000** | **deferred** to the moment the tab is hidden | nobody is waiting on the main thread once the visitor has looked away |
| **> 3,000** | not run; the rule ids go in `perf.skipped` | one pass costs over a second at this size on a fast laptop — too much to ask of any moment |

There used to be a third tier: pages up to 250 elements ran the pass straight
away. That threshold was measured on a fast laptop, where the 120-element front
page costs ~22ms. Measured again under Chromium's CPU throttling, the same pass
costs ~40ms at 2x, ~76ms at 4x and ~117ms at 6x — over budget on a mid-range
phone even for a small page. No size is small enough to run it while the
visitor is looking without knowing the device, so no page does.

A consequence for single-page apps: one pass waits for the tab to hide, and it
checks the view showing then. Views the visitor navigated through client-side
earlier are not contrast-checked. A beacon sent from such a view carries
`perf.pending`, so the server records the rules as not yet checked there rather
than as passed.

### The order on the way out

Hiding the tab is when the saved work runs: the document-cost pass, then any
parked or not-yet-reached scanning. A hidden tab may be frozen or discarded at
any moment, so when that work is long it does **not** go first:

1. **flush** everything the collector already has, with its one retry — but
   only when the work ahead is long: a queue to finish, or a page over 250
   elements (the pass costs ~66ms on a 420-element page on a fast laptop and
   ~250ms at a mid-range phone's speed). A small page's pass runs first and
   everything leaves in one beacon, because every beacon counts against the
   site's daily cap;
2. run the deferred document-cost pass;
3. if scanning was parked or unfinished, **flush** the contrast findings, then
   finish the queue, one chunk after another;
4. if a beacon already sent said `pending` or `aborted` and that is no longer
   true, send the final state, even with no new findings — otherwise the
   server would keep the stale claim as the last word;
5. **flush** and tear everything down.

In a really hidden tab the browser throttles timers, and axe resolves each rule
through one, so each chunk finished at tab-hide takes roughly a second of wall
time (measured: ~0.23s visible, ~1.2s backgrounded). Switching tabs leaves
plenty of time; a phone that freezes the page within seconds may cut the queue
short, and then the earlier beacon's `aborted: true` stands.

Losing the contrast findings because the browser froze the tab is a small loss.
Losing the whole beacon because a scan was queued in front of it is not.

`visibilitychange` to hidden is the deferred pass's moment and its last one.
`pagehide` is not: the page is unloading and there is no time, so the pass is
abandoned and its rules are named in `perf.skipped` instead of quietly going
missing. The same happens if `pagehide` arrives while the deferred pass is
already running.

### Measured, per fixture page

The beacon and `skipped` columns describe **a pageview that ends on a
backgrounded tab** — the visitor switches away, or the tab is hidden while the
page stays loaded. That is the only ending in which a deferred pass gets its
moment.

| Fixture page | Elements | Tier | Worst task while visible | Worst task overall | Beacons *(backgrounded tab)* | `skipped` *(backgrounded tab)* |
|---|---|---|---|---|---|---|
| `/` | 120 | immediate | 32 ms | 32 ms | 1 | — |
| `/products.html` | 419 | deferred | 26 ms | 113 ms (after hiding) | 2 | — |
| `/mid.html` | 1,121 | deferred | 13 ms | 227 ms (after hiding) | 2 | — |
| `/big.html` | 5,345 | skipped | 26 ms | 26 ms | 1 | the four rules |

**On a navigation away, `pagehide` follows `visibilitychange` immediately; the
deferred pass is abandoned before it can run and is reported in `perf.skipped`.
Most mid-size pageviews that end in a click therefore report contrast as
unchecked.** The two-beacon ending in the table above is what a *backgrounded*
tab produces. A visitor who reads the page and then clicks a link — the ordinary
case — produces one beacon, with `color-contrast`, `link-in-text-block`,
`target-size` and `region` all named as not run. The deferred tier is worth
having because it turns silence into either coverage or an explicit gap; it is
not a claim that mid-size pages usually get their contrast checked.

### What is not reported

**On a page over 3,000 elements this is a coverage gap, and it is a reported
one.** No contrast findings, no `link-in-text-block` findings, no `target-size`
findings and no landmark-`region` findings come from real-user monitoring there
— and the beacon names all four rules in `perf.skipped`, so nothing downstream
can mistake the silence for a clean page. A rule comes back off that list if a later client-side route change
lands on a page small enough to run it after all.
Static scans, which are not on a visitor's main thread, remain the place those
rules get answered on very large pages.

**A deferred pass that has not run yet is reported as `perf.pending`.** It is
the third state between "checked" and "not checked": `pending` names the rules
whose pass has been postponed and not yet happened, so a beacon sent from a page
the visitor is still on says "not yet" instead of saying nothing — which read
exactly like a page that had been checked and was clean. A rule is never in both
lists. It leaves `pending` for `skipped` when the pass is abandoned, and leaves
both when the pass runs; the beacon that follows a completed pass carries
neither.

**What `pending` does not fix**: if a tab is never hidden and never unloaded
(the operating system kills it, the browser crashes, the device sleeps and never
wakes), the last beacon that left the page says `pending` and nothing ever
resolves it. That is now visible rather than silent, which is the whole point,
but it is still not an answer about those rules.

Giving up on a pass is always *sent*, though, even when there is nothing else
left to say: the beacon that carries the skip list may be a beacon with no
findings on it at all.

**axe's `incomplete` results are dropped, and they are not reported anywhere.**
Every run is made with `resultTypes: ['violations']`, so the "needs review" pile
— an element axe could not decide about, most often a contrast check behind a
background image or a gradient — never becomes a finding. That is deliberate on
two grounds. An incomplete result is not a barrier: reporting one as a finding
would put a maybe into a stream whose whole value is that every entry is a
defect somebody can go and fix. And it has no element identity the other tiers
can reconcile — the signature machinery exists so a scan, a journey test, and a
real session agree on one identity for one defect, and there is nothing to agree
on when the finding is "we could not tell". The **scan tier** surfaces
`incomplete` results, where a human is already reading a report and a maybe is
useful. Real-user monitoring does not.

**A container far larger than one chunk is not scanned as an element.** When the
chunker descends into a container it emits a chunk for the container itself with
its children excluded, so the rules that are about a container — `list`, the
table rules, `aria-required-children` — are asked. That chunk costs about a
third of what including the subtree would, so it is only emitted while the
container's subtree is within three times the chunk budget; a `<div>` wrapping
5,000 elements goes without one. Its children are all still scanned.

Work done at tab-hide — the document-cost run and the finished queue — is
counted in `longTasks` and `maxTaskMs`, because the page really did pay for it,
but it never parks anything: it says nothing about what fits while the visitor
is looking. The skip threshold is an engine option, `contrastDeferMaxElements`
(3,000).

## 5. Session deduplication

A barrier is identified by its **signature** (`sig`), a structural identity
computed from tag names, attribute *names*, normalised class tokens, and landmark
ancestry — never from text, layout, or URLs. See the
[`collector-core` README](../packages/monitor-core/README.md).

- A `(signature, route pattern)` pair is transmitted **once per session**. Further
  occurrences on the same route only raise `n` on the finding that is still
  queued.
- `session: { started: true }` is sent once per session.
- Each `(path, route pattern)` is reported once per session.
- If the user interacts with an element whose barrier was already reported, one
  small `interactions` entry is sent — or `i: true` is set on the finding if it
  has not been flushed yet. A click that lands before the scan has reached its
  element (a parked scan, §4) is held — at most 32 at a time — and credited
  when the scan reaches it. Page-level findings on `<html>` are never credited
  with a click: clicking somewhere is not touching a missing title or `lang`.
- All of this is mirrored to `sessionStorage`, so it survives a reload. A second
  tab is a second session and counts twice; that is documented, not fixed.

A pageview of a page whose barriers the session has already reported sends
**nothing at all**.
