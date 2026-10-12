import { describe, expect, it } from 'vitest';
import { PART_COST, pageTier, predictPartMs, slower } from '../tier';

describe('page tier', () => {
  it('is fast when chunks fit the active budget and every part fits an idle window', () => {
    // 9.3 ms, 120 elements: grid 9.3 x 4.8 = 45 ms.
    expect(pageTier(9.3, 120)).toBe('fast');
  });
  it('is fast on the products fixture, which the model says fits', () => {
    // 14 ms, 419 elements: grid 14 x 9.285 = 130 ms.
    expect(pageTier(14, 419)).toBe('fast');
  });
  it('is medium when chunks fit but a part does not fit a window', () => {
    // 11.7 ms, 1,121 elements: grid 11.7 x 19.8 = 232 ms.
    expect(pageTier(11.7, 1121)).toBe('medium');
  });
  it('is slow when even the first run is a long task', () => {
    expect(pageTier(51, 10)).toBe('slow');
  });
  it('does not call a small page on a fast device slow (the reason it is not per element)', () => {
    expect(pageTier(4, 120)).toBe('fast');
  });
  it('grows with the page: the same first run is medium on a bigger page', () => {
    expect(pageTier(12, 400)).toBe('fast');
    expect(pageTier(12, 1500)).toBe('medium');
  });
  it('is medium at the exact active budget boundary (50 ms)', () => {
    expect(pageTier(50, 10)).toBe('medium');
  });
  it('is fast when a part predicts exactly the idle boundary (150 ms)', () => {
    expect(pageTier(10, 0, { grid: { base: 15, perThousand: 0 }, region: { base: 1, perThousand: 0 } })).toBe('fast');
    expect(pageTier(10, 0, { grid: { base: 15.1, perThousand: 0 }, region: { base: 1, perThousand: 0 } })).toBe('medium');
  });
  it('lets learned multipliers decide what fits', () => {
    expect(pageTier(10, 0)).toBe('fast'); // grid predicts 30 ms
    expect(pageTier(10, 0, PART_COST, 50, 150, { grid: 3 })).toBe('fast'); // 90 ms
    expect(pageTier(10, 0, PART_COST, 50, 150, { grid: 6 })).toBe('medium'); // 180 ms
  });
  it('uses the fixture coefficients', () => {
    expect(PART_COST.grid).toEqual({ base: 3, perThousand: 15 });
    expect(PART_COST.region).toEqual({ base: 0.5, perThousand: 0.8 });
  });
});

describe('predictions', () => {
  const cost = { base: 3, perThousand: 15 };
  it('is first run x (base + perThousand x elements / 1000), unknown before it', () => {
    expect(predictPartMs(null, 1000, cost)).toBeNull();
    expect(predictPartMs(10, 1000, cost)).toBe(180);
    expect(predictPartMs(10, 0, cost)).toBe(30);
  });
  it('scales by what was learned from this page', () => {
    expect(predictPartMs(10, 1000, cost, 1.5)).toBe(270);
  });
  it('matches the measured fixtures (methodology 4.1)', () => {
    expect(predictPartMs(26.1, 5345, PART_COST.region)).toBeCloseTo(125, 0);
    expect(predictPartMs(11.7, 1121, PART_COST.grid)).toBeCloseTo(232, 0);
  });
});

describe('slower', () => {
  it('keeps the slowest tier seen, and treats none as none', () => {
    expect(slower(null, 'fast')).toBe('fast');
    expect(slower('fast', 'slow')).toBe('slow');
    expect(slower('slow', 'medium')).toBe('slow');
    expect(slower(null, null)).toBeNull();
  });
});
