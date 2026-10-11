/**
 * Barrier signature (version s1).
 *
 * A structural identity for an accessibility defect that stays the same across
 * pages, deploys, and the tier that found it (static scan, real-user monitoring,
 * journey test). Everything here is layout-independent on purpose. It reads tag
 * names, attribute *names*, the values of `role` and `type`, normalised class
 * tokens, landmark ancestry, and — when a build tool stamped it — the
 * `data-a11y-component` identifier, a developer-chosen component name that
 * never carries user data. Accessible names of landmarks enter only as a
 * word-count bucket (0, 1-3, 4-8, 9+) — never the text. It never reads text,
 * any other attribute value, computed styles, or URLs; the criterion-level
 * fallback embeds only a bare route path with no host, query, or fragment.
 *
 * Rule keys are criterion-namespaced whenever the finding maps to a WCAG
 * success criterion (`wcag:1.1.1`), so every tier agrees on one identity for
 * the same element; `axe:<ruleId>` is left for best-practice rules that fail
 * no criterion, and `obs:<observerId>` for behavioral observers.
 */
import { sha256Hex } from './sha256';

export { sha256Hex };
export const SIGNATURE_VERSION = 's1' as const;

export interface SignatureParts {
  ruleKey: string;
  elementSig: string;
  landmarkPath: string[];
  componentId: string | null;
}

const ALLOWLISTED_ATTR = /^(role|alt|type|tabindex|lang|for|href|aria-[a-z0-9-]+|data-a11y-[a-z0-9-]+)$/;
const HASH_SUFFIX = /[_-]([a-z0-9]{5,})$/i;
const IMPLICIT_LANDMARK: Record<string, string> = {
  main: 'main',
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  search: 'search',
  dialog: 'dialog',
};
const EXPLICIT_LANDMARK = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'region', 'form', 'dialog', 'alertdialog',
]);
const MAX_PATH = 8;

function isHashLike(token: string): boolean {
  if (token.length < 6 || !/^[a-z0-9]+$/i.test(token) || !/\d/.test(token) || !/[a-z]/i.test(token)) return false;
  // A hash interleaves letters and digits; a readable name with a trailing
  // number ("button2") switches class once. Two or more switches is a hash.
  let transitions = 0;
  for (let i = 1; i < token.length; i++) {
    const wasDigit = /\d/.test(token[i - 1]!);
    const isDigit = /\d/.test(token[i]!);
    if (wasDigit !== isDigit) transitions++;
  }
  return transitions >= 2;
}

export function normalizeClassTokens(tokens: Iterable<string>): string[] {
  const kept = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token || token.includes('[')) continue;
    const suffix = HASH_SUFFIX.exec(token);
    if (suffix && /\d/.test(suffix[1]!)) continue;
    if (isHashLike(token)) continue;
    kept.add(token);
  }
  return [...kept].sort();
}

function parentOf(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode() as Node & { host?: Element };
  return root && root.host ? root.host : null;
}

function countWords(text: string | null | undefined): number {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

function nameBucket(el: Element): string {
  let words = 0;
  const label = el.getAttribute('aria-label');
  if (label) {
    words = countWords(label);
  } else {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const root = el.getRootNode() as Document | ShadowRoot;
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        const target = typeof root.getElementById === 'function' ? root.getElementById(id) : null;
        words += countWords(target?.textContent);
      }
    }
  }
  if (words === 0) return '0';
  if (words <= 3) return '1-3';
  if (words <= 8) return '4-8';
  return '9+';
}

function landmarkRoleOf(el: Element): string | null {
  const role = (el.getAttribute('role') || '').trim().toLowerCase();
  if (role) return EXPLICIT_LANDMARK.has(role) ? role : null;
  const tag = el.tagName.toLowerCase();
  const implicit = IMPLICIT_LANDMARK[tag];
  if (implicit) return implicit;
  const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
  if (tag === 'section' && named) return 'region';
  if (tag === 'form' && named) return 'form';
  return null;
}

function isAnonymousWrapper(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'div' && tag !== 'span') return false;
  if (el.hasAttribute('data-a11y-component')) return false;
  for (const attr of Array.from(el.attributes)) {
    if (ALLOWLISTED_ATTR.test(attr.name.toLowerCase())) return false;
  }
  return true;
}

function collapse(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) if (out[out.length - 1] !== t) out.push(t);
  return out;
}

export function elementSignature(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').trim().toLowerCase() || '-';
  const type = (el.getAttribute('type') || '').trim().toLowerCase() || '-';
  const attrNames = Array.from(el.attributes)
    .map((a) => a.name.toLowerCase())
    .filter((n) => ALLOWLISTED_ATTR.test(n))
    .sort();
  const classes = normalizeClassTokens(Array.from(el.classList));
  return JSON.stringify([tag, role, type, attrNames, classes]);
}

