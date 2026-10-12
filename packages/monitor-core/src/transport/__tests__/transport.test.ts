import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RumContext, RumFinding } from '../../protocol/types';
import { Transport } from '../index';

const ctx: RumContext = { vw: 1280, vh: 800, dpr: 1, zoom: 1, fontPx: 16, navigationMode: 'unknown' };

function makeFinding(over: Partial<RumFinding> = {}): RumFinding {
  return {
    sig: 's1:' + '0'.repeat(32),
    key: null,
    rule: 'wcag:1.1.1',
    confidence: 'rule',
    impact: 'serious',
    wcag: ['1.1.1'],
    p: '/home',
    r: null,
    el: { tag: 'img', attrs: {}, text: null },
    comp: null,
    n: 1,
    i: false,
    ...over,
  };
}

function harness(opts: Partial<Parameters<typeof Transport>[0]> = {}) {
  const bodies: any[] = [];
  const send = vi.fn((_url: string, body: string) => { bodies.push(JSON.parse(body)); return true; });
  const t = Transport({ endpoint: 'https://x.test', siteKey: 'site1', sessionId: 'sess1', version: 'v1', ctx: () => ctx, send, ...opts });
  return { t, bodies, send };
}

const originalSendBeacon = (navigator as any).sendBeacon;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (navigator as any).sendBeacon = originalSendBeacon;
});

