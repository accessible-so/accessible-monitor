import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const loaderSrc = readFileSync(path.resolve(__dirname, '../../dist/loader.js'), 'utf8');

const SITE_KEY = 'acc_rum_' + 'a'.repeat(24);
const LOADER_SRC_URL = 'http://cdn.test/a11y/loader.js';
const ENGINE_URL = 'http://cdn.test/a11y/engine.js';
const CONFIG_URL = `http://cdn.test/api/a11y/config?k=${SITE_KEY}`;

function makeScript(attrs: Record<string, string> = {}): HTMLScriptElement {
  const el = document.createElement('script');
  el.src = attrs.src ?? LOADER_SRC_URL;
  el.setAttribute('data-site-key', attrs['data-site-key'] ?? SITE_KEY);
  if (!('data-endpoint' in attrs)) el.setAttribute('data-endpoint', 'http://cdn.test');
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'src' || k === 'data-site-key') continue;
    if (k === 'data-endpoint' && v === '') { el.removeAttribute(k); continue; } // '' leaves it off
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

describe('where the loader sends config and finds the engine', () => {
  const sampled = (cfg: Record<string, unknown> = {}) =>
    vi.fn().mockResolvedValue(okConfig({ enabled: true, killSwitch: false, sampleRate: 1, boosted: [], ...cfg }));
  const engineSrc = () => (document.head.querySelector('script[src]') as HTMLScriptElement | null)?.src;

  it('talks to https://app.accessible.so when data-endpoint is absent, wherever the loader is served from', async () => {
    const fetchMock = sampled();
    vi.stubGlobal('fetch', fetchMock);
    setCurrentScript(makeScript({ src: 'https://accessible.so/a11y/loader.js', 'data-endpoint': '' }));
    runLoader();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(`https://app.accessible.so/api/a11y/config?k=${SITE_KEY}`, { credentials: 'omit' });
  });

  it('served by Accessible, loads the engine version the app names', async () => {
    vi.stubGlobal('fetch', sampled({ minCollector: '0.5.0' }));
    setCurrentScript(makeScript({ src: 'https://accessible.so/a11y/loader.js' }));
    runLoader();
    await flush();
    expect(engineSrc()).toBe('https://accessible.so/a11y/0.5.0/engine.js');
  });

  it.each([undefined, '../x', '0.5', '0.5.0/../../evil'])('served by Accessible with minCollector %s, falls back to the sibling engine', async (v) => {
    vi.stubGlobal('fetch', sampled(v === undefined ? {} : { minCollector: v }));
    setCurrentScript(makeScript({ src: 'https://accessible.so/a11y/loader.js' }));
    runLoader();
    await flush();
    expect(engineSrc()).toBe('https://accessible.so/a11y/engine.js');
  });

  it('self-hosted, loads the engine next to the loader whatever version the app names', async () => {
    vi.stubGlobal('fetch', sampled({ minCollector: '0.5.0' }));
    setCurrentScript(makeScript({ src: 'https://cdn.customer.example/assets/loader.js' }));
    runLoader();
    await flush();
    expect(engineSrc()).toBe('https://cdn.customer.example/assets/engine.js');
  });

  it('data-engine wins over both', async () => {
    vi.stubGlobal('fetch', sampled({ minCollector: '0.5.0' }));
    setCurrentScript(makeScript({ src: 'https://accessible.so/a11y/loader.js', 'data-engine': 'https://cdn.customer.example/e.js' }));
    runLoader();
    await flush();
    expect(engineSrc()).toBe('https://cdn.customer.example/e.js');
  });
});
