import { describe, expect, it } from 'vitest';
import { redactElement, redactHref, textMetrics } from '../index';

const render = (html: string) => { document.body.innerHTML = html; return document; };
const q = (s: string) => document.querySelector(s) as Element;

describe('textMetrics', () => {
  it('returns length, word count, and the known-bad flag, never the text', () => {
    expect(textMetrics('  Click here  ')).toEqual({ length: 10, words: 2, knownBad: true });
    expect(textMetrics('Checkout')).toEqual({ length: 8, words: 1, knownBad: false });
    expect(textMetrics('')).toBeNull();
    expect(textMetrics(null)).toBeNull();
  });
});

describe('redactHref', () => {
  it('keeps the path of same-origin links and collapses external ones', () => {
    expect(redactHref('/account/orders?id=42#top', 'https://shop.test')).toBe('/account/orders');
    expect(redactHref('https://shop.test/a/b?x=1', 'https://shop.test')).toBe('/a/b');
    expect(redactHref('https://other.test/x', 'https://shop.test')).toBe('external');
    expect(redactHref('mailto:jane@shop.test', 'https://shop.test')).toBe('external');
    expect(redactHref('javascript:void(0)', 'https://shop.test')).toBe('external');
  });
});

describe('redactElement', () => {
  it('keeps token attribute values, derives text-like values, counts idrefs, drops the rest', () => {
    render(`<h2 id="t">Weekly deals for members</h2>
      <button id="b" class="btn primary" type="submit" name="buy" data-track="x" style="color:red"
        aria-label="Add Blue Shirt to cart" aria-expanded="false" aria-describedby="t missing"
        title="Buy" tabindex="0" data-a11y-component="BuyButton" data-a11y-source="src/Buy.tsx:12">Add to cart</button>`);
    const out = redactElement(q('#b'));
    expect(out.tag).toBe('button');
    expect(out.attrs).toEqual({
      type: 'submit',
      tabindex: '0',
      'aria-expanded': 'false',
      'aria-label': { len: 22, words: 5 },
      'aria-describedby': { refs: 2, resolved: 1 },
      title: { len: 3, words: 1 },
      'data-a11y-component': 'BuyButton',
      'data-a11y-source': 'src/Buy.tsx:12',
    });
    expect(out.text).toEqual({ length: 11, words: 3, knownBad: false });
    expect(JSON.stringify(out)).not.toMatch(/Blue Shirt|Add to cart|jane|buy|red/);
  });

  it('reduces href to a path and never keeps id, class, src, or value', () => {
    render('<a id="a" class="x" href="/p/1?utm=1" data-x="1"><img src="/secret.png" alt="Jane Doe portrait"></a>');
    const out = redactElement(q('#a'));
    expect(out.attrs).toEqual({ href: '/p/1' });
    expect(out.children?.[0]?.attrs).toEqual({ alt: { len: 17, words: 3 } });
    expect(JSON.stringify(out)).not.toMatch(/secret|Jane|utm/);
  });

  it('keeps one parent and at most two children, none of which recurse further', () => {
    render('<main><ul><li id="l"><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a></li></ul></main>');
    const out = redactElement(q('#l'));
    expect(out.parent?.tag).toBe('ul');
    expect(out.parent?.parent).toBeUndefined();
    expect(out.parent?.children).toBeUndefined();
    expect(out.children).toHaveLength(2);
    expect(out.children?.[0]?.children).toBeUndefined();
  });

  it('marks presence-only attributes as true', () => {
    render('<label id="f" for="email">Email</label>');
    expect(redactElement(q('#f')).attrs).toEqual({ for: true });
  });
});
