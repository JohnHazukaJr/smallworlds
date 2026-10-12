import { describe, expect, it } from 'vitest';
import { knowledgeWallScore, speakLeaksMustNotKnow, acceptWallRetry, clearMustNotKnowClause } from './knowledgeWall';

const WALL = 'That Ivo took guild money to cover the debt — she must not learn this until the story reveals it.';

describe('speakLeaksMustNotKnow', () => {
  it('flags distinctive overlap (Ivo + guild)', () => {
    expect(speakLeaksMustNotKnow('*stamps the page* "Ivo took the guild money."', WALL)).toBe(true);
    expect(knowledgeWallScore('Ivo took the guild money.', WALL)).toBeGreaterThan(0);
  });

  it('does not flag a single common word', () => {
    expect(speakLeaksMustNotKnow('*looks up* "The lamp ticks."', WALL)).toBe(false);
  });

  it('never leaks on an empty wall', () => {
    expect(speakLeaksMustNotKnow('"Ivo took the guild money."', '')).toBe(false);
    expect(speakLeaksMustNotKnow('"Ivo took the guild money."', '   ')).toBe(false);
  });
});

describe('acceptWallRetry', () => {
  it('drops a retry that still states the forbidden fact', () => {
    expect(acceptWallRetry('Ivo took the guild money.', WALL)).toBeNull();
    expect(acceptWallRetry('   ', WALL)).toBeNull();
  });

  it('keeps a retry that stays clear of the wall', () => {
    expect(acceptWallRetry('  The lamp ticks.  ', WALL)).toBe('The lamp ticks.');
  });
});

describe('clearMustNotKnowClause', () => {
  it('removes a clause that overlaps what they learned and keeps the rest', () => {
    const wall = 'Ivo took the guild money; the lamp is cracked';
    expect(clearMustNotKnowClause(wall, 'Ivo took the guild money')).toBe('the lamp is cracked');
  });

  it('leaves an unrelated clause in place', () => {
    expect(clearMustNotKnowClause('the lamp is cracked', 'Ivo took guild money')).toBe('the lamp is cracked');
  });
});
