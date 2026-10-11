import { z } from 'zod';
import { HREF, REDACT_IDREF, REDACT_PRESENCE_ONLY, REDACT_TEXT_LIKE, REDACT_VALUE_KEPT } from './attr-policy';

const SIG = /^s1:[0-9a-f]{32}$/;
const PATH = z.string().min(1).max(2048).refine((p) => !p.includes('?') && !p.includes('#'), 'no query or fragment');
const short = z.string().max(256);

const TextMetricsSchema = z.object({ length: z.number().int().min(0), words: z.number().int().min(0), knownBad: z.boolean() }).strict();
// The string branch is as wide as the widest string the redactor can emit,
// which is `href` (a same-origin path, capped at 2048). The superRefine below
// is what actually holds each key to its own limit — 64 for the token
// attributes, 2048 for `href` — so a long path no longer takes the whole
// beacon down with it.
const AttrValueSchema = z.union([
  z.string().max(2048), z.literal(true),
  z.object({ len: z.number().int().min(0), words: z.number().int().min(0) }).strict(),
  z.object({ refs: z.number().int().min(0), resolved: z.number().int().min(0) }).strict(),
]);

const isTextLikeValue = (v: unknown): v is { len: number; words: number } =>
  typeof v === 'object' && v !== null && 'len' in v && 'words' in v;
const isIdrefValue = (v: unknown): v is { refs: number; resolved: number } =>
  typeof v === 'object' && v !== null && 'refs' in v && 'resolved' in v;

// The redactor emits a closed key set with exactly one value shape per key
// (see attr-policy.ts). This is the server-side backstop, so it must accept
// exactly that — not merely "some allowed key with some allowed shape" — or a
// compromised or buggy client could pair, say, an idref count onto `role`.
const AttrsSchema = z.record(z.string(), AttrValueSchema).superRefine((attrs, ctx) => {
  const keys = Object.keys(attrs);
  if (keys.length > 32) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'too many attributes' });
  for (const key of keys) {
    const value = attrs[key];
    if (REDACT_VALUE_KEPT.has(key)) {
      if (typeof value !== 'string' || value.length > 64) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'expected a short token string' });
      }
    } else if (REDACT_PRESENCE_ONLY.has(key)) {
      if (value !== true) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'expected true' });
    } else if (REDACT_TEXT_LIKE.has(key)) {
      if (!isTextLikeValue(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'expected { len, words }' });
    } else if (REDACT_IDREF.has(key)) {
      if (!isIdrefValue(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'expected { refs, resolved }' });
    } else if (key === HREF) {
      if (typeof value !== 'string' || value.length > 2048) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'expected a path string' });
    } else {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'attribute not allowed' });
    }
  }
});

const LeafElement = z.object({ tag: short, attrs: AttrsSchema, text: TextMetricsSchema.nullable() }).strict();
export const RedactedElementSchema = LeafElement.extend({
  parent: LeafElement.nullable().optional(),
  children: z.array(LeafElement).max(2).optional(),
}).strict();

/**
 * `findings[].key` — the one field on the wire whose contents the client
 * composes as free-form text rather than the schema naming each part.
 *
 * It is `elementKeyOf`'s output: JSON for `{ v, e, l, c }`, where `e` is
 * itself the JSON 5-tuple `elementSignature` produces. Accepting "any string
 * under 4KB" made it the one place a compromised or buggy client could put a
 * sentence of user text on the wire, so the schema parses it and checks the
 * structure instead. Anything that is not that exact shape is rejected — the
 * server would not be able to recompute a signature from it anyway.
 */
const KEY_MAX_BYTES = 4096;
/**
 * Landmark path entries: `main#1-3`, `document#0`, or an ancestor's tag name.
 *
 * The character class is the one a tag name can actually use. `_` is in it
 * because a custom element name may legally contain one (`<my_widget>`), and
 * leaving it out would have rejected the landmark path — and so silently
 * dropped every finding — on any page that ships such an element.
 */
const KEY_PATH_ENTRY = /^[a-z0-9#+._:-]{1,64}$/i;
const KEY_MAX_PATH = 12;
const KEY_MAX_TOKEN = 64;
/** Attribute names and normalised class tokens: bounded, but generously. */
const KEY_MAX_TOKENS = 128;

function isTokenList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= KEY_MAX_TOKENS &&
    value.every((t) => typeof t === 'string' && t.length <= KEY_MAX_TOKEN)
  );
}

