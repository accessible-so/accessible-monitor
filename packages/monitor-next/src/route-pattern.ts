/**
 * `/products/red-shoes` + `{ slug: 'red-shoes' }` → `/products/[slug]`.
 *
 * Next hands the App Router two things at runtime — the concrete pathname and
 * the params it matched — but not the pattern itself. Rebuilding it is a
 * segment-wise substitution: every segment equal to a param's value becomes
 * `[key]`, a catch-all's segments become one `[...key]`. Whole segments only,
 * so `10` never matches inside `/p/1/10`; percent-decoding so `a%20b` matches
 * `'a b'`. A param whose value is nowhere in the path leaves the path alone,
 * and so does any ambiguity about which key owns which segment — two params
 * sharing a value, a scalar matching more than one segment, or a catch-all
 * run matching more than one position — because a wrong or mislabeled
 * pattern is worse than the raw path.
 */
export function routePatternFor(
  pathname: string,
  params: Record<string, string | string[]> | null | undefined,
): string | null {
  if (!pathname) return null;
  if (!params) return pathname;
  const segments = pathname.split('/');
  const decoded = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : true),
  );

  // Give up on ambiguity rather than guess which key owns which segment.
  const seenValueKeys = new Set<string>();
  for (const [, value] of entries) {
    const key = valueKey(value);
    if (seenValueKeys.has(key)) return pathname;
    seenValueKeys.add(key);
  }
  for (const [, value] of entries) {
    if (Array.isArray(value)) {
      if (countRuns(decoded, value) > 1) return pathname;
    } else if (countOccurrences(decoded, value) > 1) {
      return pathname;
    }
  }

  const ordered = entries
    .slice()
    // Longest values first so `[...parts]` wins over a same-named single param.
    .sort((a, b) => valueLength(b[1]) - valueLength(a[1]));
  for (const [key, value] of ordered) {
    if (Array.isArray(value)) {
      const start = findRun(decoded, value);
      if (start === -1) continue;
      segments.splice(start, value.length, `[...${key}]`);
      decoded.splice(start, value.length, `[...${key}]`);
    } else {
      const i = decoded.indexOf(value);
      if (i === -1) continue;
      segments[i] = `[${key}]`;
      decoded[i] = `[${key}]`;
    }
  }
  return segments.join('/');
}

function valueKey(v: string | string[]): string {
  return Array.isArray(v) ? v.join('/') : v;
}

function valueLength(v: string | string[]): number {
  return Array.isArray(v) ? v.length : 1;
}

function countOccurrences(hay: string[], value: string): number {
  let count = 0;
  for (const s of hay) if (s === value) count++;
  return count;
}

function countRuns(hay: string[], run: string[]): number {
  let count = 0;
  for (let i = 0; i + run.length <= hay.length; i++) {
    if (run.every((s, j) => hay[i + j] === s)) count++;
  }
  return count;
}

function findRun(hay: string[], run: string[]): number {
  for (let i = 0; i + run.length <= hay.length; i++) {
    if (run.every((s, j) => hay[i + j] === s)) return i;
  }
  return -1;
}

/** The last N concrete paths and their patterns, so a finding on an earlier page still resolves. */
export class RouteMap {
  private readonly entries = new Map<string, string | null>();
  constructor(private readonly max = 50) {}

  set(path: string, pattern: string | null): void {
    this.entries.delete(path);
    this.entries.set(path, pattern);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get(path: string): string | null {
    return this.entries.get(path) ?? null;
  }

  get size(): number {
    return this.entries.size;
  }
}
