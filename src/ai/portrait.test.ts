import '../test/storagePolyfill';
import { describe, expect, it } from 'vitest';
import { characterAvatarStyle } from '../ui/avatar';
import { portraitsPatch } from '../worldOps';
import { buildCharacterPortraitPrompt, characterReadsAsMinor } from './portrait';

const base = {
  name: 'Marisol',
  age: '34',
  appearance: 'Silver streak in black hair, a scar through the left brow.',
  mannerisms: 'Keeps one hand on the ledger.',
  role: 'harbour registrar',
  contentNotes: '',
  mature: true,
  style: 'realistic' as const
};

describe('characterReadsAsMinor', () => {
  it('treats a blank age as not a minor', () => {
    expect(characterReadsAsMinor('')).toBe(false);
    expect(characterReadsAsMinor('   ')).toBe(false);
  });

  it('reads numbers under 18 and age words as minors', () => {
    expect(characterReadsAsMinor('16')).toBe(true);
    expect(characterReadsAsMinor('17 years')).toBe(true);
    expect(characterReadsAsMinor('under 18')).toBe(true);
    expect(characterReadsAsMinor('teen')).toBe(true);
    expect(characterReadsAsMinor('a child')).toBe(true);
  });

  it('reads 18 and older as adults', () => {
    expect(characterReadsAsMinor('18')).toBe(false);
    expect(characterReadsAsMinor('34')).toBe(false);
    expect(characterReadsAsMinor('thirties')).toBe(false);
  });
});

describe('buildCharacterPortraitPrompt', () => {
  it('uses a photograph line for realistic and a comic line for comic', () => {
    const photo = buildCharacterPortraitPrompt(base);
    const comic = buildCharacterPortraitPrompt({ ...base, style: 'comic' });
    expect(photo.ok && photo.prompt).toMatch(/Photorealistic portrait photograph/);
    expect(photo.ok && photo.prompt).not.toMatch(/Comic book/);
    expect(comic.ok && comic.prompt).toMatch(/Comic book illustration/);
    expect(comic.ok && comic.prompt).not.toMatch(/Photorealistic/);
  });

  it('includes appearance and leaves out text that was not passed', () => {
    const built = buildCharacterPortraitPrompt(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.prompt).toMatch(/Silver streak/);
    expect(built.prompt).toMatch(/harbour registrar/);
    expect(built.prompt).not.toMatch(/must not know/i);
  });

  it('asks for a clothed portrait when the world is general audience', () => {
    const built = buildCharacterPortraitPrompt({ ...base, mature: false, appearance: 'nude on the dock' });
    expect(built.ok && built.prompt).toMatch(/Fully clothed, non-sexual/);
  });

  it('sends an adult appearance as written when the world is adult', () => {
    const built = buildCharacterPortraitPrompt({ ...base, appearance: 'nude on the dock, silver streak' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.prompt).toMatch(/nude on the dock/);
    expect(built.prompt).toMatch(/Adult subject/);
    expect(built.prompt).not.toMatch(/non-sexual/);
    expect(built.prompt).not.toMatch(/Fully clothed/);
  });

  it('refuses a sexual description of a minor', () => {
    const built = buildCharacterPortraitPrompt({ ...base, age: '15', appearance: 'nude, silver streak' });
    expect(built).toEqual({
      ok: false,
      error: 'This character reads as under 18. A sexual description can’t be sent for a portrait.'
    });
  });

  it('keeps a minor portrait non-sexual even in an adult world', () => {
    const built = buildCharacterPortraitPrompt({
      ...base,
      age: '15',
      appearance: 'Silver streak, wool coat.'
    });
    expect(built.ok && built.prompt).toMatch(/Fully clothed, non-sexual/);
    expect(built.ok && built.prompt).not.toMatch(/Adult subject/);
  });

  it('includes world boundaries and asks for a look first', () => {
    const bounded = buildCharacterPortraitPrompt({ ...base, contentNotes: 'No gore.' });
    expect(bounded.ok && bounded.prompt).toMatch(/Boundaries: No gore/);
    expect(buildCharacterPortraitPrompt({ ...base, appearance: '', mannerisms: '', role: '' })).toEqual({
      ok: false,
      error: 'Add an appearance, mannerisms, or role before generating a portrait.'
    });
  });
});

describe('portrait gallery as avatar', () => {
  it('makes the first photo the avatar', () => {
    expect(portraitsPatch(['data:generated']).portrait).toBe('data:generated');
  });

  it('keeps the current main photo when another is added', () => {
    const next = portraitsPatch(['data:main', 'data:generated']);
    expect(next.portrait).toBe('data:main');
    expect(next.portraits).toEqual(['data:main', 'data:generated']);
  });

  it('moves the chosen photo to the front so it becomes the avatar', () => {
    const gallery = ['data:main', 'data:generated'];
    const next = portraitsPatch([gallery[1], ...gallery.filter((_, i) => i !== 1)]);
    expect(next.portrait).toBe('data:generated');
    expect(next.portraits?.[0]).toBe('data:generated');
  });

  it('uses the main photo on the avatar and promotes the next photo when it is removed', () => {
    const style = characterAvatarStyle(
      { hue: 10, portrait: 'data:main', portraits: ['data:main', 'data:other'] },
      34
    );
    expect(String(style.background)).toContain('data:main');
    const removed = portraitsPatch(['data:main', 'data:other'].filter((_, i) => i !== 0));
    expect(removed.portrait).toBe('data:other');
    expect(String(characterAvatarStyle(
      { hue: 10, portrait: removed.portrait, portraits: removed.portraits },
      34
    ).background)).toContain('data:other');
  });
});
