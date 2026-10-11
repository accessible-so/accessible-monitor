import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationModeTracker } from '../navigation-mode';

function tabKeydown() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
}

function focusIn(target: Element) {
  target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

function pointerDown(target: Element) {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="b0"></button><button id="b1"></button>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NavigationModeTracker', () => {
  it('reports keyboard-driven after 5 key-then-focus moves with no pointer activity', () => {
    const tracker = NavigationModeTracker(document);
    const els = Array.from({ length: 6 }, (_, i) => {
      const div = document.createElement('div');
      div.tabIndex = 0;
      document.body.appendChild(div);
      return div;
    });
    for (let i = 0; i < 5; i++) {
      tabKeydown();
      vi.advanceTimersByTime(20);
      focusIn(els[i + 1]!);
      vi.advanceTimersByTime(20);
    }
    expect(tracker.mode()).toBe('keyboard-driven');
    tracker.detach();
  });

  it('reports pointer-driven after pointer interactions on an interactive element with no key nav', () => {
    const tracker = NavigationModeTracker(document);
    const button = document.getElementById('b0')!;
    pointerDown(button);
    pointerDown(button);
    pointerDown(button);
    expect(tracker.mode()).toBe('pointer-driven');
    tracker.detach();
  });

  it('reports mixed when both keyboard focus moves and pointer interactions occur', () => {
    const tracker = NavigationModeTracker(document);
    const els = Array.from({ length: 6 }, () => {
      const div = document.createElement('div');
      div.tabIndex = 0;
      document.body.appendChild(div);
      return div;
    });
    for (let i = 0; i < 5; i++) {
      tabKeydown();
      vi.advanceTimersByTime(20);
      focusIn(els[i + 1]!);
      vi.advanceTimersByTime(20);
    }
    const button = document.getElementById('b0')!;
    pointerDown(button);
    pointerDown(button);
    pointerDown(button);
    expect(tracker.mode()).toBe('mixed');
    tracker.detach();
  });

  it('reports unknown when nothing has happened', () => {
    const tracker = NavigationModeTracker(document);
    expect(tracker.mode()).toBe('unknown');
    tracker.detach();
  });

  it('does not count a Tab keydown as a focus move when focus does not change', () => {
    const tracker = NavigationModeTracker(document);
    const button = document.getElementById('b0')!;
    for (let i = 0; i < 5; i++) {
      tabKeydown();
      vi.advanceTimersByTime(20);
      focusIn(button);
      vi.advanceTimersByTime(20);
    }
    expect(tracker.mode()).toBe('unknown');
    tracker.detach();
  });
});
