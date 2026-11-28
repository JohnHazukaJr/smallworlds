import { readAge, readsAsChild, type AgeReading } from './ageRead';
import { allLooksText, looksText } from '../looks';
import type { CharacterLooks, CharacterState } from '../types';

export type PortraitStyle = 'realistic' | 'comic';

/** How much of the person the picture shows. */
export type PortraitFraming = 'head' | 'full';

export interface PortraitPromptInput {
  name: string;
  age: string;
  appearance: string;
  role: string;
  contentNotes: string;
  mature: boolean;
  style: PortraitStyle;
  /** Head and shoulders unless asked for the whole figure. */
  framing?: PortraitFraming;
  /** Image 1 is this person's main photo, sent to keep the same face. */
  faceRef?: boolean;
  /** Face, hair, body, clothing, and the rest. */
  looks?: CharacterLooks;
}

export type PortraitPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

const SEXUAL_VISUAL =
  /\b(nude|naked|nudity|topless|bottomless|nsfw|explicit|erotic|erotica|lingerie|genitals|genital|breasts|nipples|penis|vagina|orgasm|undressed|sex|sexual)\b/i;

export const PORTRAIT_STYLE_KEY = 'sw-portrait-style';
export const PORTRAIT_FRAMING_KEY = 'sw-portrait-framing';

export function rememberedPortraitFraming(): PortraitFraming {
  try {
    return localStorage.getItem(PORTRAIT_FRAMING_KEY) === 'full' ? 'full' : 'head';
  } catch {
    return 'head';
  }
}

export function rememberPortraitFraming(framing: PortraitFraming) {
  try {
    localStorage.setItem(PORTRAIT_FRAMING_KEY, framing);
  } catch { /* private mode */ }
}

const FULL_BODY = /\b(full[- ]?body|full[- ]?length|head[- ]to[- ](toe|foot|feet)|whole (figure|body)|from head to (toe|foot|feet)|standing tall)\b/i;

/** True when a typed prompt asks for the whole figure. Picks a tall image. */
export function wantsFullBody(text: string): boolean {
  return FULL_BODY.test(text);
}

const LOOK_MAX = 480;

