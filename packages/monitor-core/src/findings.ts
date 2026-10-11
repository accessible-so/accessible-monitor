/**
 * Turning an element into a finding — the one place the protocol's finding
 * shape is built.
 *
 * A barrier is reported once per (signature, route) per session; further
 * occurrences only raise `n` on the finding while it is still queued. The
 * element itself is remembered in a `WeakMap` so a later click or keypress on
 * it can flip `i` without holding the DOM alive.
 *
 * A click can land before the scan reaches its element — on a slow device the
 * scan parks after one long task and only finishes at tab-hide. Those targets
 * wait in a short list and are attributed when a recorded element contains
 * them, so a touched barrier is still flagged on the devices that park.
 */
import { computeSignature, componentIdOf, componentSourceOf, elementKeyOf } from './signature/index';
import { redactElement } from './redact/index';
import type { SeenSetApi } from './session/seen';
import type { TransportApi } from './transport/index';
import type { CollectorAdapter } from './adapter';
import type { Confidence, Impact, RumFinding } from './protocol/types';

export interface FindingRecorderOptions {
  transport: TransportApi;
  seen: SeenSetApi;
  /** Resolved fresh on every call — see `resolveAdapter` in `./adapter`. */
  adapter: () => CollectorAdapter | null;
  path: () => string;
  pattern: () => string | null;
  debug: (...args: unknown[]) => void;
}

export interface FindingRecorderApi {
  record(el: Element, rule: string, impact: Impact | null, wcag: string[], confidence: Confidence): void;
  interact(target: EventTarget | null): void;
}

const keyOf = (sig: string, r: string | null): string => `${sig}|${r ?? ''}`;

/** Unattributed interaction targets kept at once; the oldest drop first. */
const MAX_PENDING = 32;

export function FindingRecorder(opts: FindingRecorderOptions): FindingRecorderApi {
  const { transport, seen, adapter, path, pattern, debug } = opts;
  const queued = new Map<string, RumFinding>();
  const sigs = new WeakMap<Element, { sig: string; r: string | null }>();
  let pending: Element[] = [];

  /**
   * Credits the nearest recorded element at or above `target`; false if there
   * is none yet. The walk stops below <body>: page-level findings (a missing
   * title or lang) sit on <html>, and a click anywhere is not touching them.
   */
  function attribute(target: Element): boolean {
    const doc = target.ownerDocument;
    let node: Element | null = target;
    while (node && node !== doc.body && node !== doc.documentElement) {
      const hit = sigs.get(node);
      if (hit) {
        if (!seen.hasInteraction(hit.sig, hit.r)) {
          seen.addInteraction(hit.sig, hit.r);
          const finding = queued.get(keyOf(hit.sig, hit.r));
          if (finding) finding.i = true;
          else transport.queueInteraction(hit.sig, hit.r);
        }
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function settlePending(el: Element): void {
    if (pending.length === 0) return;
    const reached = pending.filter((t) => el.contains(t));
    if (reached.length === 0) return;
    pending = pending.filter((t) => !el.contains(t));
    for (const t of reached) attribute(t);
  }

  function componentOf(el: Element): { id: string; source?: string } | null {
    try {
      const fromAdapter = adapter()?.attribution?.componentOf?.(el);
      if (fromAdapter) return fromAdapter;
    } catch {
      // A throwing adapter falls back to the build stamps.
    }
    const id = componentIdOf(el);
    if (!id) return null;
    const source = componentSourceOf(el);
    return source ? { id, source } : { id };
  }

  return {
    record(el, rule, impact, wcag, confidence): void {
      try {
        const sig = computeSignature(el, rule);
        const r = pattern();
        sigs.set(el, { sig, r });
        const key = keyOf(sig, r);
        if (seen.has(sig, r)) {
          // Already reported on this route this session: count the recurrence
          // if the finding is still queued, otherwise it is old news.
          const existing = queued.get(key);
          if (existing) existing.n++;
          return;
        }
        seen.add(sig, r);
        const finding: RumFinding = {
          sig,
          key: elementKeyOf(el),
          rule,
          confidence,
          impact,
          wcag,
          p: path(),
          r,
          el: redactElement(el),
          comp: componentOf(el),
          n: 1,
          i: false,
        };
        queued.set(key, finding);
        transport.queueFinding(finding);
        debug('finding', rule, sig);
      } catch (err) {
        debug('record failed', err);
      }
      try { settlePending(el); } catch (err) { debug('interaction failed', err); }
    },

    interact(target): void {
      try {
        if (!(target instanceof Element) || attribute(target) || pending.includes(target)) return;
        pending.push(target);
        if (pending.length > MAX_PENDING) pending.shift();
      } catch (err) {
        debug('interaction failed', err);
      }
    },
  };
}
