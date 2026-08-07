/**
 * Canonical character/guest speak format:
 *   *she smiled, showing her dimples* "It's good to see you."
 * Actions in *asterisks*; spoken words in "double quotes".
 */

export type SpeakSegmentKind = 'action' | 'speech' | 'plain';

export interface SpeakSegment {
  kind: SpeakSegmentKind;
  text: string;
}

const NAME_PREFIX = /^[A-Z][^:\n]{0,48}:\s*/;
const CURLY_OPEN = /[“„«]/g;
const CURLY_CLOSE = /[”»]/g;

/** Normalize smart quotes to ASCII for reliable parsing. */
export function normalizeQuotes(text: string): string {
  return text.replace(CURLY_OPEN, '"').replace(CURLY_CLOSE, '"');
}

/**
 * Clean model output into canonical speak storage.
 * Strips name prefixes; repairs common mistakes; preserves *action* and "speech".
 */
export function normalizeSpeakText(raw: string): string {
  let text = normalizeQuotes(raw.trim());
  if (!text) return '';

  // Drop leading "Name: " if the model ignored instructions.
  text = text.replace(NAME_PREFIX, '').trim();

  // Unwrap a single outer pair of quotes wrapping the entire turn when it also
  // contains *actions* — those belong outside speech.
  if (/^\*[\s\S]+\*\s*"[\s\S]+"$/.test(text) === false && /^"[\s\S]*"$/.test(text)) {
    const inner = text.slice(1, -1).trim();
    if (inner.includes('*') || inner.includes('"')) text = inner;
  }

  // Fix *"spoken"* (action markers around dialogue) → "spoken"
  text = text.replace(/\*"([^"*]+)"\*/g, '"$1"');
  // Fix "*spoken*" same idea
  text = text.replace(/\*"([^"*]+)"\*/g, '"$1"');

  // If there are no markers at all, treat the whole line as speech.
  if (!text.includes('*') && !text.includes('"')) {
    return `"${text.replace(/^"|"$/g, '')}"`;
  }

  // Collapse horizontal whitespace only — keep intentional newlines in dialogue.
  return text.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** True when normalized speak text contains at least one "quoted" speech segment. */
export function hasSpokenDialogue(raw: string): boolean {
  return parseSpeakSegments(raw).some((s) => s.kind === 'speech' && s.text.trim().length > 0);
}

/**
 * Split a speak turn into action / speech / plain segments for rendering.
 * Asterisks and quote delimiters are not included in segment text.
 */
export function parseSpeakSegments(raw: string): SpeakSegment[] {
  const text = normalizeQuotes(raw.trim());
  if (!text) return [];

  const segments: SpeakSegment[] = [];
  const re = /\*([^*]+)\*|"([^"]+)"/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const plain = text.slice(last, m.index).trim();
      if (plain) segments.push({ kind: 'plain', text: plain });
    }
    if (m[1] !== undefined) {
      const action = m[1].trim();
      if (action) segments.push({ kind: 'action', text: action });
    } else if (m[2] !== undefined) {
      const speech = m[2].trim();
      if (speech) segments.push({ kind: 'speech', text: speech });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const plain = text.slice(last).trim();
    if (plain) segments.push({ kind: 'plain', text: plain });
  }

  // Legacy: entire turn was plain dialogue with optional outer quotes.
  if (segments.length === 0) {
    const stripped = text.replace(/^"|"$/g, '').trim();
    if (stripped) segments.push({ kind: 'speech', text: stripped });
  }

  return segments;
}

/** Instructions injected into character / guest speak system prompts. */
export const SPEAK_FORMAT_RULES =
  'Output format (required):\n' +
  '- Physical looks, gestures, mannerisms, and body language go inside *asterisks* — never inside the spoken quotes.\n' +
  '- Words said aloud go inside "double quotes" only.\n' +
  '- Example: *she smiled shyly, showing her dimples* "It\'s good to see you."\n' +
  '- You may use dialogue-only. Action-only (*gestures* with no quotes) is allowed only when the beat brief says so; otherwise prefer at least one spoken line. ' +
  'Do NOT prefix with your name. Do NOT wrap the whole reply in one outer quote.';
