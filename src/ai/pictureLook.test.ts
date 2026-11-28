import '../test/storagePolyfill';
import { describe, expect, it } from 'vitest';
import type { Character, ProviderConfig } from '../types';
import { emptyCharacter, faceRefFor, portraitKey, portraitStylesPatch } from '../worldOps';
import {
  chapterPictureLooks, chapterPicturePrompt, imageSizeCandidates, passagePictureFallback, prepareChapterPicture
} from './image';
import { buildCharacterPortraitPrompt, characterLookLine, wantsFullBody } from './portrait';

const or = { id: 'or', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', label: 'OR' } as unknown as ProviderConfig;

const person = (id: string, name: string, patch: Partial<Character> = {}): Character =>
  emptyCharacter('w', {
    id, name, age: '34', role: 'harbour registrar',
    appearance: 'Tall and spare, silver streak in black hair, ink-stained cuffs, long grey coat.',
    mannerisms: 'Keeps one hand on the ledger.',
    secrets: 'Forged the manifest.',
    backstory: 'Lost a brother at sea.',
    ...patch
  });

const portraitBase = {
  name: 'Marisol', age: '34',
  appearance: 'Silver streak in black hair, a scar through the left brow.',
  mannerisms: 'Keeps one hand on the ledger.', role: 'harbour registrar',
  contentNotes: '', mature: true, style: 'realistic' as const
};

describe('characterLookLine', () => {
  it('carries what the eye can see and nothing hidden', () => {
    const line = characterLookLine(person('a', 'Ada'));
    expect(line).toMatch(/^Ada, 34: Tall and spare/);
    expect(line).toMatch(/long grey coat/);
    expect(line).toMatch(/harbour registrar/);
    expect(line).not.toMatch(/hand on the ledger/);
    expect(line).not.toMatch(/Forged|brother/);
  });

  it('is empty without anything visible, and clipped when long', () => {
    expect(characterLookLine(person('a', 'Ada', { appearance: '', role: '', mannerisms: '' }))).toBe('');
    expect(characterLookLine(person('a', 'Ada', { appearance: 'x'.repeat(900) })).length).toBeLessThanOrEqual(480);
  });
});

describe('portrait framing', () => {
  it('keeps head and shoulders by default', () => {
    const built = buildCharacterPortraitPrompt(portraitBase);
    expect(built.ok && built.prompt).toMatch(/head and shoulders/);
  });

  it('asks for the whole figure on full body, with the face kept from the photo', () => {
    const built = buildCharacterPortraitPrompt({ ...portraitBase, framing: 'full', faceRef: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.prompt).toMatch(/Full-body portrait of Marisol, the whole figure visible from head to feet/);
    expect(built.prompt).toMatch(/Image 1 is Marisol: use it only for who they are \(face shape, hair, coloring\), not for its art style/);
    // A drawn reference must not keep a realistic portrait drawn.
    expect(built.prompt).toMatch(/show it as a real photograph even if the image is drawn or painted/);
    expect(built.prompt).not.toMatch(/head and shoulders/);
  });

  it('stays clothed for a general-audience world in full body too', () => {
    const built = buildCharacterPortraitPrompt({ ...portraitBase, framing: 'full', mature: false });
    expect(built.ok && built.prompt).toMatch(/Fully clothed, non-sexual/);
  });

  it('spots a typed request for the whole figure', () => {
    expect(wantsFullBody('Ada, full body, at the docks')).toBe(true);
    expect(wantsFullBody('Ada head to toe in the rain')).toBe(true);
    expect(wantsFullBody('a full-length portrait')).toBe(true);
    expect(wantsFullBody('Ada at the docks')).toBe(false);
    expect(wantsFullBody('a bodyguard nearby')).toBe(false);
    expect(imageSizeCandidates('tall')).toEqual(['1024x1536', '1024x1024']);
  });
});

describe('chapter pictures carry the written look', () => {
  it('sends the face from the photo and the body and clothes from the sheet', () => {
    const plan = prepareChapterPicture({
      characters: [person('a', 'Ada', { portraits: ['data:image/jpeg;base64,ada'] }), person('b', 'Ben', { appearance: 'Stocky, red beard, oilskin jacket.' })],
      castIds: ['a', 'b'],
      userPrompt: 'Ada and Ben arguing on the quay.',
      style: 'realistic', contentNotes: '', mature: true, provider: or, model: 'flux'
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.prompt).toMatch(/Image 1 is Ada/);
    expect(plan.prompt).toMatch(/Body, build, and clothing — Ada, 34: Tall and spare/);
    expect(plan.prompt).toMatch(/Looks — Ben, 34: Stocky, red beard, oilskin jacket/);
    expect(plan.prompt).toMatch(/no invented outfits, builds, or faces/);
    expect(plan.prompt).not.toMatch(/Forged|brother/);
  });

  it('asks for the whole figure when told to', () => {
    const plan = prepareChapterPicture({
      characters: [person('a', 'Ada')], castIds: ['a'], userPrompt: 'Ada at the docks',
      style: 'realistic', contentNotes: '', mature: true, provider: or, model: 'flux', fullBody: true
    });
    expect(plan.ok && plan.prompt).toMatch(/Show the whole figure, head to feet/);
  });

  it('shortens the looks before it ever cuts the user\'s own words', () => {
    const userPrompt = `Ada on the quay at dusk. ${'Lanterns sway on the masts. '.repeat(30)}THE END`;
    const prompt = chapterPicturePrompt({
      userPrompt, refs: [], style: 'realistic', contentNotes: '', mature: true, minor: false,
      looks: chapterPictureLooks([person('a', 'Ada', { appearance: 'y'.repeat(300) })])
    });
    expect(prompt.length).toBeLessThanOrEqual(1600);
    expect(prompt).toContain('THE END');
  });

  it('still refuses a sexual scene for someone who reads as under 18', () => {
    const plan = prepareChapterPicture({
      characters: [person('k', 'Mina', { age: '16' })], castIds: ['k'], userPrompt: 'Mina, nude, full body',
      style: 'realistic', contentNotes: '', mature: true, provider: or, model: 'flux', fullBody: true
    });
    expect(plan.ok).toBe(false);
  });
});

describe('chosen style leads every picture prompt', () => {
  it('puts the style first in a chapter picture, before the photos and the request', () => {
    const refs = [{ name: 'Ada', dataUrl: 'data:image/jpeg;base64,x', kind: 'face' as const }];
    const realistic = chapterPicturePrompt({ userPrompt: 'Ada at the window', refs, style: 'realistic', contentNotes: '', mature: false, minor: false });
    const comic = chapterPicturePrompt({ userPrompt: 'Ada at the window', refs, style: 'comic', contentNotes: '', mature: false, minor: false });
    expect(realistic).toMatch(/^Photorealistic photograph/);
    expect(comic).toMatch(/^Comic book illustration/);
    expect(realistic).toMatch(/show it as a real photograph even if the image is drawn/);
    expect(comic).toMatch(/draw it as a comic illustration even if the image is a photograph/);
  });

  it('keeps the style when a long request fills the prompt', () => {
    const long = 'Ada at the window, rain, '.repeat(120);
    const prompt = chapterPicturePrompt({ userPrompt: long, refs: [], style: 'comic', contentNotes: '', mature: false, minor: false });
    expect(prompt).toMatch(/^Comic book illustration/);
  });
});

describe('passagePictureFallback', () => {
  it('keeps what is seen, drops what is said, and names who is in it', () => {
    const passage = 'Ada Vey: *slides the page toward the lamp* "Read it again." Rain needles the window; Brannoc says nothing.';
    const out = passagePictureFallback(passage, ['Ada Vey', 'Brannoc Hale', 'Sister Ilse']);
    expect(out.startsWith('Ada Vey and Brannoc Hale: ')).toBe(true);
    expect(out).toContain('slides the page toward the lamp');
    expect(out).toContain('Rain needles the window');
    expect(out).not.toContain('Read it again');
    expect(out).not.toContain('Ilse');
  });
});

describe('a face reference in the chosen style', () => {
  const photo = 'data:image/jpeg;base64,' + 'P'.repeat(4000);
  const drawn = 'data:image/jpeg;base64,' + 'D'.repeat(4000);

  it('prefers a portrait made in that style, else the primary one', () => {
    const c = { portraits: [drawn, photo], portrait: drawn, portraitStyles: { [portraitKey(drawn)]: 'comic' as const, [portraitKey(photo)]: 'realistic' as const } };
    expect(faceRefFor(c, 'realistic')).toBe(photo);
    expect(faceRefFor(c, 'comic')).toBe(drawn);
    expect(faceRefFor({ portraits: [drawn, photo], portrait: drawn }, 'realistic')).toBe(drawn);
    expect(faceRefFor({ portraits: [], portrait: null }, 'realistic')).toBeUndefined();
  });

  it('keeps styles through a reorder, and forgets deleted pictures', () => {
    const c = { portraits: [drawn], portrait: drawn, portraitStyles: { [portraitKey(drawn)]: 'comic' as const, stale: 'realistic' as const } };
    const styles = portraitStylesPatch(c, [photo, drawn], { url: photo, style: 'realistic' });
    expect(styles).toEqual({ [portraitKey(drawn)]: 'comic', [portraitKey(photo)]: 'realistic' });
    expect(portraitKey(photo)).not.toBe(portraitKey(drawn));
  });
});
