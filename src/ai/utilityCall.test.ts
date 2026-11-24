import { describe, expect, it } from 'vitest';
import { AIError } from './client';
import { extractJson, jsonInstruction, jsonValueIsEmpty, parseToolArguments, UTILITY_HARD_CAP_FACTOR, withStallSignal } from './utilityCall';
import { vi } from 'vitest';

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips fences and leading prose', () => {
    expect(extractJson<{ ok: boolean }>('Here you go:\n```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('throws on empty prose', () => {
    expect(() => extractJson('no json here')).toThrow(AIError);
  });
});

describe('parseToolArguments', () => {
  it('parses tool args or falls back to extractJson', () => {
    expect(parseToolArguments<{ beats: number }>('{"beats":2}')).toEqual({ beats: 2 });
    expect(parseToolArguments<{ beats: number }>('noise {"beats":3}')).toEqual({ beats: 3 });
  });
});

describe('jsonValueIsEmpty', () => {
  it('treats empty objects and arrays as empty', () => {
    expect(jsonValueIsEmpty({})).toBe(true);
    expect(jsonValueIsEmpty([])).toBe(true);
    expect(jsonValueIsEmpty(null)).toBe(true);
    expect(jsonValueIsEmpty({ title: 'Harbour' })).toBe(false);
    expect(jsonValueIsEmpty({ characters: [] })).toBe(false);
  });
});

describe('jsonInstruction', () => {
  it('asks for plain JSON when no return_json tool is sent', () => {
    expect(jsonInstruction('Call return_json with this shape: {}')).toBe('Reply with only a JSON object, with this shape: {}');
    expect(jsonInstruction('Call return_json with this shape: {}', 'return_json')).toBe('Call return_json with this shape: {}');
  });
});

describe('withStallSignal', () => {
  it('times out on silence, not while the model is still sending', () => {
    vi.useFakeTimers();
    try {
      const { signal, activity, cancel } = withStallSignal(undefined, 1000);
      vi.advanceTimersByTime(900);
      activity();
      vi.advanceTimersByTime(900);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(200);
      expect(signal.aborted).toBe(true);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still stops a model that never finishes', () => {
    vi.useFakeTimers();
    try {
      const { signal, activity, cancel } = withStallSignal(undefined, 1000);
      for (let t = 0; t < 1000 * UTILITY_HARD_CAP_FACTOR - 500; t += 500) {
        vi.advanceTimersByTime(500);
        activity();
      }
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(600);
      expect(signal.aborted).toBe(true);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
