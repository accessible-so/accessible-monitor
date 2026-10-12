import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleGate, IDLE_QUIET_MS } from '../idle-gate';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}
function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { value: state, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  setReadyState('complete');
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
  setReadyState('complete');
  delete (navigator as unknown as Record<string, unknown>).scheduling;
});

describe('IdleGate', () => {
  it('opens after a second of quiet on a loaded, visible page', () => {
    const gate = IdleGate({ win: window, doc: document });
    expect(gate.isOpen()).toBe(false);
    vi.advanceTimersByTime(IDLE_QUIET_MS - 1);
    expect(gate.isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(gate.isOpen()).toBe(true);
    gate.detach();
  });

  it('treats an already-loaded page as loaded: the engine is injected after load', () => {
    setReadyState('complete');
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(gate.isOpen()).toBe(true);
    gate.detach();
  });

  it('waits for load on a page still loading', () => {
    setReadyState('loading');
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS * 3);
    expect(gate.isOpen()).toBe(false);
    setReadyState('complete');
    window.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(gate.isOpen()).toBe(true);
    gate.detach();
  });

  it.each(['keydown', 'wheel', 'touchstart', 'scroll'])('closes on %s and reopens after quiet', (type) => {
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(gate.isOpen()).toBe(true);
    document.dispatchEvent(new Event(type, { bubbles: true }));
    expect(gate.isOpen()).toBe(false);
    vi.advanceTimersByTime(IDLE_QUIET_MS - 1);
    expect(gate.isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(gate.isOpen()).toBe(true);
    gate.detach();
  });

  it('is closed while the page is hidden', () => {
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    setVisibility('hidden');
    expect(gate.isOpen()).toBe(false);
    gate.detach();
  });

  it('is closed while input is pending, where the browser can say so', () => {
    (navigator as unknown as Record<string, unknown>).scheduling = { isInputPending: () => true };
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(gate.isOpen()).toBe(false);
    gate.detach();
  });

  it('calls each waiter once, when the gate opens', () => {
    const gate = IdleGate({ win: window, doc: document });
    const cb = vi.fn();
    gate.whenOpen(cb);
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('keydown', { bubbles: true }));
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    gate.detach();
  });

  it('calls a waiter on the next tick when already open', () => {
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    const cb = vi.fn();
    gate.whenOpen(cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledTimes(1);
    gate.detach();
  });

  it('never throws into the host from a waiter, and leaves nothing attached after detach', () => {
    const gate = IdleGate({ win: window, doc: document });
    gate.whenOpen(() => { throw new Error('boom'); });
    expect(() => vi.advanceTimersByTime(IDLE_QUIET_MS)).not.toThrow();
    gate.detach();
    const cb = vi.fn();
    gate.whenOpen(cb);
    vi.advanceTimersByTime(IDLE_QUIET_MS * 2);
    expect(cb).not.toHaveBeenCalled();
    expect(gate.isOpen()).toBe(false);
  });

  it('restarts the quiet period when the page becomes visible after being hidden', () => {
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(gate.isOpen()).toBe(true);
    setVisibility('hidden');
    expect(gate.isOpen()).toBe(false);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    // After visibility change, the gate should be closed and waiting for a fresh quiet period
    expect(gate.isOpen()).toBe(false);
    vi.advanceTimersByTime(IDLE_QUIET_MS - 1);
    expect(gate.isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(gate.isOpen()).toBe(true);
    gate.detach();
  });

  it('calls a waiter once when registered while hidden, after the page becomes visible and a fresh quiet period passes', () => {
    const gate = IdleGate({ win: window, doc: document });
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    setVisibility('hidden');
    const cb = vi.fn();
    gate.whenOpen(cb);
    expect(cb).not.toHaveBeenCalled();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    // The visibility change restarts the quiet period, but the waiter is not called yet
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDLE_QUIET_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    gate.detach();
  });

  it('does not open the gate or call waiters after detach, even when timers advance past the quiet period', () => {
    const gate = IdleGate({ win: window, doc: document });
    const cb = vi.fn();
    gate.whenOpen(cb);
    // Detach while the timer is still pending
    gate.detach();
    vi.advanceTimersByTime(IDLE_QUIET_MS * 2);
    expect(gate.isOpen()).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  describe('a pressed pointer', () => {
    const press = (): void => { document.dispatchEvent(new Event('pointerdown', { bubbles: true })); };

    it('keeps the gate closed for as long as the press is held', () => {
      const gate = IdleGate({ win: window, doc: document });
      vi.advanceTimersByTime(IDLE_QUIET_MS);
      press();
      vi.advanceTimersByTime(3000);
      expect(gate.isOpen()).toBe(false);
      gate.detach();
    });

    it.each(['pointerup', 'pointercancel'])('opens a full quiet period after %s, not before', (type) => {
      const gate = IdleGate({ win: window, doc: document });
      press();
      vi.advanceTimersByTime(3000);
      document.dispatchEvent(new Event(type, { bubbles: true }));
      vi.advanceTimersByTime(IDLE_QUIET_MS - 1);
      expect(gate.isOpen()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(gate.isOpen()).toBe(true);
      gate.detach();
    });

    it('is cleared by window blur, so a lost release cannot stick', () => {
      const gate = IdleGate({ win: window, doc: document });
      press();
      window.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(IDLE_QUIET_MS);
      expect(gate.isOpen()).toBe(true);
      gate.detach();
    });

    it('is not cleared by an element losing focus, which is what a press usually causes', () => {
      document.body.innerHTML = '<input id="field"><button id="target">drag me</button>';
      document.getElementById('field')!.focus();
      const gate = IdleGate({ win: window, doc: document });
      press();
      // The press moves focus: the field blurs. That is not the window losing focus.
      document.getElementById('target')!.focus();
      vi.advanceTimersByTime(3000);
      expect(gate.isOpen(), 'an element blur released the press mid-drag').toBe(false);
      gate.detach();
      document.body.innerHTML = '';
    });

    it('is cleared when the page is hidden', () => {
      const gate = IdleGate({ win: window, doc: document });
      press();
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(IDLE_QUIET_MS);
      expect(gate.isOpen()).toBe(true);
      gate.detach();
    });
  });
});
