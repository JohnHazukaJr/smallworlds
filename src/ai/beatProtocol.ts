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
const HAS_QUOTE = /[“”"]/;

/** "**@Ada**" and "__@Ada__" are tags too. Markdown around the marker is dropped. */
function tagLineBody(line: string): string | null {
  const trimmed = line.trim();
  const wrapped = /^([*_]{1,3})@(.+?)\1(.*)$/.exec(trimmed);
  if (wrapped) return `${wrapped[2]}${wrapped[3]}`.trim() || null;
  const match = TAG_LINE.exec(trimmed);
  return match ? match[1] : null;
}

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

/** First, last, or leading part of one person's name: "@Ada" for Ada Vell. Ambiguous means nobody. */
function looseSpeaker(head: string, speakers: SceneSpeaker[]): SceneSpeaker | undefined {
  const key = labelKey(head);
  if (key.length < 2) return undefined;
  const hits = speakers.filter((speaker) =>
    [speaker.name, ...(speaker.aliases ?? [])].some((label) => {
      const full = labelKey(label);
      if (!full) return false;
      if (full.split(' ').includes(key)) return true;
      return key.length >= 3 && full.startsWith(key) && full.charAt(key.length) === ' ';
    })
  );
  const unique = [...new Map(hits.map((speaker) => [speaker.id, speaker])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

/** Markdown left on a name: "@**Ada**" reads as "@Ada". */
function unwrapName(raw: string): string {
  const wrapped = /^([*_]{1,3})([^*_]+)\1(.*)$/.exec(raw);
  return wrapped ? `${wrapped[2]}${wrapped[3]}` : raw;
}

function readTag(
  body: string,
  labels: Array<{ label: string; speaker: SceneSpeaker }>,
  speakers: SceneSpeaker[],
  offstage: SceneSpeaker[] = []
): Tag {
  const raw = unwrapName(body.trim()).trim();
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
  const loose = looseSpeaker(head, speakers) ?? looseSpeaker(head, offstage);
  if (loose) return { narration: false, speaker: loose, written: head, inline: afterColon };
  // "@Ada *nods* ..." where Ada is only part of the name.
  const lead = /^([\p{L}\p{N}'’-]+)\s+(.*)$/u.exec(raw);
  const leadSpeaker = lead && colon < 0
    ? looseSpeaker(lead[1], speakers) ?? looseSpeaker(lead[1], offstage)
    : undefined;
  if (lead && leadSpeaker) {
    return { narration: false, speaker: leadSpeaker, written: lead[1], inline: lead[2].trim() };
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
  return raw.split(/\r?\n/).some((line) => tagLineBody(line) !== null);
}

function beatFor(speaker: SceneSpeaker, text: string): TurnBeat {
  return { role: 'character', text, speakerId: speaker.id, kind: speaker.kind, name: speaker.name };
}

interface DraftBeat extends TurnBeat {
  /** Kept as written: a tag for someone not here, often the player. */
  stranger?: boolean;
}

/**
 * Narration that still holds dialogue: credit each quote the splitter can place.
 * Paragraph by paragraph, so line starts like `Ada: "..."` still read as a speaker.
 */
function creditNarration(lines: string[], speakers: SceneSpeaker[]): DraftBeat[] {
  const out: DraftBeat[] = [];
  const pushNarration = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.role === 'narrator') last.text = `${last.text}\n\n${text}`;
    else out.push({ role: 'narrator', text });
  };
  for (const para of lines.join('\n').split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    if (speakers.length === 0 || (!HAS_QUOTE.test(para) && !para.includes(':'))) {
      pushNarration(cleanNarration([para]));
      continue;
    }
    for (const piece of splitSceneReply(para, speakers)) {
      const text = piece.text.trim();
      if (!text) continue;
      const speaker = piece.role === 'character' ? speakers.find((s) => s.id === piece.speakerId) : undefined;
      if (speaker) out.push(beatFor(speaker, text));
      else pushNarration(cleanNarration([text]));
    }
  }
  return out;
}

/** Quoted words left in narration, credited to the person who was asked to answer. */
function creditToAnswerer(text: string, answerer: SceneSpeaker): DraftBeat[] {
  const out: DraftBeat[] = [];
  let cursor = 0;
  const narrate = (raw: string) => {
    let t = raw.replace(/[ \t]+/g, ' ').trim();
    if (out[out.length - 1]?.role === 'character') t = t.replace(/^[,.;—–-]+\s*/, '').trim();
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.role === 'narrator') last.text = `${last.text} ${t}`;
    else out.push({ role: 'narrator', text: t });
  };
  for (const match of text.matchAll(/[“"][^“”"]+[”"]/g)) {
    const start = match.index ?? 0;
    narrate(text.slice(cursor, start));
    out.push(beatFor(answerer, match[0].trim()));
    cursor = start + match[0].length;
  }
  narrate(text.slice(cursor));
  return out;
}

/**
 * Last pass so a spoken line never ends up as narration: when nobody got a line
 * but someone was asked to answer, the quotes go to them. Neighbouring narration
 * reads as one block.
 */
function settleBeats(beats: DraftBeat[], answerer?: SceneSpeaker): TurnBeat[] {
  let draft = beats;
  if (answerer && !draft.some((beat) => beat.role === 'character')) {
    draft = draft.flatMap((beat) =>
      beat.role === 'narrator' && !beat.stranger && HAS_QUOTE.test(beat.text)
        ? creditToAnswerer(beat.text, answerer)
        : [beat]
    );
  }
  const out: TurnBeat[] = [];
  for (const { stranger, ...beat } of draft) {
    const last = out[out.length - 1];
    if (!stranger && beat.role === 'narrator' && last?.role === 'narrator' && !last.name) {
      last.text = `${last.text}\n\n${beat.text}`;
    } else {
      out.push({ ...beat });
    }
  }
  return out;
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
  opts: {
    partial?: boolean;
    carry?: TurnBeat;
    /**
     * The person asked to answer. Their spoken line must come out as theirs, so
     * untagged prose is parsed too and stray quotes fall back to them.
     */
    answerer?: SceneSpeaker;
    /** Named cast who are not in the room. A tag that names one of them still credits them. */
    offstage?: SceneSpeaker[];
  } = {}
): ParsedBeats | null {
  const source = raw.replace(/\r\n/g, '\n');
  if (!hasBeatTags(source) && !opts.carry && !opts.answerer) return null;
  const offstage = (opts.offstage ?? []).filter((o) => !speakers.some((s) => s.id === o.id));
  const labels = speakerLabels([...speakers, ...offstage]);
  const lines = source.split('\n');
  if (opts.partial && lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last.startsWith('@')) lines.pop();
  }

  const beats: DraftBeat[] = [];
  let current: { tag: Tag | null; lines: string[] } = { tag: null, lines: [] };
  const carry = opts.carry;

  const flush = () => {
    const { tag, lines: body } = current;
    if (!tag) {
      if (carry && beats.length === 0 && carry.role === 'character' && carry.speakerId) {
        const text = cleanSpoken(body);
        if (text) beats.push({ ...carry, text });
      } else {
        beats.push(...creditNarration(body, speakers));
      }
      return;
    }
    if (tag.narration) {
      beats.push(...creditNarration(body, speakers));
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
    beats.push({ role: 'narrator', text: who ? `${who}: ${text}` : text, stranger: true });
  };

  for (const line of lines) {
    const tagBody = tagLineBody(line);
    if (tagBody !== null) {
      flush();
      const tag = readTag(tagBody, labels, speakers, offstage);
      current = { tag, lines: tag.inline ? [tag.inline] : [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  const settled = settleBeats(beats, opts.answerer);
  return { beats: settled, prose: beatsToProse(settled) };
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
    // Older turns could file a spoken line inside narration. Credit it now.
    return beats.flatMap((beat): ScenePiece[] => {
      if (beat.role === 'narrator' && speakers.length > 0 && HAS_QUOTE.test(beat.text)) {
        return splitSceneReply(beat.text, speakers);
      }
      return [{
        role: beat.role,
        text: beat.text,
        ...(beat.speakerId ? { speakerId: beat.speakerId } : {}),
        ...(beat.kind ? { kind: beat.kind } : {})
      }];
    });
  }
  return splitSceneReply(turn.text, speakers);
}

/** Standing format rules for the scene writer. */
export const BEAT_FORMAT_RULES = [
  'Format: start every block with a tag on its own line, then the block\'s text on the lines below.',
  '@narration opens narration. Narration has no quoted dialogue.',
  '@Name opens that person\'s beat, using their tag from Here: an optional *action* then their "dialogue". Every spoken line goes in its speaker\'s beat, never in narration. The gesture belongs in that beat. Do not narrate it again.',
  'Open a new tag whenever the voice changes. Never tag the player.',
  'Example:\n@narration\nRain needles the window.\n@Ada\n*taps the ledger* "Read it again."'
].join('\n');
