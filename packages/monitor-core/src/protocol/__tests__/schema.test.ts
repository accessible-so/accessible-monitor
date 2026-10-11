import { describe, expect, it } from 'vitest';
import { RedactedElementSchema, RumBeaconSchema, RumConfigSchema } from '../schema';
import { elementKeyOf } from '../../signature/index';

const finding = {
  sig: 's1:0123456789abcdef0123456789abcdef', key: null, rule: 'wcag:1.1.1', confidence: 'rule', impact: 'critical',
  wcag: ['1.1.1'], p: '/products/1', r: null, el: { tag: 'img', attrs: {}, text: null }, comp: null, n: 1, i: false,
};
const beacon = {
  v: 1, k: 'acc_rum_' + 'a'.repeat(24), s: 'b'.repeat(32), c: '0.2.0', sent: 1,
  ctx: { vw: 1280, vh: 800, dpr: 2, zoom: 1, fontPx: 16, navigationMode: 'unknown' },
  session: { started: true }, routes: [{ p: '/products/1', r: null }], findings: [finding],
};

describe('RumBeaconSchema', () => {
  it('accepts a well-formed beacon', () => { expect(RumBeaconSchema.safeParse(beacon).success).toBe(true); });
  it('rejects a path with a query string, a bad signature, and too many findings', () => {
    expect(RumBeaconSchema.safeParse({ ...beacon, findings: [{ ...finding, p: '/x?y=1' }] }).success).toBe(false);
    expect(RumBeaconSchema.safeParse({ ...beacon, findings: [{ ...finding, sig: 'nope' }] }).success).toBe(false);
    expect(RumBeaconSchema.safeParse({ ...beacon, findings: Array.from({ length: 201 }, () => finding) }).success).toBe(false);
  });
  it('accepts perf with and without the skipped rule list, and bounds it', () => {
    const perf = { scans: 4, longTasks: 1, maxTaskMs: 82.4, aborted: false };
    expect(RumBeaconSchema.safeParse({ ...beacon, perf }).success).toBe(true);
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, skipped: ['color-contrast', 'region'] } }).success).toBe(true);
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, skipped: [] } }).success).toBe(true);
    // Bounds: at most 16 rule ids, each at most 64 characters, strings only.
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, skipped: Array.from({ length: 17 }, () => 'r') } }).success).toBe(false);
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, skipped: ['x'.repeat(65)] } }).success).toBe(false);
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, skipped: [1] } }).success).toBe(false);
    // The object is still strict: an unknown perf field is rejected.
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, whatever: 1 } }).success).toBe(false);
  });

  it('accepts perf.pending under the same bounds as perf.skipped', () => {
    const perf = { scans: 4, longTasks: 1, maxTaskMs: 82.4, aborted: false };
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, pending: ['color-contrast'] } }).success).toBe(true);
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, pending: Array.from({ length: 17 }, () => 'r') } }).success).toBe(false);
    expect(RumBeaconSchema.safeParse({ ...beacon, perf: { ...perf, pending: ['x'.repeat(65)] } }).success).toBe(false);
  });

  it('rejects raw text or unknown attribute shapes inside elements', () => {
    expect(RumBeaconSchema.safeParse({ ...beacon, findings: [{ ...finding, el: { tag: 'p', attrs: {}, text: 'hello' } }] }).success).toBe(false);
    expect(RumBeaconSchema.safeParse({ ...beacon, findings: [{ ...finding, el: { tag: 'p', attrs: { id: 'x' }, text: null } }] }).success).toBe(false);
  });
});

/**
 * `findings[].key` was the one string on the wire the schema only bounded, not
 * checked: a client that put a sentence of user text there would have been
 * accepted. The schema now parses it and holds it to the shape `elementKeyOf`
 * produces — which is also the only shape the server can do anything with.
 */
