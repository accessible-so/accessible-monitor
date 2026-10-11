import { describe, expect, it } from 'vitest';
import { sessionStore } from '../storage';
import { SeenSet } from '../seen';

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  constructor(private throwOnSet = false) {}
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('quota exceeded');
    this.map.set(key, value);
  }
  removeItem(key: string): void { this.map.delete(key); }
  key(index: number): string | null { return Array.from(this.map.keys())[index] ?? null; }
  clear(): void { this.map.clear(); }
  get length(): number { return this.map.size; }
}

describe('SeenSet', () => {
  it('reports false before add and true after', () => {
    const seen = SeenSet(sessionStore(new FakeStorage()));
    expect(seen.has('s1:abc', '/home')).toBe(false);
    seen.add('s1:abc', '/home');
    expect(seen.has('s1:abc', '/home')).toBe(true);
  });

  it('persists across a second SeenSet built on the same fake storage', () => {
    const storage = new FakeStorage();
    const first = SeenSet(sessionStore(storage));
    first.add('s1:abc', '/home');
    const second = SeenSet(sessionStore(storage));
    expect(second.has('s1:abc', '/home')).toBe(true);
  });

  it('tracks interactions separately from findings', () => {
    const seen = SeenSet(sessionStore(new FakeStorage()));
    seen.addInteraction('s1:abc', '/home');
    expect(seen.hasInteraction('s1:abc', '/home')).toBe(true);
    expect(seen.has('s1:abc', '/home')).toBe(false);
  });

  it('works entirely in memory when storage is null', () => {
    const seen = SeenSet(sessionStore(null));
    expect(seen.has('s1:abc', '/home')).toBe(false);
    seen.add('s1:abc', '/home');
    expect(seen.has('s1:abc', '/home')).toBe(true);
  });

  it('tolerates a storage whose setItem throws', () => {
    const seen = SeenSet(sessionStore(new FakeStorage(true)));
    expect(() => seen.add('s1:abc', '/home')).not.toThrow();
    expect(seen.has('s1:abc', '/home')).toBe(true);
  });
});
