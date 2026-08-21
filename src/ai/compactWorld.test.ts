import { describe, expect, it } from 'vitest';
import type { WorldExport } from '../db';
import type { CalendarEvent, Character, ContinuityFact, Location, OpenThread } from '../types';
import { DEFAULT_AI } from '../worldOps';
import {
  assembleCompactedWorld,
  calendarEventsForVolume,
  mergePinnedFactTexts,
  nextVolumeTitle,
  VOLUME_CHARACTER_BATCH_SYSTEM,
  VOLUME_LORE_SYSTEM,
  VOLUME_RECAP_SYSTEM
} from './compactWorld';

const cal = {
  currentDay: 40,
  system: 'harbour reckoning',
  weekdays: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  dayOneWeekday: 0,
  episodeAdvanceDays: 1,
  months: ['Jan'],
  monthLengths: [30],
  yearOne: 1,
  dayOneMonth: 0,
  dayOneDate: 1
};

const npc = (id: string, name: string, extras: Partial<Character> = {}): Character => ({
  id, worldId: 'w1', name, role: 'registrar', age: '', appearance: `${name} look`,
  mannerisms: `${name} tic`, summary: `${name} summary`,
  backstory: `${name} old backstory`, speechStyle: 'clipped', exampleLines: [`"${name} line"`],
  traits: '', desires: '', fears: '', flaws: '', secrets: `${name} secret`,
  mustNotKnow: `${name} must not know`,
  anchors: [`${name} never kneels`], relationships: [],
  state: { goal: 'old goal', emotion: 'wary', location: 'office', condition: '' },
  customInstructions: 'keep voice', hue: 20, isPlayer: false, selfTag: false,
  portrait: null, portraits: [], createdAt: 0, updatedAt: 0,
  ...extras
});

function sourceExport(): WorldExport {
  const player = npc('you', 'you', {
    isPlayer: true, role: 'protagonist', hue: 60, customInstructions: ''
  });
  const ada = npc('ada', 'Ada', {
    relationships: [{ targetId: 'ben', kind: 'ally', note: 'Shares the desk' }]
  });
  const ben = npc('ben', 'Ben');
  const loc: Location = {
    id: 'loc1', worldId: 'w1', name: 'Harbour office', tagline: 'public desk', hue: 0,
    summary: 'A cramped registrar.', atmosphere: 'salt-rot wood',
    features: '', history: 'old history', inhabitants: '', secrets: '',
    currentState: 'Crowded.', rules: ['No blades past the rail.'], customInstructions: '',
    createdAt: 0, updatedAt: 0
  };
  const facts: ContinuityFact[] = [
    { id: 'f1', worldId: 'w1', seasonId: 's1', text: 'The ledger is forged.', source: 'manual', pinned: true, createdAt: 1 },
    { id: 'f2', worldId: 'w1', seasonId: 's1', text: 'Ada bought a bun.', source: 'auto', createdAt: 2 }
  ];
  const threads: OpenThread[] = [
    { id: 'th1', worldId: 'w1', seasonId: 's1', text: 'Who paid Ivo?', openedLabel: 'S1 · E1', status: 'open', pinned: true, createdAt: 1 },
    { id: 'th2', worldId: 'w1', seasonId: 's1', text: 'The feast seating', openedLabel: 'S1 · E2', status: 'resolved', createdAt: 2 }
  ];
  const events: CalendarEvent[] = [
    {
      id: 'cal-played', worldId: 'w1', seasonId: 's1', title: 'Harbour Feast', summary: 'Lanterns.',
      kind: 'festival', scale: 'large', storyDay: 12, visibility: 'title', promptPolicy: 'hard',
      status: 'played', source: 'manual', createdAt: 1, updatedAt: 1
    },
    {
      id: 'cal-due', worldId: 'w1', seasonId: 's1', title: 'Audit', summary: 'Books open.',
      kind: 'mundane', scale: 'small', storyDay: 40, visibility: 'title', promptPolicy: 'soft',
      status: 'due', source: 'manual', createdAt: 1, updatedAt: 1
    },
    {
      id: 'cal-future', worldId: 'w1', seasonId: 's1', title: 'Tide fair', summary: 'Stalls.',
      kind: 'festival', scale: 'medium', storyDay: 80, visibility: 'title', promptPolicy: 'soft',
      status: 'scheduled', source: 'manual', createdAt: 1, updatedAt: 1
    }
  ];
  return {
    format: 'small-worlds-world',
    version: 1,
    exportedAt: 1,
    world: {
      id: 'w1', title: 'Harbour', line: 'Fog and debts.', bible: 'A coastal city of ledgers.',
      hue: 200, visibility: 'private', ai: { ...DEFAULT_AI },
      proseModel: null, utilityModel: null, activeSeasonId: 's1',
      calendar: cal, createdAt: 0, updatedAt: 0
    },
    seasons: [{
      id: 's1', worldId: 'w1', number: 1, title: '', premise: 'The forged ledger.',
      timeGap: null, bible: null, status: 'active', createdAt: 0,
      plotTargets: [{ id: 'pt1', text: 'Recover the ledger', status: 'pending', source: 'manual' }]
    }],
    episodes: [{
      id: 'e1', seasonId: 's1', worldId: 'w1', number: 1, title: '',
      location: 'Harbour office', locationId: 'loc1',
      castIds: ['you', 'ada'], wrap: { recap: 'The books did not add up.', beats: [], guestEffects: [] },
      storyDay: 40, status: 'ended', createdAt: 0
    }],
    turns: [{
      id: 't1', episodeId: 'e1', worldId: 'w1', role: 'narrator', mode: null,
      text: 'Fog on the glass.', createdAt: 1
    }],
    characters: [player, ada, ben],
    locations: [loc],
    continuity: facts,
    threads,
    wraps: [],
    calendarEvents: events
  };
}