describe('RumFindingSchema element keys', () => {
  const withKey = (key: unknown): unknown => ({ ...beacon, findings: [{ ...finding, key }] });
  const accepts = (key: unknown): boolean => RumBeaconSchema.safeParse(withKey(key)).success;

  it('accepts a key the collector really produced, and null', () => {
    document.body.innerHTML = '<main><section aria-label="Latest"><p class="byline lead"><img alt="x"></p></section></main>';
    const key = elementKeyOf(document.querySelector('img')!);
    expect(accepts(key), `rejected ${key}`).toBe(true);
    expect(accepts(null)).toBe(true);
  });

  it('accepts every element the fixture-shaped page can produce a key for', () => {
    document.body.innerHTML =
      '<main><nav aria-label="Primary"><a href="/x" class="more">a</a></nav>' +
      '<form aria-label="Sign up"><input type="email" aria-describedby="h"><p id="h">h</p></form>' +
      '<div><span role="button" tabindex="0" data-a11y-component="Star"></span></div></main>';
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const key = elementKeyOf(el);
      expect(accepts(key), `rejected the key for <${el.tagName.toLowerCase()}>: ${key}`).toBe(true);
    }
  });

  it('rejects free text where an element key belongs', () => {
    expect(accepts('my email is jane@example.com')).toBe(false);
    expect(accepts('')).toBe(false);
    expect(accepts('null')).toBe(false);
    expect(accepts('{}')).toBe(false);
  });

  it('rejects a landmark path entry that is not a landmark path entry', () => {
    const e = JSON.stringify(['div', '-', '-', [], []]);
    expect(accepts(JSON.stringify({ v: 1, e, l: ['main#1-3', 'ul'], c: null }))).toBe(true);
    expect(accepts(JSON.stringify({ v: 1, e, l: ['<script>'], c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e, l: ['a b'], c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e, l: Array.from({ length: 13 }, () => 'div'), c: null }))).toBe(false);
  });

  /**
   * A landmark path entry is an ancestor's tag name, and a custom element name
   * may contain an underscore. Rejecting one would have dropped every finding
   * on a page that ships such an element — silently, at ingest, with nothing
   * to tell the client its beacons were being thrown away.
   */
  it('accepts a tag name with an underscore in the landmark path', () => {
    const e = JSON.stringify(['div', '-', '-', [], []]);
    expect(accepts(JSON.stringify({ v: 1, e, l: ['main#0', 'my_widget', 'x-host'], c: null }))).toBe(true);
    // Still nothing that could be markup or a sentence.
    expect(accepts(JSON.stringify({ v: 1, e, l: ['<script>'], c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e, l: ['my widget'], c: null }))).toBe(false);
  });

  it('accepts a real key from a page with an underscored custom element', () => {
    // End to end: the tag lands in the `e` tuple for the element itself and in
    // the landmark path for its descendants, and both have to pass.
    document.body.innerHTML = '<main><my_widget><img alt="x"></my_widget></main>';
    const host = document.querySelector('my_widget')!;
    const img = document.querySelector('img')!;

    expect(host.tagName.toLowerCase()).toBe('my_widget');
    expect(JSON.parse(elementKeyOf(img)).l, 'the tag never reached the path').toContain('my_widget');
    expect(JSON.parse(elementKeyOf(host)).e, 'the tag never reached the signature').toContain('my_widget');

    expect(accepts(elementKeyOf(img)), `rejected ${elementKeyOf(img)}`).toBe(true);
    expect(accepts(elementKeyOf(host)), `rejected ${elementKeyOf(host)}`).toBe(true);
  });

  it('rejects a malformed element signature or an unknown key field', () => {
    const l = ['document#0'];
    // `e` must itself parse to the 5-tuple elementSignature emits.
    expect(accepts(JSON.stringify({ v: 1, e: 'div', l, c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e: JSON.stringify(['div', '-', '-', []]), l, c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e: JSON.stringify(['div', '-', '-', [], [1]]), l, c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e: JSON.stringify(['d'.repeat(65), '-', '-', [], []]), l, c: null }))).toBe(false);
    // Version, component id, and the closed field set.
    const e = JSON.stringify(['div', '-', '-', [], []]);
    expect(accepts(JSON.stringify({ v: 2, e, l, c: null }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e, l, c: 'x'.repeat(65) }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e, l, c: null, extra: 1 }))).toBe(false);
    expect(accepts(JSON.stringify({ v: 1, e, l }))).toBe(false);
  });
});

