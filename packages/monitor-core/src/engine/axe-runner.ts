/**
 * The three shapes of axe run the collector makes.
 *
 * Page-level rules ("is there a title", "is there one main landmark") are
 * about the document, so they run once, on the document. Everything else is
 * about an element, so it runs per chunk with the page-level rules disabled —
 * otherwise every chunk would re-report the same missing title.
 *
 * Between them sits a third set. `color-contrast`, `target-size` and `region`
 * are element-level in *meaning* — each reports a specific failing element —
 * but document-level in *cost*: the first two make axe build a spatial grid of
 * the whole page and the third walks every element, on every `axe.run`,
 * whatever context it was given. Running them per chunk means paying that
 * whole-document cost once per chunk, which is what made the engine's per-task
 * budget unreachable on a large page no matter how small the chunks were.
 *
 * Measured on a 5,300-element page, per single `axe.run`: `color-contrast`
 * 145ms and `target-size` 141ms even on a context of two or four elements,
 * `region` 73-78ms on the document — against 13-19ms for every other rule
 * under our tag set, and 17-19ms for the whole remaining page-level pass. So
 * these run once, on the document; above a size threshold the engine does not
 * run them at all and names them in `perf.skipped`, rather than pretending the
 * page was checked.
 *
 * The tag set is deliberately identical to the MCP scanner's AA set plus
 * best-practice, so a barrier found by a scan and the same barrier found in a
 * real session produce the same rule key, and therefore the same signature.
 */
import type { Chunk } from './chunks';
import type { Impact } from '../protocol/types';

export interface AxeNodeLike {
  target: string[];
  element?: Element | null;
}

export interface AxeViolationLike {
  id: string;
  impact?: Impact | null;
  tags: string[];
  nodes: AxeNodeLike[];
}

export interface AxeResultsLike {
  violations: AxeViolationLike[];
}

/**
 * The context shapes the collector hands axe: a document, one element, a group,
 * or a group with part of its subtree excluded (a container whose children are
 * covered by chunks of their own).
 */
export type AxeContext = Element | Document | { include: Element[]; exclude?: Element[] };

export interface AxeLike {
  run(context: AxeContext, options: object): Promise<AxeResultsLike>;
  configure?(o: object): void;
}

export const PAGE_LEVEL_RULES: string[] = [
  'document-title', 'html-has-lang', 'html-lang-valid', 'html-xml-lang-mismatch',
  'page-has-heading-one', 'landmark-one-main', 'landmark-no-duplicate-banner',
  'landmark-no-duplicate-contentinfo', 'landmark-no-duplicate-main',
  'landmark-banner-is-top-level', 'landmark-contentinfo-is-top-level',
  'landmark-main-is-top-level', 'landmark-complementary-is-top-level',
  'bypass', 'meta-viewport', 'meta-viewport-large', 'meta-refresh',
  'duplicate-id', 'duplicate-id-active', 'duplicate-id-aria',
  'frame-title-unique', 'skip-link', 'heading-order',
];

/**
 * Element-level rules whose cost is a property of the document, not of the
 * context they are given. They run once per page, on the document, and are
 * disabled in every chunk run. This is also the list `perf.skipped` reports
 * when the pass does not happen.
 *
 * Every rule here is inside the AA-plus-best-practice set the scanner tier
 * uses, so a barrier found here and the same barrier found by a scan share a
 * rule key and therefore a signature.
 */
export const DOCUMENT_COST_RULES: string[] = [
  'color-contrast', 'link-in-text-block', 'target-size', 'region',
];

/**
 * The document-cost set as two runs. The first three share axe's spatial grid
 * of the page, so they cost one grid build together; `region` walks the
 * document instead (methodology §4.1: ~75 ms vs ~145 ms on the 5,345-element
 * fixture). Two shorter tasks fit idle windows one long task does not.
 */
export const DOCUMENT_COST_PARTS: readonly { name: 'grid' | 'region'; rules: string[] }[] = [
  { name: 'grid', rules: ['color-contrast', 'link-in-text-block', 'target-size'] },
  { name: 'region', rules: ['region'] },
];

