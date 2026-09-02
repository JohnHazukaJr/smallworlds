import { describe, expect, it } from 'vitest';
import {
  groupSpeakParagraphs,
  hasSpokenDialogue,
  parseInlineEmphasis,
  parseSpeakSegments,
  previewSpeakText,
  SPEAK_FORMAT_RULES,
  speakHoldsForPlayer,
  stitchSpeakRetry,
  stripNarratorEmbeddedDialogue
} from './dialogueFormat';

describe('SPEAK_FORMAT_RULES', () => {
  it('uses contrasting concrete examples instead of soft RP stock', () => {
    expect(SPEAK_FORMAT_RULES).not.toMatch(/dimples|shyly/i);
    expect(SPEAK_FORMAT_RULES).toMatch(/ledger|salt/i);
  });

  it('tells the speaker to stop after one question', () => {
    expect(SPEAK_FORMAT_RULES).toMatch(/at most one question/i);
    expect(SPEAK_FORMAT_RULES).toMatch(/stop there/i);
  });
});

describe('speakHoldsForPlayer', () => {
  it('holds when quoted speech asks a question', () => {
    expect(speakHoldsForPlayer('*looks up* "Where were you last night?"')).toBe(true);
    expect(speakHoldsForPlayer('"You sure?"')).toBe(true);
  });

  it('does not hold on a statement or a question only in action', () => {
    expect(speakHoldsForPlayer('*nods* "The ledger is closed."')).toBe(false);
    expect(speakHoldsForPlayer('*mouths what now?* "Sit."')).toBe(false);
  });
});

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

describe('previewSpeakText', () => {
  it('hides dangling open quote while streaming', () => {
    const preview = previewSpeakText('*she smiles* "Hel');
    expect(preview).not.toContain('"Hel');
    expect(preview).toContain('Hel');
    expect(parseSpeakSegments(preview).some((s) => s.kind === 'action')).toBe(true);
  });
});

describe('stitchSpeakRetry', () => {
  it('keeps action from the first attempt when retry is speech-only', () => {
    const out = stitchSpeakRetry('*sets the stamp down* "No."', '"The ledger is closed."');
    expect(out).toMatch(/sets the stamp down/);
    expect(out).toMatch(/The ledger is closed/);
    expect(hasSpokenDialogue(out)).toBe(true);
  });

  it('keeps the retry when it already has a physical beat', () => {
    expect(stitchSpeakRetry('*nods*', '*leans in* "Yes."')).toBe('*leans in* "Yes."');
  });
});

describe('stripNarratorEmbeddedDialogue', () => {
  it('drops leaked Name: "line" from narrator prose', () => {
    const out = stripNarratorEmbeddedDialogue(
      'Rain on the glass.\nAda: "The ledger is closed."\nThe lamp ticks.'
    );
    expect(out).toContain('Rain on the glass.');
    expect(out).toContain('The lamp ticks.');
    expect(out).not.toMatch(/Ada:/);
    expect(out).not.toMatch(/ledger is closed/);
  });
});
