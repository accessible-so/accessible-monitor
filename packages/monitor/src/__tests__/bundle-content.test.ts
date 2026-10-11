import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { BANNER } from '../banner';

const distDir = path.resolve(__dirname, '../../dist');

describe('dist/engine.js content', () => {
  const src = readFileSync(path.join(distDir, 'engine.js'), 'utf8');

  it('never bundles screen-reader/media-query fingerprints', () => {
    expect(src).not.toMatch(/JAWS|NVDA|VoiceOver|TalkBack|Narrator|speechSynthesis|forced-colors/);
  });

  it('never bundles zod', () => {
    expect(src).not.toMatch(/from "zod"|zod/);
  });

  /**
   * The bundle inlines axe-core, which is MPL-2.0. The notice has to be in the
   * file the customer serves, not only in a markdown file in this repository —
   * `dist/engine.js` is what leaves here and lands on someone else's origin.
   */
  it('opens with the licence notice for the axe-core it inlines', () => {
    expect(src.startsWith(BANNER), `engine.js starts with: ${src.slice(0, 120)}`).toBe(true);
    expect(BANNER).toContain('MPL-2.0');
    expect(BANNER).toContain('https://github.com/dequelabs/axe-core');
  });
});

describe('dist/loader.js size', () => {
  it('is gzipped to 2048 bytes or fewer', () => {
    const buf = readFileSync(path.join(distDir, 'loader.js'));
    const gz = gzipSync(buf, { level: 9 });
    expect(gz.byteLength).toBeLessThanOrEqual(2048);
  });
});
