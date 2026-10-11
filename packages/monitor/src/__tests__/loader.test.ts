import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const loaderSrc = readFileSync(path.resolve(__dirname, '../../dist/loader.js'), 'utf8');

const SITE_KEY = 'acc_rum_' + 'a'.repeat(24);
const LOADER_SRC_URL = 'http://cdn.test/rum/loader.js';
const ENGINE_URL = 'http://cdn.test/rum/engine.js';
const CONFIG_URL = `http://cdn.test/api/rum/config?k=${SITE_KEY}`;

function makeScript(attrs: Record<string, string> = {}): HTMLScriptElement {
  const el = document.createElement('script');
  el.src = attrs.src ?? LOADER_SRC_URL;
  el.setAttribute('data-site-key', attrs['data-site-key'] ?? SITE_KEY);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'src' || k === 'data-site-key') continue;
    el.setAttribute(k, v);
  }
  return el;
}

function setCurrentScript(el: HTMLScriptElement | null) {
  Object.defineProperty(document, 'currentScript', { value: el, configurable: true });
}

function runLoader() {
  new Function(loaderSrc)();
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function okConfig(cfg: Record<string, unknown>) {
  return { ok: true, json: async () => cfg } as Response;
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
  sessionStorage.clear();
  document.head.innerHTML = '';
  delete (window as any).__accessibleRumLoaded;
  delete (window as any).__accessibleRum;
  (window as any).requestIdleCallback = (cb: () => void) => cb();
});

afterEach(() => {
  setCurrentScript(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collector loader', () => {
  it('fetches config from the endpoint with credentials omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: false, sampleRate: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(CONFIG_URL, { credentials: 'omit' });
  });

  it('injects the engine and records a sampled decision when sampleRate is 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: false, sampleRate: 1, boosted: [] })),
    );
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    const injected = document.head.querySelector(`script[src="${ENGINE_URL}"]`);
    expect(injected).not.toBeNull();
    expect((injected as HTMLScriptElement).async).toBe(true);

    const stored = JSON.parse(sessionStorage.getItem('a11y_rum')!);
    expect(stored.d).toBe(1);
    expect(stored.s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('records an unsampled decision and injects nothing when sampleRate is 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: false, sampleRate: 0, boosted: [] })),
    );
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    expect(document.head.querySelector('script[src]')).toBeNull();
    const stored = JSON.parse(sessionStorage.getItem('a11y_rum')!);
    expect(stored.d).toBe(0);
  });

  it('does not re-fetch config on a second load in the same session once unsampled', async () => {
    sessionStorage.setItem('a11y_rum', JSON.stringify({ s: 'f'.repeat(32), d: 0 }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.head.querySelector('script[src]')).toBeNull();
  });

  it('re-fetches config for a sampled session and honors a kill switch', async () => {
    sessionStorage.setItem('a11y_rum', JSON.stringify({ s: 'e'.repeat(32), d: 1 }));
    const fetchMock = vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: true, sampleRate: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.head.querySelector('script[src]')).toBeNull();
  });

  it('does nothing when data-disabled is present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setCurrentScript(makeScript({ 'data-disabled': '' }));

    runLoader();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.head.querySelector('script[src]')).toBeNull();
    expect(sessionStorage.getItem('a11y_rum')).toBeNull();
  });

  it('injects at sample rate 0 when ?a11y_debug=1 is present', async () => {
    window.history.pushState(null, '', '/?a11y_debug=1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: false, sampleRate: 0, boosted: [] })),
    );
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    const injected = document.head.querySelector(`script[src="${ENGINE_URL}"]`);
    expect(injected).not.toBeNull();
  });

  it('calls window.__accessibleRum.start with the expected options when the engine loads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: false, sampleRate: 1, boosted: [] })),
    );
    setCurrentScript(makeScript());

    runLoader();
    await flush();

    const injected = document.head.querySelector(`script[src="${ENGINE_URL}"]`) as HTMLScriptElement;
    expect(injected).not.toBeNull();

    const startMock = vi.fn();
    (window as any).__accessibleRum = { start: startMock, version: '0.2.0' };
    injected.dispatchEvent(new Event('load'));

    const stored = JSON.parse(sessionStorage.getItem('a11y_rum')!);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith({
      siteKey: SITE_KEY,
      endpoint: 'http://cdn.test',
      config: { enabled: true, killSwitch: false, sampleRate: 1, boosted: [] },
      sessionId: stored.s,
      debug: false,
    });
  });

  it('never throws into the host when fetch itself throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network stack unavailable');
      }),
    );
    setCurrentScript(makeScript());

    expect(() => runLoader()).not.toThrow();
    await flush();

    expect(document.head.querySelector('script[src]')).toBeNull();
  });
});
