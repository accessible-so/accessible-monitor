import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_VERSION,
  componentIdOf,
  componentSourceOf,
  computeSignature,
  criteriaFromAxeTags,
  criterionFromAxeTags,
  elementKeyOf,
  elementSignature,
  fallbackSignature,
  landmarkPath,
  normalizeClassTokens,
  parseElementKey,
  ruleKeyForAxe,
  signatureFromElementKey,
  signatureFromParts,
} from '../index';

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}
const q = (sel: string) => document.querySelector(sel) as Element;

describe('normalizeClassTokens', () => {
  it('drops hashed CSS-module and utility suffixes and arbitrary values, keeps the rest sorted and unique', () => {
    expect(
      normalizeClassTokens(['btn', 'Card_root__x1f9A', 'card-8f3k2', 'w-[32px]', 'a1b2c3', 'mt-4', 'col-md-6', 'btn']),
    ).toEqual(['btn', 'col-md-6', 'mt-4']);
  });
  it('keeps readable tokens that merely contain digits', () => {
    expect(normalizeClassTokens(['h1', 'grid-cols-12', 'text-2xl', 'button2'])).toEqual(['button2', 'grid-cols-12', 'h1', 'text-2xl']);
  });
});

describe('elementSignature', () => {
  it('encodes tag, role, type, allowlisted attribute names, and normalised classes only', () => {
    render('<input id="x" class="Field_input__9z8y7 input" type="Email" aria-label="Your email" name="email" data-a11y-component="Field" placeholder="you@example.com">');
    expect(elementSignature(q('#x'))).toBe(
      JSON.stringify(['input', '-', 'email', ['aria-label', 'data-a11y-component', 'type'], ['input']]),
    );
  });
  it('ignores attribute values and text', () => {
    render('<a id="a" href="/one" aria-label="Alpha">One</a><a id="b" href="/two" aria-label="Beta and gamma">Two</a>');
    expect(elementSignature(q('#a'))).toBe(elementSignature(q('#b')));
  });
});

describe('landmarkPath', () => {
  it('is relative to the nearest landmark and buckets the accessible name by word count', () => {
    render('<nav aria-label="Primary site navigation"><ul><li><a id="l">x</a></li></ul></nav>');
    expect(landmarkPath(q('#l'))).toEqual(['navigation#1-3', 'ul', 'li']);
  });
  it('maps implicit landmark elements and treats named sections as regions', () => {
    render('<main><section aria-label="Featured products this week"><div><div><span id="s">x</span></div></div></section></main>');
    expect(landmarkPath(q('#s'))).toEqual(['region#4-8']);
  });
  it('skips anonymous div and span wrappers, so adding one does not move the element', () => {
    render('<main><div><div role="list"><span><b id="t">x</b></span></div></div></main>');
    expect(landmarkPath(q('#t'))).toEqual(['main#0', 'div']);
    render('<main><div><div><div role="list"><span><span><b id="t2">x</b></span></span></div></div></div></main>');
    expect(landmarkPath(q('#t2'))).toEqual(['main#0', 'div']);
    render('<main><div aria-live="polite"><section><b id="t3">x</b></section></div></main>');
    expect(landmarkPath(q('#t3'))).toEqual(['main#0', 'div', 'section']);
  });
  it('falls back to document and caps depth at the 8 nearest ancestors', () => {
    // section (unnamed, not a landmark) + p b i u s em strong small, and body and html above them = 11 counted ancestors; the div is anonymous. The 8 nearest survive the slice.
    render('<section><div><p><b><i><u><s><em><strong><small><mark id="deep">x</mark></small></strong></em></s></u></i></b></p></div></section>');
    expect(landmarkPath(q('#deep'))).toEqual(['document#0', 'p', 'b', 'i', 'u', 's', 'em', 'strong', 'small']);
  });
  it('collapses adjacent ancestors with the same tag', () => {
    render('<main><ul><ul><li id="n">x</li></ul></ul></main>');
    expect(landmarkPath(q('#n'))).toEqual(['main#0', 'ul']);
  });
  it('crosses shadow roots to reach a landmark in the light DOM', () => {
    render('<main><x-host id="h"></x-host></main>');
    const host = q('#h');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div><button id="inner">go</button></div>';
    expect(landmarkPath(root.querySelector('#inner') as Element)).toEqual(['main#0', 'x-host']);
  });
  it('resolves aria-labelledby for the bucket without leaking text', () => {
    render('<h2 id="t">Weekly featured products and offers</h2><section aria-labelledby="t"><a id="a">x</a></section>');
    expect(landmarkPath(q('#a'))).toEqual(['region#4-8']);
  });
});

describe('componentIdOf', () => {
  it('uses the nearest data-a11y-component including self', () => {
    render('<div data-a11y-component="ProductCard"><div><img id="i" alt=""></div></div>');
    expect(componentIdOf(q('#i'))).toBe('ProductCard');
    render('<div><img id="j" alt=""></div>');
    expect(componentIdOf(q('#j'))).toBeNull();
  });
});

