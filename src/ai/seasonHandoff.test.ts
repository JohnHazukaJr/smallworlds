import { describe, expect, it } from 'vitest';
import {
  applySeasonRelationshipUpdates,
  clearMustNotKnowClauses,
  mergeSeasonOpenState,
  mergeSeasonSheetPatch
} from './engine';
import { buildNextSeasonPlotTargets } from '../worldOps';
import type { Character, CharacterState, WrapCharacterOutcome } from '../types';

const blankState = (): CharacterState => ({
  goal: 'old goal',
  emotion: 'tense',
  location: 'harbour',
  condition: 'bruised'
});

const npc = (id: string, name: string, extras: Partial<Character> = {}): Character => ({
  id, worldId: 'w', name, role: 'smuggler', age: '', appearance: '', mannerisms: '', summary: 'A sharp operator.',
  backstory: '', speechStyle: 'clipped', exampleLines: [], traits: 'careful', desires: 'pay the debt',
  fears: 'exposure', flaws: 'pride', secrets: '', mustNotKnow: 'The ledger is forged; Ivo took guild money.',
  anchors: ['Never lies in writing'], relationships: [],
  state: blankState(),
  customInstructions: '', hue: 20, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0,
  ...extras
});

describe('mergeSeasonOpenState', () => {
  it('keeps prior goal/emotion when no statePatch; refreshes condition from evolution', () => {
    const outcome: Pick<WrapCharacterOutcome, 'evolution' | 'outcome' | 'statePatch' | 'keepState'> = {
      evolution: 'Hardened after the gap.',
      outcome: 'Left the long room.',
      keepState: true
    };
    expect(mergeSeasonOpenState(blankState(), outcome)).toEqual({
      goal: 'old goal',
      emotion: 'tense',
      location: 'harbour',
      condition: 'Hardened after the gap.'
    });
  });

  it('uses statePatch fields when provided', () => {
    const next = mergeSeasonOpenState(blankState(), {
      evolution: 'ignored when patched',
      outcome: '',
      statePatch: { goal: 'Find Mira', emotion: 'quiet', condition: 'rested' },
      keepState: true
    });
    expect(next).toEqual({
      goal: 'Find Mira',
      emotion: 'quiet',
      location: 'harbour',
      condition: 'rested'
    });
  });

  it('leaves prior goal when statePatch omits goal', () => {
    const next = mergeSeasonOpenState(blankState(), {
      evolution: 'gap',
      outcome: '',
      statePatch: { emotion: 'calm' },
      keepState: true
    });
    expect(next.goal).toBe('old goal');
    expect(next.emotion).toBe('calm');
  });

  it('leaves prior state untouched when keepState is false', () => {
    const prior = blankState();
    expect(mergeSeasonOpenState(prior, {
      evolution: 'should not apply',
      outcome: '',
      statePatch: { goal: 'x' },
      keepState: false
    })).toEqual(prior);
  });
});

describe('mergeSeasonSheetPatch', () => {
  it('merges only provided sheet fields and skips voice/anchors', () => {
    const c = npc('c1', 'Ada');
    const patch = mergeSeasonSheetPatch(c, {
      keepSheet: true,
      sheetPatch: { desires: 'Leave the guild', summary: 'Still sharp, less certain.' }
    });
    expect(patch).toEqual({
      desires: 'Leave the guild',
      summary: 'Still sharp, less certain.'
    });
    expect(patch).not.toHaveProperty('speechStyle');
    expect(patch).not.toHaveProperty('anchors');
  });

  it('skips player and dropped sheet patches', () => {
    const player = npc('p1', 'You', { isPlayer: true });
    expect(mergeSeasonSheetPatch(player, {
      keepSheet: true,
      sheetPatch: { desires: 'nope' }
    })).toBeNull();
    expect(mergeSeasonSheetPatch(npc('c1', 'Ada'), {
      keepSheet: false,
      sheetPatch: { desires: 'nope' }
    })).toBeNull();
  });
});

describe('clearMustNotKnowClauses', () => {
  it('removes matching clauses', () => {
    const next = clearMustNotKnowClauses(
      'The ledger is forged; Ivo took guild money.',
      'ledger is forged'
    );
    expect(next.toLowerCase()).toContain('ivo');
    expect(next.toLowerCase()).not.toContain('ledger');
  });
});

describe('applySeasonRelationshipUpdates', () => {
  it('upserts kept edges and skips dropped', () => {
    const cast = [
      npc('c1', 'Ada', { relationships: [{ targetId: 'c2', kind: 'ally', note: 'old' }] }),
      npc('c2', 'Ben')
    ];
    const next = applySeasonRelationshipUpdates(cast, [
      { from: 'Ada', to: 'Ben', kind: 'rival', note: 'after the theft', keep: true },
      { from: 'Ben', to: 'Ada', kind: 'debt', note: 'owes silence', keep: false }
    ]);
    const ada = next.find((c) => c.id === 'c1')!;
    const ben = next.find((c) => c.id === 'c2')!;
    expect(ada.relationships).toEqual([{ targetId: 'c2', kind: 'rival', note: 'after the theft' }]);
    expect(ben.relationships).toEqual([]);
  });
});

describe('buildNextSeasonPlotTargets', () => {
  it('merges raise, kept arc, and carried pending with de-dupe and cap', () => {
    const targets = buildNextSeasonPlotTargets({
      raiseBeats: [
        { text: 'Find the key', consequence: 'before dawn' },
        { text: 'Find the key', consequence: 'before dawn' }
      ],
      plotArc: [
        { text: 'Confront Mira', keep: true },
        { text: 'Find the key → before dawn', keep: true },
        { text: 'Dropped pressure', keep: false }
      ],
      carried: [
        { id: 't1', text: 'Old debt', status: 'pending', source: 'manual' },
        { id: 't2', text: 'Confront Mira', status: 'pending', source: 'season-raise' },
        { id: 't3', text: 'Already hit', status: 'hit', source: 'manual' }
      ],
      cap: 8
    });
    const texts = targets.map((t) => t.text.toLowerCase());
    expect(texts.filter((t) => t.includes('find the key')).length).toBe(1);
    expect(texts).toContain('confront mira');
    expect(texts).toContain('old debt');
    expect(texts).not.toContain('dropped pressure');
    expect(texts).not.toContain('already hit');
    expect(targets.every((t) => t.status === 'pending')).toBe(true);
  });

  it('soft-dedupes Raise "text → consequence" against bare arc text', () => {
    const targets = buildNextSeasonPlotTargets({
      raiseBeats: [{ text: 'Confront Mira', consequence: 'at the quay' }],
      plotArc: [{ text: 'Confront Mira', keep: true }],
      carried: [],
      cap: 8
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].text.toLowerCase()).toContain('confront mira');
  });
});
