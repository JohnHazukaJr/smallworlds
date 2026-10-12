import type { CSSProperties } from 'react';
import type { MoodId, BackdropId } from '../store/app';

/** Binding color — oxblood, used for the primary mark, not for washes. */
export const ACCENT = 'oklch(0.32 0.12 25)';

/** Soft forms of ACCENT for inline styles that need alpha. */
export const ACCENT_RGBA = {
  a08: 'oklch(0.32 0.12 25 / 0.08)',
  a10: 'oklch(0.32 0.12 25 / 0.1)',
  a12: 'oklch(0.32 0.12 25 / 0.12)',
  a14: 'oklch(0.32 0.12 25 / 0.14)',
  a25: 'oklch(0.32 0.12 25 / 0.25)',
  a28: 'oklch(0.32 0.12 25 / 0.28)',
  a35: 'oklch(0.32 0.12 25 / 0.35)',
  a45: 'oklch(0.32 0.12 25 / 0.45)',
  a55: 'oklch(0.32 0.12 25 / 0.55)',
  a70: 'oklch(0.32 0.12 25 / 0.7)',
  a85: 'oklch(0.32 0.12 25 / 0.85)',
  solid: ACCENT
};

/** Moods are faint stains on the page. Prose stays ink. */
export const MOODS: Record<MoodId, { label: string; tint: string; text: string; accent: string; prose: string }> = {
  ember: { label: 'Ember', tint: 'rgba(160,90,40,0.06)', text: '#1c1612', accent: 'oklch(0.42 0.08 55)', prose: '#2a241c' },
  ash:   { label: 'Ash',   tint: 'rgba(80,90,100,0.05)', text: '#1c1612', accent: 'oklch(0.4 0.02 250)', prose: '#2a241c' },
  frost: { label: 'Frost', tint: 'rgba(70,110,130,0.06)', text: '#1c1612', accent: 'oklch(0.4 0.04 210)', prose: '#2a241c' },
  rot:   { label: 'Rot',   tint: 'rgba(70,100,60,0.06)', text: '#1c1612', accent: 'oklch(0.4 0.06 140)', prose: '#2a241c' },
  dusk:  { label: 'Dusk',  tint: 'rgba(90,70,110,0.06)', text: '#1c1612', accent: 'oklch(0.4 0.04 295)', prose: '#2a241c' },
  bloom: { label: 'Bloom', tint: 'rgba(110,120,50,0.06)', text: '#1c1612', accent: 'oklch(0.42 0.06 115)', prose: '#2a241c' },
  storm: { label: 'Storm', tint: 'rgba(50,70,100,0.07)', text: '#1c1612', accent: 'oklch(0.38 0.04 240)', prose: '#2a241c' },
  brine: { label: 'Brine', tint: 'rgba(40,110,100,0.06)', text: '#1c1612', accent: 'oklch(0.4 0.05 185)', prose: '#2a241c' }
};

export const STRIPE = (a: string, b: string) =>
  `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;

export const BACKDROPS: Record<BackdropId, { tag: string; a: string; b: string }> = {
  scene: { tag: 'scene plate', a: 'rgba(243,239,230,0.92)', b: 'rgba(247,243,234,0.96)' },
  moment: { tag: 'moment plate', a: 'rgba(239,230,214,0.9)', b: 'rgba(247,243,234,0.96)' },
  character: { tag: 'character plate', a: 'rgba(236,228,214,0.9)', b: 'rgba(247,243,234,0.96)' },
  none: { tag: 'plain page', a: 'rgba(243,239,230,0.4)', b: '#f7f3ea' }
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
  return `oklch(0.38 0.09 ${hue})`;
}

export function avatarStyle(hue: number, size: number, ring?: string): CSSProperties {
  const r = size > 30 ? 2 : 2;
  return {
    width: size,
    height: size,
    borderRadius: r,
    flexShrink: 0,
    border: `1px solid ${ring || 'rgba(28,22,18,0.18)'}`,
    backgroundImage: `linear-gradient(160deg, oklch(0.78 0.05 ${hue}), oklch(0.9 0.03 ${hue}))`,
    boxShadow: 'none'
  };
}

/** Endpaper — a hue stain on the sheet, not a dark plate. */
export function plateStyle(hue: number, height: number | string): CSSProperties {
  return {
    height,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 8,
    padding: 12,
    background: `linear-gradient(165deg, oklch(0.9 0.04 ${hue} / 0.55), #f7f3ea)`
  };
}
