import { describe, expect, it } from 'vitest';
import {
  attributionRun,
  dialogueSpeakerOf,
  isDialogueBlock,
  lastSpokenBy,
  type AttributableBlock
} from './attribution';

const says = (speaker: string): AttributableBlock => ({ kind: 'speak', speaker });
const acts = (speaker: string): AttributableBlock => ({ kind: 'action', speaker });
const narration: AttributableBlock = { kind: 'narration' };
const direction: AttributableBlock = { kind: 'direction' };

describe('dialogueSpeakerOf', () => {
  it('reports the speaker for spoken and acted blocks', () => {
    expect(dialogueSpeakerOf(says('Ada'))).toBe('Ada');
    expect(dialogueSpeakerOf(acts('Ada'))).toBe('Ada');
    expect(dialogueSpeakerOf({ kind: 'dialogue', speaker: 'Ada' })).toBe('Ada');
  });

  it('clears the floor for narration and author direction', () => {
    expect(dialogueSpeakerOf(narration)).toBeNull();
    expect(dialogueSpeakerOf(direction)).toBeNull();
    expect(isDialogueBlock(narration)).toBe(false);
  });

  it('handles a dialogue block with no known speaker', () => {
    expect(dialogueSpeakerOf({ kind: 'speak' })).toBeNull();
  });
});

describe('lastSpokenBy', () => {
  it('reads the floor from the end of a turn', () => {
    expect(lastSpokenBy([narration, says('Ada')])).toBe('Ada');
    expect(lastSpokenBy([says('Ada'), narration])).toBeNull();
    expect(lastSpokenBy([])).toBeNull();
  });
});

describe('attributionRun', () => {
  it('names a speaker once and stays quiet while they hold the floor', () => {
    expect(attributionRun([says('Ada'), says('Ada'), says('Ada')], null))
      .toEqual([false, true, true]);
  });

  it('re-names the speaker after narration breaks the run', () => {
    expect(attributionRun([says('Ada'), narration, says('Ada')], null))
      .toEqual([false, false, false]);
  });

  it('names each speaker as the floor changes', () => {
    expect(attributionRun([says('Ada'), says('Ben'), says('Ada')], null))
      .toEqual([false, false, false]);
  });

  it('carries the run across a turn boundary', () => {
    expect(attributionRun([says('Ada')], 'Ada')).toEqual([true]);
    expect(attributionRun([says('Ada')], 'Ben')).toEqual([false]);
    expect(attributionRun([says('Ada')], null)).toEqual([false]);
  });

  it('treats a speak then act by the same person as one run', () => {
    expect(attributionRun([says('Ada'), acts('Ada')], null)).toEqual([false, true]);
  });

  it('never suppresses a name it cannot resolve', () => {
    expect(attributionRun([{ kind: 'speak' }, { kind: 'speak' }], null)).toEqual([false, false]);
  });
});
