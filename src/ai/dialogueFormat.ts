/**
 * Canonical character/guest speak format:
 *   *she smiled, showing her dimples* "It's good to see you."
 * Actions in *asterisks* outside quotes; spoken words in "double quotes".
 * Inside quotes, *stress* or **stress** = vocal emphasis (rendered bold).
 */

export type SpeakSegmentKind = 'action' | 'speech' | 'plain' | 'break';

export interface SpeakSegment {
  kind: SpeakSegmentKind;
  text: string;
}

export interface InlineRun {
  text: string;
  strong?: boolean;
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
 * Display-only cleanup for mid-stream speak text.
 * Drops dangling open `*` / `"` so the preview does not flash raw delimiters,
 * then normalizes when pairs are balanced.
 */
export function previewSpeakText(raw: string): string {
  let text = normalizeQuotes(raw.trim());
  if (!text) return '';

  if (((text.match(/"/g) || []).length) % 2 === 1) {
    const i = text.lastIndexOf('"');
    if (i >= 0) text = text.slice(0, i) + text.slice(i + 1);
  }
  if (((text.match(/\*/g) || []).length) % 2 === 1) {
    const i = text.lastIndexOf('*');
    if (i >= 0) text = text.slice(0, i) + text.slice(i + 1);
  }

  text = text.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';
  if (!text.includes('*') && !text.includes('"')) return text;
  return normalizeSpeakText(text);
}

/**
 * Split plain gap text into plain runs and paragraph breaks.
 * Leading/trailing whitespace around breaks is discarded; single newlines become spaces.
 */
function pushPlainWithBreaks(segments: SpeakSegment[], gap: string): void {
  if (!gap) return;
  // Normalize 3+ newlines to paragraph breaks first.
  const normalized = gap.replace(/\n{3,}/g, '\n\n');
  const parts = normalized.split(/\n\n/);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) segments.push({ kind: 'break', text: '' });
    // Single newlines → space so soft wraps don't become paragraphs.
    const plain = parts[i].replace(/\n/g, ' ').replace(/[^\S\n]+/g, ' ').trim();
    if (plain) segments.push({ kind: 'plain', text: plain });
  }
}

/**
 * Split a speak turn into action / speech / plain / break segments for rendering.
 * Asterisks and quote delimiters are not included in segment text.
 * Blank lines between beats become `break` segments.
 */
export function parseSpeakSegments(raw: string): SpeakSegment[] {
  const text = normalizeQuotes(raw.trim()).replace(/\n{3,}/g, '\n\n');
  if (!text) return [];

  const segments: SpeakSegment[] = [];
  // Speech first in the alternation so "I *said* leave." stays one speech segment
  // (in-quote *stress* is not treated as action).
  const re = /"([^"]+)"|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      pushPlainWithBreaks(segments, text.slice(last, m.index));
    }
    if (m[1] !== undefined) {
      const speech = m[1].trim();
      if (speech) segments.push({ kind: 'speech', text: speech });
    } else if (m[2] !== undefined) {
      const action = m[2].trim();
      if (action) segments.push({ kind: 'action', text: action });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    pushPlainWithBreaks(segments, text.slice(last));
  }

  // Legacy: entire turn was plain dialogue with optional outer quotes.
  if (segments.length === 0) {
    const stripped = text.replace(/^"|"$/g, '').trim();
    if (stripped) segments.push({ kind: 'speech', text: stripped });
  }

  // Drop leading/trailing breaks; collapse consecutive breaks.
  const cleaned: SpeakSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === 'break') {
      if (cleaned.length === 0) continue;
      if (cleaned[cleaned.length - 1].kind === 'break') continue;
      cleaned.push(seg);
      continue;
    }
    cleaned.push(seg);
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].kind === 'break') cleaned.pop();

  return cleaned;
}

/**
 * Light inline emphasis: **strong** then *strong* (vocal stress).
 * No nesting; unmatched markers stay literal.
 */
export function parseInlineEmphasis(text: string): InlineRun[] {
  if (!text) return [];
  const runs: InlineRun[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      runs.push({ text: text.slice(last, m.index) });
    }
    const strong = (m[1] ?? m[2] ?? '').trim();
    if (strong) runs.push({ text: strong, strong: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length > 0 ? runs : [{ text }];
}

/** Group speak segments into paragraphs separated by break markers. */
export function groupSpeakParagraphs(segments: SpeakSegment[]): SpeakSegment[][] {
  const paras: SpeakSegment[][] = [];
  let cur: SpeakSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === 'break') {
      if (cur.length > 0) paras.push(cur);
      cur = [];
      continue;
    }
    cur.push(seg);
  }
  if (cur.length > 0) paras.push(cur);
  return paras.length > 0 ? paras : [[]];
}

/** Instructions injected into character / guest speak user messages. */
export const SPEAK_FORMAT_RULES =
  'Output format (required):\n' +
  '- Physical looks, gestures, mannerisms, and body language go inside *asterisks* outside the spoken quotes.\n' +
  '- Words said aloud go inside "double quotes" only.\n' +
  '- Vocal stress on a word: wrap it in *asterisks* or **double asterisks** inside the quotes (shown bold). Example: "I *said* leave."\n' +
  '- Prefer one tight beat: a short *action* plus one or two spoken lines. Do not monologue or lecture.\n' +
  '- Use a blank line only when tone truly shifts mid-reply; most replies need none.\n' +
  '- Example:\n' +
  '  *she smiled shyly, showing her dimples* "It\'s good to see you."\n' +
  '- You may use dialogue-only. Action-only (*gestures* with no quotes) is allowed only when the beat brief says so; otherwise prefer at least one spoken line. ' +
  'Do NOT prefix with your name. Do NOT wrap the whole reply in one outer quote.';
