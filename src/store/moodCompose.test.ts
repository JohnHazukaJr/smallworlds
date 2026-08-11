import { describe, expect, it } from 'vitest';
import { moodFromHue, type MoodId } from './app';
import { isPlayerAgencyMode, resolveComposeMode } from '../types';

describe('moodFromHue', () => {
  it('maps hues across all eight climates', () => {
    const samples: Array<[number, MoodId]> = [
      [10, 'ember'],
      [50, 'bloom'],
      [90, 'rot'],
      [140, 'brine'],
      [180, 'frost'],
      [220, 'storm'],
      [270, 'ash'],
      [320, 'dusk'],
      [350, 'ember']
    ];
    for (const [hue, mood] of samples) {
      expect(moodFromHue(hue)).toBe(mood);
    }
  });

  it('normalizes negative and out-of-range hues', () => {
    expect(moodFromHue(-10)).toBe(moodFromHue(350));
    expect(moodFromHue(370)).toBe(moodFromHue(10));
  });
});

describe('resolveComposeMode', () => {
  it('keeps continue/steer when Speak and Act are off', () => {
    expect(resolveComposeMode('continue', false, false)).toBe('continue');
    expect(resolveComposeMode('steer', false, false)).toBe('steer');
  });

  it('resolves Speak/Act toggles to speak, act, or play', () => {
    expect(resolveComposeMode('continue', true, false)).toBe('speak');
    expect(resolveComposeMode('steer', false, true)).toBe('act');
    expect(resolveComposeMode('continue', true, true)).toBe('play');
  });

  it('marks speak/act/play as player agency', () => {
    expect(isPlayerAgencyMode('speak')).toBe(true);
    expect(isPlayerAgencyMode('act')).toBe(true);
    expect(isPlayerAgencyMode('play')).toBe(true);
    expect(isPlayerAgencyMode('continue')).toBe(false);
    expect(isPlayerAgencyMode('steer')).toBe(false);
  });
});