/** The `e` field: `JSON.stringify([tag, role, type, attrNames, classes])`. */
function isElementSignature(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return false;
  const [tag, role, type, attrNames, classes] = parsed as unknown[];
  for (const token of [tag, role, type]) {
    if (typeof token !== 'string' || token.length > KEY_MAX_TOKEN) return false;
  }
  return isTokenList(attrNames) && isTokenList(classes);
}

export function isValidElementKey(raw: string): boolean {
  if (raw.length > KEY_MAX_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const key = parsed as Record<string, unknown>;
  const names = Object.keys(key);
  if (names.length !== 4 || !['v', 'e', 'l', 'c'].every((n) => names.includes(n))) return false;
  if (key.v !== 1) return false;
  if (!isElementSignature(key.e)) return false;
  if (key.c !== null && !(typeof key.c === 'string' && key.c.length <= KEY_MAX_TOKEN)) return false;
  if (!Array.isArray(key.l) || key.l.length > KEY_MAX_PATH) return false;
  return key.l.every((entry) => typeof entry === 'string' && KEY_PATH_ENTRY.test(entry));
}

const ElementKeySchema = z
  .string()
  .max(KEY_MAX_BYTES)
  .refine(isValidElementKey, 'not a well-formed element key')
  .nullable();

export const NavigationModeSchema = z.enum(['keyboard-driven', 'pointer-driven', 'mixed', 'unknown']);
export const RumContextSchema = z.object({
  vw: z.number().int().min(0), vh: z.number().int().min(0), dpr: z.number().positive(), zoom: z.number().positive(),
  fontPx: z.number().positive(), navigationMode: NavigationModeSchema,
}).strict();

export const RumFindingSchema = z.object({
  sig: z.string().regex(SIG), key: ElementKeySchema, rule: short,
  confidence: z.enum(['rule', 'heuristic']), impact: z.enum(['critical', 'serious', 'moderate', 'minor']).nullable(),
  wcag: z.array(z.string().regex(/^\d\.\d{1,2}\.\d{1,2}$/)).max(8),
  p: PATH, r: z.string().max(2048).nullable(), el: RedactedElementSchema,
  comp: z.object({ id: short, source: short.optional() }).strict().nullable(),
  n: z.number().int().min(1), i: z.boolean(),
}).strict();

export const RumBeaconSchema = z.object({
  v: z.literal(1), k: z.string().regex(/^acc_rum_[0-9a-f]{24}$/), s: z.string().regex(/^[0-9a-f]{32}$/), c: z.string().max(32),
  sent: z.number().int().positive(), ctx: RumContextSchema,
  session: z.object({ started: z.literal(true) }).strict().optional(),
  routes: z.array(z.object({ p: PATH, r: z.string().max(2048).nullable() }).strict()).max(100).optional(),
  findings: z.array(RumFindingSchema).max(200).optional(),
  interactions: z.array(z.object({ sig: z.string().regex(SIG), r: z.string().max(2048).nullable() }).strict()).max(200).optional(),
  perf: z.object({
    scans: z.number().int().min(0),
    longTasks: z.number().int().min(0),
    maxTaskMs: z.number().min(0),
    aborted: z.boolean(),
    // Rules the engine chose not to run at all (the document-cost set on a
    // page too large to afford it). Absent when nothing was skipped.
    skipped: z.array(z.string().max(64)).max(16).optional(),
    // Rules whose pass has been deferred and has not run yet. A rule is never
    // in both lists: it leaves `pending` for `skipped` if the pass is
    // abandoned, and leaves both if it runs.
    pending: z.array(z.string().max(64)).max(16).optional(),
  }).strict().optional(),
}).strict();

export const RumConfigSchema = z.object({
  enabled: z.boolean(), killSwitch: z.boolean(), sampleRate: z.number().min(0).max(1),
  boosted: z.array(z.object({ pattern: z.string().max(2048), rate: z.number().min(0).max(1) }).strict()).max(50),
  endpoint: z.string().url(), minCollector: z.string().max(32),
}).strict();

export type RumBeaconInput = z.input<typeof RumBeaconSchema>;
