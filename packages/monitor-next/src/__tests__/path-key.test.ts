import { describe, expect, it } from 'vitest';
import { basePrefix, pathKey, pathOnly } from '../path-key';

describe('basePrefix', () => {
  it('is empty for a plain app, where the two paths are the same string', () => {
    expect(basePrefix('/products/red-shoes', '/products/red-shoes')).toBe('');
    expect(basePrefix('/', '/')).toBe('');
  });

  it('is the basePath when the router has stripped one', () => {
    expect(basePrefix('/x/products/red-shoes', '/products/red-shoes')).toBe('/x');
    expect(basePrefix('/x', '/')).toBe('/x');
    expect(basePrefix('/x/', '/')).toBe('/x');
  });

  it('is the locale prefix the Pages Router strips off asPath', () => {
    expect(basePrefix('/fr/products/red-shoes', '/products/red-shoes')).toBe('/fr');
    expect(basePrefix('/x/fr/products/red-shoes', '/products/red-shoes')).toBe('/x/fr');
  });

  it('tolerates the trailing slash `trailingSlash: true` adds to the document URL', () => {
    expect(basePrefix('/x/products/red-shoes/', '/products/red-shoes')).toBe('/x');
  });

  it('is empty rather than a guess when the two paths are unrelated', () => {
    expect(basePrefix('/completely/other', '/products/red-shoes')).toBe('');
    expect(basePrefix('', '/products')).toBe('');
  });
});

describe('pathKey', () => {
  it('joins the prefix and the app path', () => {
    expect(pathKey('', '/products/red-shoes')).toBe('/products/red-shoes');
    expect(pathKey('/x', '/products/red-shoes')).toBe('/x/products/red-shoes');
  });

  it('keeps the root of a basePath app free of a trailing slash, as the browser does', () => {
    expect(pathKey('', '/')).toBe('/');
    expect(pathKey('/x', '/')).toBe('/x');
  });
});

describe('pathOnly', () => {
  it('drops the query string and the hash', () => {
    expect(pathOnly('/p/red-shoes?q=1#reviews')).toBe('/p/red-shoes');
    expect(pathOnly('/p/red-shoes')).toBe('/p/red-shoes');
  });
});
