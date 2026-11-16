import { describe, expect, it } from 'vitest';
import { narrationNeedsContinue } from './dialogueFormat';
import { KnowledgeWallError, partialReplyAfterError } from './engine';

const finished = '*leans in* "The ledger is closed."';
const openQuote = '*nods* "I was going';

describe('one prose follow-up', () => {
  it('does not continue a finished line', () => {
    expect(narrationNeedsContinue('Rain hits the glass and keeps on falling while nobody moves', {
      truncated: false
    })).toBe(false);
    expect(narrationNeedsContinue(finished, { truncated: false })).toBe(false);
  });

  it('continues an open quote', () => {
    expect(narrationNeedsContinue(openQuote, { truncated: false })).toBe(true);
  });

  it('continues a length stop, but not a stall that already produced the sentence', () => {
    expect(narrationNeedsContinue(finished, { truncated: true })).toBe(true);
    expect(narrationNeedsContinue(finished, { truncated: true, stalled: true })).toBe(false);
  });
});

describe('partialReplyAfterError', () => {
  const clean = 'Rain on the glass.';
  it('drops a knowledge-wall failure even when an earlier prefix was clean', () => {
    expect(partialReplyAfterError({
      error: new KnowledgeWallError(),
      safeText: clean,
      stillLeaks: () => false
    })).toBeNull();
  });

  it('keeps a clean prefix when the connection drops', () => {
    expect(partialReplyAfterError({
      error: new Error('network'),
      safeText: clean,
      stillLeaks: () => false
    })).toBe(clean);
    expect(partialReplyAfterError({
      error: new Error('network'),
      safeText: 'the secret',
      stillLeaks: (text) => text.includes('secret')
    })).toBeNull();
  });
});
