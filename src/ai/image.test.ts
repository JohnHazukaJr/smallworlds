import { describe, expect, it } from 'vitest';
import { collectSceneImageRefs, imageModelAcceptsRefs, sceneImagePrompt } from './image';
import type { Character, Location, ProviderConfig, World } from '../types';
import { DEFAULT_AI } from '../worldOps';

const zai: ProviderConfig = {
  id: 'z', kind: 'openai', label: 'Z.ai',
  baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: 'k'
};
const or: ProviderConfig = {
  id: 'o', kind: 'openai', label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k'
};

const world = (): World => ({
  id: 'w', title: 'Harbour', line: 'Fog.', bible: '', hue: 0, visibility: 'private',
  ai: { ...DEFAULT_AI }, proseModel: null, utilityModel: null, activeSeasonId: 's',
  calendar: { currentDay: 1, system: '', episodeAdvanceDays: 1 }, createdAt: 0, updatedAt: 0
});

const loc = (portrait?: string): Location => ({
  id: 'l', worldId: 'w', name: 'Office', tagline: '', hue: 0,
  summary: 'A desk.', atmosphere: 'salt', features: '', history: '', inhabitants: '',
  secrets: '', currentState: '', rules: [], customInstructions: '',
  portrait: portrait ?? null, createdAt: 0, updatedAt: 0
});

const char = (id: string, name: string, player: boolean, face?: string): Character => ({
  id, worldId: 'w', name, role: '', hue: 0, isPlayer: player, selfTag: false,
  portrait: face ?? null, portraits: face ? [face] : [],
  age: '', appearance: '', mannerisms: '', backstory: '', summary: '',
  speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
  secrets: '', mustNotKnow: '', relationships: [], anchors: [], customInstructions: '',
  state: { goal: '', emotion: '', location: '', condition: '' },
  createdAt: 0, updatedAt: 0
});

describe('scene image refs', () => {
  it('treats official glm-image as text-only', () => {
    expect(imageModelAcceptsRefs(zai, 'glm-image')).toBe(false);
    expect(imageModelAcceptsRefs(or, 'z-ai/glm-image')).toBe(false);
    expect(imageModelAcceptsRefs(or, 'black-forest-labs/flux-1.1-pro')).toBe(true);
  });

  it('picks player first, caps faces at 3, adds a place ref', () => {
    const refs = collectSceneImageRefs({
      characters: [
        char('p', 'You', true, 'data:image/jpeg;base64,aaa'),
        char('a', 'Ada', false, 'data:image/jpeg;base64,bbb'),
        char('b', 'Ben', false, 'data:image/jpeg;base64,ccc'),
        char('c', 'Cora', false, 'data:image/jpeg;base64,ddd'),
        char('d', 'Dax', false)
      ],
      castIds: ['p', 'a', 'b', 'c', 'd'],
      location: loc('data:image/jpeg;base64,place')
    });
    expect(refs.filter((r) => r.kind === 'face').map((r) => r.name)).toEqual(['You', 'Ada', 'Ben']);
    expect(refs.some((r) => r.kind === 'place' && r.name === 'Office')).toBe(true);
  });

  it('names face refs and drops the no-people line when matching', () => {
    const prompt = sceneImagePrompt(world(), loc(), 'rain', [
      { name: 'Ada', dataUrl: 'data:image/jpeg;base64,x', kind: 'face' }
    ]);
    expect(prompt).toMatch(/Image 1 is Ada/);
    expect(prompt).not.toMatch(/no people/);
  });
});
