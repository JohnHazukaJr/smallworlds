import { describe, expect, it } from 'vitest';
import { narrationNeedsContinue } from './dialogueFormat';
import { speakFollowUpKind } from './engine';

const finished = '*leans in* "The ledger is closed."';
const openQuote = '*nods* "I was going';

describe('one prose follow-up', () => {
  it('does not continue a finished line', () => {
    expect(speakFollowUpKind({
      text: finished,
      truncated: false,
      requireDialogue: true,
      hasDialogue: true,
      leaksWall: false,
      reasks: false
    })).toBe('none');
    expect(narrationNeedsContinue('Rain hits the glass and keeps on falling while nobody moves', {
      truncated: false
    })).toBe(false);
  });

  it('continues an open quote, including when the line is also missing dialogue', () => {
    expect(speakFollowUpKind({
      text: openQuote,
      truncated: false,
      requireDialogue: true,
      hasDialogue: false,
      leaksWall: true,
      reasks: true
    })).toBe('continue');
  });

  it('continues a length stop, but not a stall that already produced the sentence', () => {
    expect(speakFollowUpKind({
      text: finished,
      truncated: true,
      requireDialogue: true,
      hasDialogue: true,
      leaksWall: false,
      reasks: false
    })).toBe('continue');
    expect(speakFollowUpKind({
      text: finished,
      truncated: true,
      stalled: true,
      requireDialogue: true,
      hasDialogue: true,
      leaksWall: false,
      reasks: false
    })).toBe('none');
    expect(narrationNeedsContinue(finished, { truncated: true, stalled: true })).toBe(false);
  });

  it('picks only one of dialogue, wall, or re-ask', () => {
    expect(speakFollowUpKind({
      text: '*sets the cup down*',
      truncated: false,
      requireDialogue: true,
      hasDialogue: false,
      leaksWall: true,
      reasks: true
    })).toBe('dialogue');
    expect(speakFollowUpKind({
      text: '"Ivo took the guild money."',
      truncated: false,
      requireDialogue: true,
      hasDialogue: true,
      leaksWall: true,
      reasks: true
    })).toBe('wall');
    expect(speakFollowUpKind({
      text: '"Where did you put it?"',
      truncated: false,
      requireDialogue: true,
      hasDialogue: true,
      leaksWall: false,
      reasks: true
    })).toBe('reask');
  });
});
