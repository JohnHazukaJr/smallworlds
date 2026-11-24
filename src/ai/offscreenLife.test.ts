import { describe, expect, it } from 'vitest';
import type { Character, World } from '../types';
import {
  OFFSCREEN_CAP, cleanOffscreen, gapPhrase, namesPhrase, offscreenLifeOn, offscreenLines, offscreenPrompt, pickOffscreenCast
} from './offscreenLife';
import { arrivedSpeakers } from './sceneFit';

function person(id: string, name: string, patch: Partial<Character> = {}): Character {
  return {
    id, worldId: 'w', name, role: '', hue: 0, isPlayer: false, selfTag: false,
    age: '40', appearance: '', mannerisms: '', backstory: '', summary: '',
    speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
    secrets: '', mustNotKnow: '', relationships: [], anchors: [], customInstructions: '',
    state: { goal: '', emotion: '', location: '', condition: '' },
    createdAt: 0, updatedAt: 0,
    ...patch
  };
}

const player = person('p', 'Rowan', { isPlayer: true });
const ada = person('a', 'Ada Vey', { importance: 'lead', state: { goal: 'Hide the page', emotion: '', location: 'Registry', condition: '' } });
const brannoc = person('b', 'Brannoc Hale', { importance: 'regular' });
const corin = person('c', 'Corin Marsh', { importance: 'occasional', state: { goal: 'Take the Council seat', emotion: '', location: '', condition: '' } });
const idle = person('i', 'Idle Tom', { importance: 'occasional' });
const extra = person('x', 'Crowd', { importance: 'background', state: { goal: 'Watch', emotion: '', location: '', condition: '' } });
const everyone = [player, ada, brannoc, corin, idle, extra];

describe('pickOffscreenCast', () => {
  it('takes absent people who matter, goals first, never the player or anyone present', () => {
    const picked = pickOffscreenCast(everyone, ['p', 'b'], '').map((c) => c.id);
    expect(picked).toEqual(['a', 'c']);
  });

  it('skips background people and occasional people with nowhere to go', () => {
    const picked = pickOffscreenCast(everyone, [], '').map((c) => c.id);
    expect(picked).not.toContain('x');
    expect(picked).not.toContain('i');
  });

  it('lifts someone the chapter talked about', () => {
    const quiet = person('q', 'Quill', { importance: 'regular' });
    const loud = person('l', 'Lark', { importance: 'regular' });
    expect(pickOffscreenCast([quiet, loud], [], 'Everyone asked where Quill had gone.')[0].id).toBe('q');
  });

  it('caps the number of movers', () => {
    const many = Array.from({ length: 9 }, (_, i) => person(`m${i}`, `Mover ${i}`, { importance: 'regular' }));
    expect(pickOffscreenCast(many, [], '')).toHaveLength(OFFSCREEN_CAP);
  });
});

describe('cleanOffscreen', () => {
  const ilse = person('s', 'Sister Ilse', {
    aliases: ['Ilse'],
    mustNotKnow: 'Ilse does not know that Ada Vey signed the forged page.'
  });

  it('keeps people we asked about, once each, with state and memories', () => {
    const out = cleanOffscreen({
      people: [
        { name: 'Ada Vey', did: 'Burned the draft copies in the stove.', location: 'Registry cellar', goal: '', emotion: 'tense', heard: 'Rowan was asking questions, from Brannoc', feeling: 'cornered', salience: 3 },
        { name: 'ada vey', did: 'A duplicate entry that must be ignored.' },
        { name: 'Stranger', did: 'Someone we never asked about.' }
      ]
    }, [ada]);
    expect(out).toHaveLength(1);
    expect(out[0].state).toEqual({ location: 'Registry cellar', emotion: 'tense' });
    expect(out[0].beat).toEqual({
      characterId: 'a', name: 'Ada Vey', did: 'Burned the draft copies in the stove.',
      heard: 'Rowan was asking questions, from Brannoc'
    });
    expect(out[0].memories.map((m) => m.salience)).toEqual([2, 3]);
  });

  it('matches by alias and drops heard news that breaks a must-not-know wall', () => {
    const out = cleanOffscreen({
      people: [{ name: 'Ilse', did: 'Sat with the drowned-book until dawn.', heard: 'Ada Vey signed the forged page herself' }]
    }, [ilse]);
    expect(out[0].beat.heard).toBeUndefined();
    expect(out[0].memories).toHaveLength(1);
  });

  it('ignores junk, empty actions, and placeholder words', () => {
    expect(cleanOffscreen(null, [ada])).toEqual([]);
    expect(cleanOffscreen({ people: [{ name: 'Ada Vey', did: 'none' }] }, [ada])).toEqual([]);
    const out = cleanOffscreen({ people: [{ name: 'Ada Vey', did: 'Walked the quay at night.', goal: 'unchanged', heard: 'N/A' }] }, [ada]);
    expect(out[0].state).toEqual({});
    expect(out[0].beat.heard).toBeUndefined();
  });
});

