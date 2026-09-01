import { describe, expect, it } from 'vitest';
import {
  clipMeanwhile,
  gapDays,
  matchLocationForPatch,
  meanwhileFact,
  mergeLocationPatch,
  nextAtmosphereNote,
  normalizePlacePatch,
  normalizePlacePatches
} from './worldMemory';
import type { Location } from '../types';

const loc = (id: string, name: string, currentState = ''): Location => ({
  id, worldId: 'w', name, tagline: '', hue: 0, summary: '', atmosphere: 'salt',
  features: '', history: '', inhabitants: '', rules: [], secrets: '',
  currentState, customInstructions: '', createdAt: 0, updatedAt: 0
});

describe('normalizePlacePatch', () => {
  it('drops empty patches and clips long state', () => {
    expect(normalizePlacePatch(null)).toBeNull();
    expect(normalizePlacePatch({ name: 'Quay' })).toBeNull();
    const long = 'x'.repeat(400);
    const p = normalizePlacePatch({ name: 'Quay', currentState: `  ${long}  ` });
    expect(p?.name).toBe('Quay');
    expect(p?.currentState?.length).toBeLessThanOrEqual(240);
    expect(p?.currentState?.endsWith('…')).toBe(true);
  });

  it('keeps an atmosphere-only patch for the next opening', () => {
    expect(normalizePlacePatch({ name: 'Quay', atmosphere: 'fog at dawn' })).toEqual({
      name: 'Quay',
      currentState: undefined,
      atmosphere: 'fog at dawn'
    });
  });

  it('de-duplicates elsewhere by name', () => {
    const list = normalizePlacePatches([
      { name: 'Quay', currentState: 'empty' },
      { name: 'quay', currentState: 'should drop' },
      { name: 'Office', currentState: 'lamp out' }
    ]);
    expect(list.map((p) => p.name)).toEqual(['Quay', 'Office']);
  });
});

describe('matchLocationForPatch / merge', () => {
  const places = [loc('l1', 'Harbour office', 'Crowded.'), loc('l2', 'Quay', 'Wet.')];

  it('prefers the scene id over a mismatched name', () => {
    const hit = matchLocationForPatch(places, { name: 'Wrong', currentState: 'Quiet.' }, 'l1');
    expect(hit?.id).toBe('l1');
  });

  it('matches exact then contained names when no id is given', () => {
    expect(matchLocationForPatch(places, { name: 'Quay', currentState: 'x' })?.id).toBe('l2');
    expect(matchLocationForPatch(places, { name: 'harbour', currentState: 'x' })?.id).toBe('l1');
  });

  it('replaces currentState and leaves identity atmosphere alone', () => {
    const office = places[0];
    expect(mergeLocationPatch(office, { name: 'Harbour office', currentState: 'The lamp is smashed.' }))
      .toEqual({ currentState: 'The lamp is smashed.' });
    expect(office.atmosphere).toBe('salt');
  });
});

describe('meanwhile / gap weather', () => {
  it('counts whole days between close and next open', () => {
    expect(gapDays(12, 12)).toBe(0);
    expect(gapDays(12, 13)).toBe(1);
    expect(gapDays(12, 10)).toBe(0);
  });

  it('files a meanwhile fact only when time actually passed', () => {
    expect(meanwhileFact({ episodeNumber: 2, gap: 0, text: 'Ada waited.' })).toBeNull();
    expect(meanwhileFact({ episodeNumber: 2, gap: 2, text: '  Ada waited on the quay.  ' }))
      .toBe('Meanwhile (2 days after episode 2): Ada waited on the quay.');
    expect(meanwhileFact({ episodeNumber: 3, gap: 1, text: 'Rain.' }))
      .toBe('Meanwhile (1 day after episode 3): Rain.');
  });

  it('clips a rambling meanwhile', () => {
    expect(clipMeanwhile('x'.repeat(900)).length).toBeLessThanOrEqual(720);
  });

  it('drops inherited weather across a gap unless wrap supplies a fresh note', () => {
    expect(nextAtmosphereNote({ carried: 'rain', gap: 2 })).toBeUndefined();
    expect(nextAtmosphereNote({ carried: 'rain', gap: 0 })).toBe('rain');
    expect(nextAtmosphereNote({ carried: 'rain', override: 'fog at dawn', gap: 7 }))
      .toBe('fog at dawn');
    expect(nextAtmosphereNote({ carried: 'rain', override: '  ', gap: 0 })).toBe('rain');
  });
});