describe('AttrsSchema (via RedactedElementSchema)', () => {
  it('rejects a value shape not paired with its key', () => {
    expect(RedactedElementSchema.safeParse({ tag: 'div', attrs: { role: { refs: 1, resolved: 1 } }, text: null }).success).toBe(false);
  });
  it('rejects an aria attribute outside the allowed set', () => {
    expect(RedactedElementSchema.safeParse({ tag: 'div', attrs: { 'aria-foo': 'x' }, text: null }).success).toBe(false);
  });
  it('rejects raw text where a text-like attribute expects a metrics object', () => {
    expect(RedactedElementSchema.safeParse({ tag: 'div', attrs: { 'aria-label': 'raw text' }, text: null }).success).toBe(false);
  });
  /**
   * `href` is a path, and a path can be long. Holding the string branch of the
   * union to 256 characters meant a 301-character link rejected the whole
   * beacon — every finding on the page lost for one URL. The per-key limits in
   * the superRefine are what actually matter: 64 for the token attributes,
   * 2,048 for `href`.
   */
  it('takes a long href without taking the beacon down, and still bounds the token keys', () => {
    const href = '/' + 'a'.repeat(300);
    expect(href).toHaveLength(301);
    expect(RedactedElementSchema.safeParse({ tag: 'a', attrs: { href }, text: null }).success).toBe(true);
    expect(RedactedElementSchema.safeParse({ tag: 'a', attrs: { href: '/' + 'a'.repeat(2048) }, text: null }).success).toBe(false);
    expect(RedactedElementSchema.safeParse({ tag: 'div', attrs: { role: 'x'.repeat(64) }, text: null }).success).toBe(true);
    expect(RedactedElementSchema.safeParse({ tag: 'div', attrs: { role: 'x'.repeat(65) }, text: null }).success).toBe(false);
  });

  it('accepts every allowed key/value-shape pairing at once', () => {
    expect(RedactedElementSchema.safeParse({
      tag: 'a',
      attrs: { for: true, href: '/x', 'aria-expanded': 'true', alt: { len: 1, words: 1 }, 'aria-describedby': { refs: 1, resolved: 1 } },
      text: null,
    }).success).toBe(true);
  });
});

describe('RumConfigSchema', () => {
  it('accepts config and rejects rates outside 0..1', () => {
    expect(RumConfigSchema.safeParse({ enabled: true, killSwitch: false, sampleRate: 0.05, boosted: [], endpoint: 'https://x', minCollector: '0.2.0' }).success).toBe(true);
    expect(RumConfigSchema.safeParse({ enabled: true, killSwitch: false, sampleRate: 1.5, boosted: [], endpoint: 'https://x', minCollector: '0.2.0' }).success).toBe(false);
  });
});

/**
 * The attribute redaction policy and the element-key validator used to be
 * reachable only from internal paths, so a server that wanted to validate
 * against the exact sets the client redacts with had to copy them. They are
 * now re-exported from `./protocol`'s public barrel — this locks that in.
 */
describe('protocol entry re-exports the attribute policy', () => {
  it('exposes the policy sets, the max value length, and the key validator from ../index', async () => {
    const entry = await import('../index');
    expect(entry.REDACT_VALUE_KEPT).toBeInstanceOf(Set);
    expect(entry.REDACT_PRESENCE_ONLY).toBeInstanceOf(Set);
    expect(entry.REDACT_TEXT_LIKE).toBeInstanceOf(Set);
    expect(entry.REDACT_IDREF).toBeInstanceOf(Set);
    expect(entry.HREF).toBe('href');
    expect(entry.REDACT_MAX_VALUE_LENGTH).toBe(64);
    expect(typeof entry.isValidElementKey).toBe('function');

    expect(entry.REDACT_VALUE_KEPT.size).toBe(25);
    expect(entry.REDACT_TEXT_LIKE.size).toBe(8);
    expect(entry.REDACT_IDREF.size).toBe(5);
    expect(entry.REDACT_PRESENCE_ONLY.size).toBe(1);
  });
});
