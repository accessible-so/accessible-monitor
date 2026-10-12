/**
 * Predicting what a task will cost on this page, on this device, and naming
 * what fits (spec §3.1, §3.3).
 *
 * A part's cost is the page's first `axe.run` times a factor that grows with
 * the page: `firstRunMs × (base + perThousand × elements / 1000)`. The first
 * run measures this page on this device, mostly the document-wide floor axe
 * pays on every run. Costs are not per element alone: the floor has a fixed
 * part, so a 120-element page on a fast laptop would come out "slow". Nor are
 * they a constant multiple of the first run: contrast builds a grid over the
 * whole page, so its cost grows with the page while the first run barely does
 * (measured: 3.7x the first run at 120 elements, 17.6x at 1,121).
 *
 * The coefficients bound the fixtures measured in methodology §4.1, which are
 * heavier per element than real pages. A part that has run once this session
 * replaces the model with its own measured ratio (`learnedFactor`), up or down.
 */
import type { PageTier } from '../protocol/types';
import { IDLE_BUDGET_MS } from './scheduler';

export type DocCostPartName = 'grid' | 'region';

export const PART_COST: Readonly<Record<DocCostPartName, { base: number; perThousand: number }>> = {
  grid: { base: 3, perThousand: 15 },
  region: { base: 0.5, perThousand: 0.8 },
};

/** Margin on a measured ratio: the next page may be a little heavier than the one measured. */
export const LEARNED_HEADROOM = 1.25;
/** A measured ratio below this is treated as this: one lucky run never makes a part nearly free. */
export const LEARNED_FLOOR = 0.25;

/**
 * The factor on the model for a part whose largest measured `actualMs / modelMs`
 * this session is `measured`: 1 (the pure model) before any measurement.
 */
export function learnedFactor(measured: number | undefined): number {
  return measured === undefined ? 1 : Math.max(LEARNED_FLOOR, measured) * LEARNED_HEADROOM;
}

const ACTIVE_BUDGET_MS = 50;
const ORDER: Record<PageTier, number> = { fast: 0, medium: 1, slow: 2 };

/** The model's prediction, before any learned factor. */
export function modelPartMs(firstRunMs: number, elements: number, cost: { base: number; perThousand: number }): number {
  return firstRunMs * (cost.base + (cost.perThousand * elements) / 1000);
}

export function predictPartMs(
  firstRunMs: number | null,
  elements: number,
  cost: { base: number; perThousand: number },
  factor = 1,
): number | null {
  return firstRunMs === null ? null : modelPartMs(firstRunMs, elements, cost) * factor;
}

export function pageTier(
  firstRunMs: number,
  elements: number,
  costs: Readonly<Record<DocCostPartName, { base: number; perThousand: number }>> = PART_COST,
  activeBudgetMs = ACTIVE_BUDGET_MS,
  idleBudgetMs = IDLE_BUDGET_MS,
  /** Per-part `learnedFactor`s; a part not listed is the pure model. */
  factors: Partial<Record<DocCostPartName, number>> = {},
): PageTier {
  if (firstRunMs <= 0) return 'medium'; // coarsened timers: unmeasured, never 'fast'
  if (firstRunMs > activeBudgetMs) return 'slow';
  const fits = (Object.keys(costs) as DocCostPartName[]).every((p) => modelPartMs(firstRunMs, elements, costs[p]) * (factors[p] ?? 1) <= idleBudgetMs);
  return fits ? 'fast' : 'medium';
}

export function slower(a: PageTier | null, b: PageTier | null): PageTier | null {
  if (!a) return b;
  if (!b) return a;
  return ORDER[a] >= ORDER[b] ? a : b;
}