describe('Transport', () => {
  it('reports whether the batch went out, so a caller can retry before teardown', () => {
    let ok = true;
    const bodies: string[] = [];
    const t = Transport({
      endpoint: 'https://x.test', siteKey: 'site1', sessionId: 'sess1', version: 'v1', ctx: () => ctx,
      send: (_url, body) => { if (ok) bodies.push(body); return ok; },
    });

    // Nothing queued: true, and nothing sent.
    expect(t.flush('hidden')).toBe(true);
    expect(bodies).toHaveLength(0);

    // Sent: true.
    t.queueRoute('/a', null);
    expect(t.flush('hidden')).toBe(true);
    expect(bodies).toHaveLength(1);

    // Failed with the batch still held for one retry: false.
    ok = false;
    t.queueRoute('/b', null);
    expect(t.flush('hidden')).toBe(false);
    expect(bodies).toHaveLength(1);

    // The retry succeeds and carries the same batch.
    ok = true;
    expect(t.flush('hidden-retry')).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]!).routes).toEqual([{ p: '/b', r: null }]);

    // A second consecutive failure drops the batch and still reports false.
    ok = false;
    t.queueRoute('/c', null);
    expect(t.flush('hidden')).toBe(false);
    expect(t.flush('hidden-retry')).toBe(false);
    expect(t.flush('again')).toBe(true);
    t.detach();
  });

  it('reads the perf supplier on every beacon, including a batch-full flush', () => {
    let scans = 0;
    const { t, bodies } = harness({
      maxFindings: 2,
      flushIntervalMs: 1000,
      perf: () => ({ scans: ++scans, longTasks: 1, maxTaskMs: 61, aborted: false }),
    });

    // A batch-full flush is triggered by the transport itself: nobody is
    // there to call setPerf first, so the supplier has to carry it.
    t.queueFinding(makeFinding());
    t.queueFinding(makeFinding({ sig: 's1:' + '1'.repeat(32) }));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].perf).toEqual({ scans: 1, longTasks: 1, maxTaskMs: 61, aborted: false });

    // And on the interval flush, with fresh numbers each time.
    t.queueRoute('/a', null);
    vi.advanceTimersByTime(1000);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].perf).toEqual({ scans: 2, longTasks: 1, maxTaskMs: 61, aborted: false });
    t.detach();
  });

  it('prefers an explicit setPerf over the supplier, and never throws when the supplier does', () => {
    const { t, bodies } = harness({ perf: () => { throw new Error('boom'); } });
    t.queueRoute('/a', null);
    expect(() => t.flush('hidden')).not.toThrow();
    expect(bodies[0].perf).toBeUndefined();

    t.setPerf({ scans: 9, longTasks: 0, maxTaskMs: 3, aborted: false });
    t.queueRoute('/b', null);
    t.flush('hidden');
    expect(bodies[1].perf).toEqual({ scans: 9, longTasks: 0, maxTaskMs: 3, aborted: false });
    t.detach();
  });

  it('sends a queued finding on flush with the beacon envelope and the finding unchanged', () => {
    const { t, bodies } = harness();
    const f = makeFinding();
    t.queueFinding(f);
    t.flush('hidden');
    expect(bodies).toHaveLength(1);
    const b = bodies[0];
    expect(b).toMatchObject({ v: 1, k: 'site1', s: 'sess1', c: 'v1', ctx });
    expect(b.findings[0]).toEqual(f);
  });

  it('sends session:{started:true} once, on the next beacon after markSessionStart', () => {
    const { t, bodies } = harness();
    t.markSessionStart();
    t.queueRoute('/a', null);
    t.flush('hidden');
    expect(bodies[0].session).toEqual({ started: true });
    t.queueRoute('/b', null);
    t.flush('hidden');
    expect(bodies[1].session).toBeUndefined();
  });

  it('auto-flushes once 50 findings are queued', () => {
    const { t, bodies } = harness();
    for (let i = 0; i < 50; i++) t.queueFinding(makeFinding({ sig: 's1:' + String(i).padStart(32, '0') }));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].findings).toHaveLength(50);
  });

  it('splits an over-budget payload and sends the overflow on the next flush, in order', () => {
    const { t, bodies } = harness({ maxBytes: 2048 });
    const findings = Array.from({ length: 6 }, (_, i) =>
      makeFinding({ sig: 's1:' + String(i).padStart(32, '0'), key: 'k'.repeat(400) }));
    findings.forEach((f) => t.queueFinding(f));
    t.flush('hidden');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].findings.length).toBeGreaterThan(0);
    expect(bodies[0].findings.length).toBeLessThan(6);
    t.flush('hidden');
    expect(bodies).toHaveLength(2);
    const sent = [...bodies[0].findings, ...bodies[1].findings].map((f: RumFinding) => f.sig);
    expect(sent).toEqual(findings.map((f) => f.sig));
  });

  it('retries a failed send exactly once, then drops the batch', () => {
    const send = vi.fn(() => false);
    const t = Transport({ endpoint: 'https://x.test', siteKey: 'site1', sessionId: 'sess1', version: 'v1', ctx: () => ctx, send });
    t.queueFinding(makeFinding());
    t.flush('hidden');
    expect(send).toHaveBeenCalledTimes(1);
    t.flush('hidden');
    expect(send).toHaveBeenCalledTimes(2);
    t.flush('hidden');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('dedupes identical (p, r) pairs queued via queueRoute', () => {
    const { t, bodies } = harness();
    t.queueRoute('/a', 'route:a');
    t.queueRoute('/a', 'route:a');
    t.queueRoute('/b', null);
    t.flush('hidden');
    expect(bodies[0].routes).toEqual([{ p: '/a', r: 'route:a' }, { p: '/b', r: null }]);
  });

  it('never resends a route already flushed once, for the life of the transport instance', () => {
    const { t, bodies, send } = harness();
    t.queueRoute('/a', null);
    t.flush('x');
    t.queueRoute('/a', null);
    t.flush('y');
    expect(send).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(1);

    t.queueRoute('/a', null);
    t.queueRoute('/b', null);
    t.flush('z');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].routes).toEqual([{ p: '/b', r: null }]);
  });

  it('never resends an interaction already flushed once, for the life of the transport instance', () => {
    const { t, bodies, send } = harness();
    const sig = 's1:' + '0'.repeat(32);
    t.queueInteraction(sig, null);
    t.flush('x');
    t.queueInteraction(sig, null);
    t.flush('y');
    expect(send).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(1);

    const sig2 = 's1:' + '1'.repeat(32);
    t.queueInteraction(sig, null);
    t.queueInteraction(sig2, null);
    t.flush('z');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].interactions).toEqual([{ sig: sig2, r: null }]);
  });

  it('uses navigator.sendBeacon by default, posting a text/plain blob to the ingest URL', () => {
    const beaconSpy = vi.fn((_url: string, _data?: BodyInit | null) => true);
    (navigator as any).sendBeacon = beaconSpy;
    const t = Transport({ endpoint: 'https://x.test', siteKey: 'site1', sessionId: 'sess1', version: 'v1', ctx: () => ctx });
    t.queueRoute('/a', null);
    t.flush('hidden');
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, blob] = beaconSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://x.test/api/a11y/ingest');
    expect(blob).toBeInstanceOf(Blob);
    // `text/plain` keeps the beacon a CORS-safelisted simple request: no
    // preflight, and no dependence on the ingest endpoint echoing `Origin`.
    // The body is still JSON; only the declared type is not. See the comment
    // on BEACON_CONTENT_TYPE in ../index.ts.
    expect((blob as Blob).type).toBe('text/plain;charset=utf-8');
    t.detach();
  });

  it('falls back to fetch with keepalive when sendBeacon refuses the beacon', () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => false);
    (navigator as any).sendBeacon = beacon;
    const doFetch = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve({} as Response));
    vi.stubGlobal('fetch', doFetch);

    const t = Transport({ endpoint: 'https://x.test', siteKey: 'site1', sessionId: 'sess1', version: 'v1', ctx: () => ctx });
    t.queueRoute('/a', null);
    expect(t.flush('hidden')).toBe(true);

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch.mock.calls[0]![0]).toBe('https://x.test/api/a11y/ingest');
    expect(doFetch.mock.calls[0]![1]).toMatchObject({ keepalive: true, method: 'POST' });
    t.detach();
  });

  it('falls back to fetch with keepalive when sendBeacon is unavailable', () => {
    (navigator as any).sendBeacon = undefined;
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve({} as Response));
    vi.stubGlobal('fetch', fetchSpy);
    const t = Transport({ endpoint: 'https://x.test', siteKey: 'site1', sessionId: 'sess1', version: 'v1', ctx: () => ctx });
    t.queueRoute('/a', null);
    t.flush('hidden');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://x.test/api/a11y/ingest');
    expect((init as RequestInit).keepalive).toBe(true);
    t.detach();
  });
});
