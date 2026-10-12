import type { AstroIntegration, IntegrationResolvedRoute } from 'astro';
import type { SerializedRoute } from './client';

export type { SerializedRoute } from './client';

export const DEFAULT_ENDPOINT = 'https://app.accessible.so';
export const DEFAULT_LOADER_SRC = 'https://accessible.so/rum/loader.js';

export interface AccessibleMonitorOptions {
  /** The site key from your domain's Install snippet, `acc_rum_…`. */
  siteKey: string;
  /** Where config is read and beacons are sent. Defaults to Accessible's app. */
  endpoint?: string;
  /**
   * The loader's URL, to self-host it (the engine is read from `engine.js` next
   * to it). Defaults to Accessible's copy, or `<endpoint>/rum/loader.js` when
   * `endpoint` is set.
   */
  src?: string;
}

const VIRTUAL_ID = 'virtual:accessible-monitor/routes';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * Pages only, in the order Astro gives them. Endpoints render no DOM, a
 * redirect never reaches the browser as a page, and `internal` routes are
 * Astro's own (the image endpoint, server islands) rather than the site's.
 */
export function serializeRoutes(routes: readonly IntegrationResolvedRoute[]): SerializedRoute[] {
  return routes
    .filter((r) => r.type === 'page' && r.origin !== 'internal')
    .map((r) => ({ pattern: r.pattern, source: r.patternRegex.source, flags: r.patternRegex.flags }));
}

/**
 * Inline in every page's <head>: adds the loader tag, which then decides
 * sampling and whether to fetch the engine exactly as it does on any site.
 * Not processed by Vite, so plain ES5-safe script. The loader guards against
 * running twice itself (client-side navigation re-running head scripts).
 */
export function loaderSnippet(endpoint: string, siteKey: string, src?: string): string {
  const custom = endpoint !== DEFAULT_ENDPOINT;
  return (
    `(function(){var s=document.createElement('script');` +
    `s.src=${JSON.stringify(src ?? (custom ? `${endpoint}/rum/loader.js` : DEFAULT_LOADER_SRC))};s.async=true;` +
    `s.setAttribute('data-site-key',${JSON.stringify(siteKey)});` +
    (custom ? `s.setAttribute('data-endpoint',${JSON.stringify(endpoint)});` : '') +
    `document.head.appendChild(s)})();`
  );
}

/** The module every page imports: the route table and the call that registers the adapter. */
export function routesModule(routes: readonly SerializedRoute[], base: string): string {
  return (
    `import { registerRoutes } from '@accessible-so/monitor-astro/client';\n` +
    `registerRoutes(${JSON.stringify(routes)}, ${JSON.stringify(base)});\n`
  );
}

/**
 * `integrations: [accessibleMonitor({ siteKey })]` in astro.config.mjs.
 *
 * Two pieces, because Astro hands integrations the route table only after the
 * last chance to inject an inline script: the loader tag goes in at
 * `astro:config:setup`, and the route table is a virtual module that every
 * page imports and that Vite asks for later, once `astro:routes:resolved` has
 * filled it in. In `astro dev` a route change refreshes the module.
 */
export default function accessibleMonitor(options: AccessibleMonitorOptions): AstroIntegration {
  const siteKey = options?.siteKey?.trim();
  if (!siteKey) throw new Error('@accessible-so/monitor-astro: `siteKey` is required (the acc_rum_… key from your Install snippet).');
  const endpoint = (options.endpoint?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');

  let routes: SerializedRoute[] = [];
  let base = '/';
  let invalidate: (() => void) | undefined;

  return {
    name: '@accessible-so/monitor-astro',
    hooks: {
      'astro:config:setup': ({ injectScript, updateConfig }) => {
        injectScript('head-inline', loaderSnippet(endpoint, siteKey, options.src?.trim() || undefined));
        injectScript('page', `import ${JSON.stringify(VIRTUAL_ID)};`);
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'accessible-monitor-routes',
                resolveId: (id: string) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
                load: (id: string) => (id === RESOLVED_ID ? routesModule(routes, base) : undefined),
              },
            ],
          },
        });
      },
      'astro:config:done': ({ config }) => {
        base = config.base;
      },
      'astro:server:setup': ({ server }) => {
        invalidate = () => {
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (mod) server.moduleGraph.invalidateModule(mod);
        };
      },
      'astro:routes:resolved': ({ routes: resolved }) => {
        routes = serializeRoutes(resolved);
        invalidate?.();
      },
    },
  };
}
