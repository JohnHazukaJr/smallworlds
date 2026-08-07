import { describe, expect, it } from 'vitest';
import {
  groupSpeakParagraphs,
  parseInlineEmphasis,
  parseSpeakSegments
} from './dialogueFormat';

describe('parseSpeakSegments', () => {
  it('keeps in-quote *stress* inside one speech segment', () => {
    const segs = parseSpeakSegments('"I *said* leave."');
    expect(segs).toEqual([{ kind: 'speech', text: 'I *said* leave.' }]);
  });

  it('does not treat in-quote stress as action when action precedes speech', () => {
    const segs = parseSpeakSegments('*she leans in* "I *really* mean it."');
    expect(segs.map((s) => s.kind)).toEqual(['action', 'speech']);
    expect(segs[0].text).toBe('she leans in');
    expect(segs[1].text).toBe('I *really* mean it.');
  });

  it('emits break segments for blank lines between beats', () => {
    const segs = parseSpeakSegments('*nods*\n\n"First."\n\n"Second."');
    expect(segs.map((s) => s.kind)).toEqual(['action', 'break', 'speech', 'break', 'speech']);
    expect(segs[2].text).toBe('First.');
    expect(segs[4].text).toBe('Second.');
  });
});

describe('parseInlineEmphasis', () => {
  it('marks *said* as strong', () => {
    expect(parseInlineEmphasis('I *said* leave.')).toEqual([
      { text: 'I ' },
      { text: 'said', strong: true },
      { text: ' leave.' }
    ]);
  });

  it('marks **stress** as strong', () => {
    expect(parseInlineEmphasis('I **meant** that.')).toEqual([
      { text: 'I ' },
      { text: 'meant', strong: true },
      { text: ' that.' }
    ]);
  });
});

describe('groupSpeakParagraphs', () => {
  it('splits on break segments', () => {
    const segs = parseSpeakSegments('*nods*\n\n"First."\n\n"Second."');
    const paras = groupSpeakParagraphs(segs);
    expect(paras).toHaveLength(3);
    expect(paras[0].map((s) => s.kind)).toEqual(['action']);
    expect(paras[1].map((s) => s.kind)).toEqual(['speech']);
    expect(paras[2].map((s) => s.kind)).toEqual(['speech']);
  });
});
