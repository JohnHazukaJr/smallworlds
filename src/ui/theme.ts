import type { CSSProperties } from 'react';
import type { MoodId, BackdropId } from '../store/app';

/** Seed accent — growth / craft chrome (single source of truth). */
export const ACCENT = 'oklch(0.72 0.06 195)';

/** Soft rgba forms of ACCENT for inline styles that need alpha. */
export const ACCENT_RGBA = {
  a08: 'oklch(0.72 0.06 195 / 0.08)',
  a10: 'oklch(0.72 0.06 195 / 0.1)',
  a12: 'oklch(0.72 0.06 195 / 0.12)',
  a14: 'oklch(0.72 0.06 195 / 0.14)',
  a25: 'oklch(0.72 0.06 195 / 0.25)',
  a28: 'oklch(0.72 0.06 195 / 0.28)',
  a35: 'oklch(0.72 0.06 195 / 0.35)',
  a45: 'oklch(0.72 0.06 195 / 0.45)',
  a55: 'oklch(0.72 0.06 195 / 0.55)',
  a70: 'oklch(0.72 0.06 195 / 0.7)',
  a85: 'oklch(0.72 0.06 195 / 0.85)',
  solid: ACCENT
};

/** Moods = weather of the world (washes), not glowing orbs. */
export const MOODS: Record<MoodId, { label: string; tint: string; text: string; accent: string; prose: string }> = {
  ember: { label: 'Ember', tint: 'rgba(196,150,110,0.1)', text: '#f0ebe4', accent: 'oklch(0.72 0.05 55)', prose: '#ebe2d6' },
  ash:   { label: 'Ash',   tint: 'rgba(150,165,185,0.1)', text: '#eef0f3', accent: 'oklch(0.74 0.03 250)', prose: '#e2e5ea' },
  frost: { label: 'Frost', tint: 'rgba(120,170,195,0.1)', text: '#e8f1f5', accent: 'oklch(0.74 0.05 210)', prose: '#dae7ee' },
  rot:   { label: 'Rot',   tint: 'rgba(140,175,130,0.1)', text: '#eaf0e4', accent: 'oklch(0.72 0.06 140)', prose: '#dfe7d4' }
};

export const STRIPE = (a: string, b: string) =>
  `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;

export const BACKDROPS: Record<BackdropId, { tag: string; a: string; b: string }> = {
  scene: { tag: 'scene plate', a: 'rgba(48,52,56,0.78)', b: 'rgba(10,12,14,0.92)' },
  moment: { tag: 'moment plate', a: 'rgba(56,50,42,0.72)', b: 'rgba(10,12,14,0.93)' },
  character: { tag: 'character plate', a: 'rgba(42,48,54,0.74)', b: 'rgba(10,12,14,0.93)' },
  none: { tag: 'plain page', a: 'rgba(255,255,255,0.02)', b: 'rgba(12,14,16,0.98)' }
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

export function avatarStyle(hue: number, size: number, ring?: string): CSSProperties {
  const r = size > 30 ? 6 : 4;
  return {
    width: size,
    height: size,
    borderRadius: r,
    flexShrink: 0,
    border: `1px solid ${ring || 'rgba(255,255,255,0.14)'}`,
    backgroundImage: `linear-gradient(150deg, oklch(0.5 0.045 ${hue}), rgba(255,255,255,0.04)), ${STRIPE('rgba(255,255,255,0.07)', 'rgba(255,255,255,0.012)')}`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)'
  };
}

/** Endpaper climate plate — hue = weather of the world. */
export function plateStyle(hue: number, height: number | string): CSSProperties {
  return {
    height,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 8,
    padding: 12,
    background: `linear-gradient(165deg, oklch(0.4 0.045 ${hue} / 0.75), rgba(10,12,14,0.9)), ${STRIPE('rgba(255,255,255,0.04)', 'rgba(255,255,255,0.01)')}`
  };
}
