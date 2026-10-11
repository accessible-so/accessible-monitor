/**
 * Sampling decisions for RUM collection. A session either is or isn't
 * sampled; the caller is responsible for making the decision sticky across
 * the session (deciding once and storing the result). `forced` always wins
 * (debug/QA override), then a boosted per-route rate can raise — never
 * lower — the base rate for paths that match its pattern.
 */

export function matchRoutePattern(pattern: string, path: string): boolean {
  const patternSegs = pattern.split('/').filter(Boolean);
  const pathSegs = path.split('/').filter(Boolean);

  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i]!;
    if (seg.startsWith('[...') && seg.endsWith(']')) {
      // Catch-all: must consume at least one remaining segment, and must be
      // the last pattern segment.
      return i === patternSegs.length - 1 && pathSegs.length - i >= 1;
    }
    if (seg.startsWith('[') && seg.endsWith(']')) {
      if (pathSegs[i] === undefined || pathSegs[i] === '') return false;
      continue;
    }
    if (pathSegs[i] !== seg) return false;
  }
  return pathSegs.length === patternSegs.length;
}

export function decideSampling(input: {
  rate: number;
  boosted: { pattern: string; rate: number }[];
  path: string;
  forced: boolean;
  random: () => number;
}): boolean {
  if (input.forced) return true;
  const boost = input.boosted.find((b) => matchRoutePattern(b.pattern, input.path));
  const rate = Math.max(input.rate, boost?.rate ?? 0);
  return input.random() < rate;
}
