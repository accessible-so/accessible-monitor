import { describe, expect, it } from 'vitest';
import { INITIAL_RATIOS, pageTier, predictPartMs, slower } from '../tier';

describe('page tier', () => {
  it('is fast when chunks fit the active budget and every part fits an idle window', () => {
    // 12 ms first run: grid 120 ms, region 48 ms — both within 150.
    expect(pageTier(12, INITIAL_RATIOS)).toBe('fast');
  });
  it('is medium when chunks fit but a part does not fit a window', () => {
    // 20 ms first run: grid predicted 200 ms.
    expect(pageTier(20, INITIAL_RATIOS)).toBe('medium');
  });
  it('is slow when even the first run is a long task', () => {
    expect(pageTier(51, INITIAL_RATIOS)).toBe('slow');
  });
  it('does not call a small page on a fast device slow (the reason it is not per element)', () => {
    // A 120-element page whose first run is 4 ms: anything per-element would blow this up.
    expect(pageTier(4, INITIAL_RATIOS)).toBe('fast');
  });
  it('uses ratios raised by measurement', () => {
    expect(pageTier(12, { grid: 20, region: 4 })).toBe('medium');
  });
  it('is medium at the exact active budget boundary (50 ms)', () => {
    // 50 ms first run: exactly at active budget (not slow), but grid predicts 500 ms > 150 ms.
    expect(pageTier(50, INITIAL_RATIOS)).toBe('medium');
  });
  it('is fast when a part predicts exactly the idle boundary (150 ms)', () => {
    // 15 ms first run: grid predicts exactly 150 ms, region predicts 60 ms — both fit.
    expect(pageTier(15, INITIAL_RATIOS)).toBe('fast');
  });
});

describe('predictions', () => {
  it('is a multiple of the first run, unknown before it', () => {
    expect(predictPartMs(null, 10)).toBeNull();
    expect(predictPartMs(15, 10)).toBe(150);
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
