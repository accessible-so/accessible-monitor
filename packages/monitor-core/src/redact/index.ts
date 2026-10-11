/**
 * Client-side redaction (spec 5.6). Everything here runs before a finding is
 * queued, and the web tier re-applies the same policy on ingest. Text never
 * leaves the page: only its length, word count, and a known-bad flag do.
 */
import type { AttrValue, RedactedElement, TextMetrics } from '../protocol/types';
import { HREF, REDACT_IDREF, REDACT_MAX_VALUE_LENGTH, REDACT_PRESENCE_ONLY, REDACT_TEXT_LIKE, REDACT_VALUE_KEPT } from '../protocol/attr-policy';

const KNOWN_BAD = new Set(['click here', 'read more', 'here', 'learn more', 'link', 'more', 'this']);

export function textMetrics(text: string | null | undefined): TextMetrics | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const words = t.split(' ').length;
  return { length: t.length, words, knownBad: KNOWN_BAD.has(t.toLowerCase()) };
}

export function redactHref(value: string, origin: string): string {
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin || !/^https?:$/.test(u.protocol)) return 'external';
    return u.pathname || '/';
  } catch {
    return 'external';
  }
}

function redactAttrs(el: Element): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const { name, value } of Array.from(el.attributes)) {
    const n = name.toLowerCase();
    if (REDACT_VALUE_KEPT.has(n)) out[n] = value.slice(0, REDACT_MAX_VALUE_LENGTH);
    else if (REDACT_PRESENCE_ONLY.has(n)) out[n] = true;
    else if (REDACT_TEXT_LIKE.has(n)) { const m = textMetrics(value); out[n] = { len: m?.length ?? 0, words: m?.words ?? 0 }; }
    else if (REDACT_IDREF.has(n)) {
      const ids = value.split(/\s+/).filter(Boolean);
      const resolved = ids.filter((id) => typeof root.getElementById === 'function' && root.getElementById(id)).length;
      out[n] = { refs: ids.length, resolved };
    } else if (n === HREF) out[HREF] = redactHref(value, location.origin);
    // everything else — id, class, name, value, src, style, data-*, on* — is dropped
  }
  return out;
}

function leaf(el: Element): RedactedElement {
  return { tag: el.tagName.toLowerCase(), attrs: redactAttrs(el), text: textMetrics(el.textContent) };
}

export function redactElement(el: Element): RedactedElement {
  const out = leaf(el);
  const parent = el.parentElement;
  out.parent = parent ? leaf(parent) : null;
  const kids = Array.from(el.children).slice(0, 2);
  if (kids.length) out.children = kids.map(leaf);
  return out;
}
