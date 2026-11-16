import { describe, expect, it } from 'vitest';
import { textMatchScore } from './engine';
import {
  compressOmittedTurns,
  turnsSinceCharMark,
  selectFactsPinnedFirst,
  historyTailFor,
  OVERFLOW_HISTORY_TAIL
} from './prompts';
import { inferContextWindowTokens, promptCharBudget } from './contextBudget';
import { AIError, isContextOverflowError, isEmptyModelResponse, isPromptPackRetryError } from './client';
import type { ContinuityFact, Turn } from '../types';

describe('textMatchScore', () => {
  it('scores paraphrases with shared content words', () => {
    expect(
      textMatchScore(
        'recover stolen harbour ledger',
        'Recover the stolen harbour ledger before dawn'
      )
    ).toBeGreaterThan(0.6);
  });

  it('rejects weak single-token overlap', () => {
    expect(textMatchScore('the fog', 'Recover the stolen harbour ledger before dawn')).toBe(0);
  });
});

describe('lorebook recall', () => {
  it('pulls a related fact that does not share words with this beat', () => {
    const facts: ContinuityFact[] = [
      {
        id: 'a', worldId: 'w', seasonId: 's', text: 'The brass key opens the harbour office',
        source: 'manual', createdAt: 1
      },
      {
        id: 'b', worldId: 'w', seasonId: 's', text: 'The harbour office ledger names Ivo',
        source: 'manual', createdAt: 2
      },
      {
        id: 'c', worldId: 'w', seasonId: 's', text: 'Rain on the chapel glass',
        source: 'manual', createdAt: 3
      }
    ];
    const picked = selectFactsPinnedFirst(facts, [], 2, 'Where is the brass key?');
    expect(picked.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('matches a filed key when the beat uses another word for the same thing', () => {
    const facts: ContinuityFact[] = [
      {
        id: 'a', worldId: 'w', seasonId: 's', text: 'A debt sits under a false hand',
        keys: ['harbor'], source: 'manual', createdAt: 1
      },
      {
        id: 'b', worldId: 'w', seasonId: 's', text: 'Rain on the chapel glass',
        source: 'manual', createdAt: 2
      }
    ];
    const picked = selectFactsPinnedFirst(facts, [], 1, 'We walk the harbour road');
    expect(picked.map((f) => f.id)).toEqual(['a']);
  });
});

describe('turnsSinceCharMark', () => {
  it('returns only the turns after the watermark', () => {
    const turns = [
      { text: 'aaaa' },
      { text: 'bbbb' },
      { text: 'cccc' }
    ];
    expect(turnsSinceCharMark(turns, 4).map((t) => t.text)).toEqual(['bbbb', 'cccc']);
    expect(turnsSinceCharMark(turns, 0)).toHaveLength(3);
  });
});

describe('compressOmittedTurns', () => {
  it('keeps the whole omitted chapter when it fits', () => {
    const turns: Turn[] = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: 'narrator' as const,
      mode: null,
      text: `MARKER_${i}_` + 'x'.repeat(200),
      createdAt: i
    }));
    const digest = compressOmittedTurns(turns, []);
    expect(digest).toContain('MARKER_0_');
    expect(digest).toContain('MARKER_15_');
    expect(digest).toContain('MARKER_29_');
    expect(digest).not.toContain('…');
  });

  it('samples the middle when the omitted chapter is long', () => {
    const turns: Turn[] = Array.from({ length: 24 }, (_, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: 'narrator' as const,
      mode: null,
      text: `MARKER_${i}_` + 'x'.repeat(800),
      createdAt: i
    }));
    const digest = compressOmittedTurns(turns, []);
    expect(digest).toContain('MARKER_0_');
    expect(digest).toContain('MARKER_23_');
    expect(digest).toMatch(/MARKER_1[0-5]_/);
    expect(digest.split('…').length).toBeGreaterThanOrEqual(4);
  });
});

describe('context window heuristics', () => {
  it('defaults unknown models to 32k', () => {
    expect(inferContextWindowTokens('some-local-chat')).toBe(32_768);
  });

  it('recognizes gemini, claude, and suffix windows', () => {
    expect(inferContextWindowTokens('gemini-2.5-flash')).toBe(1_048_576);
    expect(inferContextWindowTokens('claude-haiku-4-5')).toBe(200_000);
    expect(inferContextWindowTokens('my-model-8k')).toBe(8 * 1024);
  });

  it('gives known large families a long window and small local ids a short one', () => {
    expect(inferContextWindowTokens('qwen2.5-72b')).toBe(128_000);
    expect(inferContextWindowTokens('ollama/llama3')).toBe(8_192);
    expect(inferContextWindowTokens('custom-ctx-8192')).toBe(8192);
  });

  it('lets an author window override the model-name guess', () => {
    const overridden = promptCharBudget('unknown', 1100, { windowTokens: 8192 });
    expect(overridden).toBe(Math.floor((8192 - 1100 - 1024) * 3.2));
    expect(overridden).toBeLessThan(promptCharBudget('unknown', 1100));
    expect(promptCharBudget('my-model-4k', 400, { windowTokens: 131_072 }))
      .toBeGreaterThan(promptCharBudget('my-model-4k', 400));
  });

  it('keeps a 32k unknown model above a short chapter', () => {
    expect(promptCharBudget('unknown', 1100)).toBeGreaterThanOrEqual(12_000);
  });

  it('does not lift a 4k model up to 12,000 characters', () => {
    const budget = promptCharBudget('my-model-4k', 1400);
    expect(budget).toBeLessThan(12_000);
    expect(budget).toBeLessThan(4 * 1024 * 4);
  });

  it('cuts the transcript tail only on the overflow retry', () => {
    const normal = historyTailFor('unknown', 'narrator', 'normal');
    const tight = historyTailFor('unknown', 'narrator', 'tight');
    expect(normal.maxTurns).toBeGreaterThan(OVERFLOW_HISTORY_TAIL.maxTurns);
    expect(tight).toEqual(OVERFLOW_HISTORY_TAIL);
  });
});

describe('isContextOverflowError', () => {
  it('detects common provider overflow copy', () => {
    expect(isContextOverflowError(new Error('context_length_exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('This model\'s maximum context length is 8192'))).toBe(true);
    expect(isContextOverflowError(new Error('prompt is too long'))).toBe(true);
    expect(isContextOverflowError(new Error('input tokens exceed the limit'))).toBe(true);
    expect(isContextOverflowError(new Error('max prompt size exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('too much context'))).toBe(true);
    expect(isContextOverflowError(new Error('exceeds the context window'))).toBe(true);
    expect(isContextOverflowError(new Error('context size is too large'))).toBe(true);
    expect(isContextOverflowError(new Error('HTTP 413'))).toBe(true);
    expect(isContextOverflowError(new AIError('payload too large', 413))).toBe(true);
    expect(isContextOverflowError(new Error('rate limited'))).toBe(false);
  });

  it('does not treat empty replies as overflow', () => {
    const empty = new AIError('The model returned an empty response (stop: stop).');
    expect(isEmptyModelResponse(empty)).toBe(true);
    expect(isPromptPackRetryError(empty)).toBe(false);
    expect(isContextOverflowError(empty)).toBe(false);
    expect(isPromptPackRetryError(new Error('rate limited'))).toBe(false);
  });

  it('does not treat generic token or timeout copy as overflow', () => {
    expect(isContextOverflowError(new Error('used 500 input tokens'))).toBe(false);
    expect(isContextOverflowError(new Error('The request took too long'))).toBe(false);
    expect(isPromptPackRetryError(new Error('context_length_exceeded'))).toBe(true);
  });
});
