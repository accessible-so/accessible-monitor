import { defineConfig } from 'astro/config';
import accessibleMonitor from '@accessible-so/monitor-astro';

// The browser suite builds this with its own fixture server as the endpoint
// (A11Y_ENDPOINT) and, for one case, under a base path (A11Y_BASE).
export default defineConfig({
  base: process.env.A11Y_BASE || '/',
  outDir: process.env.A11Y_OUT_DIR || 'dist',
  integrations: [
    accessibleMonitor({
      siteKey: process.env.A11Y_KEY || 'acc_rum_aaaaaaaaaaaaaaaaaaaaaaaa',
      endpoint: process.env.A11Y_ENDPOINT || 'http://localhost:4173',
    }),
  ],
});
