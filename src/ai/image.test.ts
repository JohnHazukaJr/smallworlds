import '../test/storagePolyfill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../store/settings';
import {
  ADULT_PORTRAIT_ERROR,
  chapterPictureFaces,
  chapterPictureSubjects,
  clearAdultAge,
  collectSceneImageRefs,
  generateCharacterPortrait,
  imageGenerationsBodies,
  imageGenerationsUrls,
  imageModelAcceptsRefs,
  imageModelUsesChatFallback,
  imageSizeCandidates,
  planAdultFaceEdit,
  prepareChapterPicture,
  sceneImagePrompt,
  veniceFaceEditRequest
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

  it('keeps a non-sexual picture on the current image model', () => {
    expect(planAdultFaceEdit({
      mature: true,
      userPrompt: 'Marisol at the window.',
      subjects: [{ age: '34' }],
      faceCount: 1,
      veniceConfigured: true
    })).toEqual({ action: 'current' });
  });

  it('edits an adult picture that already has a portrait', () => {
    expect(clearAdultAge('34')).toBe(true);
    expect(clearAdultAge('')).toBe(false);
    expect(clearAdultAge('thirties')).toBe(false);
    expect(clearAdultAge('16')).toBe(false);
    expect(planAdultFaceEdit({
      mature: true,
      userPrompt: 'Marisol, nude, in the long room.',
      subjects: [{ age: '34' }],
      faceCount: 1,
      veniceConfigured: true
    })).toEqual({ action: 'edit' });
  });

  it('does not edit when the age is blank, someone is under 18, or there is no portrait', () => {
    const sexual = 'Mina, nude, in the long room.';
    expect(planAdultFaceEdit({
      mature: true,
      userPrompt: sexual,
      subjects: [{ age: '' }],
      faceCount: 1,
      veniceConfigured: true
    })).toEqual({ action: 'current' });
    expect(planAdultFaceEdit({
      mature: true,
      userPrompt: sexual,
      subjects: [{ age: '16' }],
      faceCount: 1,
      veniceConfigured: true
    }).action).toBe('refuse');
    expect(planAdultFaceEdit({
      mature: true,
      userPrompt: sexual,
      subjects: [{ age: '34' }],
      faceCount: 0,
      veniceConfigured: true
    })).toEqual({ action: 'refuse', error: ADULT_PORTRAIT_ERROR });
    expect(planAdultFaceEdit({
      mature: true,
      userPrompt: sexual,
      subjects: [{ age: '34' }],
      faceCount: 1,
      veniceConfigured: false
    })).toEqual({ action: 'current' });
  });

  it('sends one face to the edit endpoint and two faces to multi-edit', () => {
    const one = veniceFaceEditRequest({
      baseUrl: 'https://api.venice.ai/api/v1/',
      prompt: 'Keep the face.',
      images: ['data:image/jpeg;base64,aaa']
    });
    expect(one.url).toBe('https://api.venice.ai/api/v1/image/edit');
    expect(one.body).toEqual({
      model: 'qwen-edit-uncensored',
      prompt: 'Keep the face.',
      image: 'aaa',
      safe_mode: false
    });
    expect(one.body).not.toHaveProperty('enhance_prompt');
    const two = veniceFaceEditRequest({
      baseUrl: 'https://api.venice.ai/api/v1',
      prompt: 'Keep both faces.',
      images: ['data:image/jpeg;base64,aaa', 'data:image/jpeg;base64,bbb']
    });
    expect(two.url).toBe('https://api.venice.ai/api/v1/image/multi-edit');
    expect(two.body).toEqual({
      modelId: 'qwen-edit-uncensored',
      prompt: 'Keep both faces.',
      images: ['aaa', 'bbb'],
      safe_mode: false
    });
    expect(two.body).not.toHaveProperty('model');
    expect(two.body).not.toHaveProperty('enhance_prompt');
  });

  it('names face refs and drops the no-people line when matching', () => {
    const prompt = sceneImagePrompt(world(), loc(), 'rain', [
      { name: 'Ada', dataUrl: 'data:image/jpeg;base64,x', kind: 'face' }
    ]);
    expect(prompt).toMatch(/Image 1 is Ada/);
    expect(prompt).not.toMatch(/no people/);
  });
});

