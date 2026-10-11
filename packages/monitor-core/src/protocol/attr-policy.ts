/**
 * The attribute policy shared by the client-side redactor and the
 * server-side beacon schema. Both sides import these same sets so they can
 * never drift apart — the schema is the backstop that runs on ingest, so it
 * must accept exactly the key/value-shape pairs the redactor can produce,
 * nothing looser. This module is DOM-free and zod-free on purpose: the
 * redactor (browser) and the schema (server, via zod) both depend on it
 * without pulling in the other's runtime.
 */

export const REDACT_VALUE_KEPT: ReadonlySet<string> = new Set([
  'role', 'type', 'tabindex', 'lang', 'data-a11y-component', 'data-a11y-source',
  'aria-hidden', 'aria-expanded', 'aria-required', 'aria-invalid', 'aria-haspopup', 'aria-live', 'aria-current',
  'aria-checked', 'aria-disabled', 'aria-selected', 'aria-pressed', 'aria-level', 'aria-modal', 'aria-atomic',
  'aria-busy', 'aria-multiline', 'aria-readonly', 'aria-sort', 'aria-orientation',
]);
// `data-a11y-source` is a file path a build tool stamped onto the element at
// build time (e.g. "src/Buy.tsx:12") — it never carries user data, so it is
// safe to keep verbatim like the other token attributes above.

export const REDACT_PRESENCE_ONLY: ReadonlySet<string> = new Set(['for']);

export const REDACT_TEXT_LIKE: ReadonlySet<string> = new Set([
  'alt', 'title', 'placeholder', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription',
]);

export const REDACT_IDREF: ReadonlySet<string> = new Set([
  'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant',
]);

export const HREF = 'href';

/** Value-kept attributes are truncated to this many characters before being sent. */
export const REDACT_MAX_VALUE_LENGTH = 64;
