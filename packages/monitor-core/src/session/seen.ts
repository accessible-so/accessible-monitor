/**
 * Tracks which (signature, route) pairs have already been transmitted this
 * session, so the collector sends one beacon per barrier per route rather
 * than re-reporting it on every scan. Interactions ("the user touched this
 * broken element") are tracked in a separate set from findings. State is
 * mirrored to the given store under one key so a page reload within the
 * same session picks up where it left off; with no storage it still works,
 * purely in memory, for the lifetime of the page.
 */
import type { SessionStore } from './storage';

const STORAGE_KEY = 'a11y_rum_seen';

interface Persisted { f: string[]; i: string[] }

export interface SeenSetApi {
  has(sig: string, r: string | null): boolean;
  add(sig: string, r: string | null): void;
  hasInteraction(sig: string, r: string | null): boolean;
  addInteraction(sig: string, r: string | null): void;
}

function keyOf(sig: string, r: string | null): string {
  return `${sig}|${r ?? ''}`;
}

export function SeenSet(store: SessionStore): SeenSetApi {
  const persisted = store.get<Persisted>(STORAGE_KEY);
  const findings = new Set<string>(persisted?.f ?? []);
  const interactions = new Set<string>(persisted?.i ?? []);

  function persist(): void {
    store.set(STORAGE_KEY, { f: Array.from(findings), i: Array.from(interactions) });
  }

  return {
    has: (sig, r) => findings.has(keyOf(sig, r)),
    add: (sig, r) => {
      findings.add(keyOf(sig, r));
      persist();
    },
    hasInteraction: (sig, r) => interactions.has(keyOf(sig, r)),
    addInteraction: (sig, r) => {
      interactions.add(keyOf(sig, r));
      persist();
    },
  };
}
