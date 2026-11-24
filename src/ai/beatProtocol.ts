/**
 * Tagged scene beats. The scene writer opens every block with a tag line:
 *
 *   @narration
 *   Rain thickens against the glass.
 *   @Ada
 *   *taps the ledger* "Read it again."
 *
 * A tag names the speaker outright, so nothing is guessed from prose. The
 * parsed beats are stored on the turn; the turn's text stays the familiar
 * `Name: *action* "dialogue"` prose so history, summaries, and older code keep
 * working. When the model ignores the tags, callers fall back to plain prose.
 */

import type { TurnBeat } from '../types';
import { splitSceneReply, type ScenePiece, type SceneSpeaker } from './sceneReply';

const NARRATION_TAGS = new Set(['narration', 'narrator', 'narrate', 'scene']);
const TAG_LINE = /^@(\S.*)$/;

export interface ParsedBeats {
  beats: TurnBeat[];
  /** The beats as stored prose. */
  prose: string;
}

function labelKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function speakerLabels(speakers: SceneSpeaker[]): Array<{ label: string; speaker: SceneSpeaker }> {
  const out: Array<{ label: string; speaker: SceneSpeaker }> = [];
  for (const speaker of speakers) {
    for (const label of [speaker.name, ...(speaker.aliases ?? [])]) {
      const key = labelKey(label);
      if (key) out.push({ label: key, speaker });
    }
  }
  // Longest first, so "Ada Vell" wins over "Ada".
  return out.sort((a, b) => b.label.length - a.label.length);
}

interface Tag {
  narration: boolean;
  speaker?: SceneSpeaker;
  /** The name as written, for a tag that names nobody here. */
  written: string;
  /** Content the model put on the tag line itself. */
  inline: string;
}

