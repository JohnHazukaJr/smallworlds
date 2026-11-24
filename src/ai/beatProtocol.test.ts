import { describe, expect, it } from 'vitest';
import type { TurnBeat } from '../types';
import {
  beatsToProse, beatsToTagged, hasBeatTags, parseBeats, scenePiecesOf, validBeats
} from './beatProtocol';
import type { SceneSpeaker } from './sceneReply';

const speakers: SceneSpeaker[] = [
  { id: 'c1', name: 'Ada Vell', aliases: ['Ada'], kind: 'cast' },
  { id: 'c2', name: 'Ben', kind: 'cast' },
  { id: 'g1', name: 'The Porter', kind: 'guest' }
];

describe('parseBeats', () => {
  it('returns null for untagged prose so callers keep it as written', () => {
    expect(parseBeats('Rain falls. "Hello," Ada said.', speakers)).toBeNull();
    expect(hasBeatTags('no tags here')).toBe(false);
  });

  it('credits each tagged block exactly', () => {
    const raw = [
      '@narration',
      'Rain needles the window.',
      '',
      'The lamp gutters.',
      '@Ada',
      '*taps the ledger*',
      '"Read it again."',
      '@The Porter',
      '"Closing time."'
    ].join('\n');
    const parsed = parseBeats(raw, speakers)!;
    expect(parsed.beats).toEqual([
      { role: 'narrator', text: 'Rain needles the window.\n\nThe lamp gutters.' },
      { role: 'character', text: '*taps the ledger* "Read it again."', speakerId: 'c1', kind: 'cast', name: 'Ada Vell' },
      { role: 'character', text: '"Closing time."', speakerId: 'g1', kind: 'guest', name: 'The Porter' }
    ]);
    expect(parsed.prose).toBe(
      'Rain needles the window.\n\nThe lamp gutters.\n\nAda Vell: *taps the ledger* "Read it again."\n\nThe Porter: "Closing time."'
    );
  });

  it('accepts inline content, colons, and case differences on the tag line', () => {
    const parsed = parseBeats('@BEN: "Fine."\n@ada *nods* "Good."\n@Narrator: The door shuts.', speakers)!;
    expect(parsed.beats.map((b) => [b.role, b.speakerId, b.text])).toEqual([
      ['character', 'c2', '"Fine."'],
      ['character', 'c1', '*nods* "Good."'],
      ['narrator', undefined, 'The door shuts.']
    ]);
  });

  it('keeps a tag for someone not here as uncredited narration', () => {
    const parsed = parseBeats('@narration\nSilence.\n@Mallory\n"I never left."', speakers)!;
    expect(parsed.beats[1]).toEqual({ role: 'narrator', text: 'Mallory: "I never left."' });
  });

  it('treats text before the first tag as narration', () => {
    const parsed = parseBeats('Fog.\n@Ben\n"Cold."', speakers)!;
    expect(parsed.beats[0]).toEqual({ role: 'narrator', text: 'Fog.' });
  });

  it('holds back an unfinished tag line while streaming', () => {
    const partial = parseBeats('@narration\nFog rolls in.\n@Ad', speakers, { partial: true })!;
    expect(partial.prose).toBe('Fog rolls in.');
    expect(partial.prose).not.toContain('@');
  });

  it('lets a continuation pick up the open beat', () => {
    const carry: TurnBeat = { role: 'character', text: '"I was', speakerId: 'c2', kind: 'cast', name: 'Ben' };
    const parsed = parseBeats('never there."', speakers, { carry })!;
    expect(parsed.beats).toEqual([{ ...carry, text: 'never there."' }]);
  });
});

describe('stored beats', () => {
  const beats: TurnBeat[] = [
    { role: 'narrator', text: 'Fog.' },
    { role: 'character', text: '"Cold."', speakerId: 'c2', kind: 'cast', name: 'Ben' }
  ];

  it('round-trips to tagged history', () => {
    const tagged = beatsToTagged(beats);
    expect(tagged).toBe('@narration\nFog.\n@Ben\n"Cold."');
    expect(parseBeats(tagged, speakers)!.beats).toEqual(beats);
  });

  it('is trusted only while it matches the stored text', () => {
    const text = beatsToProse(beats);
    expect(validBeats({ text, beats })).toBe(beats);
    expect(validBeats({ text: `${text} Edited.`, beats })).toBeNull();
  });

  it('feeds scene pieces from beats, or from the prose splitter after an edit', () => {
    const text = beatsToProse(beats);
    expect(scenePiecesOf({ text, beats }, speakers)).toEqual([
      { role: 'narrator', text: 'Fog.' },
      { role: 'character', text: '"Cold."', speakerId: 'c2', kind: 'cast' }
    ]);
    const edited = scenePiecesOf({ text: 'Fog. "Colder," Ben said.', beats }, speakers);
    expect(edited.some((piece) => piece.speakerId === 'c2')).toBe(true);
  });
});