export function landmarkPath(el: Element): string[] {
  const ancestors: string[] = [];
  let node = parentOf(el);
  while (node) {
    const landmark = landmarkRoleOf(node);
    if (landmark) {
      return [`${landmark}#${nameBucket(node)}`, ...collapse(ancestors.reverse()).slice(-MAX_PATH)];
    }
    // Layout wrappers come and go with every restyle; they carry no meaning
    // for the defect, so they carry no weight in its identity.
    if (!isAnonymousWrapper(node)) ancestors.push(node.tagName.toLowerCase());
    node = parentOf(node);
  }
  return ['document#0', ...collapse(ancestors.reverse()).slice(-MAX_PATH)];
}

export function componentIdOf(el: Element): string | null {
  let node: Element | null = el;
  while (node) {
    const id = node.getAttribute('data-a11y-component');
    if (id) return id;
    node = parentOf(node);
  }
  return null;
}

export function signatureParts(el: Element, ruleKey: string): SignatureParts {
  return { ruleKey, elementSig: elementSignature(el), landmarkPath: landmarkPath(el), componentId: componentIdOf(el) };
}

export function signatureFromParts(parts: SignatureParts): string {
  const input = JSON.stringify([parts.ruleKey, parts.elementSig, parts.landmarkPath, parts.componentId]);
  return `${SIGNATURE_VERSION}:${sha256Hex(input).slice(0, 32)}`;
}

export function computeSignature(el: Element, ruleKey: string): string {
  return signatureFromParts(signatureParts(el, ruleKey));
}

/**
 * Element keys let a tier that learns the rule *later* (a journey executor that
 * decides a WCAG criterion after it has moved on) still produce the same
 * signature the element would have received directly.
 */
interface ElementKeyV1 { v: 1; e: string; l: string[]; c: string | null }

export function elementKeyOf(el: Element): string {
  const key: ElementKeyV1 = { v: 1, e: elementSignature(el), l: landmarkPath(el), c: componentIdOf(el) };
  return JSON.stringify(key);
}

export function parseElementKey(key: string): Omit<SignatureParts, 'ruleKey'> | null {
  try {
    const parsed = JSON.parse(key) as Partial<ElementKeyV1>;
    if (parsed.v !== 1 || typeof parsed.e !== 'string' || !Array.isArray(parsed.l)) return null;
    if (!parsed.l.every((x) => typeof x === 'string')) return null;
    return { elementSig: parsed.e, landmarkPath: parsed.l, componentId: typeof parsed.c === 'string' ? parsed.c : null };
  } catch {
    return null;
  }
}

export function signatureFromElementKey(key: string, ruleKey: string): string | null {
  const parts = parseElementKey(key);
  return parts ? signatureFromParts({ ruleKey, ...parts }) : null;
}

/** Criterion-level identity for a finding with no resolvable element. */
export function fallbackSignature(ruleKey: string, routePath: string): string {
  return signatureFromParts({ ruleKey, elementSig: '-', landmarkPath: [routePath], componentId: null });
}

const AXE_WCAG_TAG = /^wcag([1-4])(\d)(\d{1,2})$/;

/**
 * The WCAG success criterion an axe rule reports, from its tags: "wcag111" is
 * 1.1.1, "wcag2412" is 2.4.12. Principles are 1–4 and guidelines a single
 * digit, so the split is unambiguous. Level tags ("wcag2a", "wcag21aa") and
 * category tags never match. Returns the first criterion tag, or null.
 */
export function criterionFromAxeTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const m = AXE_WCAG_TAG.exec(tag);
    if (m) return `${m[1]}.${m[2]}.${Number(m[3])}`;
  }
  return null;
}

/**
 * Rule key for an axe finding. Criterion-namespaced whenever the rule maps to a
 * success criterion, so a scan, a real-user session, and a journey test that
 * hit the same element under the same criterion share one signature. Only
 * best-practice rules, which have no criterion, keep the axe namespace.
 */
export function ruleKeyForAxe(ruleId: string, tags: readonly string[]): string {
  const criterion = criterionFromAxeTags(tags);
  return criterion ? `wcag:${criterion}` : `axe:${ruleId}`;
}

/** Every distinct WCAG success criterion an axe rule's tags report, in tag order. */
export function criteriaFromAxeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) { const m = AXE_WCAG_TAG.exec(tag); if (m) out.push(`${m[1]}.${m[2]}.${Number(m[3])}`); }
  return [...new Set(out)];
}

/** The nearest `data-a11y-source` build-tool stamp, including the element itself. */
export function componentSourceOf(el: Element): string | null {
  let node: Element | null = el;
  while (node) { const s = node.getAttribute('data-a11y-source'); if (s) return s; node = parentOf(node); }
  return null;
}
