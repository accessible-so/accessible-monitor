# @accessible-so/monitor-core

The barrier signature is a stable structural identity for a web accessibility
defect. It hashes the tag name, `role`/`type`, allowlisted attribute *names*,
normalised class tokens (CSS-module hashes and utility arbitrary values are
stripped out), the element's landmark ancestry, and — when present — the
`data-a11y-component` identifier a build tool stamped on the component root.
It never reads text, other attribute values, computed styles, or URLs — the
accessible name of a landmark enters only as a word-count bucket (0, 1-3, 4-8,
9+), never the text itself — so the same defect keeps the same signature across
page loads, deploys, and the tier that found it (static scan, real-user
monitoring, or a journey test), even while CSS hashes rotate, list items
reorder, or an unrelated wrapper div is added around a component.

The rule key that goes into the hash is criterion-namespaced whenever the
finding maps to a WCAG success criterion (`wcag:1.1.1`), so a scan, a real-user
session, and a journey test that hit the same element under the same criterion
share one signature; `axe:<ruleId>` is only for best-practice rules that fail no
criterion, and `obs:<observerId>` is for behavioral observers. `ruleKeyForAxe`
and `criterionFromAxeTags` derive that key from an axe rule's tags
(`wcag111` → `1.1.1`).

The package ships two entry points. `@accessible-so/monitor-core/signature`
is the ESM/CJS module for Node and bundler consumers — import
`computeSignature(element, ruleKey)` (or the lower-level `signatureParts`,
`elementKeyOf`, `ruleKeyForAxe`, `criterionFromAxeTags`, and related helpers)
directly. `@accessible-so/monitor-core/signature/source`
exports `SIGNATURE_SOURCE`, a classic-script bundle as a plain string, for
hosts that need to inject the algorithm into a page they do not control —
for example a Playwright collector:

```ts
import { SIGNATURE_SOURCE } from '@accessible-so/monitor-core/signature/source';

await page.addInitScript(SIGNATURE_SOURCE);
// The page can now call `AccessibleSignature.computeSignature(el, ruleKey)`.
```

## License

MIT.

"Accessible" and the Accessible logo are trademarks of L5 Ventures LLC, doing business as Accessible. The license covers the code, not the name: a fork or redistribution may not be called Accessible or presented as ours.
