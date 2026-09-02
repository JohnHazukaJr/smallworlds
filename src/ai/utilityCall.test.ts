import { describe, expect, it } from 'vitest';
import { AIError } from './client';
import { extractJson, jsonValueIsEmpty, parseToolArguments } from './utilityCall';

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
