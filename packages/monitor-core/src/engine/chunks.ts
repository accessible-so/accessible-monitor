/**
 * Splitting a subtree into scan-sized chunks.
 *
 * A chunk is a group of *sibling* elements, not a single element, and that
 * matters more than it looks. Every `axe.run` costs a fixed amount before it
 * looks at anything — 13-20ms on a 5,000-element page, because axe rebuilds its
 * view of the document each time — so splitting is worth doing only to keep one
 * run inside the time budget, never for its own sake. A splitter that recursed
 * all the way to individual list items turned one 5,000-element page into 498
 * runs of 20ms: no single run was over budget, and the page still gave up
 * against the per-page scan ceiling having scanned two-fifths of itself.
 *
 * So: descend only into a subtree too big to scan on its own, and pack whatever
 * fits back into groups of at most `maxElements`. Splitting is by element
 * *count* only — never by geometry or content — so it stays cheap and
 * deterministic.
 *
 * Descending has a cost that is easy to miss: the container that was descended
 * into is not in any of the groups, because those groups are its *children*. A
 * `<select>` with 500 options used to vanish from the scan entirely — the
 * options were covered, the `<select>` itself never was, and the rules that are
 * *about* a container (`list`, the table rules, `aria-required-children`) were
 * therefore never asked. So a container that is split gets a chunk of its own
 * with its children excluded: scanned exactly once, and nothing under it
 * scanned twice. That is what the `exclude` field is for, and it is the only
 * thing it is for. Excluding the children does not blind those rules — axe
 * builds its view of the document first and the context only decides which
 * nodes rules *run on* — so a `<ul>` with a stray `<div>` in it still reports
 * `list` from a chunk that excludes every child.
 */

/** Descendant elements of `root`, not counting `root` itself. */
export function countElements(root: Element): number {
  try {
    return root.getElementsByTagName('*').length;
  } catch {
    return 0;
  }
}

/** What one element costs a chunk: itself plus everything under it. */
function sizeOf(el: Element): number {
  return countElements(el) + 1;
}

/**
 * How much bigger than one chunk a container's subtree may be before its own
 * chunk stops being worth what it costs.
 *
 * An excluded element is not free: axe still walks the whole included subtree
 * and decides, node by node, what is in context. Measured on the 5,300-element
 * fixture, a container chunk that excludes everything under it costs about a
 * third of what including those elements would — 31 ms over a 443-element
 * subtree, 50 ms at ~1,800, 109 ms at 5,316 — against 26 ms for an ordinary
 * 400-element chunk. Three times the chunk budget is therefore the point at
 * which a container run costs about what a chunk run costs, and it moves with
 * the budget: when the scheduler halves `maxElements`, this halves too.
 *
 * A container over that ceiling is left unscanned, exactly as every container
 * was before. That is a narrower gap than the one it replaces, not a new one.
 */
const CONTAINER_COST_RATIO = 3;

/**
 * One `axe.run`'s worth of work: the elements to scan, and — for a container
 * whose children are covered by chunks of their own — the elements not to.
 */
export interface Chunk {
  include: Element[];
  exclude?: Element[];
}

/**
 * Chunks covering `root` and everything under it, each holding at most
 * `maxElements` elements wherever that is possible. A subtree with no element
 * children is always returned whole: there is nothing left to split, so an
 * oversized leaf is scanned as-is rather than dropped.
 *
 * When `root` is split, the first chunk is `root` itself with its children
 * excluded — see the note at the top of this file.
 */
export function splitIntoChunks(root: Element, maxElements: number): Chunk[] {
  if (countElements(root) <= maxElements) return [{ include: [root] }];
  const children = Array.from(root.children);
  if (children.length === 0) return [{ include: [root] }];

  const out: Chunk[] = [];
  let group: Element[] = [];
  let size = 0;
  const flush = (): void => {
    if (group.length > 0) out.push({ include: group });
    group = [];
    size = 0;
  };

  for (const child of children) {
    const cost = sizeOf(child);
    if (cost > maxElements) {
      // Too big to sit in any group: split it on its own terms.
      flush();
      for (const chunk of splitIntoChunks(child, maxElements)) out.push(chunk);
      continue;
    }
    if (size + cost > maxElements) flush();
    group.push(child);
    size += cost;
  }
  flush();
  if (out.length === 0) return [{ include: [root] }];
  // Every chunk above covers a *child* of `root`, so `root` itself is covered
  // by none of them. It gets one chunk, holding exactly one element — as long
  // as skipping past its subtree still fits the budget.
  if (countElements(root) <= maxElements * CONTAINER_COST_RATIO) {
    out.unshift({ include: [root], exclude: children });
  }
  return out;
}
