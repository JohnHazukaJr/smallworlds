import { describe, expect, it } from 'vitest';
import type { NpcMemory } from './types';
import {
  NPC_MEMORY_CAP, NPC_MEMORY_PER_PASS, addMemories, clampSalience, forgetFiledSince, memoryCardLine, recallMemories
} from './npcMemory';
import { answeredMove, groupMemoryDrafts, turnsToGrade } from './ai/engine';
import { BOND_RUBRIC } from './bonds';

let seq = 0;
const makeId = () => `m${++seq}`;

const mem = (text: string, salience: 1 | 2 | 3, createdAt: number, episodeId = 'e1'): NpcMemory => ({
  id: makeId(), text, salience, createdAt, episodeId
});

describe('addMemories', () => {
  it('cleans, clamps, and files at most a couple per pass', () => {
    const out = addMemories([], [
      { text: '  The stranger   paid the debt in silver.  ', feeling: 'uneasy', salience: 7 },
      { text: 'They shared bread by the fire at dusk.', feeling: 'none', salience: 0 },
      { text: 'A third memory that should be dropped this pass.', salience: 2 }
    ], { episodeId: 'e1', now: 1000, makeId });
    expect(out).toHaveLength(NPC_MEMORY_PER_PASS);
    expect(out[0]).toMatchObject({ text: 'The stranger paid the debt in silver.', feeling: 'uneasy', salience: 3, episodeId: 'e1' });
    expect(out[1].feeling).toBeUndefined();
    expect(out[1].salience).toBe(1);
  });

  it('skips near-duplicates of what they already remember and scraps', () => {
    const existing = [mem('The stranger paid the old debt in silver coins.', 2, 1)];
    const out = addMemories(existing, [
      { text: 'The stranger paid the old debt in silver coins today.' },
      { text: 'ok' }
    ], { episodeId: 'e1', now: 2000, makeId });
    expect(out).toEqual(existing);
  });

  it('prunes to the cap, keeping the memories that marked them', () => {
    const existing = Array.from({ length: NPC_MEMORY_CAP }, (_, i) =>
      mem(`Routine moment number ${i} at the harbour office`, i === 0 ? 3 : 1, i + 1)
    );
    const out = addMemories(existing, [{ text: 'Watched the warehouse burn down', salience: 2 }], {
      episodeId: 'e1', now: 100, makeId
    });
    expect(out).toHaveLength(NPC_MEMORY_CAP);
    expect(out.some((m) => m.salience === 3)).toBe(true);
    expect(out.some((m) => m.text === 'Watched the warehouse burn down')).toBe(true);
    // The oldest passing memory is the one that fades.
    expect(out.some((m) => m.text.endsWith('number 1 at the harbour office'))).toBe(false);
  });
});

describe('recallMemories', () => {
  const list = [
    mem('Lost a card game to the captain and owes him a favour', 1, 10),
    mem('The player pulled them from the burning warehouse', 3, 20),
    mem('Argued with Ben about the harbour ledger', 2, 30),
    mem('Bought apples at the market', 1, 40)
  ];

  it('reaches for what the moment is about, then what marked them, oldest first', () => {
    const got = recallMemories(list, 'Ben slams the harbour ledger on the desk', 2);
    expect(got.map((m) => m.text)).toEqual([
      'The player pulled them from the burning warehouse',
      'Argued with Ben about the harbour ledger'
    ]);
  });

  it('is empty without memories', () => {
    expect(recallMemories(undefined, 'anything')).toEqual([]);
  });

  it('writes a card line with the feeling', () => {
    expect(memoryCardLine({ ...list[1], feeling: 'grateful' })).toBe(
      'The player pulled them from the burning warehouse (left them grateful)'
    );
  });
});

describe('forgetFiledSince', () => {
  it('drops only this chapter\'s memories from the rewind point on', () => {
    const list = [mem('before', 1, 5), mem('after rewind', 1, 50), mem('other chapter', 1, 60, 'e0')];
    expect(forgetFiledSince(list, 'e1', 40)?.map((m) => m.text)).toEqual(['before', 'other chapter']);
    expect(forgetFiledSince(list, 'e1', 100)).toBeNull();
  });
});

describe('groupMemoryDrafts', () => {
  it('files drafts under people present, by name or alias', () => {
    const grouped = groupMemoryDrafts([
      { name: 'ada', text: 'One' },
      { name: 'The Registrar', text: 'Two' },
      { name: 'Mallory', text: 'Not here' },
      { name: 'Ben', text: '' }
    ], [
      { id: 'c1', name: 'Ada', aliases: ['The Registrar'] },
      { id: 'c2', name: 'Ben' }
    ]);
    expect([...grouped.entries()]).toEqual([['c1', [{ name: 'ada', text: 'One' }, { name: 'The Registrar', text: 'Two' }]]]);
  });
});

describe('bond rubric', () => {
  it('makes zero the default and scales to ±2', () => {
    expect(BOND_RUBRIC).toMatch(/0 — the default/);
    expect(BOND_RUBRIC).toMatch(/\+2/);
    expect(BOND_RUBRIC).toMatch(/-2/);
    expect(clampSalience('x')).toBe(1);
  });
});

describe('grading window', () => {
  const t = (role: 'user' | 'narrator', text: string) => ({ role, text });
  const turns = [t('user', 'aaaa'), t('narrator', 'bbbb'), t('user', 'cccc'), t('narrator', 'dddd'), t('narrator', 'eeee')];

  it('grades only what landed since the last pass', () => {
    // 12 chars already graded: the first three turns.
    expect(turnsToGrade(turns, 12).map((x) => x.text)).toEqual(['dddd', 'eeee']);
  });

  it('after a reset, grades only from the last player move, never the whole chapter', () => {
    expect(turnsToGrade(turns, 0).map((x) => x.text)).toEqual(['cccc', 'dddd', 'eeee']);
    expect(turnsToGrade([t('narrator', 'x'), t('narrator', 'y'), t('narrator', 'z')], 0).map((x) => x.text)).toEqual(['y', 'z']);
  });
});

describe('answeredMove', () => {
  const turn = (id: string, role: 'user' | 'narrator') =>
    ({ id, role, episodeId: 'e', worldId: 'w', mode: null, text: id, createdAt: 0 }) as const;

  it('is the line right before a reply, and nothing for a Continue reply', () => {
    const turns = [turn('move', 'user'), turn('reply', 'narrator'), turn('continued', 'narrator')];
    expect(answeredMove([...turns], 1)?.id).toBe('move');
    expect(answeredMove([...turns], 2)).toBeUndefined();
    expect(answeredMove([...turns], 0)).toBeUndefined();
  });
});
