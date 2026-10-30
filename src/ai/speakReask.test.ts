import { describe, expect, it } from 'vitest';
import {
  questionOverlapScore,
  rewriteReaskSpeakBrief,
  speakBriefLooksLikeReask,
  speakReasksPriorQuestion
} from './speakReask';

const PRIOR = '"Where were you last night, and who saw the brass key?"';

describe('speakReasksPriorQuestion', () => {
  it('flags a rephrased question that still asks', () => {
    expect(speakReasksPriorQuestion(
      '*leans in* "So where were you last night with the brass key?"',
      PRIOR
    )).toBe(true);
  });

  it('accepts a line that advances without re-asking', () => {
    expect(speakReasksPriorQuestion(
      '*nods once* "The quay, then. We check the blotter."',
      PRIOR
    )).toBe(false);
  });

  it('ignores a new question that does not overlap the prior one', () => {
    expect(speakReasksPriorQuestion(
      '*taps the page* "Will you sign the debt?"',
      PRIOR
    )).toBe(false);
  });
});

describe('speakBriefLooksLikeReask', () => {
  it('flags a brief that is only ask-again intent', () => {
    expect(speakBriefLooksLikeReask('ask again where they were last night with the key', PRIOR)).toBe(true);
    expect(speakBriefLooksLikeReask('Where were you?', PRIOR)).toBe(true);
  });

  it('passes a brief that registers and advances', () => {
    expect(speakBriefLooksLikeReask(
      'register their answer about the quay; doubt it and push for the key',
      PRIOR
    )).toBe(false);
  });
});

describe('rewriteReaskSpeakBrief', () => {
  it('names the asker and forbids the same question', () => {
    const brief = rewriteReaskSpeakBrief('Ada', 'At the quay.');
    expect(brief).toMatch(/Ada/);
    expect(brief).toMatch(/At the quay/);
    expect(brief).toMatch(/do not ask that same question/i);
  });
});

describe('questionOverlapScore', () => {
  it('needs two distinctive shared words', () => {
    expect(questionOverlapScore('brass key night', 'brass key harbour')).toBeGreaterThan(0);
    expect(questionOverlapScore('brass only', 'brass key harbour')).toBe(0);
  });
});
