import { describe, expect, it } from 'vitest';
import { matchPlotTargets, normalizeBeats } from './engine';
import {
  episodeContextPressure,
  episodeHistoryChars,
  HISTORY_CHAR_BUDGET,
  packTurnsDetailed,
  selectDirectorFacts,
  selectDirectorThreads
} from './prompts';
import type { Character, ContinuityFact, EpisodeGuest, OpenThread, PlotTarget, Turn } from '../types';

const npc = (id: string, name: string): Character => ({
  id, worldId: 'w', name, role: '', age: '', appearance: '', mannerisms: '', summary: '',
  backstory: '', speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
  secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: '', emotion: '', location: '', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0
});

describe('normalizeBeats', () => {
  const cast = [npc('c1', 'Ada'), npc('c2', 'Ben')];
  const guests: EpisodeGuest[] = [{ id: 'g1', name: 'Clerk', brief: 'tired', voice: '' }];

  it('keeps narration and speak under caps', () => {
    const beats = normalizeBeats(
      {
        beats: [
          { type: 'narration', brief: 'Rain on glass.' },
          { type: 'speak', characterId: 'Ada', brief: 'greet coldly' },
          { type: 'speak', characterId: 'missing', brief: 'skip me' },
          { type: 'speak', guestId: 'g1', brief: 'interrupt' },
          { type: 'narration', brief: '' },
          { type: 'narration', brief: 'Door opens.' }
        ]
      },
      cast,
      guests,
      new Map(),
      'continue',
      ''
    );
    expect(beats.map((b) => b.type)).toEqual(['narration', 'speak', 'speak', 'narration']);
    expect(beats[1]).toMatchObject({ type: 'speak', characterId: 'c1' });
    expect(beats[2]).toMatchObject({ type: 'speak', guestId: 'g1' });
  });

  it('injects a speak reply when player spoke and plan has none', () => {
    const beats = normalizeBeats(
      { beats: [{ type: 'narration', brief: 'She stares.' }] },
      cast,
      guests,
      new Map(),
      'speak',
      'Hello?'
    );
    expect(beats.some((b) => b.type === 'speak')).toBe(true);
    expect(beats[0].type).toBe('speak');
  });
});

describe('packTurnsDetailed / pressure', () => {
  const mk = (n: number, size: number): Turn[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, episodeId: 'e', worldId: 'w', role: 'narrator' as const, mode: null,
      text: 'x'.repeat(size), createdAt: i
    }));

  it('keeps newest turns under budget', () => {
    const turns = mk(40, 3000);
    const { kept, omitted } = packTurnsDetailed(turns);
    expect(kept.length).toBeGreaterThan(0);
    expect(omitted.length).toBeGreaterThan(0);
    expect(kept.at(-1)?.id).toBe(turns.at(-1)?.id);
    expect(episodeHistoryChars(kept)).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET + 3000);
  });

  it('escalates pressure near budget', () => {
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.4)).toBe('ok');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.6)).toBe('warn');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.8)).toBe('escalate');
  });
});

describe('matchPlotTargets', () => {
  const targets: PlotTarget[] = [
    { id: 'a', text: 'Find the key', status: 'pending', source: 'manual' },
    { id: 'b', text: 'Confront Mira', status: 'pending', source: 'manual' },
    { id: 'c', text: 'Old debt', status: 'hit', source: 'manual' }
  ];

  it('matches exact and loose contains', () => {
    const hits = matchPlotTargets(targets, ['find the key', 'confront mira about the past']);
    expect(hits.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('ignores already-hit targets', () => {
    expect(matchPlotTargets(targets, ['Old debt'])).toEqual([]);
  });
});

describe('selectDirectorFacts / Threads pin', () => {
  it('includes pinned facts before soft cap picks', () => {
    const facts: ContinuityFact[] = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`, worldId: 'w', seasonId: 's', episodeId: 'e',
      text: `Fact ${i}`, source: 'manual' as const,
      pinned: i === 19,
      createdAt: i, updatedAt: i
    }));
    const selected = selectDirectorFacts(facts, ['e']);
    expect(selected.some((f) => f.id === 'f19')).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(12);
  });

  it('includes pinned threads before soft cap picks', () => {
    const threads: OpenThread[] = Array.from({ length: 16 }, (_, i) => ({
      id: `t${i}`, worldId: 'w', seasonId: 's',
      text: `Thread ${i}`, openedLabel: 'S1 · E1', status: 'open' as const,
      pinned: i === 0,
      createdAt: i, updatedAt: i
    }));
    const selected = selectDirectorThreads(threads, ['E1']);
    expect(selected[0]?.id === 't0' || selected.some((t) => t.id === 't0')).toBe(true);
    expect(selected.every((t) => t.status === 'open')).toBe(true);
  });
});
