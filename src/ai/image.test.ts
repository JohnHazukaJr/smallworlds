import { describe, expect, it } from 'vitest';
import {
  chapterPictureFaces,
  chapterPictureSubjects,
  collectSceneImageRefs,
  imageModelAcceptsRefs,
  prepareChapterPicture,
  sceneImagePrompt
} from './image';
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

  it('names a character in the prompt and sends that photo', () => {
    const characters = [
      char('p', 'you', true, 'data:image/jpeg;base64,you'),
      char('m', 'Marisol Vey', false, 'data:image/jpeg;base64,marisol'),
      char('c', 'The Cartwright', false, 'data:image/jpeg;base64,cart')
    ];
    const subjects = chapterPictureSubjects({
      characters,
      castIds: ['p', 'm', 'c'],
      prompt: 'Marisol Vey at the window, the manifest in her hand.'
    });
    expect(subjects.map((c) => c.name)).toEqual(['Marisol Vey']);
    const plan = prepareChapterPicture({
      characters,
      castIds: ['p', 'm', 'c'],
      userPrompt: 'Marisol Vey at the window, the manifest in her hand.',
      style: 'realistic',
      contentNotes: '',
      mature: true,
      provider: or,
      model: 'black-forest-labs/flux-1.1-pro'
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.refs.map((r) => r.name)).toEqual(['Marisol Vey']);
    expect(plan.refs[0].dataUrl).toBe('data:image/jpeg;base64,marisol');
    expect(plan.prompt).toMatch(/Image 1 is Marisol Vey/);
  });

  it('uses people in the chapter when the prompt names no one', () => {
    const faces = chapterPictureFaces({
      characters: [
        char('a', 'Ada', false, 'data:image/jpeg;base64,a'),
        char('p', 'you', true, 'data:image/jpeg;base64,you'),
        char('b', 'Ben', false)
      ],
      castIds: ['p', 'a', 'b'],
      prompt: 'A quiet argument over the ledger.'
    });
    expect(faces.map((r) => r.name)).toEqual(['you', 'Ada']);
  });

  it('does not generate when the model cannot take the photos', () => {
    const plan = prepareChapterPicture({
      characters: [char('m', 'Marisol Vey', false, 'data:image/jpeg;base64,marisol')],
      castIds: ['m'],
      userPrompt: 'Marisol Vey at the window.',
      style: 'comic',
      contentNotes: '',
      mature: true,
      provider: zai,
      model: 'glm-image'
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/can’t use character photos/);
  });

  it('refuses a sexual prompt when someone in the picture reads as under 18', () => {
    const plan = prepareChapterPicture({
      characters: [char('k', 'Mina', false, 'data:image/jpeg;base64,mina')],
      castIds: ['k'],
      userPrompt: 'Mina, nude, in the long room.',
      style: 'realistic',
      contentNotes: '',
      mature: true,
      provider: or,
      model: 'black-forest-labs/flux-1.1-pro'
    });
    const minor = { ...char('k', 'Mina', false, 'data:image/jpeg;base64,mina'), age: '16' };
    const blocked = prepareChapterPicture({
      characters: [minor],
      castIds: ['k'],
      userPrompt: 'Mina, nude, in the long room.',
      style: 'realistic',
      contentNotes: '',
      mature: true,
      provider: or,
      model: 'black-forest-labs/flux-1.1-pro'
    });
    expect(plan.ok).toBe(true);
    expect(blocked.ok).toBe(false);
  });

  it('names face refs and drops the no-people line when matching', () => {
    const prompt = sceneImagePrompt(world(), loc(), 'rain', [
      { name: 'Ada', dataUrl: 'data:image/jpeg;base64,x', kind: 'face' }
    ]);
    expect(prompt).toMatch(/Image 1 is Ada/);
    expect(prompt).not.toMatch(/no people/);
  });
});
