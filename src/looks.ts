/**
 * Appearance in parts: face, hair, body, clothing, details, voice & scent, and
 * an adult-only intimate section. The character's `appearance` field stays the
 * overall line, so older cards read exactly as before.
 */

import type { CharacterLooks, CharacterState } from './types';

export type LookKey = keyof CharacterLooks;

export interface LookSection {
  key: LookKey;
  label: string;
  /** Label used when the parts are joined into one line for a prompt. */
  promptLabel: string;
  placeholder: string;
  /** Shown only in adult worlds, for characters who do not read as under 18. */
  adultOnly?: boolean;
}

export const LOOK_SECTIONS: LookSection[] = [
  { key: 'face', label: 'Face', promptLabel: 'Face', placeholder: 'Sharp cheekbones, grey eyes, a scar through the left brow' },
  { key: 'hair', label: 'Hair', promptLabel: 'Hair', placeholder: 'Black with a silver streak, worn in a loose braid' },
  { key: 'body', label: 'Body', promptLabel: 'Body', placeholder: 'Tall and rangy, broad shoulders, moves like a fencer' },
  { key: 'clothing', label: 'Clothing', promptLabel: 'Usually wears', placeholder: 'Long grey registrar’s coat, ink-stained cuffs' },
  { key: 'details', label: 'Details', promptLabel: 'Details', placeholder: 'Gold ring she never removes; compass tattoo on her wrist' },
  { key: 'senses', label: 'Voice & scent', promptLabel: 'Voice & scent', placeholder: 'Low, rasping voice; smells of pipe smoke and rain' },
  { key: 'intimate', label: 'Intimate', promptLabel: 'Intimate', placeholder: 'Adult details the story may describe when the scene calls for it', adultOnly: true }
];

/** Sections a generated sheet may fill. Intimate is asked for separately. */
export const DRAFTABLE_LOOK_KEYS: LookKey[] = ['face', 'hair', 'body', 'clothing', 'details', 'senses'];

interface LooksSource {
  appearance?: string;
  looks?: CharacterLooks;
  state?: Pick<CharacterState, 'wearing'>;
}

function clean(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** A live outfit that is set and not a clear-word. */
export function wearingNow(state: Pick<CharacterState, 'wearing'> | undefined): string {
  const w = clean(state?.wearing);
  return w && !/^(none|n\/a|-|usual|same)$/i.test(w) ? w : '';
}

/**
 * How someone looks, as one labeled line for a prompt:
 * "Tall, weathered. Face: … Hair: … Usually wears: … Wearing now: …".
 * Empty parts are left out. Intimate only when `adult` is true.
 */
export function looksText(c: LooksSource, opts: { adult?: boolean; wearing?: boolean } = {}): string {
  const parts: string[] = [];
  const overall = clean(c.appearance).replace(/[.;,\s]+$/, '');
  if (overall) parts.push(overall);
  for (const section of LOOK_SECTIONS) {
    if (section.adultOnly && !opts.adult) continue;
    const text = clean(c.looks?.[section.key]).replace(/[.;,\s]+$/, '');
    if (text) parts.push(`${section.promptLabel}: ${text}`);
    if (section.key === 'clothing' && opts.wearing) {
      const now = wearingNow(c.state);
      if (now) parts.push(`Wearing now: ${now.replace(/[.;,\s]+$/, '')}`);
    }
  }
  return parts.length > 0 ? `${parts.join('. ')}.` : '';
}

/** Every part, intimate included. For safety checks only, never for a prompt. */
export function allLooksText(c: LooksSource): string {
  return looksText(c, { adult: true, wearing: true });
}

/** True when any section has text. */
export function hasLooks(looks: CharacterLooks | undefined): boolean {
  return LOOK_SECTIONS.some((s) => clean(looks?.[s.key]));
}

/** Fill empty sections from a draft; never overwrite what is already written. */
export function mergeLooks(
  current: CharacterLooks | undefined,
  /** Raw model output: unknown keys and non-strings are ignored. */
  incoming: object | undefined,
  allowIntimate: boolean
): CharacterLooks | undefined {
  const raw = (incoming ?? {}) as Record<string, unknown>;
  const out: CharacterLooks = { ...(current ?? {}) };
  for (const section of LOOK_SECTIONS) {
    if (section.adultOnly && !allowIntimate) continue;
    if (clean(out[section.key])) continue;
    const value = raw[section.key];
    if (typeof value === 'string' && clean(value)) out[section.key] = value.trim();
  }
  return hasLooks(out) ? out : current;
}
