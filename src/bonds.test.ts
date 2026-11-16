import { describe, expect, it } from 'vitest';
import { mergeRelationships } from './ai/engine';
import {
  applyTrackedShifts, goalsToKeep, marksToKeep, scoreStep,
  shouldDraftBondMeanings, shouldDraftGoalMeanings, withBondTracked
} from './bonds';
import { normalizeRelationships, upsertLink } from './relationships';
import type { Character, Relationship } from './types';

const person = (id: string, name: string, extras: Partial<Character> = {}): Character => ({
  id, worldId: 'w', name, role: '', age: '', appearance: '', mannerisms: '', summary: '',
  backstory: '', speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
  secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: '', emotion: '', location: '', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0,
  ...extras
});

const tracked = (score: number, extra: Partial<Relationship> = {}): Relationship => ({
  targetId: 'you',
  kind: 'wary',
  note: 'keeps the desk',
  track: true,
  score,
  ...extra
});

describe('scoreStep', () => {
  const base = { worldPace: 'measured' as const, stance: 'longform' as const, moment: false };

  it('moves a strong beat less on slow burn than on quick', () => {
    const slow = scoreStep({ ...base, shift: 2, pace: 'slow' });
    const quick = scoreStep({ ...base, shift: 2, pace: 'quick' });
    expect(slow).toBe(1);
    expect(quick).toBe(4);
    expect(slow).toBeLessThan(quick);
  });

  it('leaves a manual track and a moment turn where they are', () => {
    expect(scoreStep({ ...base, shift: 2, pace: 'manual' })).toBe(0);
    expect(scoreStep({ ...base, shift: 2, pace: 'quick', moment: true })).toBe(0);
  });
});

describe('applyTrackedShifts', () => {
  it('does not enroll an untracked tie', () => {
    const player = person('you', 'Sam', { isPlayer: true });
    const ada = person('c1', 'Ada', {
      relationships: [{ targetId: 'you', kind: 'wary', note: 'quiet' }]
    });
    const changes = applyTrackedShifts({
      people: [player, ada],
      bonds: [{ name: 'Ada', shift: 2, reason: 'she stayed' }],
      worldPace: 'quick',
      stance: 'longform',
      moment: false
    });
    expect(changes).toEqual([]);
    expect(ada.relationships[0].score).toBeUndefined();
  });

  it('moves nothing on a moment turn', () => {
    const player = person('you', 'Sam', { isPlayer: true });
    const ada = person('c1', 'Ada', { relationships: [tracked(19)] });
    const changes = applyTrackedShifts({
      people: [player, ada],
      bonds: [{ name: 'Ada', shift: 2 }],
      worldPace: 'quick',
      stance: 'longform',
      moment: true
    });
    expect(changes).toEqual([]);
  });

  it('keeps a locked kind and adds a crossed meaning when the tie is open', () => {
    const player = person('you', 'Sam', { isPlayer: true });
    const marks = [{ at: 21, text: 'she names who signed it' }];
    const locked = person('c1', 'Ada', {
      relationships: [tracked(19, { locked: true, marks })]
    });
    const open = person('c2', 'Bea', {
      relationships: [tracked(19, { marks })]
    });
    const lockedChanges = applyTrackedShifts({
      people: [player, locked],
      bonds: [{ name: 'Ada', shift: 2, reason: 'after the ledger' }],
      worldPace: 'quick',
      stance: 'longform',
      moment: false
    });
    const openChanges = applyTrackedShifts({
      people: [player, open],
      bonds: [{ name: 'Bea', shift: 2, reason: 'after the ledger' }],
      worldPace: 'quick',
      stance: 'longform',
      moment: false
    });
    const lockedRow = lockedChanges[0]?.relationships?.[0];
    const openRow = openChanges[0]?.relationships?.[0];
    expect(lockedRow?.score).toBe(23);
    expect(lockedRow?.kind).toBe('wary');
    expect(lockedRow?.note).toBe('keeps the desk');
    expect(openRow?.kind).toBe('wary');
    expect(openRow?.note).toContain('she names who signed it');
    expect(openRow?.note).toContain('after the ledger');
  });

  it('uses the fallback band as the kind when a tracked bond has no meanings', () => {
    const player = person('you', 'Sam', { isPlayer: true });
    const ada = person('c1', 'Ada', {
      relationships: [tracked(19, { kind: 'enemy' })]
    });
    const changes = applyTrackedShifts({
      people: [player, ada],
      bonds: [{ name: 'Ada', shift: 2 }],
      worldPace: 'quick',
      stance: 'longform',
      moment: false
    });
    expect(changes[0]?.relationships?.[0]).toMatchObject({ score: 23, kind: 'wary' });
  });
});

