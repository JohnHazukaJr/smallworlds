import { describe, expect, it } from 'vitest';
import { canRewriteFromHere, isUserInjection, shouldFileUserTurn } from './engine';

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
