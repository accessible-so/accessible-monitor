// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const usePathnameMock = vi.fn();
const useParamsMock = vi.fn();
const useRouterMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
  useParams: () => useParamsMock(),
}));

vi.mock('next/router', () => ({
  useRouter: () => useRouterMock(),
}));

vi.mock('next/script', () => ({
  // Same props reach the DOM as a plain <script>, so assertions can read
  // src/data-* straight off the rendered element.
  default: (props: Record<string, unknown>) => React.createElement('script', props),
}));

import { AccessibleMonitor, loaderAttributes } from '../monitor';
import { AccessibleMonitorPages } from '../monitor-pages';

interface AdapterWindow {
  __accessibleAdapter?: { attribution: { routePattern: (path: string) => string | null } };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as AdapterWindow).__accessibleAdapter;
  window.history.replaceState({}, '', '/');
});

function adapterWindow(): AdapterWindow {
  return window as unknown as AdapterWindow;
}

/** What the collector core does: `routePattern(window.location.pathname)`. */
function patternForBrowserPath(): string | null | undefined {
  return adapterWindow().__accessibleAdapter?.attribution.routePattern(window.location.pathname);
}

describe('AccessibleMonitor (App Router)', () => {
  it('registers the adapter, resolves route patterns across navigations, and renders the loader script', () => {
    window.history.replaceState({}, '', '/products/red-shoes');
    usePathnameMock.mockReturnValue('/products/red-shoes');
    useParamsMock.mockReturnValue({ slug: 'red-shoes' });

    const { container, rerender } = render(
      <AccessibleMonitor siteKey="acc_rum_x" endpoint="https://ingest.test" />,
    );

    expect(patternForBrowserPath()).toBe('/products/[slug]');

    const script = container.querySelector('script');
    expect(script?.getAttribute('src')).toBe('https://ingest.test/a11y/loader.js');
    expect(script?.getAttribute('data-site-key')).toBe('acc_rum_x');
    expect(script?.getAttribute('data-endpoint')).toBe('https://ingest.test');

    window.history.replaceState({}, '', '/products/blue-shoes');
    usePathnameMock.mockReturnValue('/products/blue-shoes');
    useParamsMock.mockReturnValue({ slug: 'blue-shoes' });
    rerender(<AccessibleMonitor siteKey="acc_rum_x" endpoint="https://ingest.test" />);

    // The earlier path still resolves: a beacon sent after a client-side
    // navigation carries findings raised on the page it left.
    expect(adapterWindow().__accessibleAdapter?.attribution.routePattern('/products/red-shoes')).toBe(
      '/products/[slug]',
    );
    expect(patternForBrowserPath()).toBe('/products/[slug]');
  });

  it('resolves under a basePath, where usePathname() and location.pathname differ', () => {
    // A `basePath: '/x'` app: the browser is on /x/products/red-shoes, while
    // the App Router reports the app-relative path. The core looks up the
    // former, so that is what the map has to be keyed on.
    window.history.replaceState({}, '', '/x/products/red-shoes');
    usePathnameMock.mockReturnValue('/products/red-shoes');
    useParamsMock.mockReturnValue({ slug: 'red-shoes' });

    render(<AccessibleMonitor siteKey="acc_rum_x" />);

    // The key carries the basePath; the pattern stays the app route, not
    // `/x/products/[slug]` — aggregates group by what the file tree calls it.
    expect(patternForBrowserPath()).toBe('/products/[slug]');
    expect(
      adapterWindow().__accessibleAdapter?.attribution.routePattern('/products/red-shoes'),
    ).toBeNull();
  });

  it('resolves under a locale prefix the router has already stripped', () => {
    window.history.replaceState({}, '', '/fr/products/red-shoes');
    usePathnameMock.mockReturnValue('/products/red-shoes');
    useParamsMock.mockReturnValue({ slug: 'red-shoes' });

    render(<AccessibleMonitor siteKey="acc_rum_x" />);

    expect(patternForBrowserPath()).toBe('/products/[slug]');
  });
});

describe('AccessibleMonitorPages (Pages Router)', () => {
  it('registers the adapter, resolves route patterns across navigations, and renders the loader script', () => {
    window.history.replaceState({}, '', '/products/red-shoes');
    useRouterMock.mockReturnValue({ pathname: '/products/[slug]', asPath: '/products/red-shoes' });

    const { container, rerender } = render(
      <AccessibleMonitorPages siteKey="acc_rum_x" endpoint="https://ingest.test" />,
    );

    expect(patternForBrowserPath()).toBe('/products/[slug]');

    const script = container.querySelector('script');
    expect(script?.getAttribute('src')).toBe('https://ingest.test/a11y/loader.js');
    expect(script?.getAttribute('data-site-key')).toBe('acc_rum_x');
    expect(script?.getAttribute('data-endpoint')).toBe('https://ingest.test');

    window.history.replaceState({}, '', '/products/blue-shoes');
    useRouterMock.mockReturnValue({ pathname: '/products/[slug]', asPath: '/products/blue-shoes' });
    rerender(<AccessibleMonitorPages siteKey="acc_rum_x" endpoint="https://ingest.test" />);

    expect(adapterWindow().__accessibleAdapter?.attribution.routePattern('/products/red-shoes')).toBe(
      '/products/[slug]',
    );
    expect(patternForBrowserPath()).toBe('/products/[slug]');
  });

  it('keys on the browser path, so a query string, a hash and a basePath all resolve', () => {
    window.history.replaceState({}, '', '/x/p/red-shoes?q=1#reviews');
    useRouterMock.mockReturnValue({ pathname: '/p/[slug]', asPath: '/p/red-shoes?q=1#reviews' });

    render(<AccessibleMonitorPages siteKey="acc_rum_x" />);

    expect(window.location.pathname).toBe('/x/p/red-shoes');
    expect(patternForBrowserPath()).toBe('/p/[slug]');
  });

  it('registers nothing and still renders the loader when there is no Pages router', () => {
    // `useRouter()` from `next/router` returns null outside a Pages Router
    // context — this component pasted into an App Router app. Reading
    // `.pathname` off that would throw into the host application's render.
    useRouterMock.mockReturnValue(null);

    const { container } = render(
      <AccessibleMonitorPages siteKey="acc_rum_x" endpoint="https://ingest.test" />,
    );

    expect(adapterWindow().__accessibleAdapter).toBeUndefined();
    expect(container.querySelector('script')?.getAttribute('src')).toBe(
      'https://ingest.test/a11y/loader.js',
    );
  });
});

describe('loaderAttributes', () => {
  it("defaults to Accessible's hosted loader and leaves data-endpoint to the loader's own default", () => {
    expect(loaderAttributes({ siteKey: 'k' })).toEqual({ src: 'https://accessible.so/a11y/loader.js', 'data-site-key': 'k' });
    expect(loaderAttributes({ siteKey: 'k', endpoint: 'https://app.accessible.so' })).toEqual({ src: 'https://accessible.so/a11y/loader.js', 'data-site-key': 'k' });
  });
  it('a custom endpoint serves the loader too, unless src says otherwise', () => {
    expect(loaderAttributes({ siteKey: 'k', endpoint: 'https://dev.example' })).toEqual({
      src: 'https://dev.example/a11y/loader.js', 'data-site-key': 'k', 'data-endpoint': 'https://dev.example',
    });
    expect(loaderAttributes({ siteKey: 'k', src: 'https://cdn.example/loader.js' })).toEqual({ src: 'https://cdn.example/loader.js', 'data-site-key': 'k' });
  });
});
