import { describe, expect, it } from 'vitest';
import { otherPlacesBlock, whereYouAreBlock } from './ai/prompts';
import {
  findPlaceByName, placeAncestors, placeNeedsMigration, placeTree, placeWhereLine, placesAround,
  planPlaceMigration, planSceneMove, resolveScenePlace, wouldCreateLoop
} from './places';
import type { Location } from './types';
import { emptyLocation } from './worldOps';

const place = (id: string, name: string, patch: Partial<Location> = {}): Location =>
  emptyLocation('w', { id, name, hue: 10, ...patch });

const town = place('town', 'Saltmere');
const harbour = place('harbour', 'Harbour', { parentId: 'town' });
const room = place('room', 'The Long Room', { parentId: 'harbour', summary: 'A lamplit room above the customs house. Tide-loud.' });
const docks = place('docks', 'Docks', { parentId: 'harbour' });
const all = [room, docks, town, harbour];

describe('place tree', () => {
  it('walks ancestors and names where a place sits', () => {
    expect(placeAncestors(room, all).map((p) => p.id)).toEqual(['harbour', 'town']);
    expect(placeWhereLine(room, all)).toBe('Harbour · Saltmere');
    expect(placeWhereLine(town, all)).toBe('');
  });

  it('orders rows depth-first with depth', () => {
    expect(placeTree(all).map((r) => [r.place.id, r.depth])).toEqual([
      ['town', 0], ['harbour', 1], ['docks', 2], ['room', 2]
    ]);
  });

  it('refuses a parent that would put a place inside itself', () => {
    expect(wouldCreateLoop('town', 'room', all)).toBe(true);
    expect(wouldCreateLoop('room', 'room', all)).toBe(true);
    expect(wouldCreateLoop('docks', 'town', all)).toBe(false);
  });

  it('keeps places that are in a loop instead of losing them', () => {
    const a = place('a', 'A', { parentId: 'b' });
    const b = place('b', 'B', { parentId: 'a' });
    expect(placeTree([a, b]).map((r) => r.place.id).sort()).toEqual(['a', 'b']);
  });

  it('lists nearby places from the tree first', () => {
    expect(placesAround(room, all).map((p) => p.id).slice(0, 2)).toEqual(['harbour', 'docks']);
  });
});

describe('the chapter place', () => {
  it('resolves by id, then by exact name only', () => {
    expect(resolveScenePlace({ locationId: 'docks', location: '' }, all)?.id).toBe('docks');
    expect(resolveScenePlace({ locationId: null, location: 'the long room' }, all)?.id).toBe('room');
    expect(resolveScenePlace({ locationId: null, location: 'the long room, upstairs' }, all)).toBeUndefined();
  });

  it('finds a place by name with or without "the"', () => {
    expect(findPlaceByName('Long Room', all)?.id).toBe('room');
  });
});

describe('scene moves', () => {
  it('moves to a saved place by name', () => {
    expect(planSceneMove({ place: 'Docks' }, room, all)).toEqual({ kind: 'saved', place: docks });
  });

  it('ignores a move to where the scene already is', () => {
    expect(planSceneMove({ place: 'The Long Room' }, room, all)).toBeNull();
    expect(planSceneMove({ place: 'none' }, room, all)).toBeNull();
    expect(planSceneMove(null, room, all)).toBeNull();
  });

  it('makes a new place beside the current one', () => {
    expect(planSceneMove({ newPlace: 'The Fish Market' }, room, all)).toEqual({
      kind: 'new', name: 'The Fish Market', parentId: 'harbour'
    });
  });
});

describe('migration from flat sheets', () => {
  it('turns an area into a parent place and folds old fields', () => {
    const old = place('old', 'Mill', {
      area: 'Briar Park',
      tagline: 'Briar Park · old mill',
      features: 'A waterwheel.',
      history: 'Built in 1820.',
      secrets: 'A body in the race.',
      near: 'next to the Docks',
      rules: ['Quiet and cold.', 'No fire inside.'],
      atmosphere: 'Quiet and cold.'
    });
    expect(placeNeedsMigration(old)).toBe(true);
    const { creates, patches } = planPlaceMigration([old, docks], 'w');
    expect(creates.map((c) => c.name)).toEqual(['Briar Park']);
    const patch = patches.find((p) => p.id === 'old')!.patch;
    expect(patch.parentId).toBe(creates[0].id);
    expect(patch.summary).toContain('Features: A waterwheel.');
    expect(patch.hidden).toContain('Built in 1820.');
    expect(patch.hidden).toContain('A body in the race.');
    expect(patch.nearIds).toEqual(['docks']);
    expect(patch.rules).toEqual(['No fire inside.']);
    expect(patch.area).toBe('');
  });

  it('reuses an existing place for an area of the same name', () => {
    const shop = place('shop', 'Shop', { area: 'Saltmere' });
    const { creates, patches } = planPlaceMigration([shop, town], 'w');
    expect(creates).toEqual([]);
    expect(patches[0].patch.parentId).toBe('town');
  });

  it('leaves a migrated place alone', () => {
    expect(placeNeedsMigration(room)).toBe(false);
  });
});

describe('what the writer is told about the place', () => {
  it('sends every field, labels Hidden, and shows where it sits', () => {
    const full = place('full', 'The Long Room', {
      parentId: 'harbour',
      summary: 'A lamplit room.',
      atmosphere: 'Tide-loud.',
      currentState: 'Shuttered.',
      inhabitants: 'Clerks.',
      rules: ['No blades drawn.'],
      hidden: 'The ledger is forged.',
      customInstructions: 'Keep it cold.'
    });
    const block = whereYouAreBlock(full, [...all, full], { sceneNote: 'Rain.', placeNote: 'by the window' });
    expect(block).toContain('## Where you are');
    expect(block).toContain('(in Harbour · Saltmere)');
    expect(block).toContain('What it is: A lamplit room.');
    expect(block).toContain('Right now: Shuttered. Rain.');
    expect(block).toContain('Exactly where: by the window');
    expect(block).toContain('- No blades drawn.');
    expect(block).toMatch(/Hidden \(.*reveal only when.*\): The ledger is forged\./);
    expect(block).toContain("Author's notes for this place: Keep it cold.");
  });

  it('lists other places the scene can move to', () => {
    const block = otherPlacesBlock(room, all);
    expect(block).toContain('- Harbour (in Saltmere)');
    expect(block).toContain('- Docks (in Harbour · Saltmere)');
    expect(block).not.toContain('The Long Room');
  });
});