/**
 * Same cost shape, never run.
 *
 * `color-contrast-enhanced` is the AAA sibling of `color-contrast` (1.4.6). It
 * builds the same whole-page grid, and the scanner tier does not run it — so
 * running it here would cost the budget twice over *and* report a second
 * finding, under a rule key no other tier produces, for the one contrast defect
 * `color-contrast` already found. `runOnly: { type: 'rule' }` force-enables
 * whatever it is given regardless of a rule's own `enabled` flag, so the only
 * way not to run it is not to name it. It stays here so chunk runs keep it off
 * too, in case a future tag set would otherwise pull it in.
 */
export const DOCUMENT_COST_NEVER_RUN: string[] = ['color-contrast-enhanced'];

export const ELEMENT_TAGS: string[] = [
  'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice',
];

/** Everything a chunk run must not do: page-level, document-cost, and never-run. */
const DISABLED_IN_CHUNKS: Record<string, { enabled: false }> = {};
for (const rule of [...PAGE_LEVEL_RULES, ...DOCUMENT_COST_RULES, ...DOCUMENT_COST_NEVER_RUN]) {
  DISABLED_IN_CHUNKS[rule] = { enabled: false };
}

export interface RunResult {
  violations: AxeViolationLike[];
  ms: number;
}

function nowMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch {
    // fall through
  }
  return Date.now();
}

async function timed(run: () => Promise<AxeResultsLike>, clock?: () => number): Promise<RunResult> {
  const now = clock ?? nowMs;
  const started = now();
  try {
    const results = await run();
    return { violations: Array.isArray(results?.violations) ? results.violations : [], ms: now() - started };
  } catch {
    // A rule that throws inside axe must not stop the page or the engine.
    return { violations: [], ms: now() - started };
  }
}

/** Page-level rules, once per page, on the whole document. */
export function runPage(axe: AxeLike, doc: Document, clock?: () => number): Promise<RunResult> {
  return timed(() =>
    axe.run(doc, {
      runOnly: { type: 'rule', values: PAGE_LEVEL_RULES },
      resultTypes: ['violations'],
      elementRef: true,
      iframes: false,
    }),
    clock,
  );
}

/**
 * Some or all of the document-cost rules, on the whole document. See DOCUMENT_COST_PARTS.
 */
export function runDocumentCost(axe: AxeLike, doc: Document, rules: string[], clock?: () => number): Promise<RunResult> {
  return timed(() =>
    axe.run(doc, {
      runOnly: { type: 'rule', values: rules },
      resultTypes: ['violations'],
      elementRef: true,
      iframes: false,
    }),
    clock,
  );
}

/**
 * Element-level rules on one chunk, with the page-level and document-cost rules
 * turned off. A single element with nothing excluded is passed straight through
 * as the context; anything else goes in as `{ include }` — plus `exclude` when
 * the chunk is a container whose children are scanned by chunks of their own —
 * which axe scopes exactly the same way.
 */
export function runChunk(axe: AxeLike, chunk: Chunk, clock?: () => number): Promise<RunResult> {
  const excluded = chunk.exclude ?? [];
  const context: AxeContext =
    excluded.length > 0
      ? { include: [...chunk.include], exclude: [...excluded] }
      : chunk.include.length === 1
        ? chunk.include[0]!
        : { include: [...chunk.include] };
  return timed(() =>
    axe.run(context, {
      runOnly: { type: 'tag', values: ELEMENT_TAGS },
      rules: DISABLED_IN_CHUNKS,
      resultTypes: ['violations'],
      elementRef: true,
      iframes: false,
    }),
    clock,
  );
}

/**
 * The live element behind an axe node. `elementRef: true` puts it on
 * `node.element`; the CSS selector is only a fallback for hosts (or fakes)
 * that omit it. Anything that does not resolve to an `Element` is skipped —
 * a finding with no element has no signature.
 */
export function resolveNodeElement(doc: Document, node: AxeNodeLike): Element | null {
  try {
    if (node.element instanceof Element) return node.element;
    const selector = node.target?.[0];
    if (typeof selector !== 'string' || selector === '') return null;
    const found = doc.querySelector(selector);
    return found instanceof Element ? found : null;
  } catch {
    return null;
  }
}
