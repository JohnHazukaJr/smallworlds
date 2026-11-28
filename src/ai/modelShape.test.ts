import { describe, expect, it } from 'vitest';
import { rowList, textList } from './modelShape';
import { capSoftWrapExtract } from './engine';

describe('rowList', () => {
  it('keeps a proper list of rows', () => {
    expect(rowList([{ name: 'Ada', text: 'x' }])).toEqual([{ name: 'Ada', text: 'x' }]);
  });

  it('reads a plain list of strings into the given field', () => {
    expect(rowList(['A harbour clerk.', 'A dockmaster.'], 'description')).toEqual([
      { description: 'A harbour clerk.' },
      { description: 'A dockmaster.' }
    ]);
  });

  it('reads a map keyed by name', () => {
    expect(rowList({ Ada: { outcome: 'Leaves.' }, Brannoc: 'Stays.' }, 'outcome')).toEqual([
      { name: 'Ada', outcome: 'Leaves.' },
      { name: 'Brannoc', outcome: 'Stays.' }
    ]);
  });

  it('returns nothing for junk, never throws', () => {
    for (const junk of [undefined, null, 7, 'x', true]) expect(rowList(junk)).toEqual([]);
  });
});

describe('textList', () => {
  it('accepts one string, numbers, and rows with text', () => {
    expect(textList('One fact.')).toEqual(['One fact.']);
    expect(textList(['a', 2, { text: 'b' }, { other: 1 }, null])).toEqual(['a', '2', 'b']);
    expect(textList(undefined)).toEqual([]);
  });
});

describe('closing a chapter with a bent reply', () => {
  it('does not throw on a string, a keyed map, or mixed rows', () => {
    const raw = {
      facts: 'Mae saw the cart.',
      threads: [{ text: 'Who drove it?' }, 3],
      characterUpdates: { Ada: { emotion: 'cornered' }, Nobody: { emotion: 'x' } },
      staleFacts: 'The cart was never seen.'
    } as unknown as Parameters<typeof capSoftWrapExtract>[0];
    const out = capSoftWrapExtract(raw, new Set(['ada']));
    expect(out.facts).toEqual(['Mae saw the cart.']);
    expect(out.threads).toEqual(['Who drove it?', '3']);
    expect(out.characterUpdates).toEqual([{ name: 'Ada', emotion: 'cornered', goal: undefined, location: undefined, condition: undefined }]);
    expect(out.staleFacts).toEqual(['The cart was never seen.']);
  });
});
