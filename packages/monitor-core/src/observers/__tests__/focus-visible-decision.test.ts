import { describe, expect, it } from 'vitest';
import { decideFocusVisible } from '../focus-visible';

describe('decideFocusVisible', () => {
  it('is not visible when there is no outline, no box-shadow, and no border change', () => {
    expect(
      decideFocusVisible({ outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'none', borderChanged: false }),
    ).toBe(false);
  });

  it('is visible when a solid outline with nonzero width is present', () => {
    expect(
      decideFocusVisible({ outlineStyle: 'solid', outlineWidth: '2px', boxShadow: 'none', borderChanged: false }),
    ).toBe(true);
  });

  it('is visible when a box-shadow is present', () => {
    expect(
      decideFocusVisible({
        outlineStyle: 'none',
        outlineWidth: '0px',
        boxShadow: '0 0 0 2px blue',
        borderChanged: false,
      }),
    ).toBe(true);
  });

  it('is visible when the border changed on focus', () => {
    expect(
      decideFocusVisible({ outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'none', borderChanged: true }),
    ).toBe(true);
  });

  it('is visible when outlineStyle is auto, regardless of width', () => {
    expect(
      decideFocusVisible({ outlineStyle: 'auto', outlineWidth: '0px', boxShadow: 'none', borderChanged: false }),
    ).toBe(true);
  });

  it('is not visible when jsdom reports empty strings for outlineStyle and boxShadow', () => {
    expect(decideFocusVisible({ outlineStyle: '', outlineWidth: '0px', boxShadow: '', borderChanged: false })).toBe(
      false,
    );
  });

  it('is visible when outlineStyle is empty but a real box-shadow is present', () => {
    expect(
      decideFocusVisible({ outlineStyle: '', outlineWidth: '0px', boxShadow: '0 0 0 2px blue', borderChanged: false }),
    ).toBe(true);
  });
});