describe('relationship rewrites', () => {
  const row: Relationship = {
    targetId: 'c2', kind: 'wary', note: 'quiet', track: true, score: 22, pace: 'slow',
    marks: [{ at: 40, text: 'she shares the ledger' }]
  };

  it('keeps the score and the meanings through normalize', () => {
    const next = normalizeRelationships([row], ['c1', 'c2'], 'c1');
    expect(next[0]).toMatchObject({
      score: 22,
      pace: 'slow',
      marks: [{ at: 40, text: 'she shares the ledger' }]
    });
  });

  it('keeps the track when a row is rewritten, and drops it when tracking turns off', () => {
    const kept = upsertLink([row], { ...row, note: 'quiet still' });
    expect(kept[0]).toMatchObject({ score: 22, pace: 'slow', note: 'quiet still' });
    const off = upsertLink([row], withBondTracked(row, false));
    expect(off[0].track).toBeUndefined();
    expect(off[0].score).toBeUndefined();
    expect(off[0].marks).toBeUndefined();
    expect(off[0].kind).toBe('wary');
  });

  it('keeps the score when flesh-out rewrites the note', () => {
    const merged = mergeRelationships(
      [row],
      [{ targetId: 'c2', kind: 'lover', note: 'a longer note from the sheet fill' }]
    );
    expect(merged[0]).toMatchObject({
      track: true,
      score: 22,
      pace: 'slow',
      marks: [{ at: 40, text: 'she shares the ledger' }]
    });
  });
});

describe('draft guards', () => {
  it('drafts bond meanings only after tracking is on, and leaves a written list alone', () => {
    const bare: Relationship = { targetId: 'you', kind: 'wary', note: '' };
    const trackedRow: Relationship = { ...bare, track: true, score: 45 };
    const written: Relationship = { ...trackedRow, marks: [{ at: 20, text: 'she will not speak of the debt' }] };
    expect(shouldDraftBondMeanings(bare, true)).toBe(false);
    expect(shouldDraftBondMeanings(trackedRow, false)).toBe(true);
    expect(shouldDraftBondMeanings(written, false)).toBe(false);
    expect(shouldDraftBondMeanings(written, true)).toBe(true);
    expect(marksToKeep(written.marks, [{ at: 90, text: 'replaced' }], false)[0]?.text).toContain('debt');
  });

  it('drafts player goals only when asked, and leaves a written goal alone', () => {
    const written = [{ id: 'g1', text: 'prove the forgery', score: 10 }];
    const incoming = [{ id: 'g2', text: 'a drafted aim', score: 0 }];
    expect(goalsToKeep(undefined, incoming, false)).toEqual([]);
    expect(goalsToKeep([], incoming, true)[0]?.text).toBe('a drafted aim');
    expect(goalsToKeep(written, incoming, true)).toEqual(written);
    expect(shouldDraftGoalMeanings({ id: 'g1', text: '', score: 0 }, true)).toBe(false);
    expect(shouldDraftGoalMeanings(
      { id: 'g1', text: 'prove it', score: 0, marks: [{ at: 30, text: 'you know the office has a second book' }] },
      false
    )).toBe(false);
  });
});
