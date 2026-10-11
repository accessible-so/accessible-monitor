import { describe, expect, it } from 'vitest';
import { computeSignature } from '../index';
import { buildCorpus } from './corpus';

const RULE = 'axe:probe';

function signaturesOf(html: string): Map<string, string> {
  document.body.innerHTML = html;
  const out = new Map<string, string>();
  for (const el of Array.from(document.querySelectorAll('[data-probe]'))) {
    out.set(el.getAttribute('data-probe')!, computeSignature(el, RULE));
  }
  return out;
}

describe('signature stability across a routine deploy', () => {
  it('keeps at least 95% of probe signatures unchanged from build A to build B', () => {
    const a = signaturesOf(buildCorpus('A'));
    const b = signaturesOf(buildCorpus('B'));
    expect(a.size).toBeGreaterThanOrEqual(40);
    expect(b.size).toBe(a.size);
    let same = 0;
    const changed: string[] = [];
    for (const [probe, sig] of a) {
      if (b.get(probe) === sig) same++;
      else changed.push(probe);
    }
    expect(changed.sort()).toEqual(['moved-1', 'moved-2']);
    expect(same / a.size).toBeGreaterThanOrEqual(0.95);
  });

  it('collapses the same component defect across all cards to one signature', () => {
    const a = signaturesOf(buildCorpus('A'));
    const imgs = new Set([...a].filter(([k]) => k.startsWith('card-img-')).map(([, v]) => v));
    expect(imgs.size).toBe(1);
  });
});
