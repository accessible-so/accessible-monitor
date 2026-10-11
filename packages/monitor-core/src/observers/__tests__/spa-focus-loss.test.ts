import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSpaFocusLoss } from '../spa-focus-loss';

function advanceTwoFrames(): void {
  vi.advanceTimersByTime(40);
}

describe('attachSpaFocusLoss', () => {
  let onFinding: ReturnType<typeof vi.fn>;
  let onRouteChange: ReturnType<typeof vi.fn>;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    onFinding = vi.fn();
    onRouteChange = vi.fn();
    detach = attachSpaFocusLoss(document, window, onFinding, onRouteChange).detach;
  });

  afterEach(() => {
    detach();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('emits spa-focus-loss when a pushState leaves focus on body', () => {
    expect(document.activeElement).toBe(document.body);
    history.pushState({}, '', '/next');
    advanceTwoFrames();
    expect(onFinding).toHaveBeenCalledTimes(1);
    expect(onFinding).toHaveBeenCalledWith({
      observer: 'spa-focus-loss',
      wcag: '2.4.3',
      impact: 'serious',
      element: document.body,
    });
  });

  it('reports element as <main> when one is present instead of body', () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    history.pushState({}, '', '/next');
    advanceTwoFrames();
    expect(onFinding).toHaveBeenCalledWith(expect.objectContaining({ element: main }));
  });

  it('does not emit when a heading is focused before the check runs', () => {
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    history.pushState({}, '', '/next');
    heading.focus();
    advanceTwoFrames();
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('calls onRouteChange exactly once per pushState transition', () => {
    history.pushState({}, '', '/next');
    advanceTwoFrames();
    expect(onRouteChange).toHaveBeenCalledTimes(1);
    expect(onRouteChange).toHaveBeenCalledWith('/next');
  });

  it('also triggers on replaceState', () => {
    history.replaceState({}, '', '/other');
    advanceTwoFrames();
    expect(onRouteChange).toHaveBeenCalledTimes(1);
    expect(onRouteChange).toHaveBeenCalledWith('/other');
    expect(onFinding).toHaveBeenCalledTimes(1);
  });

  it('also triggers on popstate', () => {
    window.dispatchEvent(new PopStateEvent('popstate'));
    advanceTwoFrames();
    expect(onRouteChange).toHaveBeenCalledTimes(1);
    expect(onFinding).toHaveBeenCalledTimes(1);
  });

  it('does not clobber a later wrapper installed after us, and that wrapper still calls through', () => {
    const ours = window.history.pushState;
    let secondScriptCalls = 0;
    const secondWrapper = function (this: History, ...args: Parameters<History['pushState']>) {
      secondScriptCalls++;
      return ours.apply(this, args);
    };
    window.history.pushState = secondWrapper;

    detach();

    expect(window.history.pushState).toBe(secondWrapper);

    window.history.pushState({}, '', '/via-second-script');
    expect(secondScriptCalls).toBe(1);
    expect(location.pathname).toBe('/via-second-script');
  });

  /**
   * The other half of leaving a later wrapper alone: that wrapper calls through
   * to our patch, so after `detach` our code still runs. A detached observer
   * that still reports would outlive the collector that owns it — the finding
   * would have nowhere to go and the route change nobody to tell.
   */
  it('reports nothing once detached, even when a later wrapper calls through', () => {
    const ours = window.history.pushState;
    window.history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      return ours.apply(this, args);
    };

    detach();

    window.history.pushState({}, '', '/after-detach');
    advanceTwoFrames();

    expect(location.pathname, 'the wrapper still navigated').toBe('/after-detach');
    expect(onRouteChange, 'a detached observer reported a route change').not.toHaveBeenCalled();
    expect(onFinding, 'a detached observer reported a finding').not.toHaveBeenCalled();
  });

  it('reports nothing when detach lands between the transition and the check', () => {
    history.pushState({}, '', '/next');
    detach();
    advanceTwoFrames();
    expect(onFinding).not.toHaveBeenCalled();
  });
});
