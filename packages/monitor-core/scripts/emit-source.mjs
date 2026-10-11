// Wrap the browser bundle as an importable string so a Node host (Playwright's
// addInitScript, for instance) can inject it without resolving file paths.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'signature');
const source = readFileSync(join(dist, 'browser.global.js'), 'utf8');
const literal = JSON.stringify(source);
writeFileSync(join(dist, 'source.js'), `export const SIGNATURE_SOURCE = ${literal};\n`);
writeFileSync(join(dist, 'source.cjs'), `"use strict";\nexports.SIGNATURE_SOURCE = ${literal};\n`);
writeFileSync(join(dist, 'source.d.ts'), `/** Classic-script bundle that assigns the signature module to globalThis.AccessibleSignature. */\nexport declare const SIGNATURE_SOURCE: string;\n`);
