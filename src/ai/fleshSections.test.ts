import { describe, expect, it } from 'vitest';
import { fleshSectionsToRun } from './engine';
import { BIBLE_MIN_CHARS } from '../worldOps';

const empty = {
  bible: '',
  premise: '',
  narratorRules: [] as string[],
  hasPlayer: true,
  playerSummary: '',
  playerGoal: ''
};

describe('fleshSectionsToRun', () => {
  it('asks for every blank section', () => {
    expect(fleshSectionsToRun(empty)).toEqual({
      lore: true,
      premise: true,
      rules: true,
      player: true
    });
  });

  it('skips lore, premise, rules, and you once each one is already written', () => {
    expect(fleshSectionsToRun({
      bible: 'x'.repeat(BIBLE_MIN_CHARS),
      premise: 'The ledger is open on the long table.',
      narratorRules: ['Never skip time without asking.'],
      hasPlayer: true,
      playerSummary: 'You are living under a false name.',
      playerGoal: ''
    })).toEqual({
      lore: false,
      premise: false,
      rules: false,
      player: false
    });
  });

  it('still fleshes you when summary and goal are both empty', () => {
    expect(fleshSectionsToRun({
      ...empty,
      bible: 'x'.repeat(BIBLE_MIN_CHARS),
      premise: 'The harbour is awake.',
      narratorRules: ['Stay in the room.']
    }).player).toBe(true);
  });

  it('treats a goal alone as enough to leave the player sheet alone', () => {
    expect(fleshSectionsToRun({
      ...empty,
      playerGoal: 'Keep the ledger quiet.'
    }).player).toBe(false);
  });

  it('ignores blank rule lines', () => {
    expect(fleshSectionsToRun({
      ...empty,
      narratorRules: ['', '   ']
    }).rules).toBe(true);
  });
});
