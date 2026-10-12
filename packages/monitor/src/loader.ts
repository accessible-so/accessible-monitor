(() => {
  try {
    const w = window as any,
      d = document,
      s = d.currentScript as HTMLScriptElement | null;
    if (!s || w.__accessibleRumLoaded) return;
    w.__accessibleRumLoaded = 1;
    if (s.hasAttribute('data-disabled')) return;
    const key = s.getAttribute('data-site-key');
    if (!key) return;
    const src = new URL(s.src, location.href);
    const endpoint = (s.getAttribute('data-endpoint') || 'https://app.accessible.so').replace(/\/$/, '');
    // Served by Accessible, the engine is the version the app's config names
    // (`/rum/<version>/engine.js`), so it always matches what ingest accepts.
    // Self-hosted, it is the file next to the loader.
    const engineFor = (cfg: any) =>
      s.getAttribute('data-engine') ||
      (src.origin === 'https://accessible.so' && /^\d+\.\d+\.\d+$/.test(cfg.minCollector)
        ? `${src.origin}/rum/${cfg.minCollector}/engine.js`
        : src.href.replace(/loader(\.min)?\.js(\?.*)?$/, 'engine.js'));
    const debug = /[?&]a11y_debug=1(&|$)/.test(location.search);
    const ss = (() => {
      try {
        return sessionStorage;
      } catch {
        return null;
      }
    })();
    const read = () => {
      try {
        return JSON.parse(ss?.getItem('a11y_rum') || 'null');
      } catch {
        return null;
      }
    };
    const write = (v: unknown) => {
      try {
        ss?.setItem('a11y_rum', JSON.stringify(v));
      } catch {}
    };
    const hex = () => {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    };
    // Same semantics as @accessible-so/monitor-core's matchRoutePattern:
    // `[param]` matches one non-empty segment, `[...rest]` (last segment
    // only) consumes one or more remaining segments.
    const match = (pat: string, path: string) => {
      const ps = pat.split('/').filter(Boolean);
      const xs = path.split('/').filter(Boolean);
      for (let i = 0; i < ps.length; i++) {
        const seg = ps[i]!;
        if (seg.indexOf('[...') === 0 && seg[seg.length - 1] === ']') {
          return i === ps.length - 1 && xs.length - i >= 1;
        }
        if (seg[0] === '[' && seg[seg.length - 1] === ']') {
          if (!xs[i]) return false;
          continue;
        }
        if (xs[i] !== seg) return false;
      }
      return xs.length === ps.length;
    };
    let st = read();
    if (st && st.d === 0 && !debug) return;
    const sid = (st && st.s) || hex();
    const inject = (cfg: any) => {
      const el = d.createElement('script');
      el.src = engineFor(cfg);
      el.async = true;
      el.onload = () => {
        try {
          w.__accessibleRum &&
            w.__accessibleRum.start({ siteKey: key, endpoint, config: cfg, sessionId: sid, debug });
        } catch {}
      };
      d.head.appendChild(el);
    };
    const decide = (cfg: any) => {
      if (!cfg || cfg.enabled === false || cfg.killSwitch) return;
      let sampled = st && st.d === 1;
      if (!st || debug) {
        const override = parseFloat(s.getAttribute('data-sample') || '');
        let rate = isNaN(override) ? +cfg.sampleRate || 0 : override;
        for (const b of cfg.boosted || []) if (match(b.pattern, location.pathname)) rate = Math.max(rate, +b.rate || 0);
        sampled = debug || Math.random() < rate;
        write({ s: sid, d: sampled ? 1 : 0 });
      }
      if (!sampled) return;
      const ric = w.requestIdleCallback as undefined | ((cb: () => void, o?: object) => void);
      ric ? ric(() => inject(cfg), { timeout: 3000 }) : setTimeout(() => inject(cfg), 1500);
    };
    fetch(`${endpoint}/api/rum/config?k=${encodeURIComponent(key)}`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then(decide)
      .catch(() => {});
  } catch {}
})();
