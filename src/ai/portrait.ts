export type PortraitStyle = 'realistic' | 'comic';

export interface PortraitPromptInput {
  name: string;
  age: string;
  appearance: string;
  mannerisms: string;
  role: string;
  contentNotes: string;
  mature: boolean;
  style: PortraitStyle;
}

export type PortraitPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

const MINOR_AGE =
  /\b(child|children|kid|kids|toddler|infant|baby|teen|teens|teenager|teenagers|minor|minors|underage|preteen|pre-teen|adolescent|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|ten)\b/i;

const UNDER_EIGHTEEN = /\bunder\s*-?\s*18\b/i;

const SEXUAL_VISUAL =
  /\b(nude|naked|nudity|topless|bottomless|nsfw|explicit|erotic|erotica|lingerie|genitals|genital|breasts|nipples|penis|vagina|orgasm|undressed|sex|sexual)\b/i;

export const PORTRAIT_STYLE_KEY = 'sw-portrait-style';

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

export function portraitStyleLine(style: PortraitStyle): string {
  return style === 'comic'
    ? 'Comic book illustration, ink linework and painted color, graphic novel, not a photograph'
    : 'Photorealistic, natural light, real camera';
}

/** True when the age line describes someone under 18. A blank age is not a minor. */
export function characterReadsAsMinor(age: string): boolean {
  const s = age.trim().toLowerCase();
  if (!s) return false;
  if (MINOR_AGE.test(s) || UNDER_EIGHTEEN.test(s)) return true;
  const years = [...s.matchAll(/\b(\d{1,3})\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= 120);
  return years.some((n) => n < 18);
}

/**
 * Portrait prompt from how the character looks.
 * Secrets, backstory, and example lines are not inputs.
 * Adult depiction is included only when the world allows it and the character is not a minor.
 */
export function buildCharacterPortraitPrompt(input: PortraitPromptInput): PortraitPromptResult {
  const look = [input.appearance, input.mannerisms, input.role].map((s) => s.trim()).filter(Boolean);
  if (look.length === 0) {
    return { ok: false, error: 'Add an appearance, mannerisms, or role before generating a portrait.' };
  }
  const minor = characterReadsAsMinor(input.age);
  const visual = [input.appearance, input.mannerisms, input.role].join('\n');
  if (minor && SEXUAL_VISUAL.test(visual)) {
    return {
      ok: false,
      error: 'This character reads as under 18. A sexual description can’t be sent for a portrait.'
    };
  }
  const style = input.style === 'comic'
    ? portraitStyleLine('comic')
    : 'Photorealistic portrait photograph, natural skin, real camera, shallow depth of field';
  const audience = minor || !input.mature
    ? 'Fully clothed, non-sexual, no nudity, no suggestive pose'
    : 'Adult subject. Follow the appearance as written';
  const bits = [
    `Portrait of ${input.name.trim() || 'one person'}, head and shoulders, one person only`,
    input.age.trim() ? `Age: ${input.age.trim()}` : '',
    input.role.trim() ? `Role and costume: ${input.role.trim()}` : '',
    input.appearance.trim() ? `Appearance: ${input.appearance.trim()}` : '',
    input.mannerisms.trim() ? `Visible manner: ${input.mannerisms.trim()}` : '',
    input.contentNotes.trim() ? `Boundaries: ${input.contentNotes.trim()}` : '',
    style,
    audience,
    'No text, no watermark, no extra people'
  ].filter(Boolean);
  return { ok: true, prompt: bits.join('. ').slice(0, 1600) };
}