describe('image request adapter', () => {
  it('sends a minimal generations body without DALL-E-only fields', () => {
    const bodies = imageGenerationsBodies({
      model: 'black-forest-labs/flux.2-pro',
      prompt: 'Portrait of Ada'
    });
    expect(bodies[0]).toEqual({
      model: 'black-forest-labs/flux.2-pro',
      prompt: 'Portrait of Ada'
    });
    expect(bodies[0]).not.toHaveProperty('quality');
    expect(bodies[0]).not.toHaveProperty('response_format');
    expect(bodies[0]).not.toHaveProperty('n');
  });

  it('adds conservative sizes after the unsized body, not CogView-only 864x1152', () => {
    expect(imageSizeCandidates('portrait')).toEqual(['1024x1024', '1024x1536']);
    expect(imageSizeCandidates('portrait').join(' ')).not.toMatch(/864x1152/);
    const bodies = imageGenerationsBodies({
      model: 'any-image-model',
      prompt: 'Portrait of Ada',
      sizes: imageSizeCandidates('portrait')
    });
    expect(bodies.map((b) => b.size)).toEqual([undefined, '1024x1024', '1024x1536']);
  });

  it('uses OpenRouter /images then /images/generations', () => {
    expect(imageGenerationsUrls(or.baseUrl)).toEqual([
      'https://openrouter.ai/api/v1/images',
      'https://openrouter.ai/api/v1/images/generations'
    ]);
    expect(imageGenerationsUrls(zai.baseUrl)).toEqual([
      'https://api.z.ai/api/paas/v4/images/generations'
    ]);
  });

  it('skips chat fallback for generation-only models, including glm-image as one of them', () => {
    expect(imageModelUsesChatFallback('black-forest-labs/flux.2-pro')).toBe(false);
    expect(imageModelUsesChatFallback('glm-image')).toBe(false);
    expect(imageModelUsesChatFallback('z-ai/glm-image')).toBe(false);
    expect(imageModelUsesChatFallback('small-worlds/image')).toBe(false);
    expect(imageModelUsesChatFallback('google/gemini-2.5-flash-image')).toBe(true);
    expect(imageModelUsesChatFallback('openai/gpt-5-image')).toBe(true);
  });

  it('attaches refs on every body when the caller passed them', () => {
    const bodies = imageGenerationsBodies({
      model: 'openai/gpt-5-image',
      prompt: 'Keep the face.',
      refs: [{ name: 'Ada', dataUrl: 'data:image/jpeg;base64,x', kind: 'face' }],
      sizes: ['1024x1024']
    });
    expect(bodies[0]).toMatchObject({
      image: 'data:image/jpeg;base64,x',
      images: ['data:image/jpeg;base64,x']
    });
    expect(bodies[1].size).toBe('1024x1024');
    expect(bodies[1].images).toEqual(['data:image/jpeg;base64,x']);
  });
});

describe('generateCharacterPortrait request', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    calls.length = 0;
    localStorage.removeItem('small-worlds-settings');
    useSettings.setState({
      providers: [or],
      proseModel: null,
      utilityModel: null,
      imageModel: { providerId: or.id, model: 'black-forest-labs/flux.2-pro' },
      matureImageModel: null,
      matureDefault: true,
      defaultVisibility: 'private',
      vaultPersistError: ''
    });
    vi.stubGlobal('Image', class {
      width = 8;
      height = 8;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    });
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() { /* jpeg encode stub */ } }),
          toDataURL: () => 'data:image/jpeg;base64,stub'
        };
      }
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        data: [{ b64_json: 'AAAA', media_type: 'image/png' }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem('small-worlds-settings');
    useSettings.setState({
      providers: [],
      proseModel: null,
      utilityModel: null,
      imageModel: null,
      matureImageModel: null,
      matureDefault: true,
      defaultVisibility: 'private',
      vaultPersistError: ''
    });
  });

  it('posts a minimal body to OpenRouter /images for whichever image model is selected', async () => {
    const url = await generateCharacterPortrait({
      world: world(),
      character: { ...char('a', 'Ada', false), appearance: 'grey coat, dark hair' },
      style: 'realistic'
    });
    expect(url).toBe('data:image/jpeg;base64,stub');
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/images');
    expect(calls[0]?.body).toEqual({
      model: 'black-forest-labs/flux.2-pro',
      prompt: expect.stringMatching(/Portrait of Ada/)
    });
    expect(calls[0]?.body).not.toHaveProperty('quality');
    expect(calls[0]?.body).not.toHaveProperty('response_format');
  });
});
