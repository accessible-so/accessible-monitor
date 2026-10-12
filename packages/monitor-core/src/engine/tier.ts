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
 * The coefficients bound the fixtures measured in methodology §4.1. A part that
 * still runs longer than predicted raises a per-page `learned` multiplier, so
 * the mistake is made once per page.
 */
import type { PageTier } from '../protocol/types';
import { IDLE_BUDGET_MS } from './scheduler';

export type DocCostPartName = 'grid' | 'region';

export const PART_COST: Readonly<Record<DocCostPartName, { base: number; perThousand: number }>> = {
  grid: { base: 3, perThousand: 15 },
  region: { base: 0.5, perThousand: 0.8 },
};

const ACTIVE_BUDGET_MS = 50;
const ORDER: Record<PageTier, number> = { fast: 0, medium: 1, slow: 2 };

/** The model's prediction before anything is learned from this page. */
export function modelPartMs(firstRunMs: number, elements: number, cost: { base: number; perThousand: number }): number {
  return firstRunMs * (cost.base + (cost.perThousand * elements) / 1000);
}

export function predictPartMs(
  firstRunMs: number | null,
  elements: number,
  cost: { base: number; perThousand: number },
  learned = 1,
): number | null {
  return firstRunMs === null ? null : modelPartMs(firstRunMs, elements, cost) * learned;
}

export function pageTier(
  firstRunMs: number,
  elements: number,
  costs: Readonly<Record<DocCostPartName, { base: number; perThousand: number }>> = PART_COST,
  activeBudgetMs = ACTIVE_BUDGET_MS,
  idleBudgetMs = IDLE_BUDGET_MS,
): PageTier {
  if (firstRunMs > activeBudgetMs) return 'slow';
  const fits = (Object.keys(costs) as DocCostPartName[]).every((p) => modelPartMs(firstRunMs, elements, costs[p]) <= idleBudgetMs);
  return fits ? 'fast' : 'medium';
}

export function slower(a: PageTier | null, b: PageTier | null): PageTier | null {
  if (!a) return b;
  if (!b) return a;
  return ORDER[a] >= ORDER[b] ? a : b;
}
