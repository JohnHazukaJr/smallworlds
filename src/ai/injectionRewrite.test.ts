import { describe, expect, it } from 'vitest';
import {
  canRewriteFromHere,
  injectionFollowUpBeats,
  injectionFollowUpBrief,
  isUserInjection,
  shouldFileUserTurn
} from './engine';

describe('rewrite from an injection', () => {
  it('files a normal Write and skips a rewrite that already has the line', () => {
    expect(shouldFileUserTurn({ mode: 'play', input: '"The ledger is forged."' })).toBe(true);
    expect(shouldFileUserTurn({
      mode: 'play',
      input: '"The ledger is forged."',
      keepExistingUserTurn: true
    })).toBe(false);
    expect(shouldFileUserTurn({ mode: 'continue', input: 'again' })).toBe(false);
    expect(shouldFileUserTurn({ mode: 'act', input: '   ' })).toBe(false);
  });

  it('offers rewrite-from-here on You and Write-as lines', () => {
    expect(isUserInjection({ role: 'user', asCharacterId: 'ada' })).toBe(true);
    expect(isUserInjection({ role: 'user' })).toBe(false);
    expect(canRewriteFromHere({ role: 'user' })).toBe(true);
    expect(canRewriteFromHere({ role: 'user', asCharacterId: 'ada' } as { role: string })).toBe(true);
    expect(canRewriteFromHere({ role: 'character' })).toBe(false);
    expect(canRewriteFromHere({ role: 'narrator' })).toBe(false);
  });
});

describe('narration after a Write-as line', () => {
  it('describes the injected line and drops every resumed speaker', () => {
    const brief = injectionFollowUpBrief({
      name: 'Ada',
      line: '"The ledger is forged."',
      location: 'Harbour office'
    });
    expect(brief).toContain('Ada');
    expect(brief).toContain('The ledger is forged.');
    expect(brief).toMatch(/counts as Ada's line/);
    expect(brief).toMatch(/Do not quote a new speaker/);
    expect(brief).toMatch(/Do not bring anyone into the room/);

    const kept = injectionFollowUpBeats([
      { type: 'speak', characterId: 'ben', brief: 'answer her about the ledger' },
      { type: 'narration', brief: 'The office holds still after Ada speaks.' }
    ], brief);
    expect(kept).toEqual([{ type: 'narration', brief: 'The office holds still after Ada speaks.' }]);
    expect(kept.some((b) => b.type === 'speak')).toBe(false);

    expect(injectionFollowUpBeats([], brief)).toEqual([{ type: 'narration', brief }]);
  });
});
