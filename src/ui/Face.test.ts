import { describe, expect, it } from 'vitest';
import { FACE_PLATE_RATIO, facePlateSize } from './Face';

describe('facePlateSize', () => {
  it('keeps a square for initials without a photo', () => {
    expect(facePlateSize(80, false)).toEqual({ width: 80, height: 80 });
  });

  it('uses a 3:4 plate when a photo is present', () => {
    expect(facePlateSize(80, true)).toEqual({
      width: Math.round(80 * FACE_PLATE_RATIO),
      height: 80
    });
  });
});