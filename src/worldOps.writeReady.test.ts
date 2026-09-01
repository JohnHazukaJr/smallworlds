import { describe, expect, it } from 'vitest';
import { carryScenePresentation, openingScenePresentation, evaluateWorldWriteReady, emptyCharacter, emptyLocation, latestEndedEpisode, preferExistingActiveEpisode, isVagueSpeechStyle } from './worldOps';
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
      mannerisms: 'Taps the stamp twice before sealing.',
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
    expect(result.warnings.some((w) => /mannerisms/i.test(w))).toBe(true);
  });
});

describe('isVagueSpeechStyle', () => {
  it('flags empty and stock styles', () => {
    expect(isVagueSpeechStyle('')).toBe(true);
    expect(isVagueSpeechStyle('normal')).toBe(true);
    expect(isVagueSpeechStyle('Speaks normally.')).toBe(true);
    expect(isVagueSpeechStyle('Clipped harbour clerk cadence')).toBe(false);
  });
});

describe('latestEndedEpisode', () => {
  const ep = (n: number, status: 'active' | 'ended', createdAt = 0): Episode => ({
    ...episode(['p1'], 'loc1'), id: `e${n}-${createdAt}`, number: n, status, createdAt
  });

  it('picks the highest-numbered ended episode', () => {
    expect(latestEndedEpisode([ep(1, 'ended'), ep(2, 'active'), ep(3, 'ended')])?.number).toBe(3);
    expect(latestEndedEpisode([ep(1, 'active')])).toBeUndefined();
    expect(latestEndedEpisode([])).toBeUndefined();
  });

  it('breaks ties on number with createdAt', () => {
    expect(latestEndedEpisode([ep(2, 'ended', 10), ep(2, 'ended', 99)])?.createdAt).toBe(99);
  });
});

describe('preferExistingActiveEpisode', () => {
  const ep = (id: string, status: 'active' | 'ended'): Episode => ({
    ...episode(['p1'], 'loc1'), id, status
  });

  it('returns another active episode and ignores the ending id', () => {
    expect(preferExistingActiveEpisode([ep('a', 'ended'), ep('b', 'active')], 'a')?.id).toBe('b');
    expect(preferExistingActiveEpisode([ep('a', 'active')], 'a')).toBeUndefined();
  });
});

describe('carryScenePresentation', () => {
  it('carries the backdrop, weather, and pinned mood into the next episode', () => {
    const carried = carryScenePresentation({
      ...episode(['p1'], 'loc1'),
      image: 'data:image/png;base64,zz',
      atmosphereNote: '  rain easing off the quay  ',
      moodPinned: true
    });
    expect(carried).toEqual({
      image: 'data:image/png;base64,zz',
      atmosphereNote: 'rain easing off the quay',
      moodPinned: true
    });
  });

  it('leaves blank weather and unpinned mood out rather than writing empties', () => {
    const carried = carryScenePresentation({ ...episode(['p1'], 'loc1'), atmosphereNote: '   ' });
    expect(carried).toEqual({ image: null });
    expect('atmosphereNote' in carried).toBe(false);
    expect('moodPinned' in carried).toBe(false);
  });
});

describe('openingScenePresentation', () => {
  const rainy = {
    ...episode(['p1'], 'loc1'),
    image: 'data:image/png;base64,zz',
    atmosphereNote: 'rain on the glass'
  };

  it('keeps weather on a same-day continuation', () => {
    expect(openingScenePresentation(rainy, { gapDays: 0 }).atmosphereNote).toBe('rain on the glass');
  });

  it('drops stale weather after a gap', () => {
    const next = openingScenePresentation(rainy, { gapDays: 2 });
    expect(next.image).toBe('data:image/png;base64,zz');
    expect('atmosphereNote' in next).toBe(false);
  });

  it('lets wrap supply a fresh note even after a gap', () => {
    expect(openingScenePresentation(rainy, { gapDays: 7, atmosphereNote: 'fog at dawn' }).atmosphereNote)
      .toBe('fog at dawn');
  });

  it('clears weather when wrap sends an empty override', () => {
    expect('atmosphereNote' in openingScenePresentation(rainy, { gapDays: 0, atmosphereNote: '' }))
      .toBe(false);
  });
});

describe('evaluateWorldWriteReady episode copy', () => {
  it('uses later-episode location wording', () => {
    const result = evaluateWorldWriteReady({
      world: world(),
      season: season(),
      episode: { ...episode(['p1'], null), number: 3 },
      characters: [
        emptyCharacter('w1', {
          id: 'p1', isPlayer: true, name: 'you', summary: 'A smuggler.',
          appearance: 'Steady', desires: 'Survive',
          state: { goal: 'Clear the debt', emotion: 'wary', location: 'Quay', condition: '' }
        })
      ],
      locations: [],
      continuityCount: 2
    });
    expect(result.missing.some((m) => /episode 3/i.test(m))).toBe(true);
    expect(result.missing.some((m) => /episode 1/i.test(m))).toBe(false);
  });
});
