/**
 * Optional delivery / emotion tags on player speak & act turns.
 * Stored as a leading `[tone]` on Turn.text; MODE_PREFIX folds it into
 * stage direction so the tag is never treated as spoken words.
 */

export const DELIVERY_TONES = [
  'mad',
  'sarcastic',
  'happy',
  'sad',
  'scared',
  'quietly',
  'whispered',
  'cold',
  'warm',
  'nervous',
  'bitter',
  'playful',
  'tired',
  'gentle'
] as const;

export type DeliveryTone = (typeof DELIVERY_TONES)[number];

const TAG_RE = /^\[([a-z]+)\]\s*/i;

const TONE_SET = new Set<string>(DELIVERY_TONES);

export function isDeliveryTone(value: string): value is DeliveryTone {
  return TONE_SET.has(value.toLowerCase());
}

/** Strip a leading `[tone]` tag if it matches the preset list. */
export function parseDeliveryTone(text: string): { tone: DeliveryTone | null; body: string } {
  const m = text.match(TAG_RE);
  if (!m) return { tone: null, body: text };
  const candidate = m[1].toLowerCase();
  if (!isDeliveryTone(candidate)) return { tone: null, body: text };
  return { tone: candidate, body: text.slice(m[0].length) };
}

/** Prepend `[tone] ` when a tone is set; otherwise return text unchanged. */
export function applyDeliveryTone(text: string, tone: DeliveryTone | null): string {
  const body = parseDeliveryTone(text).body;
  if (!tone) return body;
  return `[${tone}] ${body}`;
}