describe('prompt and lines', () => {
  it('shows each mover with their wants and walls, and the gap', () => {
    const text = offscreenPrompt({
      world: { title: 'Saltmere', bible: 'Fog.' },
      movers: [person('s', 'Sister Ilse', { mustNotKnow: 'who signed it', relationships: [{ targetId: 'a', kind: 'friend', note: '' }] })],
      everyone: [ada],
      presentNames: ['Rowan', 'Ada Vey'],
      placeNames: ['The Long Room'],
      recap: 'Rowan found the forged page.',
      gapDays: 3
    });
    expect(text).toContain('MUST NOT LEARN: who signed it');
    expect(text).toContain('friend of Ada Vey');
    expect(text).toContain('3 days');
    expect(text).toContain('Places: The Long Room');
  });

  it('formats lines and names', () => {
    expect(offscreenLines([{ characterId: 'a', name: 'Ada', did: 'Left town.', heard: 'the news' }])).toBe('- Ada: Left town. (Heard: the news)');
    expect(namesPhrase(['Ada Vey'])).toBe('Ada Vey');
    expect(namesPhrase(['Ada Vey', 'Brannoc Hale'])).toBe('Ada Vey and Brannoc Hale');
    expect(namesPhrase(['Ada Vey', 'Brannoc Hale', 'Sister Ilse'])).toBe('Ada Vey, Brannoc Hale, and Sister Ilse');
    expect(gapPhrase(0)).toContain('same night');
    expect(gapPhrase(1)).toContain('overnight');
  });

  it('is on unless the world turns it off', () => {
    const ai = { offscreenLife: undefined } as unknown as World['ai'];
    expect(offscreenLifeOn({ ai })).toBe(true);
    expect(offscreenLifeOn({ ai: { ...ai, offscreenLife: false } })).toBe(false);
  });
});

describe('arrivedSpeakers', () => {
  it('returns cast credited a line who were not in the room, once each', () => {
    const beats = [
      { role: 'narrator' as const, text: 'The door opens.' },
      { role: 'character' as const, text: '"Evening."', speakerId: 'c', kind: 'cast' as const, name: 'Corin Marsh' },
      { role: 'character' as const, text: '"Again."', speakerId: 'c', kind: 'cast' as const, name: 'Corin Marsh' },
      { role: 'character' as const, text: '"Aye."', speakerId: 'b', kind: 'cast' as const, name: 'Brannoc Hale' },
      { role: 'character' as const, text: '"Me?"', speakerId: 'p', kind: 'cast' as const, name: 'Rowan' },
      { role: 'character' as const, text: '"Hm."', speakerId: 'g1', kind: 'guest' as const, name: 'Wenna' }
    ];
    expect(arrivedSpeakers(beats, ['p', 'b'], everyone).map((c) => c.id)).toEqual(['c']);
    expect(arrivedSpeakers(undefined, [], everyone)).toEqual([]);
  });
});