function clipLook(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * How someone looks, in one line: age, appearance, costume. Mannerisms are behaviour, not looks.
 * Only what the eye can see. Secrets, backstory, and lines are never inputs.
 */
export function characterLookLine(
  c: {
    name: string; age: string; appearance: string; role: string;
    looks?: CharacterLooks; state?: Pick<CharacterState, 'wearing'>;
  },
  max = LOOK_MAX,
  opts: { adult?: boolean } = {}
): string {
  const parts = [
    looksText(c, { adult: !!opts.adult, wearing: true }).replace(/\.$/, ''),
    c.role.trim() ? `dressed as befits: ${c.role.trim()}` : ''
  ].filter(Boolean);
  if (parts.length === 0) return '';
  const who = [c.name.trim() || 'They', c.age.trim()].filter(Boolean).join(', ');
  return clipLook(`${who}: ${parts.join('; ')}`, max);
}

export function rememberedPortraitStyle(): PortraitStyle {
  try {
    return localStorage.getItem(PORTRAIT_STYLE_KEY) === 'comic' ? 'comic' : 'realistic';
  } catch {
    return 'realistic';
  }
}

export function rememberPortraitStyle(style: PortraitStyle) {
  try {
    localStorage.setItem(PORTRAIT_STYLE_KEY, style);
  } catch { /* private mode */ }
}

export function textLooksSexual(text: string): boolean {
  return SEXUAL_VISUAL.test(text);
}

/** How much of the written look a portrait prompt carries. */
const PORTRAIT_LOOK_CHARS = 700;

export function portraitStyleLine(style: PortraitStyle): string {
  return style === 'comic'
    ? 'Comic book illustration, ink linework and painted color, graphic novel, not a photograph'
    : 'Photorealistic photograph, natural light, real camera, not an illustration, drawing, or painting';
}

/**
 * The line for one reference image. Image models copy a reference's art style as readily as
 * its face, so a drawn portrait made every later picture drawn, and a photo made them all
 * photos, whatever style was picked. Each reference is named as identity only, in both
 * directions, with the chosen style restated.
 */
export function refIdentityLine(style: PortraitStyle, index: number, name: string, kind: 'face' | 'place'): string {
  const render = style === 'comic'
    ? 'draw it as a comic illustration even if the image is a photograph'
    : 'show it as a real photograph even if the image is drawn or painted';
  return kind === 'place'
    ? `Image ${index} is ${name}, the setting: keep its layout, materials, and light, but not its art style; ${render}`
    : `Image ${index} is ${name}: use it only for who they are (face shape, hair, coloring), not for its art style; ${render}`;
}

/**
 * True when the age line describes someone under 18. A blank age is not a minor.
 * A stated minor age always wins; heights, counts, years, and words about other
 * people do not count (see readAge).
 */
export function characterReadsAsMinor(age: string): boolean {
  return readAge(age).minor;
}

/**
 * Whether a character reads as a minor or an adult for pictures.
 * A stated age decides it, so "18, looks young for her age" is an adult.
 * With no clear age, their appearance and role decide: anything that reads
 * under 18 ("a teen", "looks 15") is a minor, and otherwise they are treated
 * as an adult. Words like "youthful" or "petite" never make someone a minor.
 */
export function subjectAgeReading(c: {
  age: string; appearance?: string; role?: string; looks?: CharacterLooks;
}): AgeReading {
  const stated = readAge(c.age);
  if (stated.minor && !stated.unclear) return stated;
  // Every part of how they are described counts, the intimate section included.
  const description = [allLooksText(c), c.role ?? ''].join('. ');
  // Depicted as a child ("looks 12", "a child") is a minor whatever age is written down.
  if (readsAsChild(description)) return { minor: true, adult: false };
  if (stated.adult) return stated;
  if (stated.unclear) return stated;
  const described = readAge(description);
  if (described.minor) return { minor: true, adult: false, ...(described.unclear ? { unclear: true } : {}) };
  return { minor: false, adult: true };
}

/**
 * The message for a refused picture. When the only signal is a teen word with
 * no age written down, say how to settle it: 18 and 19 are teens too.
 */
/**
 * The intimate appearance section is used only in adult worlds, for characters
 * who do not read as under 18.
 */
export function intimateAllowed(
  world: { ai: { mature?: boolean } } | null | undefined,
  c: { age: string; appearance?: string; role?: string; looks?: CharacterLooks }
): boolean {
  return !!world?.ai.mature && !subjectAgeReading(c).minor;
}

export function minorRefusalMessage(subjects: Array<{
  name?: string; age: string; appearance?: string; role?: string; looks?: CharacterLooks;
}>): string {
  const flagged = subjects.filter((s) => subjectAgeReading(s).minor);
  if (flagged.length > 0 && flagged.every((s) => subjectAgeReading(s).unclear)) {
    const names = flagged.map((s) => s.name?.trim()).filter(Boolean).join(', ') || 'This character';
    return `${names} has no age set and reads as a teen. Set their age to 18 or over on their card to make this picture.`;
  }
  return 'A character in this picture reads as under 18. A sexual prompt can’t be sent.';
}

/**
 * Portrait prompt from how the character looks.
 * Secrets, backstory, and example lines are not inputs.
 * Adult depiction is included only when the world allows it and the character is not a minor.
 */
export function buildCharacterPortraitPrompt(input: PortraitPromptInput): PortraitPromptResult {
  const reading = subjectAgeReading(input);
  const minor = reading.minor;
  // The intimate section is sent only for an adult in an adult world. Voice and scent are not visual.
  const appearance = clipLook(
    looksText({ ...input, looks: input.looks ? { ...input.looks, senses: '' } : input.looks }, { adult: input.mature && !minor })
      .replace(/\.$/, ''),
    PORTRAIT_LOOK_CHARS
  );
  const look = [appearance, input.role].map((s) => s.trim()).filter(Boolean);
  if (look.length === 0) {
    return { ok: false, error: 'Add an appearance or role before generating a portrait.' };
  }
  const visual = [allLooksText(input), input.role].join('\n');
  if (minor && SEXUAL_VISUAL.test(visual)) {
    return {
      ok: false,
      error: reading.unclear
        ? 'This character has no age set and reads as a teen. Set their age to 18 or over to make this portrait.'
        : 'This character reads as under 18. A sexual description can’t be sent for a portrait.'
    };
  }
  const audience = minor || !input.mature
    ? 'Fully clothed, non-sexual, no nudity, no suggestive pose'
    : 'Adult subject. Follow the appearance as written';
  const who = input.name.trim() || 'one person';
  const frame = input.framing === 'full'
    ? `Full-body portrait of ${who}, the whole figure visible from head to feet, outfit fully shown, one person only`
    : `Portrait of ${who}, head and shoulders, one person only`;
  const style = input.style === 'comic'
    ? portraitStyleLine('comic')
    : input.framing === 'full'
      ? 'Photorealistic full-length photograph, natural skin, real camera'
      : 'Photorealistic portrait photograph, natural skin, real camera, shallow depth of field';
  const faceLine = input.faceRef ? refIdentityLine(input.style, 1, who, 'face') : '';
  // Style leads, so a long sheet can never push it out of the prompt.
  const bits = [
    frame,
    style,
    faceLine,
    input.age.trim() ? `Age: ${input.age.trim()}` : '',
    input.role.trim() ? `Role and costume: ${clipLook(input.role.trim(), 200)}` : '',
    appearance ? `Appearance: ${appearance}` : '',
    input.contentNotes.trim() ? `Boundaries: ${clipLook(input.contentNotes.trim(), 200)}` : '',
    audience,
    input.style === 'comic' ? 'Drawn, not photographed. No text, no watermark, no extra people' : 'No text, no watermark, no extra people'
  ].filter(Boolean);
  return { ok: true, prompt: bits.join('. ') };
}
