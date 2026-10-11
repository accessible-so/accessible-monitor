/**
 * Predicting what a task will cost on this page, on this device, and naming
 * what fits (spec §3.1, §3.3).
 *
 * Everything is a multiple of the page's first `axe.run`. That run's cost is
 * mostly the document-wide floor axe pays on every run, so it measures this
 * page on this device. Dividing by the element count would not: the floor has
 * a fixed part, and a 120-element page on a fast laptop would come out "slow".
 *
 * The ratios start from methodology §4.1 (page-level pass 17–19 ms, the grid
 * rules ~145 ms, region ~75 ms on the 5,345-element fixture) and are raised to
 * what a run actually measured, for the rest of the page's life.
 */
import type { PageTier } from '../protocol/types';
import { IDLE_BUDGET_MS } from './scheduler';

export type DocCostPartName = 'grid' | 'region';

export const INITIAL_RATIOS: Readonly<Record<DocCostPartName, number>> = { grid: 10, region: 4 };

const ACTIVE_BUDGET_MS = 50;
const ORDER: Record<PageTier, number> = { fast: 0, medium: 1, slow: 2 };

export function predictPartMs(firstRunMs: number | null, ratio: number): number | null {
  return firstRunMs === null ? null : firstRunMs * ratio;
}

export function pageTier(
  firstRunMs: number,
  ratios: Record<DocCostPartName, number>,
  activeBudgetMs = ACTIVE_BUDGET_MS,
  idleBudgetMs = IDLE_BUDGET_MS,
): PageTier {
  if (firstRunMs > activeBudgetMs) return 'slow';
  const fits = (Object.keys(ratios) as DocCostPartName[]).every((p) => firstRunMs * ratios[p] <= idleBudgetMs);
  return fits ? 'fast' : 'medium';
}

export function slower(a: PageTier | null, b: PageTier | null): PageTier | null {
  if (!a) return b;
  if (!b) return a;
  return ORDER[a] >= ORDER[b] ? a : b;
}
