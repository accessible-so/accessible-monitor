/**
 * A tiny JSON-over-Storage wrapper. Reads and writes never throw: a full or
 * disabled `sessionStorage` (quota errors, privacy-mode `SecurityError`, or
 * no storage at all — `storage` is `null`) degrades to "nothing persisted"
 * rather than breaking the caller.
 */

export interface SessionStore {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

export function sessionStore(storage: Storage | null): SessionStore {
  return {
    get<T>(key: string): T | null {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },
    set(key: string, value: unknown): void {
      if (!storage) return;
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch {
        // Quota exceeded, SecurityError in a locked-down context, etc. —
        // in-memory callers (SeenSet) keep working; persistence is best-effort.
      }
    },
  };
}
