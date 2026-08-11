import { describe, expect, it } from 'vitest';
import { evaluateWorldWriteReady, emptyCharacter, emptyLocation } from './worldOps';
import type { Episode, Season, World, WorldAISettings } from './types';

const ai: WorldAISettings = {
  pov: 'second', tense: 'present', proseDensity: 45, pacing: 50,
  contentNotes: '', narratorRules: [], customInstructions: '', mature: true
};

const world = (patch: Partial<World> = {}): World => ({
  id: 'w1', title: 'Harbour', line: 'You owe a debt under a false name.',
  bible: 'x'.repeat(130), hue: 20, visibility: 'private', ai,
  proseModel: null, utilityModel: null, activeSeasonId: 's1',
  calendar: { currentDay: 1, system: '', weekdays: undefined, dayOneWeekday: 0, episodeAdvanceDays: 1 },
  createdAt: 0, updatedAt: 0,
  ...patch
});

const season = (patch: Partial<Season> = {}): Season => ({
  id: 's1', worldId: 'w1', number: 1, title: '', premise: 'The ice is going out early.',
  timeGap: null, bible: null, status: 'active', createdAt: 0, ...patch
});

const episode = (castIds: string[], locationId: string | null = 'loc1'): Episode => ({
  id: 'e1', seasonId: 's1', worldId: 'w1', number: 1, title: '',
  location: 'Quay', locationId, castIds,
  storyDay: 1, storyDayEnd: null, dateNote: null, status: 'active', createdAt: 0
});

describe('evaluateWorldWriteReady', () => {
  it('passes a seed-quality world', () => {
    const player = emptyCharacter('w1', {
      id: 'p1', isPlayer: true, name: 'you', summary: 'A smuggler with a false name.',
      appearance: 'Steady hands', desires: 'Keep the name',
      state: { goal: 'Clear the debt', emotion: 'wary', location: 'Quay', condition: '' }
    });
    const npc = emptyCharacter('w1', {
      id: 'n1', name: 'Marisol', summary: 'Harbour registrar.',
      speechStyle: 'Clipped.', exampleLines: ['Then write it again.'],
      anchors: ['Never lies in writing']
    });
    const loc = emptyLocation('w1', {
      id: 'loc1', name: 'Quay', atmosphere: 'Salt and ink.',
      rules: ['No weapons past the gate']
    });
    const result = evaluateWorldWriteReady({
      world: world(),
      season: season(),
      episode: episode(['p1', 'n1'], 'loc1'),
      characters: [player, npc],
      locations: [loc],
      continuityCount: 2
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('flags missing premise, NPC voice, and location rules', () => {
    const player = emptyCharacter('w1', { id: 'p1', isPlayer: true, name: 'you' });
    const npc = emptyCharacter('w1', { id: 'n1', name: 'Ada', summary: 'Someone.' });
    const loc = emptyLocation('w1', { id: 'loc1', name: 'Room', rules: [] });
    const result = evaluateWorldWriteReady({
      world: world({ bible: 'short' }),
      season: season({ premise: '' }),
      episode: episode(['p1', 'n1'], 'loc1'),
      characters: [player, npc],
      locations: [loc],
      continuityCount: 0
    });
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => /bible/i.test(m))).toBe(true);
    expect(result.missing.some((m) => /premise/i.test(m))).toBe(true);
    expect(result.missing.some((m) => /NPC/i.test(m))).toBe(true);
    expect(result.missing.some((m) => /hard rule/i.test(m))).toBe(true);
    expect(result.warnings.some((w) => /continuity/i.test(w))).toBe(true);
  });

  it('soft-warns on thin voice, generic place rule, and missing atmosphere without blocking', () => {
    const player = emptyCharacter('w1', {
      id: 'p1', isPlayer: true, name: 'you', summary: 'You.',
      state: { goal: 'Survive', emotion: '', location: '', condition: '' }
    });
    const npc = emptyCharacter('w1', {
      id: 'n1', name: 'Ada', summary: 'Someone.', speechStyle: 'Soft.',
      anchors: ['Never runs'], exampleLines: []
    });
    const loc = emptyLocation('w1', {
      id: 'loc1', name: 'Room', atmosphere: '',
      rules: ['Respect the place’s hard rules as written on this sheet.']
    });
    const result = evaluateWorldWriteReady({
      world: world(),
      season: season(),
      episode: episode(['p1', 'n1'], 'loc1'),
      characters: [player, npc],
      locations: [loc],
      continuityCount: 1
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings.some((w) => /example lines/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /atmosphere/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /generic place rule/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /appearance or desires/i.test(w))).toBe(true);
  });
});
