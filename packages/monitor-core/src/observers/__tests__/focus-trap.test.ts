import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFocusTrap } from '../focus-trap';

function tab(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
}

function escape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function focusMoveTo(el: Element): void {
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

describe('attachFocusTrap', () => {
  let onFinding: ReturnType<typeof vi.fn>;
  let detach: () => void;
  let dialog: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="dialog"></div><div id="outside" tabindex="0"></div>';
    dialog = document.getElementById('dialog')!;
    onFinding = vi.fn();
    detach = attachFocusTrap(document, window, onFinding).detach;
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it('emits focus-trap when 8 Tab presses cycle among 3 elements inside a dialog', () => {
    const els = [0, 1, 2].map((i) => {
      const el = document.createElement('div');
      el.tabIndex = 0;
      el.id = `t${i}`;
      dialog.appendChild(el);
      return el;
    });
    const order = [0, 1, 2, 0, 1, 2, 0, 1];
    for (const idx of order) {
      tab();
      vi.advanceTimersByTime(20);
      focusMoveTo(els[idx]!);
      vi.advanceTimersByTime(20);
    }
    expect(onFinding).toHaveBeenCalledTimes(1);
    const call = onFinding.mock.calls[0]![0];
    expect(call.observer).toBe('focus-trap');
    expect(call.wcag).toBe('2.1.2');
    expect(call.impact).toBe('critical');
    expect(call.element).toBe(dialog);
  });

  it('does not emit when 8 Tab presses land on 8 distinct elements', () => {
    const els = Array.from({ length: 8 }, (_, i) => {
      const el = document.createElement('div');
      el.tabIndex = 0;
      el.id = `d${i}`;
      dialog.appendChild(el);
      return el;
    });
    for (const el of els) {
      tab();
      vi.advanceTimersByTime(20);
      focusMoveTo(el);
      vi.advanceTimersByTime(20);
    }
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('does not emit when Escape is pressed and focus moves outside before the window fills', () => {
    // 7 taps cycling 2 dialog elements (distinct=2, one short of the 8-entry
    // window). Without an Escape reset, one more tap onto "outside" would
    // complete an 8-entry window with distinct=3 and wrongly emit.
    const els = [0, 1].map((i) => {
      const el = document.createElement('div');
      el.tabIndex = 0;
      el.id = `e${i}`;
      dialog.appendChild(el);
      return el;
    });
    const outside = document.getElementById('outside')!;
    const order = [0, 1, 0, 1, 0, 1, 0];
    for (const idx of order) {
      tab();
      vi.advanceTimersByTime(20);
      focusMoveTo(els[idx]!);
      vi.advanceTimersByTime(20);
    }
    escape();
    tab();
    vi.advanceTimersByTime(20);
    focusMoveTo(outside);
    vi.advanceTimersByTime(20);
    expect(onFinding).not.toHaveBeenCalled();
  });
});
