import { describe, expect, it } from 'vitest';
import type { Character, CharacterState } from '../types';

/** Mirrors draftCharacter result merge for state + mustNotKnow without calling AI. */
function mergeDraftCharacterFields(result: {
  mustNotKnow?: string;
  state?: { goal?: string; emotion?: string; location?: string; condition?: string };
  name?: string;
}): Partial<Character> {
  const state: CharacterState | undefined = result.state
    ? {
        goal: (result.state.goal ?? '').trim(),
        emotion: (result.state.emotion ?? '').trim(),
        location: (result.state.location ?? '').trim(),
        condition: (result.state.condition ?? '').trim()
      }
    : undefined;
  return {
    name: result.name,
    mustNotKnow: (result.mustNotKnow ?? '').trim(),
    ...(state ? { state } : {})
  };
}

describe('draftCharacter schema merge', () => {
  it('includes state and mustNotKnow when present', () => {
    const merged = mergeDraftCharacterFields({
      name: 'Marisol',
      mustNotKnow: 'The false name on the manifest',
      state: { goal: 'Watch the quay', emotion: 'wary', location: 'Tide stairs', condition: '' }
    });
    expect(merged.mustNotKnow).toBe('The false name on the manifest');
    expect(merged.state).toEqual({
      goal: 'Watch the quay',
      emotion: 'wary',
      location: 'Tide stairs',
      condition: ''
    });
  });

  it('omits state when absent', () => {
    const merged = mergeDraftCharacterFields({ name: 'Ivo', mustNotKnow: '' });
    expect(merged.state).toBeUndefined();
    expect(merged.mustNotKnow).toBe('');
  });
});
