/**
 * The bridge between the two paths a Next app has at once.
 *
 * The router reports an *app-relative* path (`usePathname()`, or `asPath` on
 * the Pages Router): `basePath` and any i18n locale prefix are already stripped
 * off it. The collector core asks for a pattern by `window.location.pathname`,
 * which carries both. On a plain app the two strings are identical and none of
 * this matters; under `basePath: '/x'` or `/fr/...` they differ by a constant
 * prefix, and keying the route map on the router's view would miss every
 * lookup — every finding on the whole site would report a null pattern.
 *
 * The prefix cannot simply be read from `window.location` at the moment it is
 * needed, either: during a client-side navigation Next renders the new tree
 * *before* it pushes the history entry, so at render time `location.pathname`
 * is still the previous page — and the collector records its `routes[]` entry
 * the instant the URL changes, before any effect of ours could run. So the
 * prefix is measured once, on the first client render (where the document's
 * own URL is authoritative), and the key for every later navigation is
 * predicted from it.
 */

/** Everything `window.location.pathname` has that the router's path does not. */
export function basePrefix(browserPath: string, appPath: string): string {
  if (!browserPath) return '';
  if (!appPath || appPath === '/') return browserPath === '/' ? '' : trimTrailingSlash(browserPath);
  if (browserPath.endsWith(appPath)) return browserPath.slice(0, browserPath.length - appPath.length);
  // `trailingSlash: true` puts a slash on the document URL that the router's
  // path does not carry.
  const trimmed = trimTrailingSlash(browserPath);
  if (trimmed.endsWith(appPath)) return trimmed.slice(0, trimmed.length - appPath.length);
  // No relationship we can explain — a prefix guessed from this would be
  // worse than none. The effect that runs after every commit writes the real
  // `window.location.pathname` anyway; this only costs the prediction.
  return '';
}

/** The browser path an app-relative path is expected to appear at. */
export function pathKey(prefix: string, appPath: string): string {
  if (!appPath || appPath === '/') return prefix || '/';
  return prefix + appPath;
}

/** `asPath` carries the query string and the hash; a pathname carries neither. */
export function pathOnly(asPath: string): string {
  return asPath.split('?')[0]!.split('#')[0]!;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
