import { describe, expect, it } from 'vitest';
import { decideSampling, matchRoutePattern } from '../sampling';

describe('matchRoutePattern', () => {
  it('matches literal segments exactly', () => {
    expect(matchRoutePattern('/products/list', '/products/list')).toBe(true);
    expect(matchRoutePattern('/products/list', '/products/other')).toBe(false);
  });

  it('matches a single dynamic segment `[param]` against exactly one non-empty segment', () => {
    expect(matchRoutePattern('/products/[slug]', '/products/blue-shirt')).toBe(true);
    expect(matchRoutePattern('/products/[slug]', '/products/a/b')).toBe(false);
  });

  it('matches a catch-all `[...rest]` against one or more trailing segments', () => {
    expect(matchRoutePattern('/docs/[...rest]', '/docs/a/b')).toBe(true);
    expect(matchRoutePattern('/docs/[...rest]', '/docs/a')).toBe(true);
    expect(matchRoutePattern('/docs/[...rest]', '/docs')).toBe(false);
  });
});

describe('decideSampling', () => {
  it('forces true regardless of rate when forced, even at rate 0', () => {
    expect(decideSampling({ rate: 0, boosted: [], path: '/', forced: true, random: () => 0.999 })).toBe(true);
  });

  it('returns true at rate 1 and false at rate 0', () => {
    expect(decideSampling({ rate: 1, boosted: [], path: '/', forced: false, random: () => 0.999 })).toBe(true);
    expect(decideSampling({ rate: 0, boosted: [], path: '/', forced: false, random: () => 0.0001 })).toBe(false);
  });

  it('applies a boosted route rate by pattern even when the base rate is 0', () => {
    const result = decideSampling({
      rate: 0,
      boosted: [{ pattern: '/products/[slug]', rate: 1 }],
      path: '/products/blue-shirt',
      forced: false,
      random: () => 0.999,
    });
    expect(result).toBe(true);
  });

  it('compares random() against the effective rate with strict less-than', () => {
    expect(decideSampling({ rate: 0.05, boosted: [], path: '/', forced: false, random: () => 0.049 })).toBe(true);
    expect(decideSampling({ rate: 0.05, boosted: [], path: '/', forced: false, random: () => 0.051 })).toBe(false);
  });
});
