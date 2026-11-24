import type { CSSProperties } from 'react';
import type { MoodId, BackdropId } from '../store/app';

/** Binding color — oxblood, used for the primary mark, not for washes. */
export const ACCENT = '#5b6b7f';

/** Soft forms of ACCENT for inline styles that need alpha. */
export const ACCENT_RGBA = {
  a08: 'rgba(91, 107, 127, 0.08)',
  a10: 'rgba(91, 107, 127, 0.1)',
  a12: 'rgba(91, 107, 127, 0.12)',
  a14: 'rgba(91, 107, 127, 0.14)',
  a25: 'rgba(91, 107, 127, 0.25)',
  a28: 'rgba(91, 107, 127, 0.28)',
  a35: 'rgba(91, 107, 127, 0.35)',
  a45: 'rgba(91, 107, 127, 0.45)',
  a55: 'rgba(91, 107, 127, 0.55)',
  a70: 'rgba(91, 107, 127, 0.7)',
  a85: 'rgba(91, 107, 127, 0.85)',
  solid: ACCENT
};

/**
 * Moods are faint stains on the page. Prose stays ink; the app chrome stays neutral.
 * `tint` washes the sheet (multiplied, so ink stays black). `accent` must stay 6-digit
 * hex: callers append a hex alpha to it.
 */
export const MOODS: Record<MoodId, { label: string; tint: string; text: string; accent: string; prose: string }> = {
  ember: { label: 'Ember', tint: 'rgba(160,90,40,0.06)',  text: '#1a1a1a', accent: '#7a5a3e', prose: '#1a1a1a' },
  ash:   { label: 'Ash',   tint: 'rgba(80,90,100,0.05)',  text: '#1a1a1a', accent: '#5b6470', prose: '#1a1a1a' },
  frost: { label: 'Frost', tint: 'rgba(70,110,130,0.06)', text: '#1a1a1a', accent: '#4d6b78', prose: '#1a1a1a' },
  rot:   { label: 'Rot',   tint: 'rgba(70,100,60,0.06)',  text: '#1a1a1a', accent: '#56684a', prose: '#1a1a1a' },
  dusk:  { label: 'Dusk',  tint: 'rgba(90,70,110,0.06)',  text: '#1a1a1a', accent: '#64587a', prose: '#1a1a1a' },
  bloom: { label: 'Bloom', tint: 'rgba(110,120,50,0.06)', text: '#1a1a1a', accent: '#6b6c3e', prose: '#1a1a1a' },
  storm: { label: 'Storm', tint: 'rgba(50,70,100,0.07)',  text: '#1a1a1a', accent: '#4b5a72', prose: '#1a1a1a' },
  brine: { label: 'Brine', tint: 'rgba(40,110,100,0.06)', text: '#1a1a1a', accent: '#3f6b66', prose: '#1a1a1a' }
};

export const STRIPE = (a: string, b: string) =>
  `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;

export const BACKDROPS: Record<BackdropId, { tag: string; a: string; b: string }> = {
  scene: { tag: 'scene', a: '#ffffff', b: '#f4f4f5' },
  moment: { tag: 'moment', a: '#ffffff', b: '#f4f4f5' },
  character: { tag: 'character', a: '#ffffff', b: '#f4f4f5' },
  none: { tag: 'none', a: '#ffffff', b: '#ffffff' }
};

export const VIS: Record<'private' | 'invited' | 'public', { label: string; line: string }> = {
  private: { label: 'Private', line: 'Only you. Stored on this device, never sent anywhere but your own AI endpoint.' },
  invited: { label: 'Invited', line: 'Reserved for a future sharing feature. Behaves as private for now.' },
  public: { label: 'Public', line: 'Reserved for a future sharing feature. Behaves as private for now.' }
};

export const GAP_LABELS = ['That same night', 'Three days', 'A season', 'Two years', 'A generation'];
/** rough in-fiction day-equivalents for each GAP_LABELS entry — flavor for the calendar, not exact */
export const GAP_DAYS = [0, 3, 90, 730, 9125];
export const GAP_EFFECTS = [
  'Nothing has settled. Wounds, debts and tempers carry straight over.',
  'Enough for rumours to move. Characters have had time to decide how they feel.',
  'The world has changed hands once. Relationships cooled or hardened.',
  'People became who the last chapter pointed them at. Old debts are now other people\u2019s problems.',
  'Your protagonist may be a story others tell. Consider starting as someone new.'
];

/** A speaker's name in the ink of their hue, dark enough to read on paper. */
export function speakerInk(hue: number): string {
  return `oklch(0.4 0.09 ${hue})`;
}

/** Placeholder plate in the person's or place's own hue, so no two look the same. */
export function avatarStyle(hue: number, size: number, ring?: string): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: 2,
    flexShrink: 0,
    border: `1px solid ${ring || 'rgba(0,0,0,0.15)'}`,
    background: `linear-gradient(160deg, oklch(0.8 0.05 ${hue}), oklch(0.92 0.025 ${hue}))`,
    boxShadow: 'none'
  };
}

/** Endpaper — a hue stain on the sheet, not a dark plate. */
export function plateStyle(_hue: number, height: number | string): CSSProperties {
  return {
    height,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 8,
    padding: 12,
    background: '#f4f4f5'
  };
}
