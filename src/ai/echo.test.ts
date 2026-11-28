import { describe, expect, it } from 'vitest';
import { echoOf, openingSpokenSentence, opensWithEcho, playerSpokenWords } from './echo';
import { extractJson } from './utilityCall';
import { liveMemoryFailWarning } from './engine';
import { playerMoveLabel } from './prompts';
import type { Character } from '../types';
import { AIError } from './client';

describe('opensWithEcho', () => {
  // Replies from the llama-4-scout eval run.
  it('catches an NPC re-asking the line as a question', () => {
    const reply = 'Brannoc: *chuckles* "See who took it? Aye, I saw no one, lad."';
    expect(opensWithEcho('Did you see who took the ledger last night Brannoc?', reply)).toBe('See who took it?');
  });

  it('catches a long verbatim repeat', () => {
    expect(opensWithEcho(
      'How are the wedding plans for your daughter coming along?',
      '"The wedding plans for your daughter, you ask. Grand."'
    )).not.toBeNull();
  });

  // Replies from the deepseek eval run, and plain answers.
  it('passes an answer that reuses the question’s words', () => {
    expect(opensWithEcho('Ada, who signed this page?', '"I signed this page." She does not look up.')).toBeNull();
    expect(opensWithEcho('Ada, who signed this page?', '"The same hand that signed every page in that quarter. Why?"')).toBeNull();
    expect(opensWithEcho(
      'Did you see who took the ledger last night Brannoc?',
      '"Ledger? What ledger? I was down at the docks \'til the tide turned, lad."'
    )).toBeNull();
  });

  it('ignores a re-ask made only of small words', () => {
    expect(opensWithEcho('Sister, do you think the Registrar could forge a page?', '"Do you think I would know?"')).toBeNull();
  });

  it('skips short lines and replies with no speech', () => {
    expect(opensWithEcho('Where is it?', '"Where is it? Gone."')).toBeNull();
    expect(opensWithEcho('Did you see who took the ledger?', 'He says nothing and looks away.')).toBeNull();
  });

  it('reads the first credited beat when there are beats', () => {
    const beats = [
      { role: 'narrator' as const, text: 'Fog at the glass.' },
      { role: 'character' as const, text: '*squints* "Who took the ledger? Nobody."', speakerId: 'b' }
    ];
    expect(openingSpokenSentence('', beats)).toBe('Who took the ledger?');
    expect(opensWithEcho('Did you see who took the ledger last night?', '', beats)).toBe('Who took the ledger?');
  });
});

describe('playerSpokenWords', () => {
  it('takes speech and quoted parts of a mixed move, never actions or directions', () => {
    expect(playerSpokenWords('speak', '"Where were you?"')).toBe('Where were you?');
    expect(playerSpokenWords('play', '*leans in* "Where were you?" *waits*')).toBe('Where were you?');
    expect(playerSpokenWords('act', 'I hold her gaze.')).toBe('');
    expect(playerSpokenWords('steer', 'Brannoc leaves.')).toBe('');
  });
});

describe('echoOf', () => {
  it('reports whether the longest run holds a real word', () => {
    expect(echoOf('do you think so', 'do you think I would').runHasContent).toBe(false);
    expect(echoOf('who took the ledger', 'who took the ledger').runHasContent).toBe(true);
  });
});

describe('utility parse failures', () => {
  it('carry the start of what the model sent', () => {
    try {
      extractJson('Sure! Here is the update you asked for.');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AIError);
      expect((e as AIError).raw).toBe('Sure! Here is the update you asked for.');
    }
  });

  it('warn at three misses in a row, then every five', () => {
    expect([1, 2, 3, 4, 7, 8, 13].map((n) => !!liveMemoryFailWarning(n))).toEqual([false, false, true, false, false, true, true]);
    expect(liveMemoryFailWarning(3)).toContain('Story memory has not updated for 3 turns');
  });
});

describe('playerMoveLabel', () => {
  const rowan = { name: 'Rowan', isPlayer: true } as Character;
  it('names the player instead of "player"', () => {
    expect(playerMoveLabel('speak', [rowan])).toBe('Rowan says');
    expect(playerMoveLabel('act', [rowan])).toBe('Rowan does');
    expect(playerMoveLabel('play', [rowan])).toBe('Rowan');
    expect(playerMoveLabel('steer', [rowan])).toBe('author direction');
    expect(playerMoveLabel('continue', [rowan])).toBe('the scene continues');
    expect(playerMoveLabel('speak', [])).toBe('The protagonist says');
  });
});
