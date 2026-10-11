import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachRageTab } from '../rage-tab';

function tab(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
}

function focusMoveTo(el: Element): void {
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

describe('attachRageTab', () => {
  let onFinding: ReturnType<typeof vi.fn>;
  let detach: () => void;
  let a: HTMLElement;
  let b: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="a" tabindex="0"></div><div id="b" tabindex="0"></div>';
    a = document.getElementById('a')!;
    b = document.getElementById('b')!;
    onFinding = vi.fn();
    detach = attachRageTab(document, window, onFinding).detach;
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it('emits rage-tab after 4 Tab presses within 2s with no focus change', () => {
    for (let i = 0; i < 4; i++) {
      tab();
      vi.advanceTimersByTime(400);
    }
    vi.advanceTimersByTime(250);
    expect(onFinding).toHaveBeenCalledTimes(1);
    expect(onFinding).toHaveBeenCalledWith({
      observer: 'rage-tab',
      wcag: '2.1.1',
      impact: 'serious',
      element: document.activeElement,
    });
  });

  it('does not emit when focus moves on every Tab press', () => {
    const targets = [a, b, a, b];
    for (const target of targets) {
      tab();
      focusMoveTo(target);
      vi.advanceTimersByTime(400);
    }
    vi.advanceTimersByTime(250);
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('emits exactly once when the window slides past an earlier moved tap', () => {
    // Tap 1 moves focus; the following 4 taps (within 2s) do not. Once the
    // 4-tap window has slid past the moved tap, it should still catch the
    // dead run and emit exactly once.
    tab();
    focusMoveTo(a);
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 4; i++) {
      tab();
      vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(250);
    expect(onFinding).toHaveBeenCalledTimes(1);
  });

  it('does not emit again for a second burst on the same element', () => {
    for (let i = 0; i < 4; i++) {
      tab();
      vi.advanceTimersByTime(400);
    }
    vi.advanceTimersByTime(250);
    expect(onFinding).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i++) {
      tab();
      vi.advanceTimersByTime(400);
    }
    vi.advanceTimersByTime(250);
    expect(onFinding).toHaveBeenCalledTimes(1);
  });
});
