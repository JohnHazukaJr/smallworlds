import { describe, expect, it } from 'vitest';
import { normalizeLiveMemory } from './liveShape';
import { groupMemoryDrafts } from './engine';
import { classifyError } from '../errors';

describe('normalizeLiveMemory', () => {
  it('turns lists keyed by name into rows', () => {
    const out = normalizeLiveMemory({
      memories: { Ada: 'Rowan saw the watermark.', Brannoc: ['Mae saw a cart.', { text: 'Rowan pressed him.', salience: '2' }] },
      updates: { Ada: { emotion: 'cornered' } }
    });
    expect(out.memories).toEqual([
      { name: 'Ada', text: 'Rowan saw the watermark.' },
      { name: 'Brannoc', text: 'Mae saw a cart.' },
      { name: 'Brannoc', text: 'Rowan pressed him.', salience: 2 }
    ]);
    expect(out.updates).toEqual([{ name: 'Ada', emotion: 'cornered' }]);
  });

  it('accepts one bare row, a single string, and numbers where text belongs', () => {
    const out = normalizeLiveMemory({
      ties: { from: 'Ada', to: 'Rowan', kind: 'wary' },
      facts: 'The cart left at two.',
      bonds: [{ name: 42, shift: '1' }, 'junk', null]
    });
    expect(out.ties).toEqual([{ from: 'Ada', to: 'Rowan', kind: 'wary' }]);
    expect(out.facts).toEqual(['The cart left at two.']);
    // A bare string row has no name, so the code after this skips it.
    expect(out.bonds).toEqual([{ name: '42', shift: 1 }, { text: 'junk' }]);
  });

  it('drops what cannot be used instead of throwing', () => {
    const out = normalizeLiveMemory({ memories: 7, scene: { a: 1 }, movedTo: 'the quay', place: 'x' });
    expect(out.memories).toEqual([]);
    expect(out.scene).toEqual([]);
    expect(out.movedTo).toEqual({ place: 'the quay' });
    expect(out.place).toBeUndefined();
    expect(normalizeLiveMemory(null)).toEqual({});
    expect(normalizeLiveMemory(['x'])).toEqual({});
  });

  it('leaves absent fields absent, so "unchanged" still means unchanged', () => {
    expect(normalizeLiveMemory({ scene: ['Lamp lit.'] })).toEqual({ scene: ['Lamp lit.'] });
  });

  it('feeds the memory grouping that used to throw', () => {
    const { memories } = normalizeLiveMemory({ memories: { Ada: 'Rowan saw the watermark.' } });
    const grouped = groupMemoryDrafts(memories, [{ id: 'a', name: 'Ada', aliases: [] }]);
    expect(grouped.get('a')?.[0].text).toBe('Rowan saw the watermark.');
  });
});

describe('classifyError', () => {
  it('calls a fetch failure a network error, but not a bug', () => {
    expect(classifyError(new TypeError('Failed to fetch')).code).toBe('network');
    expect(classifyError(new TypeError('(drafts ?? []) is not iterable')).code).not.toBe('network');
  });
});
