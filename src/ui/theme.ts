import type { CSSProperties } from 'react';
import type { MoodId, BackdropId } from '../store/app';

export const ACCENT = 'oklch(0.85 0.1 62)';

export const MOODS: Record<MoodId, { label: string; tint: string; text: string; accent: string; prose: string }> = {
  ember: { label: 'Ember', tint: 'rgba(224,165,95,0.16)', text: '#f2ece2', accent: 'oklch(0.83 0.1 58)', prose: '#ece2d4' },
  ash:   { label: 'Ash',   tint: 'rgba(160,175,200,0.14)', text: '#eef0f3', accent: 'oklch(0.84 0.04 250)', prose: '#e2e5ea' },
  frost: { label: 'Frost', tint: 'rgba(120,180,210,0.16)', text: '#e8f1f5', accent: 'oklch(0.85 0.07 215)', prose: '#dae7ee' },
  rot:   { label: 'Rot',   tint: 'rgba(150,190,130,0.14)', text: '#eaf0e4', accent: 'oklch(0.83 0.08 135)', prose: '#dfe7d4' }
};

export const STRIPE = (a: string, b: string) =>
  `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;

export const BACKDROPS: Record<BackdropId, { tag: string; a: string; b: string }> = {
  scene: { tag: 'scene plate', a: 'rgba(70,54,38,0.75)', b: 'rgba(14,15,19,0.9)' },
  moment: { tag: 'moment plate', a: 'rgba(84,60,34,0.7)', b: 'rgba(12,13,17,0.92)' },
  character: { tag: 'character plate', a: 'rgba(52,48,66,0.72)', b: 'rgba(11,12,16,0.92)' },
  none: { tag: 'no backdrop · plain page', a: 'rgba(255,255,255,0.02)', b: 'rgba(8,9,12,0.98)' }
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
  return {
    width: size,
    height: size,
    borderRadius: size > 30 ? 12 : '50%',
    flexShrink: 0,
    border: `1px solid ${ring || 'rgba(255,255,255,0.16)'}`,
    backgroundImage: `linear-gradient(150deg, oklch(0.6 0.08 ${hue}), rgba(255,255,255,0.06)), ${STRIPE('rgba(255,255,255,0.1)', 'rgba(255,255,255,0.02)')}`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)'
  };
}

export function plateStyle(hue: number, height: number): CSSProperties {
  return {
    height,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 8,
    padding: 12,
    background: `linear-gradient(155deg, oklch(0.45 0.06 ${hue} / 0.75), rgba(8,9,12,0.85)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`
  };
}
