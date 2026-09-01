import { describe, expect, it } from 'vitest';
import { normalizeScrollBackdrop, resolveScrollBackdrop } from './scrollBackdrop';

describe('resolveScrollBackdrop', () => {
  it('auto prefers episode image, then location, then climate', () => {
    expect(resolveScrollBackdrop({
      mode: 'auto', episodeImage: 'data:ep', locationPortrait: 'data:loc'
    })).toEqual({ kind: 'image', src: 'data:ep' });
    expect(resolveScrollBackdrop({
      mode: 'auto', episodeImage: '', locationPortrait: 'data:loc'
    })).toEqual({ kind: 'image', src: 'data:loc' });
    expect(resolveScrollBackdrop({
      mode: 'auto', episodeImage: null, locationPortrait: null
    })).toEqual({ kind: 'climate' });
  });

  it('locks to the chosen source and falls back to climate when missing', () => {
    expect(resolveScrollBackdrop({
      mode: 'location', episodeImage: 'data:ep', locationPortrait: 'data:loc'
    })).toEqual({ kind: 'image', src: 'data:loc' });
    expect(resolveScrollBackdrop({
      mode: 'scene', episodeImage: '', locationPortrait: 'data:loc'
    })).toEqual({ kind: 'climate' });
    expect(resolveScrollBackdrop({
      mode: 'off', episodeImage: 'data:ep', locationPortrait: 'data:loc'
    })).toEqual({ kind: 'off' });
  });
});

describe('normalizeScrollBackdrop', () => {
  it('defaults unknown values to auto', () => {
    expect(normalizeScrollBackdrop('auto')).toBe('auto');
    expect(normalizeScrollBackdrop('nope')).toBe('auto');
  });
});
