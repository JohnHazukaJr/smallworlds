import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATS, activeMechanics, applyInventoryChanges, checkChipText, checkDirective, defaultMechanics,
  inventoryLine, needsReferee, resolveCheck, statLine, tierFor
} from './mechanics';
import { checkFromRuling } from './ai/checks';
import type { CheckResult, InventoryItem } from './types';

/** Returns dice faces in order: face n → (n - 1) / 6. */
const diceRng = (...faces: number[]) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 1) / 6 + 0.01;
};

describe('tiers', () => {
  it('follows 6- / 7–9 / 10+ with a natural 12 as crit', () => {
    expect(tierFor([3, 3], 6)).toBe('fail');
    expect(tierFor([3, 4], 7)).toBe('partial');
    expect(tierFor([4, 5], 9)).toBe('partial');
    expect(tierFor([4, 6], 10)).toBe('success');
    expect(tierFor([6, 6], 10)).toBe('crit');
  });
});

describe('resolveCheck', () => {
  it('adds stat, difficulty, world, and item', () => {
    const check = resolveCheck({
      intent: 'pick the lock',
      stat: DEFAULT_STATS[1],
      statValue: 2,
      difficulty: 'hard',
      world: 'forgiving',
      item: 'lockpicks',
      rng: diceRng(3, 4)
    });
    expect(check.dice).toEqual([3, 4]);
    expect(check.modifier).toBe(2 - 1 + 1 + 1);
    expect(check.total).toBe(10);
    expect(check.tier).toBe('success');
    expect(check.stat).toBe('Finesse');
    expect(checkChipText(check)).toBe('Finesse · success · 10');
  });

  it('clamps an out-of-range stat', () => {
    const check = resolveCheck({
      intent: 'lift the gate', stat: DEFAULT_STATS[0], statValue: 9, difficulty: 'normal', world: 'fair', rng: diceRng(1, 1)
    });
    expect(check.modifier).toBe(3);
    expect(check.tier).toBe('fail');
  });
});

describe('checkDirective', () => {
  it('orders the outcome without numbers', () => {
    const check: CheckResult = {
      intent: 'sneak past the guard', stat: 'Finesse', difficulty: 'normal', dice: [2, 5], modifier: 1, total: 8, tier: 'partial'
    };
    const text = checkDirective(check);
    expect(text).toContain('sneak past the guard');
    expect(text).toContain('Partial success');
    expect(text).toContain('Do not mention dice');
    expect(text).not.toMatch(/\b8\b/);
  });
});

describe('checkFromRuling', () => {
  const mechanics = { ...defaultMechanics(), enabled: true };
  const player = {
    stats: { presence: 2 },
    inventory: [{ id: 'i1', name: 'forged writ', qty: 1 }] as InventoryItem[]
  };

  it('rolls nothing for a safe move or a failed referee', () => {
    expect(checkFromRuling({ ruling: { risky: false }, mechanics, player, moveText: 'I look around' })).toBeNull();
    expect(checkFromRuling({ ruling: null, mechanics, player, moveText: 'I look around' })).toBeNull();
  });

  it('matches the stat and a carried item loosely, and defaults difficulty', () => {
    const check = checkFromRuling({
      ruling: { risky: true, intent: 'bluff past the clerk', stat: 'presence', difficulty: 'impossible', item: 'writ' },
      mechanics,
      player,
      moveText: 'I wave the writ',
      rng: diceRng(4, 4)
    })!;
    expect(check.stat).toBe('Presence');
    expect(check.difficulty).toBe('normal');
    expect(check.item).toBe('forged writ');
    expect(check.total).toBe(8 + 2 + 0 + 0 + 1);
  });

  it('ignores an item the player does not carry', () => {
    const check = checkFromRuling({
      ruling: { risky: true, stat: 'Might', item: 'sword' }, mechanics, player, moveText: 'I swing', rng: diceRng(2, 2)
    })!;
    expect(check.item).toBeUndefined();
  });
});

describe('activeMechanics', () => {
  it('is null when off and caps stats when on', () => {
    expect(activeMechanics({ mechanics: defaultMechanics() })).toBeNull();
    expect(activeMechanics({})).toBeNull();
    const many = [...DEFAULT_STATS, { key: 'luck', name: 'Luck' }];
    expect(activeMechanics({ mechanics: { enabled: true, stats: many, difficulty: 'fair' } })?.stats).toHaveLength(4);
  });
});

describe('inventory', () => {
  let n = 0;
  const makeId = () => `n${++n}`;
  const pack: InventoryItem[] = [
    { id: 'a', name: 'rope', qty: 1 },
    { id: 'b', name: 'silver coin', qty: 3 }
  ];

  it('adds, stacks, spends, and drops what runs out', () => {
    const next = applyInventoryChanges(pack, [
      { action: 'add', name: 'a lantern' },
      { action: 'add', name: 'Silver coin', qty: 2 },
      { action: 'remove', name: 'the rope' },
      { action: 'remove', name: 'map' },
      { action: 'juggle', name: 'rope' }
    ], makeId)!;
    expect(next.map((i) => [i.name, i.qty])).toEqual([['silver coin', 5], ['a lantern', 1]]);
    expect(inventoryLine(next)).toBe('silver coin ×5, a lantern');
  });

  it('reports no change as null', () => {
    expect(applyInventoryChanges(pack, [{ action: 'remove', name: 'map' }], makeId)).toBeNull();
    expect(applyInventoryChanges(pack, undefined, makeId)).toBeNull();
  });

  it('writes a stat line for the referee', () => {
    expect(statLine(DEFAULT_STATS.slice(0, 2), { stats: { might: -1 } })).toBe(
      'Might -1 (force, endurance, fighting), Finesse +0 (speed, stealth, fine hands)'
    );
  });
});

describe('needsReferee', () => {
  it('always asks for an action', () => {
    expect(needsReferee('act', 'I climb the wall')).toBe(true);
  });

  it('skips plain conversation', () => {
    expect(needsReferee('play', '"Where were you last night?"')).toBe(false);
    expect(needsReferee('speak', '"Thanks for the tea."')).toBe(false);
    expect(needsReferee('steer', 'Make it rain.')).toBe(false);
    expect(needsReferee('continue', '')).toBe(false);
  });

  it('asks when speech carries a gesture or a deed', () => {
    expect(needsReferee('play', '*slides the knife closer* "Talk."')).toBe(true);
    expect(needsReferee('play', '"Hold this," I say, and vault the railing.')).toBe(true);
  });

  it('asks when speech presses on someone', () => {
    expect(needsReferee('play', '"Trust me, the captain sent me."')).toBe(true);
    expect(needsReferee('play', '"Step aside or else."')).toBe(true);
    expect(needsReferee('play', '[threatening] "Last chance."')).toBe(true);
    expect(needsReferee('play', '[warm] "Last chance."')).toBe(false);
  });
});
