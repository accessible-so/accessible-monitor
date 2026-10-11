import { describe, expect, it } from 'vitest';
import { RouteMap, routePatternFor } from '../route-pattern';

describe('routePatternFor', () => {
  it('rewrites each param value to its bracketed key', () => {
    expect(routePatternFor('/products/red-shoes', { slug: 'red-shoes' })).toBe('/products/[slug]');
    expect(routePatternFor('/shop/42/reviews/7', { id: '42', reviewId: '7' })).toBe('/shop/[id]/reviews/[reviewId]');
  });
  it('rewrites catch-all arrays to [...key]', () => {
    expect(routePatternFor('/docs/a/b/c', { parts: ['a', 'b', 'c'] })).toBe('/docs/[...parts]');
  });
  it('returns the pathname unchanged when there are no params', () => {
    expect(routePatternFor('/about', {})).toBe('/about');
    expect(routePatternFor('/about', null)).toBe('/about');
  });
  it('matches whole segments only and decodes percent-encoding', () => {
    expect(routePatternFor('/tag/a%20b', { tag: 'a b' })).toBe('/tag/[tag]');
    expect(routePatternFor('/p/1/10', { id: '1' })).toBe('/p/[id]/10');
  });
  it('gives up rather than guess when a param value is not in the path', () => {
    expect(routePatternFor('/x', { id: '9' })).toBe('/x');
  });
  it('gives up rather than guess when two params share a value', () => {
    expect(routePatternFor('/shop/7/reviews/7', { id: '7', reviewId: '7' })).toBe('/shop/7/reviews/7');
  });
  it('gives up rather than guess when a scalar value matches more than one segment', () => {
    expect(routePatternFor('/a/x/x', { id: 'x' })).toBe('/a/x/x');
  });
});

describe('RouteMap', () => {
  it('remembers the last N paths and forgets the oldest', () => {
    const m = new RouteMap(2);
    m.set('/a', '/[a]');
    m.set('/b', '/[b]');
    m.set('/c', '/[c]');
    expect(m.get('/a')).toBeNull();
    expect(m.get('/c')).toBe('/[c]');
    expect(m.size).toBe(2);
  });
  it('refreshes recency on set', () => {
    const m = new RouteMap(2);
    m.set('/a', '/[a]');
    m.set('/b', '/[b]');
    m.set('/a', '/[a]');
    m.set('/c', '/[c]');
    expect(m.get('/b')).toBeNull();
    expect(m.get('/a')).toBe('/[a]');
  });
});
