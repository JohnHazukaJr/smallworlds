import { describe, expect, it } from 'vitest';
import {
  addressStrength,
  detectAddressee,
  lastOpenQuestion,
  lastSpeaker,
  rankReplySpeakers,
  roomDynamicsLines,
  speakerCandidates,
  turnsSinceSpoke,
  type SpeakerCandidate
} from './roomDynamics';
import type { Character, EpisodeGuest, Turn } from '../types';

const npc = (id: string, name: string): Character => ({
  id, worldId: 'w', name, role: '', age: '', appearance: '', mannerisms: '', summary: '',
  backstory: '', speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
  secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: '', emotion: '', location: '', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0
});

const said = (id: string, text: string, guest = false): Turn => ({
  id: `t-${id}-${text.slice(0, 4)}`,
  episodeId: 'e1',
  worldId: 'w',
  role: 'character',
  mode: null,
  ...(guest ? { guestId: id } : { characterId: id }),
  text,
  createdAt: 0
});

const player = (text: string): Turn => ({
  id: `u-${text.slice(0, 6)}`,
  episodeId: 'e1',
  worldId: 'w',
  role: 'user',
  mode: 'speak',
  text,
  createdAt: 0
});

const narrator = (text: string): Turn => ({
  id: `n-${text.slice(0, 6)}`,
  episodeId: 'e1',
  worldId: 'w',
  role: 'narrator',
  mode: null,
  text,
  createdAt: 0
});

const trio: SpeakerCandidate[] = [
  { id: 'c1', name: 'Ada', kind: 'cast' },
  { id: 'c2', name: 'Ben', kind: 'cast' },
  { id: 'g1', name: 'Clerk', kind: 'guest' }
];

describe('addressStrength', () => {
  it('reads leading and trailing vocatives', () => {
    expect(addressStrength('Ada, put it down.', 'Ada')).toBe('vocative');
    expect(addressStrength('Where were you, Ben?', 'Ben')).toBe('vocative');
    expect(addressStrength('"Ada?"', 'Ada')).toBe('vocative');
  });

  it('reads address verbs as directed', () => {
    expect(addressStrength('I ask Ada about the ledger.', 'Ada')).toBe('directed');
    expect(addressStrength('*turns to Ben*', 'Ben')).toBe('directed');
  });

  it('treats a discussed third party as a mention only', () => {
    expect(addressStrength('Tell Ada that Ben lied.', 'Ben')).toBe('mention');
  });

  it('does not match names inside other words', () => {
    expect(addressStrength('I always knew.', 'Al')).toBeNull();
    expect(addressStrength('The cabinet is locked.', 'Abi')).toBeNull();
  });
});

describe('detectAddressee', () => {
  it('prefers the addressee over the person being discussed', () => {
    expect(detectAddressee('Tell Ada that Ben lied.', trio)?.id).toBe('c1');
  });

  it('prefers a vocative over an earlier directed mention', () => {
    expect(detectAddressee('I asked Ada already. Ben, your turn.', trio)?.id).toBe('c2');
  });

  it('returns null when nobody is named', () => {
    expect(detectAddressee('What now?', trio)).toBeNull();
  });
});

describe('turnsSinceSpoke', () => {
  it('counts character turns back to each speaker', () => {
    const turns = [said('c1', 'first'), player('hm'), said('g1', 'second'), said('c1', 'third')];
    const since = turnsSinceSpoke(turns, trio);
    expect(since.get('c1')).toBe(0);
    expect(since.get('g1')).toBe(1);
    expect(since.get('c2')).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports the most recent voice', () => {
    const turns = [said('c1', 'first'), said('c2', 'second'), player('hm')];
    expect(lastSpeaker(turns, trio)?.id).toBe('c2');
    expect(lastSpeaker([], trio)).toBeNull();
  });
});

describe('rankReplySpeakers', () => {
  it('falls back to cast order when the room is fresh', () => {
    const ranked = rankReplySpeakers({ candidates: trio, playerText: 'Hello?' });
    expect(ranked[0].id).toBe('c1');
  });

  it('gives the floor to whoever has been silent instead of the last speaker', () => {
    const turns = [said('c1', 'a'), said('c1', 'b'), said('c1', 'c')];
    const ranked = rankReplySpeakers({ candidates: trio, playerText: 'Hello?', turns });
    expect(ranked[0].id).toBe('c2');
    expect(ranked[ranked.length - 1].id).toBe('c1');
  });

  it('lets a direct address outrank silence', () => {
    const turns = [said('c1', 'a'), said('c1', 'b')];
    const ranked = rankReplySpeakers({ candidates: trio, playerText: 'Ada, answer me.', turns });
    expect(ranked[0].id).toBe('c1');
    expect(ranked[0].address).toBe('vocative');
  });

  it('rotates among NPCs who have all spoken, oldest voice first', () => {
    const turns = [said('c2', 'x'), said('g1', 'y'), said('c1', 'z')];
    const ranked = rankReplySpeakers({ candidates: trio, playerText: 'Go on.', turns });
    expect(ranked[0].id).toBe('c2');
  });

  it('nudges toward whoever the narrator just put in frame', () => {
    const turns = [said('c1', 'a'), said('c2', 'b'), narrator('The Clerk looks up from the ledger.')];
    const ranked = rankReplySpeakers({ candidates: trio, playerText: 'Well?', turns });
    expect(ranked[0].id).toBe('g1');
  });
});