describe('computeSignature', () => {
  it('has the s1 prefix and 32 hex characters', () => {
    render('<main><img id="i" src="/a.png"></main>');
    expect(computeSignature(q('#i'), 'axe:image-alt')).toMatch(/^s1:[0-9a-f]{32}$/);
    expect(SIGNATURE_VERSION).toBe('s1');
  });
  it('is identical for the same defect on two different pages', () => {
    render('<main><ul><li class="ProductCard_root__a1b2c"><img id="p1" src="/x.png"></li></ul></main>');
    const one = computeSignature(q('#p1'), 'axe:image-alt');
    render('<main><ul><li class="ProductCard_root__z9y8x"><img id="p2" src="/y.png"></li><li class="ProductCard_root__z9y8x"><img src="/z.png"></li></ul></main>');
    expect(computeSignature(q('#p2'), 'axe:image-alt')).toBe(one);
  });
  it('differs by rule, by landmark, and by component', () => {
    render('<main><img id="m" src="/a.png"></main><footer><img id="f" src="/a.png"></footer>');
    const m = computeSignature(q('#m'), 'axe:image-alt');
    expect(computeSignature(q('#m'), 'axe:role-img-alt')).not.toBe(m);
    expect(computeSignature(q('#f'), 'axe:image-alt')).not.toBe(m);
    q('#m').setAttribute('data-a11y-component', 'Hero');
    expect(computeSignature(q('#m'), 'axe:image-alt')).not.toBe(m);
  });
  it('equals signatureFromParts over the same parts', () => {
    render('<main><button id="b" class="x">go</button></main>');
    const sig = computeSignature(q('#b'), 'axe:button-name');
    expect(signatureFromParts({ ruleKey: 'axe:button-name', elementSig: elementSignature(q('#b')), landmarkPath: landmarkPath(q('#b')), componentId: null })).toBe(sig);
  });
});

describe('element keys', () => {
  it('round-trip to the same signature the element would get directly', () => {
    render('<main><form aria-label="Sign in"><input id="e" type="text"></form></main>');
    const key = elementKeyOf(q('#e'));
    expect(parseElementKey(key)).toEqual({ elementSig: elementSignature(q('#e')), landmarkPath: landmarkPath(q('#e')), componentId: null });
    expect(signatureFromElementKey(key, 'wcag:1.3.1')).toBe(computeSignature(q('#e'), 'wcag:1.3.1'));
  });
  it('returns null for garbage keys', () => {
    expect(parseElementKey('not json')).toBeNull();
    expect(parseElementKey(JSON.stringify({ v: 2 }))).toBeNull();
    expect(signatureFromElementKey('{}', 'wcag:1.3.1')).toBeNull();
  });
});

describe('fallbackSignature', () => {
  it('is deterministic per criterion and route path and carries no element', () => {
    const a = fallbackSignature('wcag:2.4.3', '/checkout/payment');
    expect(a).toBe(fallbackSignature('wcag:2.4.3', '/checkout/payment'));
    expect(a).not.toBe(fallbackSignature('wcag:2.4.3', '/checkout'));
    expect(a).toBe(signatureFromParts({ ruleKey: 'wcag:2.4.3', elementSig: '-', landmarkPath: ['/checkout/payment'], componentId: null }));
  });
});

describe('axe rule keys', () => {
  it('derives the criterion from axe tags', () => {
    expect(criterionFromAxeTags(['cat.text-alternatives', 'wcag2a', 'wcag111', 'ACT'])).toBe('1.1.1');
    expect(criterionFromAxeTags(['wcag2aa', 'wcag2412'])).toBe('2.4.12');
    expect(criterionFromAxeTags(['wcag21aa', 'wcag143'])).toBe('1.4.3');
    expect(criterionFromAxeTags(['cat.keyboard', 'best-practice'])).toBeNull();
  });
  it('namespaces by criterion when known and by rule otherwise', () => {
    expect(ruleKeyForAxe('image-alt', ['wcag2a', 'wcag111'])).toBe('wcag:1.1.1');
    expect(ruleKeyForAxe('region', ['cat.keyboard', 'best-practice'])).toBe('axe:region');
  });
  it('gives a scan and a journey the same signature for the same element and criterion', () => {
    render('<main><img id="i" src="/a.png"></main>');
    const el = q('#i');
    const scan = computeSignature(el, ruleKeyForAxe('image-alt', ['wcag2a', 'wcag111']));
    const journey = signatureFromElementKey(elementKeyOf(el), 'wcag:1.1.1');
    expect(journey).toBe(scan);
  });

  it('lists every criterion an axe rule reports and reads the source stamp', () => {
    expect(criteriaFromAxeTags(['wcag2a', 'wcag131', 'wcag412', 'cat.forms'])).toEqual(['1.3.1', '4.1.2']);
    render('<div data-a11y-component="Card" data-a11y-source="src/Card.tsx:9"><b id="x">x</b></div>');
    expect(componentSourceOf(q('#x'))).toBe('src/Card.tsx:9');
  });

  it('de-duplicates a criterion reported by more than one tag', () => {
    expect(criteriaFromAxeTags(['wcag131', 'wcag2a', 'wcag131'])).toEqual(['1.3.1']);
  });
});