function readTag(body: string, labels: Array<{ label: string; speaker: SceneSpeaker }>): Tag {
  const raw = body.trim();
  const colon = raw.indexOf(':');
  const head = (colon >= 0 ? raw.slice(0, colon) : raw).replace(/[\]\[]/g, '').trim();
  const afterColon = colon >= 0 ? raw.slice(colon + 1).trim() : '';
  const headKey = labelKey(head);
  if (NARRATION_TAGS.has(headKey)) return { narration: true, written: head, inline: afterColon };
  const exact = labels.find((entry) => entry.label === headKey);
  if (exact) return { narration: false, speaker: exact.speaker, written: head, inline: afterColon };
  // "@Ada *nods*" with no colon: a known name followed by the line itself.
  const rawKey = raw.toLowerCase();
  for (const entry of labels) {
    if (!rawKey.startsWith(entry.label)) continue;
    const next = raw.charAt(entry.label.length);
    if (next && /[\p{L}\p{N}'’-]/u.test(next)) continue;
    const rest = raw.slice(entry.label.length).replace(/^[\s:,—–-]+/, '').trim();
    return { narration: false, speaker: entry.speaker, written: raw.slice(0, entry.label.length), inline: rest };
  }
  const firstWord = headKey.split(' ')[0] ?? '';
  if (NARRATION_TAGS.has(firstWord)) {
    return { narration: true, written: head, inline: raw.slice(firstWord.length).replace(/^[\s:]+/, '').trim() };
  }
  return { narration: false, written: head, inline: afterColon };
}

function cleanNarration(lines: string[]): string {
  return lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function cleanSpoken(lines: string[]): string {
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/** True when the reply uses the tag protocol at all. */
export function hasBeatTags(raw: string): boolean {
  return raw.split(/\r?\n/).some((line) => TAG_LINE.test(line.trim()));
}

/**
 * Parse a tagged reply. Returns null when there are no tags, so the caller
 * keeps the raw prose. A partial stream is safe: an unfinished tag line at the
 * very end is held back until its newline arrives.
 *
 * `carry` is the beat a continuation picks up from; untagged text at the start
 * belongs to it.
 */
export function parseBeats(
  raw: string,
  speakers: SceneSpeaker[],
  opts: { partial?: boolean; carry?: TurnBeat } = {}
): ParsedBeats | null {
  const source = raw.replace(/\r\n/g, '\n');
  if (!hasBeatTags(source) && !opts.carry) return null;
  const labels = speakerLabels(speakers);
  const lines = source.split('\n');
  if (opts.partial && lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last.startsWith('@')) lines.pop();
  }

  const beats: TurnBeat[] = [];
  let current: { tag: Tag | null; lines: string[] } = { tag: null, lines: [] };
  const carry = opts.carry;

  const flush = () => {
    const { tag, lines: body } = current;
    if (!tag) {
      if (carry && beats.length === 0 && carry.role === 'character' && carry.speakerId) {
        const text = cleanSpoken(body);
        if (text) beats.push({ ...carry, text });
      } else {
        const text = cleanNarration(body);
        if (text) beats.push({ role: 'narrator', text });
      }
      return;
    }
    if (tag.narration) {
      const text = cleanNarration(body);
      if (text) beats.push({ role: 'narrator', text });
      return;
    }
    const text = cleanSpoken(body);
    if (!text) return;
    if (tag.speaker) {
      beats.push({
        role: 'character',
        text,
        speakerId: tag.speaker.id,
        kind: tag.speaker.kind,
        name: tag.speaker.name
      });
      return;
    }
    // Someone not in the room (often the player). Keep the words, credit nobody.
    const who = tag.written.trim();
    beats.push({ role: 'narrator', text: who ? `${who}: ${text}` : text });
  };

  for (const line of lines) {
    const match = TAG_LINE.exec(line.trim());
    if (match) {
      flush();
      const tag = readTag(match[1], labels);
      current = { tag, lines: tag.inline ? [tag.inline] : [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return { beats, prose: beatsToProse(beats) };
}

/** Stored prose for a list of beats. */
export function beatsToProse(beats: TurnBeat[]): string {
  return beats
    .map((beat) => {
      const text = beat.text.trim();
      if (!text) return '';
      if (beat.role === 'character' && beat.name?.trim()) return `${beat.name.trim()}: ${text}`;
      return text;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** The tagged form, for history sent back to the scene writer. */
export function beatsToTagged(beats: TurnBeat[]): string {
  return beats
    .map((beat) => {
      const text = beat.text.trim();
      if (!text) return '';
      if (beat.role === 'character' && beat.name?.trim()) return `@${beat.name.trim()}\n${text}`;
      return `@narration\n${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

/** Beats are trusted only while they still match the stored text (an edit breaks them). */
export function validBeats(turn: { text: string; beats?: TurnBeat[] }): TurnBeat[] | null {
  const beats = turn.beats;
  if (!beats || beats.length === 0) return null;
  return beatsToProse(beats) === turn.text.trim() ? beats : null;
}

/** Scene pieces for a stored reply: exact beats when present, the prose splitter otherwise. */
export function scenePiecesOf(
  turn: { text: string; beats?: TurnBeat[] },
  speakers: SceneSpeaker[]
): ScenePiece[] {
  const beats = validBeats(turn);
  if (beats) {
    return beats.map((beat) => ({
      role: beat.role,
      text: beat.text,
      ...(beat.speakerId ? { speakerId: beat.speakerId } : {}),
      ...(beat.kind ? { kind: beat.kind } : {})
    }));
  }
  return splitSceneReply(turn.text, speakers);
}

/** Standing format rules for the scene writer. */
export const BEAT_FORMAT_RULES = [
  'Format: start every block with a tag on its own line, then the block\'s text on the lines below.',
  '@narration opens narration. Narration has no quoted dialogue.',
  '@Name opens that person\'s beat, using a name exactly as listed under Here: an optional *action* then "dialogue". The gesture belongs in that beat. Do not narrate it again.',
  'Open a new tag whenever the voice changes. Never tag the player.',
  'Example:\n@narration\nRain needles the window.\n@Ada\n*taps the ledger* "Read it again."'
].join('\n');
