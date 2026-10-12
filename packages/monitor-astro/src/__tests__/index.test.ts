import { describe, expect, it } from 'vitest';
import type { IntegrationResolvedRoute } from 'astro';
import accessibleMonitor, { DEFAULT_ENDPOINT, loaderSnippet, routesModule, serializeRoutes } from '../index';

const route = (over: Partial<IntegrationResolvedRoute>): IntegrationResolvedRoute =>
  ({ type: 'page', origin: 'project', pattern: '/x', patternRegex: /^\/x\/?$/, ...over }) as IntegrationResolvedRoute;

describe('serializeRoutes', () => {
  it("keeps the site's pages, in order, and drops everything else", () => {
    const out = serializeRoutes([
      route({ pattern: '/a', patternRegex: /^\/a\/?$/ }),
      route({ type: 'endpoint', pattern: '/api' }),
      route({ type: 'redirect', pattern: '/old' }),
      route({ origin: 'internal', pattern: '/_image' }),
      route({ origin: 'external', pattern: '/injected', patternRegex: /^\/injected$/i }),
    ]);
    expect(out).toEqual([
      { pattern: '/a', source: '^\\/a\\/?$', flags: '' },
      { pattern: '/injected', source: '^\\/injected$', flags: 'i' },
    ]);
  });
});

describe('loaderSnippet', () => {
  it('adds the loader tag with the key and endpoint as attributes', () => {
    const js = loaderSnippet('https://app.example', 'acc_rum_k');
    expect(js).toContain('"https://app.example/rum/loader.js"');
    expect(js).toContain(`s.setAttribute('data-site-key',"acc_rum_k")`);
    expect(js).toContain(`s.setAttribute('data-endpoint',"https://app.example")`);
  });

  it('escapes what it embeds, so a stray quote cannot break out of the script', () => {
    const js = loaderSnippet('https://x', 'a"b</script>');
    expect(js).toContain('"a\\"b</script>"');
    expect(() => new Function(js)).not.toThrow();
  });
});

describe('routesModule', () => {
  it('registers the table and base through the client entry', () => {
    const mod = routesModule([{ pattern: '/', source: '^\\/$', flags: '' }], '/shop');
    expect(mod).toContain("from '@accessible-so/monitor-astro/client'");
    expect(mod).toContain('registerRoutes([{"pattern":"/","source":"^\\\\/$","flags":""}], "/shop")');
  });
});

describe('accessibleMonitor', () => {
  it('requires a site key', () => {
    expect(() => accessibleMonitor({ siteKey: ' ' })).toThrow(/siteKey/);
  });

  it("defaults to Accessible's app and trims a trailing slash from a custom endpoint", () => {
    expect(DEFAULT_ENDPOINT).toBe('https://app.accessible.so');
    const injected: [string, string][] = [];
    const integration = accessibleMonitor({ siteKey: 'acc_rum_k', endpoint: 'https://self.example/' });
    (integration.hooks['astro:config:setup'] as any)({
      injectScript: (stage: string, code: string) => injected.push([stage, code]),
      updateConfig: () => {},
    });
    expect(injected[0]![0]).toBe('head-inline');
    expect(injected[0]![1]).toContain('"https://self.example/rum/loader.js"');
    expect(injected[1]).toEqual(['page', 'import "virtual:accessible-monitor/routes";']);
  });

  it("defaults to Accessible's hosted loader with no data-endpoint, and takes a self-hosted src", () => {
    const snippet = (o: Parameters<typeof accessibleMonitor>[0]): string => {
      const injected: string[] = [];
      (accessibleMonitor(o).hooks['astro:config:setup'] as any)({ injectScript: (_: string, c: string) => injected.push(c), updateConfig: () => {} });
      return injected[0]!;
    };
    const plain = snippet({ siteKey: 'acc_rum_k' });
    expect(plain).toContain('"https://accessible.so/rum/loader.js"');
    expect(plain).not.toContain('data-endpoint');
    expect(snippet({ siteKey: 'acc_rum_k', src: 'https://cdn.example/l.js' })).toContain('"https://cdn.example/l.js"');
  });

  it('serves the routes Astro resolved, with the configured base, from the virtual module', () => {
    let plugin: any;
    const integration = accessibleMonitor({ siteKey: 'acc_rum_k' });
    (integration.hooks['astro:config:setup'] as any)({
      injectScript: () => {},
      updateConfig: (c: any) => (plugin = c.vite.plugins[0]),
    });
    (integration.hooks['astro:config:done'] as any)({ config: { base: '/shop' } });
    (integration.hooks['astro:routes:resolved'] as any)({ routes: [route({ pattern: '/p/[id]', patternRegex: /^\/p\/([^/]+?)\/?$/ })] });
    const id = plugin.resolveId('virtual:accessible-monitor/routes');
    const code = plugin.load(id);
    expect(code).toContain('"pattern":"/p/[id]"');
    expect(code).toContain('"/shop"');
    expect(plugin.resolveId('something-else')).toBeUndefined();
  });
});