describe('nextVolumeTitle', () => {
  it('appends Vol. 2 and increments', () => {
    expect(nextVolumeTitle('Harbour')).toBe('Harbour · Vol. 2');
    expect(nextVolumeTitle('Harbour · Vol. 2')).toBe('Harbour · Vol. 3');
  });
});

describe('calendarEventsForVolume', () => {
  it('drops played events and keeps due / upcoming', () => {
    const kept = calendarEventsForVolume(sourceExport().calendarEvents ?? [], 40);
    expect(kept.map((e) => e.title)).toEqual(['Audit', 'Tide fair']);
    expect(kept.every((e) => e.status !== 'played')).toBe(true);
  });
});

describe('mergePinnedFactTexts', () => {
  it('keeps pinned source facts even when the model omits them', () => {
    const pinned: ContinuityFact[] = [
      { id: 'f1', worldId: 'w', seasonId: 's', text: 'The ledger is forged.', source: 'manual', pinned: true, createdAt: 1 }
    ];
    const merged = mergePinnedFactTexts([{ text: 'Ada is wary of Ivo.' }], pinned);
    expect(merged.some((f) => f.text === 'The ledger is forged.' && f.pinned)).toBe(true);
    expect(merged.some((f) => f.text === 'Ada is wary of Ivo.')).toBe(true);
  });
});

describe('prompt contracts', () => {
  it('tells the recap and bible to keep proper nouns and debts', () => {
    expect(VOLUME_RECAP_SYSTEM).toMatch(/proper nouns/i);
    expect(VOLUME_RECAP_SYSTEM).toMatch(/debts/i);
    expect(VOLUME_LORE_SYSTEM).toMatch(/proper nouns/i);
    expect(VOLUME_LORE_SYSTEM).toMatch(/debts/i);
    expect(VOLUME_LORE_SYSTEM).toMatch(/example lines/i);
  });

  it('forbids inventing unnamed NPCs in character batches', () => {
    expect(VOLUME_CHARACTER_BATCH_SYSTEM).toMatch(/do not invent new people/i);
    expect(VOLUME_CHARACTER_BATCH_SYSTEM).toMatch(/unnamed NPCs/i);
    expect(VOLUME_CHARACTER_BATCH_SYSTEM).toMatch(/MUST NOT KNOW/i);
    expect(VOLUME_CHARACTER_BATCH_SYSTEM).toMatch(/do not soften anchors/i);
  });
});

describe('assembleCompactedWorld', () => {
  const seq = () => {
    let n = 0;
    return () => `n${++n}`;
  };

  it('mints a new world id, one season, no turns, and resolvable opening cast', () => {
    const ids = seq();
    const graph = assembleCompactedWorld(sourceExport(), {
      recap: 'Previously the ledger was forged and Ada kept the books.',
      lore: {
        line: 'The books still lie.',
        bible: 'Harbour now knows the ledger is false.',
        premise: 'Someone has to name the forger.',
        timeGap: 'A winter',
        storyDay: 120,
        openingLocationName: 'Harbour office',
        openingCastNames: ['Ada'],
        atmosphereNote: 'Wet wool.'
      },
      characters: [
        {
          name: 'Ada',
          backstory: 'Ada UNIQUE_BACKSTORY after the audit.',
          summary: 'Still the registrar, harder now.',
          relationships: [{ targetName: 'Ben', kind: 'ally', note: 'Still shares the desk' }]
        },
        { name: 'Invented Ghost', summary: 'should not appear' }
      ],
      locations: [{
        name: 'Harbour office',
        currentState: 'Quieter after the feast.',
        history: 'The audit happened here.'
      }],
      memory: {
        facts: [{ text: 'Ada is wary of Ivo.' }],
        threads: [{ text: 'Who paid Ivo?' }]
      }
    }, { now: 9, uid: ids });

    expect(graph.world.id).not.toBe('w1');
    expect(graph.world.title).toBe('Harbour · Vol. 2');
    expect(graph.season.number).toBe(1);
    expect(graph.season.bible?.recap).toMatch(/ledger was forged/);
    expect(graph.world.bible).toMatch(/ledger is false/);
    expect(graph.episode.number).toBe(1);
    expect(graph.episode.castIds.length).toBeGreaterThan(0);
    const byId = new Map(graph.characters.map((c) => [c.id, c]));
    for (const id of graph.episode.castIds) {
      expect(byId.has(id)).toBe(true);
    }
    expect(graph.characters.some((c) => c.name === 'Invented Ghost')).toBe(false);
    const ada = graph.characters.find((c) => c.name === 'Ada')!;
    const ben = graph.characters.find((c) => c.name === 'Ben')!;
    expect(ada.backstory).toContain('UNIQUE_BACKSTORY');
    expect(ada.customInstructions).toBe('keep voice');
    expect(ada.anchors).toEqual(['Ada never kneels']);
    expect(ada.relationships.some((r) => r.targetId === ben.id)).toBe(true);
    expect(ben.backstory).toBe('Ben old backstory');
    const loc = graph.locations[0];
    expect(loc.currentState).toMatch(/Quieter/);
    expect(loc.rules).toEqual(['No blades past the rail.']);
    expect(graph.continuity.some((f) => f.text === 'The ledger is forged.' && f.pinned)).toBe(true);
    expect(graph.calendarEvents.every((e) => e.status !== 'played')).toBe(true);
    expect(graph.calendarEvents.some((e) => e.title === 'Harbour Feast')).toBe(false);
    expect(graph.world.calendar.currentDay).toBe(120);
    expect(graph.world.ai.pov).toBe('second');
  });
});
