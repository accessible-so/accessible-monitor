import { afterEach, describe, expect, it, vi } from 'vitest';
import { coalesceRoots, DirtyTracker } from '../dirty';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('coalesceRoots', () => {
  it('absorbs descendants into their ancestor root', () => {
    document.body.innerHTML = '<main><ul><li id="li"></li></ul></main>';
    const main = document.querySelector('main')!;
    const ul = document.querySelector('ul')!;
    const li = document.querySelector('#li')!;
    expect(coalesceRoots([li, ul, main], 20, document.body)).toEqual([main]);
  });

  it('keeps unrelated roots side by side', () => {
    document.body.innerHTML = '<main></main><aside></aside>';
    const main = document.querySelector('main')!;
    const aside = document.querySelector('aside')!;
    expect(coalesceRoots([main, aside], 20, document.body)).toEqual([main, aside]);
  });

  it('falls back to the single fallback root once the cap is exceeded', () => {
    for (let i = 0; i < 25; i++) document.body.appendChild(document.createElement('section'));
    const roots = Array.from(document.body.children);
    expect(coalesceRoots(roots, 20, document.body)).toEqual([document.body]);
  });

  it('ignores detached nodes', () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    const detached = document.createElement('div');
    expect(coalesceRoots([detached, main], 20, document.body)).toEqual([main]);
    expect(coalesceRoots([detached], 20, document.body)).toEqual([]);
  });

  it('de-duplicates the same root reported twice', () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    expect(coalesceRoots([main, main], 20, document.body)).toEqual([main]);
  });

  /**
   * The old implementation was quadratic — `includes` for the dedupe and
   * `some(contains)` for the coverage test — so a page that mutated thousands
   * of distinct elements in one debounce window paid 25 million DOM calls to
   * decide something the cap answers in one line. The assertion is on the
   * answer; the test's own timeout is what would catch a return to O(n²).
   */
  it('collapses 5,000 distinct roots to the fallback without a quadratic scan', () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    for (let i = 0; i < 5000; i++) main.appendChild(document.createElement('section'));
    const roots = Array.from(main.children);

    expect(coalesceRoots(roots, 20, main)).toEqual([main]);
    // Under the cap the same 5,000-element document still resolves normally.
    expect(coalesceRoots(roots.slice(0, 5), 20, main)).toEqual(roots.slice(0, 5));
  }, 5000);
});

describe('DirtyTracker', () => {
  it('debounces mutations into one coalesced batch', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><ul></ul></main>';
    const main = document.querySelector('main')!;
    const batches: Element[][] = [];
    const tracker = DirtyTracker(document, (roots) => batches.push(roots), { debounceMs: 10, cap: 20 });

    document.querySelector('ul')!.appendChild(document.createElement('li'));
    main.appendChild(document.createElement('p'));
    await Promise.resolve();
    await Promise.resolve();
    expect(batches).toEqual([]);

    vi.advanceTimersByTime(10);
    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual([main]);

    tracker.detach();
    main.appendChild(document.createElement('p'));
    await Promise.resolve();
    vi.advanceTimersByTime(50);
    expect(batches.length).toBe(1);
  });

  it('reports attribute mutations on the element itself', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><button id="b"></button></main>';
    const batches: Element[][] = [];
    const tracker = DirtyTracker(document, (roots) => batches.push(roots), { debounceMs: 5 });

    document.querySelector('#b')!.setAttribute('aria-expanded', 'true');
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(5);

    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual([document.querySelector('#b')!]);
    tracker.detach();
  });

  it('stops collecting past ten times the cap and falls back to one root', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    const targets: Element[] = [];
    for (let i = 0; i < 5000; i++) {
      const el = document.createElement('section');
      main.appendChild(el);
      targets.push(el);
    }
    const batches: Element[][] = [];
    const tracker = DirtyTracker(document, (roots) => batches.push(roots), { debounceMs: 10, cap: 20 });

    // 5,000 records on 5,000 distinct elements: far past the point at which
    // the answer can be anything but the fallback root.
    for (const el of targets) el.setAttribute('aria-expanded', 'true');
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(10);

    expect(batches).toEqual([[main]]);
    tracker.detach();
  }, 20_000);

  it('never throws out of the observer callback', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main></main>';
    const tracker = DirtyTracker(document, () => { throw new Error('boom'); }, { debounceMs: 1 });
    document.querySelector('main')!.appendChild(document.createElement('p'));
    await Promise.resolve();
    await Promise.resolve();
    expect(() => vi.advanceTimersByTime(1)).not.toThrow();
    tracker.detach();
  });
});