describe('roomDynamicsLines', () => {
  const cast = [npc('c1', 'Ada'), npc('c2', 'Ben')];
  const guests: EpisodeGuest[] = [{ id: 'g1', name: 'Clerk', brief: 'tired', voice: '' }];

  it('builds candidates from cast and active walk-ons', () => {
    expect(speakerCandidates(cast, guests).map((c) => c.id)).toEqual(['c1', 'c2', 'g1']);
  });

  it('names the last voice, the silent, and the addressee', () => {
    const turns = [said('c1', 'a'), said('c1', 'b'), said('c1', 'c'), said('c1', 'd'), said('c1', 'e')];
    const lines = roomDynamicsLines({
      candidates: speakerCandidates(cast, guests),
      playerText: 'Ben, say something.',
      turns
    }).join('\n');
    expect(lines).toMatch(/Last voice in the room: Ada\./);
    expect(lines).toMatch(/Has not spoken this episode: Ben, Clerk\./);
    expect(lines).toMatch(/aimed at: Ben\./);
  });

  it('flags a cast member who has gone quiet for several lines', () => {
    const turns = [said('c2', 'x'), said('c1', 'a'), said('c1', 'b'), said('c1', 'c'), said('c1', 'd')];
    const lines = roomDynamicsLines({
      candidates: speakerCandidates(cast, guests),
      playerText: 'Go on.',
      turns
    }).join('\n');
    expect(lines).toMatch(/Quiet for a while: Ben \(4 lines ago\)/);
  });

  it('returns nothing for an empty room', () => {
    expect(roomDynamicsLines({ candidates: [], playerText: 'Hello?' })).toEqual([]);
  });

  it('flags when the last NPC line was a question the player just answered', () => {
    const turns = [
      said('c1', '*looks up* "Where were you last night?"'),
      player('At the quay. The tide was out.')
    ];
    const lines = roomDynamicsLines({
      candidates: speakerCandidates(cast, guests),
      playerText: 'At the quay. The tide was out.',
      turns
    }).join('\n');
    expect(lines).toMatch(/Ada asked a question/);
    expect(lines).toMatch(/Take the answer as heard/i);
    expect(lines).toMatch(/do not brief the same question/i);
  });

  it('keeps the heard-answer cue on Continue when playerText is empty', () => {
    const turns = [
      said('c1', '*looks up* "Where were you last night?"'),
      player('At the quay.')
    ];
    const lines = roomDynamicsLines({
      candidates: speakerCandidates(cast, guests),
      playerText: '',
      turns
    }).join('\n');
    expect(lines).toMatch(/Ada asked a question/);
  });
});

describe('lastOpenQuestion', () => {
  it('skips a trailing player beat and reads a question mark', () => {
    const turns = [said('c1', '"Who paid Ivo?"'), player('Marisol did.')];
    expect(lastOpenQuestion(turns, trio)?.id).toBe('c1');
  });

  it('is null when the last NPC line was not a question', () => {
    const turns = [said('c1', '"The ledger is closed."'), player('Alright.')];
    expect(lastOpenQuestion(turns, trio)).toBeNull();
  });

  it('is null when a later NPC line moved on from the question', () => {
    const turns = [
      said('c1', '"Who paid Ivo?"'),
      player('Marisol.'),
      said('c2', '"We already knew that."'),
      player('So what now?')
    ];
    expect(lastOpenQuestion(turns, trio)).toBeNull();
  });

  it('keeps the asker after later speak beats in the same Write', () => {
    const turns = [
      said('c1', '"Who paid Ivo?"'),
      player('Marisol did.'),
      said('c2', '"We already knew that."')
    ];
    expect(lastOpenQuestion(turns, trio)?.id).toBe('c1');
  });

  it('does not treat a question asked after the player as already answered', () => {
    const turns = [player('Hello.'), said('c1', '"Where were you?"')];
    expect(lastOpenQuestion(turns, trio)).toBeNull();
  });
});
