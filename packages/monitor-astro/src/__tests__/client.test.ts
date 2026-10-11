import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTER_SLOT } from '@accessible-so/monitor-core';
import { createAstroAdapter, registerRoutes, type SerializedRoute } from '../client';

// The route table as Astro produced it for examples/astro-site, in Astro's
// own priority order (verified against astro build, 7.3.6).
const ROUTES: SerializedRoute[] = [
  { pattern: '/docs/[...parts]', source: '^\\/docs(?:\\/(.*?))?\\/?$', flags: '' },
  { pattern: '/products/featured', source: '^\\/products\\/featured\\/?$', flags: '' },
  { pattern: '/products/[slug]', source: '^\\/products\\/([^/]+?)\\/?$', flags: '' },
  { pattern: '/', source: '^\\/$', flags: '' },
  { pattern: '/[...rest]', source: '^(?:\\/(.*?))?\\/?$', flags: '' },
];

const patternOf = (path: string, base = '/') => createAstroAdapter(ROUTES, base).attribution!.routePattern!(path);

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[ADAPTER_SLOT];
});

describe('createAstroAdapter', () => {
  it('reports the pattern for dynamic, catch-all and static routes', () => {
    expect(patternOf('/products/red-shoes')).toBe('/products/[slug]');
    expect(patternOf('/products/red-shoes/')).toBe('/products/[slug]');
    expect(patternOf('/docs/a/b')).toBe('/docs/[...parts]');
    expect(patternOf('/')).toBe('/');
  });

  it("keeps Astro's priority: a static route beats the dynamic one beside it", () => {
    expect(patternOf('/products/featured')).toBe('/products/featured');
  });

  it('falls through to a root catch-all only when nothing more specific matches', () => {
    expect(patternOf('/anything/else')).toBe('/[...rest]');
  });

  it('strips base before matching, with or without a trailing slash on it', () => {
    expect(patternOf('/shop/products/red-shoes', '/shop')).toBe('/products/[slug]');
    expect(patternOf('/shop/products/red-shoes', '/shop/')).toBe('/products/[slug]');
    expect(patternOf('/shop', '/shop')).toBe('/');
  });

  it('reports nothing for a path outside base, or that no route matches', () => {
    expect(patternOf('/products/red-shoes', '/shop')).toBeNull();
    expect(patternOf('/shopping/x', '/shop')).toBeNull();
    const adapter = createAstroAdapter(ROUTES.slice(0, 3), '/');
    expect(adapter.attribution!.routePattern!('/nope')).toBeNull();
  });

  it('skips a route whose regex cannot compile instead of failing', () => {
    const adapter = createAstroAdapter([{ pattern: '/bad', source: '(', flags: '' }, ...ROUTES], '/');
    expect(adapter.attribution!.routePattern!('/products/x')).toBe('/products/[slug]');
  });
});

describe('registerRoutes', () => {
  it('puts the adapter in the slot the collector core reads', () => {
    registerRoutes(ROUTES, '/');
    const slot = (window as unknown as Record<string, any>)[ADAPTER_SLOT];
    expect(slot.attribution.routePattern('/products/a')).toBe('/products/[slug]');
  });
});
