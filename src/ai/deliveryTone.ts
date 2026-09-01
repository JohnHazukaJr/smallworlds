/**
 * Optional delivery / emotion tags on player speak & act turns.
 * Stored as a leading `[tone]` on Turn.text; MODE_PREFIX folds it into
 * stage direction so the tag is never treated as spoken words.
 *
 * Ids are persisted inside saved turns — never rename or remove one, or old
 * turns will render the raw `[tag]` in the prose. Adding is always safe.
 */

/**
 * Each tone carries an adverbial phrase rather than a bare adjective, so the
 * prompt reads as direction ("says the following aloud with sarcasm") instead of
 * the older "with a sarcastic delivery" — which also broke on vowels and adverbs.
 */
const TONE_PHRASES = {
  // warm
  warm: 'with warmth',
  gentle: 'gently',
  affectionate: 'with open affection',
  sincere: 'plainly and sincerely',
  grateful: 'with gratitude',
  hopeful: 'with guarded hope',
  happy: 'with open pleasure',
  relieved: 'with relief',

  // wry
  playful: 'playfully',
  teasing: 'teasing them',
  flirty: 'flirting, with intent',
  wry: 'wryly, half-amused',
  sarcastic: 'with sarcasm',
  deadpan: 'deadpan, without a flicker',

  // guarded
  cold: 'coldly',
  curt: 'curtly, clipped short',
  guarded: 'guarded, giving little away',
  formal: 'stiffly formal',
  dismissive: 'dismissively',
  evasive: 'evading the point',
  suspicious: 'with suspicion',

  // angry
  mad: 'in anger',
  furious: 'in open fury',
  bitter: 'bitterly',
  resentful: 'with old resentment',
  indignant: 'indignant, affronted',
  threatening: 'with quiet threat',
  defiant: 'defiantly',

  // afraid
  scared: 'afraid',
  nervous: 'nervously',
  uneasy: 'uneasy, not settled',
  panicked: 'close to panic',
  desperate: 'desperately',
  pleading: 'pleading',

  // low
  sad: 'with sadness',
  hurt: 'visibly hurt',
  ashamed: 'ashamed',
  apologetic: 'apologetic',
  tired: 'tiredly, worn down',
  numb: 'numb, feeling nothing',

  // steady
  calm: 'calmly',
  firm: 'firmly, leaving no room',
  'matter-of-fact': 'matter-of-factly',
  patient: 'patiently',
  reluctant: 'reluctantly',

  // driven
  urgent: 'urgently',
  excited: 'with excitement',
  eager: 'eagerly',
  breathless: 'breathless',
  quietly: 'quietly',
  whispered: 'in a whisper',
  loud: 'loudly, raising their voice',

  // unsure
  curious: 'with open curiosity',
  confused: 'confused',
  surprised: 'caught off guard'
} as const;

export type DeliveryTone = keyof typeof TONE_PHRASES;

/** Flat list of every tone id. */
export const DELIVERY_TONES = Object.keys(TONE_PHRASES) as DeliveryTone[];

export interface DeliveryToneGroup {
  id: string;
  /** short label for the picker */
  label: string;
  tones: readonly DeliveryTone[];
}

/**
 * Families for the picker. Every tone belongs to exactly one group
 * (locked by test) so nothing becomes unreachable in the UI.
 */
export const DELIVERY_TONE_GROUPS: readonly DeliveryToneGroup[] = [
  {
    id: 'warm',
    label: 'warm',
    tones: ['warm', 'gentle', 'affectionate', 'sincere', 'grateful', 'hopeful', 'happy', 'relieved']
  },
  {
    id: 'wry',
    label: 'wry',
    tones: ['playful', 'teasing', 'flirty', 'wry', 'sarcastic', 'deadpan']
  },
  {
    id: 'guarded',
    label: 'guarded',
    tones: ['cold', 'curt', 'guarded', 'formal', 'dismissive', 'evasive', 'suspicious']
  },
  {
    id: 'angry',
    label: 'angry',
    tones: ['mad', 'furious', 'bitter', 'resentful', 'indignant', 'threatening', 'defiant']
  },
  {
    id: 'afraid',
    label: 'afraid',
    tones: ['scared', 'nervous', 'uneasy', 'panicked', 'desperate', 'pleading']
  },
  {
    id: 'low',
    label: 'low',
    tones: ['sad', 'hurt', 'ashamed', 'apologetic', 'tired', 'numb']
  },
  {
    id: 'steady',
    label: 'steady',
    tones: ['calm', 'firm', 'matter-of-fact', 'patient', 'reluctant']
  },
  {
    id: 'driven',
    label: 'driven',
    tones: ['urgent', 'excited', 'eager', 'breathless', 'quietly', 'whispered', 'loud']
  },
  {
    id: 'unsure',
    label: 'unsure',
    tones: ['curious', 'confused', 'surprised']
  }
];

// Hyphens allowed for ids like matter-of-fact; the preset check still gates it.
const TAG_RE = /^\[([a-z][a-z-]*)\]\s*/i;

const TONE_SET = new Set<string>(DELIVERY_TONES);

export function isDeliveryTone(value: string): value is DeliveryTone {
  return TONE_SET.has(value.toLowerCase());
}

/** Stage direction for a tone, e.g. `quietly` → "quietly". */
export function deliveryPhrase(tone: DeliveryTone): string {
  return TONE_PHRASES[tone];
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
