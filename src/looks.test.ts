import { describe, expect, it } from 'vitest';
import { DEFAULT_AI, emptyCharacter } from './worldOps';
import { allLooksText, hasLooks, looksText, mergeLooks, wearingNow } from './looks';
import { intimateAllowed, subjectAgeReading } from './ai/portrait';
import { buildSceneReply, characterLooksLine, type PromptContext } from './ai/prompts';
import type { Character, World } from './types';

const ada = (patch: Partial<Character> = {}): Character => emptyCharacter('w', {
  id: 'c1', name: 'Ada', age: '30', role: 'registrar',
  appearance: 'Tall, weathered, carries herself like she owns the room.',
  looks: {
    face: 'Grey eyes, a scar through the left brow',
    hair: 'Black with a silver streak, worn in a braid',
    clothing: 'Long grey registrar’s coat',
    intimate: 'adult detail'
  },
  ...patch
});

const world = (mature: boolean): World => ({
  id: 'w', title: 'Harbour', line: '', bible: '', hue: 0, visibility: 'private',
  ai: { ...DEFAULT_AI, mature }, proseModel: null, utilityModel: null, activeSeasonId: 's',
  calendar: { currentDay: 1, system: '', episodeAdvanceDays: 1 }, createdAt: 0, updatedAt: 0
});

describe('looksText', () => {
  it('joins the overall line and the filled parts in a fixed order', () => {
    const text = looksText(ada());
    expect(text).toBe(
      'Tall, weathered, carries herself like she owns the room. Face: Grey eyes, a scar through the left brow. ' +
      'Hair: Black with a silver streak, worn in a braid. Usually wears: Long grey registrar’s coat.'
    );
  });

  it('adds what they wear now right after their usual clothes', () => {
    const text = looksText(ada({ state: { goal: '', emotion: '', location: '', condition: '', wearing: 'a borrowed silk gown' } }), { wearing: true });
    expect(text).toMatch(/Usually wears: Long grey registrar’s coat\. Wearing now: a borrowed silk gown\./);
    expect(wearingNow({ wearing: 'none' })).toBe('');
  });

  it('keeps the intimate part out unless asked for an adult', () => {
    expect(looksText(ada())).not.toMatch(/Intimate/);
    expect(looksText(ada(), { adult: true })).toMatch(/Intimate: adult detail/);
    expect(allLooksText(ada())).toMatch(/Intimate: adult detail/);
  });

  it('is empty for a blank card and reads old cards with only an overall line', () => {
    expect(looksText(emptyCharacter('w'))).toBe('');
    expect(looksText(emptyCharacter('w', { appearance: 'Quick, small.' }))).toBe('Quick, small.');
  });
});

describe('mergeLooks', () => {
  it('fills only empty parts, and the intimate part only when allowed', () => {
    const merged = mergeLooks({ hair: 'Red' }, { hair: 'Blue', face: 'Round', intimate: 'x', nonsense: 'y' }, false);
    expect(merged).toEqual({ hair: 'Red', face: 'Round' });
    expect(mergeLooks(undefined, { intimate: 'x' }, true)).toEqual({ intimate: 'x' });
    expect(mergeLooks(undefined, {}, true)).toBeUndefined();
    expect(hasLooks({ face: '  ' })).toBe(false);
  });
});

describe('safety reads every part', () => {
  it('catches a childlike description in any section, whatever the stated age', () => {
    expect(subjectAgeReading(ada({ age: '18', looks: { face: 'looks 12' } })).minor).toBe(true);
    expect(subjectAgeReading(ada({ age: '25', looks: { intimate: 'a child’s body' } })).minor).toBe(true);
  });

  it('still lets an adult look young for her age', () => {
    expect(subjectAgeReading(ada({ age: '18', looks: { face: 'Looks young for her age, freckled' } })).minor).toBe(false);
  });

  it('allows the intimate part only for an adult in an adult world', () => {
    expect(intimateAllowed(world(true), ada())).toBe(true);
    expect(intimateAllowed(world(false), ada())).toBe(false);
    expect(intimateAllowed(world(true), ada({ age: '16' }))).toBe(false);
  });
});

describe('the story sees how people look', () => {
  const ctx = (mature: boolean, people: Character[]): PromptContext => ({
    world: world(mature),
    season: { id: 's', worldId: 'w', number: 1, title: '', premise: '', timeGap: null, bible: null, status: 'active', createdAt: 0 },
    episode: {
      id: 'e', seasonId: 's', worldId: 'w', number: 1, title: '', location: 'Office', castIds: people.map((p) => p.id),
      status: 'active', createdAt: 0
    },
    characters: people, locations: [], continuity: [], threads: [], turns: []
  });

  it('cards each speaker with their look and current outfit', () => {
    const dressed = ada({ state: { goal: '', emotion: '', location: '', condition: '', wearing: 'a soaked oilskin' } });
    const built = buildSceneReply({
      ctx: ctx(false, [dressed]), mode: 'speak', playerText: 'Hello', length: 'beat',
      speakers: [{ id: 'c1', name: 'Ada', kind: 'cast' }], present: [{ name: 'Ada' }]
    });
    expect(built.system).toMatch(/Looks \(keep consistent; mention only what the moment notices\): Tall, weathered/);
    expect(built.system).toMatch(/Hair: Black with a silver streak/);
    expect(built.system).toMatch(/Wearing now: a soaked oilskin/);
    expect(built.system).not.toMatch(/Intimate/);
  });

  it('describes the player too, and includes intimate details only in an adult world', () => {
    const player = emptyCharacter('w', { id: 'p', name: 'Rowan', isPlayer: true, age: '28', looks: { hair: 'Shaved', intimate: 'adult detail' } });
    const built = buildSceneReply({
      ctx: ctx(true, [player, ada()]), mode: 'speak', playerText: 'Hello', length: 'beat',
      speakers: [{ id: 'c1', name: 'Ada', kind: 'cast' }], present: [{ name: 'Ada' }]
    });
    expect(built.system).toMatch(/How Rowan looks \(keep consistent\): Hair: Shaved/);
    expect(built.system).toMatch(/Intimate: adult detail/);
    expect(characterLooksLine(world(false), player)).not.toMatch(/Intimate/);
  });
});
