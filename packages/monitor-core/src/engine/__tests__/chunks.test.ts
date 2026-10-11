import { describe, expect, it } from 'vitest';
import { countElements, splitIntoChunks, type Chunk } from '../chunks';
import { runChunk } from '../axe-runner';
import type { AxeContext, AxeLike, AxeResultsLike } from '../axe-runner';

function build(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('countElements', () => {
  it('counts every descendant element, not the root itself', () => {
    const root = build('<p><span></span></p>');
    expect(countElements(root)).toBe(2);
  });

  it('is zero for an element with no element children', () => {
    expect(countElements(build('<p>text</p>').firstElementChild!)).toBe(0);
  });
});

/**
 * Elements a chunk actually covers: everything under what it includes, less
 * everything under what it excludes. A container chunk covers exactly one.
 */
const sizeOf = (chunk: Chunk): number => {
  const total = (els: Element[]): number => els.reduce((n, el) => n + countElements(el) + 1, 0);
  return total(chunk.include) - total(chunk.exclude ?? []);
};

/** The elements a chunk names, for identity assertions. */
const included = (chunks: Chunk[]): Element[] => chunks.flatMap((c) => c.include);

describe('splitIntoChunks', () => {
  it('returns the root itself when it is under the max', () => {
    const root = build('<p><span></span></p>');
    expect(splitIntoChunks(root, 400)).toEqual([{ include: [root] }]);
  });

  it('splits a 1,000-element root into chunks that are each at most 400', () => {
    const root = document.createElement('div');
    for (let i = 0; i < 10; i++) {
      const section = document.createElement('section');
      for (let j = 0; j < 99; j++) section.appendChild(document.createElement('span'));
      root.appendChild(section);
    }
    expect(countElements(root)).toBe(1000);

    const chunks = splitIntoChunks(root, 400);
    // Sections are 100 elements each, so four fit in a chunk: 4 + 4 + 2 — plus
    // the chunk that covers the root itself, which nothing else does.
    expect(chunks.length).toBe(4);
    for (const chunk of chunks) expect(sizeOf(chunk)).toBeLessThanOrEqual(400);

    const container = chunks[0]!;
    expect(container.include).toEqual([root]);
    expect(container.exclude).toEqual(Array.from(root.children));
    expect(sizeOf(container), 'the container chunk covers only the container').toBe(1);

    // Nothing is lost and nothing is scanned twice.
    const sections = chunks.slice(1).flatMap((c) => c.include);
    expect(sections).toHaveLength(10);
    expect(new Set(sections).size).toBe(10);
    expect(sections).not.toContain(root);
  });

  it('packs small siblings together rather than scanning each on its own', () => {
    // The case that mattered in the browser: a list a little over the max
    // exploding into one chunk per item, each paying axe's fixed per-run cost.
    const root = document.createElement('div');
    const list = document.createElement('ul');
    for (let i = 0; i < 40; i++) {
      const item = document.createElement('li');
      for (let j = 0; j < 10; j++) item.appendChild(document.createElement('span'));
      list.appendChild(item);
    }
    root.appendChild(list);
    expect(countElements(root)).toBe(441);

    const chunks = splitIntoChunks(root, 400);
    // Two container chunks (the root, then the list it descended into) and the
    // 40 items packed into two groups: 36 of 11 elements, then 4.
    expect(chunks.map((c) => c.include.length)).toEqual([1, 1, 36, 4]);
    expect(chunks[0]!.include).toEqual([root]);
    expect(chunks[1]!.include).toEqual([list]);
    for (const chunk of chunks) expect(sizeOf(chunk)).toBeLessThanOrEqual(400);
  });

  /**
   * The bug this exists for: a container that chunking descends into used to be
   * covered by nothing at all. A `<select>` with 500 options had every option
   * scanned and the `<select>` itself — the element every select-shaped rule is
   * actually about — scanned never.
   */
  it('scans a container it descended into, with its children excluded', () => {
    const host = document.createElement('div');
    const select = document.createElement('select');
    for (let i = 0; i < 500; i++) select.appendChild(document.createElement('option'));
    host.appendChild(select);

    const chunks = splitIntoChunks(host, 400);
    const options = Array.from(select.children);

    expect(chunks[0]).toEqual({ include: [host], exclude: [select] });
    expect(chunks[1]).toEqual({ include: [select], exclude: options });
    // The options are still covered, in groups, and each option appears once.
    const grouped = chunks.slice(2).flatMap((c) => c.include);
    expect(grouped).toHaveLength(500);
    expect(new Set(grouped).size).toBe(500);
    for (const chunk of chunks.slice(2)) expect(chunk.exclude).toBeUndefined();

    // Every element in the subtree is covered exactly once across all chunks.
    const covered = new Map<Element, number>();
    for (const chunk of chunks) {
      const excluded = new Set<Element>();
      for (const el of chunk.exclude ?? []) {
        excluded.add(el);
        for (const d of Array.from(el.getElementsByTagName('*'))) excluded.add(d);
      }
      for (const el of chunk.include) {
        for (const node of [el, ...Array.from(el.getElementsByTagName('*'))]) {
          if (excluded.has(node)) continue;
          covered.set(node, (covered.get(node) ?? 0) + 1);
        }
      }
    }
    expect(covered.get(select), 'the container was scanned once').toBe(1);
    expect(covered.get(host)).toBe(1);
    expect([...covered.values()].filter((n) => n !== 1), 'an element covered twice').toEqual([]);
    expect(covered.size).toBe(502);
  });

  it('recurses until every chunk fits, through a deep single-child chain', () => {
    const root = document.createElement('div');
    let tip: HTMLElement = root;
    for (let i = 0; i < 12; i++) {
      const next = document.createElement('div');
      for (let j = 0; j < 4; j++) next.appendChild(document.createElement('span'));
      tip.appendChild(next);
      tip = next;
    }
    const chunks = splitIntoChunks(root, 10);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(sizeOf(chunk)).toBeLessThanOrEqual(10);
    // The deeper levels are small enough to afford a container chunk; the top
    // of the chain is more than three times the budget, so it goes without one
    // rather than pay for a walk of the whole subtree.
    const containers = chunks.filter((c) => c.exclude !== undefined).flatMap((c) => c.include);
    expect(containers.length).toBeGreaterThan(0);
    expect(containers).not.toContain(root);
    expect(included(chunks)).not.toContain(root);
  });

  /**
   * A container chunk is not free — axe walks the excluded subtree to decide
   * what is in context — so a container far bigger than one chunk does without
   * one, which is where every container stood before this existed.
   */
  it('leaves a container far bigger than the budget without a chunk of its own', () => {
    const root = document.createElement('div');
    for (let i = 0; i < 20; i++) {
      const section = document.createElement('section');
      for (let j = 0; j < 99; j++) section.appendChild(document.createElement('span'));
      root.appendChild(section);
    }
    expect(countElements(root)).toBe(2000);

    // 2,000 descendants against a 400-element budget: over three times.
    expect(splitIntoChunks(root, 400).some((c) => c.include.includes(root))).toBe(false);
    // Raise the budget past a third of the subtree and it is covered again.
    expect(splitIntoChunks(root, 700)[0]).toEqual({ include: [root], exclude: Array.from(root.children) });
  });

  it('makes an element with no element children its own chunk even when it cannot fit', () => {
    const leaf = build('<p>text</p>').firstElementChild!;
    // max -1 forces the count check to fail: the leaf is still returned whole
    // rather than dropped, because there is nothing left to split.
    expect(splitIntoChunks(leaf, -1)).toEqual([{ include: [leaf] }]);
  });
});

describe('runChunk contexts', () => {
  function fakeAxe(): AxeLike & { contexts: AxeContext[] } {
    const contexts: AxeContext[] = [];
    return {
      contexts,
      run(context: AxeContext): Promise<AxeResultsLike> {
        contexts.push(context);
        return Promise.resolve({ violations: [] });
      },
    };
  }

  it('hands axe the container and its exclusions, not just a bare element', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<p></p><p></p>';
    const kids = Array.from(host.children);
    const axe = fakeAxe();

    await runChunk(axe, { include: [host], exclude: kids });

    expect(axe.contexts[0], 'the container context was not run').toEqual({
      include: [host],
      exclude: kids,
    });
  });

  it('still passes a lone element straight through when nothing is excluded', async () => {
    const el = document.createElement('div');
    const axe = fakeAxe();
    await runChunk(axe, { include: [el] });
    expect(axe.contexts[0]).toBe(el);
    await runChunk(axe, { include: [el], exclude: [] });
    expect(axe.contexts[1], 'an empty exclude list is not an exclusion').toBe(el);
  });
});
