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

describe('NPC lines are never filed as narration', () => {
  const cast: SceneSpeaker[] = [
    { id: 'c1', name: 'Ada Vell', kind: 'cast' },
    { id: 'c2', name: 'Ben Ruiz', kind: 'cast' }
  ];
  const ada = cast[0];
  const spoken = (raw: string, answerer?: SceneSpeaker) => {
    const parsed = parseBeats(raw, cast, { answerer })!;
    const text = parsed.prose;
    return scenePiecesOf({ text, beats: parsed.beats }, cast)
      .filter((piece) => piece.role === 'character')
      .map((piece) => [piece.speakerId, piece.text]);
  };

  it('credits a correct full-name tag', () => {
    expect(spoken('@narration\nRain.\n@Ada Vell\n"Read it again."')).toEqual([['c1', '"Read it again."']]);
  });

  it('credits a first-name tag', () => {
    expect(spoken('@narration\nRain.\n@Ada\n*taps* "Read it again."')).toEqual([['c1', '*taps* "Read it again."']]);
    expect(spoken('@Ruiz\n"Fine."')).toEqual([['c2', '"Fine."']]);
  });

  it('credits a markdown-wrapped tag', () => {
    expect(spoken('**@Ada**\n"Read it."')).toEqual([['c1', '"Read it."']]);
    expect(spoken('@**Ben**\n"Fine."')).toEqual([['c2', '"Fine."']]);
  });

  it('credits novel-style dialogue written under @narration', () => {
    expect(spoken('@narration\nRain.\n\n"Read it again," Ada Vell says.')).toEqual([['c1', '"Read it again,"']]);
  });

  it('credits legacy Name: lines written under @narration', () => {
    expect(spoken('@narration\nRain.\nAda Vell: *taps* "Read."')).toEqual([['c1', '*taps* "Read."']]);
  });

  it('credits untagged prose to the person asked to answer', () => {
    expect(spoken('Rain hits the glass. "Not tonight." She turns away.', ada)).toEqual([['c1', '"Not tonight."']]);
  });

  it('credits an uncredited quote under @narration to the answerer', () => {
    expect(spoken('@narration\nShe looks up. "Late again."', ada)).toEqual([['c1', '"Late again."']]);
  });

  it('does not hand a stranger tag to the answerer', () => {
    const parsed = parseBeats('@Mallory\n"I never left."', cast, { answerer: ada })!;
    expect(parsed.beats).toEqual([{ role: 'narrator', text: 'Mallory: "I never left."' }]);
  });

  it('leaves an ambiguous first name uncredited by name', () => {
    const twins: SceneSpeaker[] = [
      { id: 'a', name: 'Sam Hart', kind: 'cast' },
      { id: 'b', name: 'Sam Doyle', kind: 'cast' }
    ];
    const parsed = parseBeats('@Sam\n"Hi."', twins)!;
    expect(parsed.beats.some((beat) => beat.role === 'character')).toBe(false);
  });

  it('credits saved all-narration turns when they are shown', () => {
    const beats: TurnBeat[] = [{ role: 'narrator', text: 'Rain. "Read it again," Ada Vell says.' }];
    const pieces = scenePiecesOf({ text: beatsToProse(beats), beats }, cast);
    expect(pieces.some((piece) => piece.role === 'character' && piece.speakerId === 'c1')).toBe(true);
  });
});
