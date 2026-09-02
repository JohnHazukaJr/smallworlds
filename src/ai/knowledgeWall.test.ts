import { describe, expect, it } from 'vitest';
import { knowledgeWallScore, speakLeaksMustNotKnow } from './knowledgeWall';

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
