/**
 * Split one scene reply into narrator prose and lines that belong to
 * someone who is here. A speech tag, a unique role, or a screenplay label
 * credits the quote. An unnamed quote belongs to the one allowed speaker.
 * "Someone muttered" stays narration even then.
 */

import { distinctiveTokens, isCommonLabel, tokensLooselyMatch } from './roomDynamics';

export interface SceneSpeaker {
  id: string;
  name: string;
  aliases?: string[];
  /** Role line. A distinctive word counts only when one person here owns it. */
  role?: string;
  kind: 'cast' | 'guest';
}

export interface ScenePiece {
  role: 'narrator' | 'character';
  text: string;
  speakerId?: string;
  kind?: 'cast' | 'guest';
}

export interface SplitSceneOptions {
  /** When this reply allows exactly one speaker, an unnamed quote is theirs. */
  fallbackSpeakerId?: string;
}

const QUOTE_RE = /[“"]([^“”"]+)[”"]/g;

/** Dialogue tags. `told` does not invert: the name after it was spoken to, not the speaker. */
const SPEECH_VERBS = new Set([
  'said', 'says', 'say', 'asked', 'asks', 'ask', 'whispered', 'whispers', 'whisper',
  'shouted', 'shouts', 'shout', 'muttered', 'mutters', 'mutter', 'replied', 'replies', 'reply',
  'answered', 'answers', 'answer', 'snapped', 'snaps', 'snap', 'murmured', 'murmurs', 'murmur',
  'told', 'tells', 'tell', 'cried', 'cries', 'cry', 'yelled', 'yells', 'yell',
  'hissed', 'hisses', 'hiss', 'added', 'continued', 'continues', 'continue',
  'offered', 'offers', 'offer', 'demanded', 'demands', 'demand', 'insisted', 'insists', 'insist',
  'sighed', 'sighs', 'sigh', 'warned', 'warns', 'warn', 'repeated', 'repeats', 'repeat',
  'agreed', 'agrees', 'agree', 'admitted', 'admits', 'admit', 'announced', 'announces', 'announce',
  'explained', 'explains', 'explain', 'promised', 'promises', 'promise', 'growled', 'growls', 'growl',
  'rasped', 'rasps', 'rasp', 'drawled', 'drawls', 'drawl', 'stammered', 'stammers', 'stammer',
  'screamed', 'screams', 'scream', 'pleaded', 'pleads', 'plead', 'begged', 'begs', 'beg',
  'declared', 'declares', 'declare', 'remarked', 'remarks', 'remark', 'suggested', 'suggests', 'suggest',
  'countered', 'counters', 'counter', 'interrupted', 'interrupts', 'interrupt',
  'echoed', 'echoes', 'echo', 'blurted', 'blurts', 'blurt', 'scoffed', 'scoffs', 'scoff',
  'snorted', 'snorts', 'snort', 'chuckled', 'chuckles', 'chuckle', 'breathed', 'breathes', 'breathe',
  'laughed', 'laughs', 'laugh'
]);

const NOT_INVERTED = new Set(['told', 'tells', 'tell']);

const PRONOUNS = new Set(['she', 'he', 'they']);

const INDEFINITE = new Set([
  'someone', 'somebody', 'voice', 'voices', 'stranger', 'man', 'woman', 'figure',
  'crowd', 'whisper', 'whispers', 'nobody', 'noone'
]);

const SKIP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'then', 'just', 'only', 'still', 'back',
  'again', 'out', 'aloud', 'softly', 'quietly', 'sharply', 'flatly', 'slowly',
  'dryly', 'coldly', 'warmly', 'gently', 'firmly', 'simply', 'finally', 'suddenly',
  'barely', 'merely', 'really', 'actually', 'almost', 'even', 'now', 'here', 'there',
  'up', 'down', 'over', 'away', 'low', 'nothing', 'something', 'anything', 'so',
  'too', 'very', 'as', 'at', 'to', 'of', 'in', 'on', 'with', 'from', 'for', 'that',
  'this', 'it', 'him', 'her', 'them', 'his', 'their', 'me', 'you', 'your', 'my',
  'our', 'not', 'no', 'yes', 'well', 'oh', 'under', 'its', 'into', 'onto', 'about',
  'while', 'when', 'than', 'across', 'through', 'without', 'off', 'by', 'quite',
  'rather', 'already'
]);

interface LabelEntry {
  text: string;
  role: boolean;
  speaker: SceneSpeaker;
}

interface Tag {
  kind: 'speaker' | 'pronoun' | 'indefinite' | 'unknown' | 'none';
  speaker?: SceneSpeaker;
  screenplay?: boolean;
  /** The tag sits in the same clause as the quote, not the previous sentence. */
  glued?: boolean;
}

interface Hit {
  start: number;
  end: number;
  text: string;
  speaker?: SceneSpeaker;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueRoleTokens(speaker: SceneSpeaker, all: SceneSpeaker[]): string[] {
  const mine = distinctiveTokens(speaker.role ?? '');
  return mine.filter((tok) => {
    const owners = all.filter((other) =>
      distinctiveTokens(other.role ?? '').some((t) => tokensLooselyMatch(t, tok))
    );
    return owners.length === 1;
  });
}

function labelEntries(speakers: SceneSpeaker[]): LabelEntry[] {
  const entries: LabelEntry[] = [];
  for (const speaker of speakers) {
    for (const label of [speaker.name, ...(speaker.aliases ?? [])]) {
      const text = label.trim();
      if (text.length >= 2) entries.push({ text, role: false, speaker });
    }
    for (const tok of uniqueRoleTokens(speaker, speakers)) {
      entries.push({ text: tok, role: true, speaker });
    }
  }
  return entries;
}

function tokensOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}'’]+/gu) ?? [];
}

function uniqueSpeakers(entries: LabelEntry[]): SceneSpeaker[] {
  const seen = new Map<string, SceneSpeaker>();
  for (const entry of entries) seen.set(entry.speaker.id, entry.speaker);
  return [...seen.values()];
}

function classifyWord(word: string, entries: LabelEntry[]): Tag {
  const lower = word.toLowerCase();
  if (SKIP.has(lower)) return { kind: 'none' };
  if (PRONOUNS.has(lower)) return { kind: 'pronoun' };
  if (INDEFINITE.has(lower)) return { kind: 'indefinite' };
  if (/^\p{Lu}/u.test(word)) {
    const names = entries.filter((entry) => !entry.role && entry.text.toLowerCase() === lower);
    const named = uniqueSpeakers(names);
    if (named.length === 1) return { kind: 'speaker', speaker: named[0] };
    if (named.length > 1) return { kind: 'unknown' };
  }
  const roles = entries.filter((entry) => entry.role && entry.text.toLowerCase() === lower);
  const roleOwners = uniqueSpeakers(roles);
  if (roleOwners.length === 1) return { kind: 'speaker', speaker: roleOwners[0] };
  if (roleOwners.length > 1) return { kind: 'unknown' };
  if (/^\p{Lu}/u.test(word) && word.length >= 2) return { kind: 'unknown' };
  return { kind: 'none' };
}

function exactTag(phrase: string, speakers: SceneSpeaker[]): Tag | undefined {
  const key = phrase.trim().toLowerCase();
  if (!key) return undefined;
  const hits = speakers.filter((speaker) =>
    [speaker.name, ...(speaker.aliases ?? [])].some((label) => label.trim().toLowerCase() === key)
  );
  if (hits.length === 1) return { kind: 'speaker', speaker: hits[0] };
  if (hits.length > 1) return { kind: 'unknown' };
  return undefined;
}

function tagForPhrase(phrase: string, speakers: SceneSpeaker[], entries: LabelEntry[], screenplay: boolean): Tag {
  const exact = exactTag(phrase, speakers);
  if (exact?.kind === 'speaker' || exact?.kind === 'unknown') {
    return screenplay ? { ...exact, screenplay: exact.kind === 'speaker' } : exact;
  }
  const meaningful = tokensOf(phrase).filter((token) => !SKIP.has(token.toLowerCase()));
  if (meaningful.length === 0) return { kind: 'none' };
  if (meaningful.every((token) => INDEFINITE.has(token.toLowerCase()))) return { kind: 'indefinite' };
  if (meaningful.length === 1 && PRONOUNS.has(meaningful[0].toLowerCase())) {
    return { kind: 'pronoun', screenplay };
  }
  let found: SceneSpeaker | undefined;
  for (const token of meaningful) {
    const tag = classifyWord(token, entries);
    if (tag.kind === 'speaker' && tag.speaker) {
      if (found && found.id !== tag.speaker.id) return { kind: 'unknown' };
      found = tag.speaker;
    } else if (tag.kind === 'unknown' || tag.kind === 'indefinite' || tag.kind === 'pronoun') {
      return tag.kind === 'pronoun' ? { kind: 'pronoun', screenplay } : { kind: tag.kind };
    }
  }
  if (found) return { kind: 'speaker', speaker: found, screenplay };
  if (meaningful.some((token) => /^\p{Lu}/u.test(token))) return { kind: 'unknown' };
  return { kind: 'none' };
}

function pairTag(tokens: string[], index: number, dir: -1 | 1, speakers: SceneSpeaker[]): Tag | undefined {
  const other = index + dir;
  if (other < 0 || other >= tokens.length) return undefined;
  const phrase = dir < 0 ? `${tokens[other]} ${tokens[index]}` : `${tokens[index]} ${tokens[other]}`;
  return exactTag(phrase, speakers);
}

function nearestTag(
  tokens: string[],
  start: number,
  dir: -1 | 1,
  limit: number,
  speakers: SceneSpeaker[],
  entries: LabelEntry[]
): Tag {
  let seen = 0;
  for (let i = start; seen < limit && i >= 0 && i < tokens.length; i += dir, seen++) {
    const pair = pairTag(tokens, i, dir, speakers);
    if (pair?.kind === 'speaker' || pair?.kind === 'unknown') return pair;
    const tag = classifyWord(tokens[i], entries);
    if (tag.kind !== 'none') return tag;
  }
  return { kind: 'none' };
}

function readTag(clause: string, speakers: SceneSpeaker[], entries: LabelEntry[], edge: 'before' | 'after'): Tag {
  const trimmed = clause.trim();
  if (!trimmed) return { kind: 'none' };
  const screen = edge === 'before' ? trimmed.match(/^(.+?)\s*:\s*$/) : null;
  if (screen?.[1]) return tagForPhrase(screen[1], speakers, entries, true);
  const tokens = tokensOf(trimmed);
  const verbAt: number[] = [];
  tokens.forEach((token, index) => {
    if (SPEECH_VERBS.has(token.toLowerCase())) verbAt.push(index);
  });
  if (verbAt.length === 0) return { kind: 'none' };
  const at = edge === 'before' ? verbAt[verbAt.length - 1] : verbAt[0];
  const before = nearestTag(tokens, at - 1, -1, 5, speakers, entries);
  if (before.kind !== 'none') return before;
  const verb = tokens[at].toLowerCase();
  if (NOT_INVERTED.has(verb)) return { kind: 'none' };
  return nearestTag(tokens, at + 1, 1, 4, speakers, entries);
}

function currentClause(trimmed: string): string {
  if (!trimmed) return '';
  if (/[.!?…]+["'”’]?$/.test(trimmed)) return '';
  const cut = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?'),
    trimmed.lastIndexOf('\n'),
    trimmed.lastIndexOf('…')
  );
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).trim();
}

function tagBefore(before: string, speakers: SceneSpeaker[], entries: LabelEntry[]): Tag {
  const trimmed = before.replace(/\s+$/g, '');
  const current = currentClause(trimmed);
  if (current) {
    const currentTag = readTag(current, speakers, entries, 'before');
    if (currentTag.kind !== 'none') return { ...currentTag, glued: true };
  }
  if (!/[.!?…]+["'”’]?$/.test(trimmed)) return { kind: 'none' };
  const prev = currentClause(trimmed.replace(/[.!?…]+["'”’]?$/, '').trimEnd());
  if (!prev) return { kind: 'none' };
  return readTag(prev, speakers, entries, 'before');
}

function tagAfter(after: string, speakers: SceneSpeaker[], entries: LabelEntry[]): Tag {
  let trimmed = after.replace(/^\s+/, '').replace(/^[,.—–-]+\s*/, '');
  if (!trimmed || /^(?:and|but|then|while|as|before|after)\b/i.test(trimmed)) return { kind: 'none' };
  const cut = trimmed.search(/[.!?\n…]/);
  if (cut >= 0) trimmed = trimmed.slice(0, cut);
  return readTag(trimmed.trim(), speakers, entries, 'after');
}

function mergeTags(before: Tag, after: Tag): Tag {
  if (before.glued) return before;
  if (after.kind === 'speaker') return after;
  if (before.kind === 'indefinite' || after.kind === 'indefinite') return { kind: 'indefinite' };
  if (before.kind === 'unknown' || after.kind === 'unknown') {
    if (before.kind === 'speaker') return before;
    return { kind: 'unknown' };
  }
  if (before.kind === 'speaker') return before;
  if (before.kind === 'pronoun') return before;
  if (after.kind === 'pronoun') return after;
  return { kind: 'none' };
}

function resolveTag(tag: Tag, lastSubject: SceneSpeaker | undefined, fallback: SceneSpeaker | undefined): SceneSpeaker | undefined {
  if (tag.kind === 'speaker') return tag.speaker;
  if (tag.kind === 'pronoun') return lastSubject ?? fallback;
  if (tag.kind === 'indefinite' || tag.kind === 'unknown') return undefined;
  return fallback;
}

function sentencesOf(text: string): string[] {
  return text.split(/[.!?\n…]+/).map((part) => part.trim()).filter(Boolean);
}

function earliestSpeaker(sentence: string, entries: LabelEntry[]): SceneSpeaker | undefined {
  let best: { at: number; len: number; speaker: SceneSpeaker } | undefined;
  for (const entry of entries) {
    if (!entry.role && isCommonLabel(entry.text)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(entry.text)})(?=[^\\p{L}\\p{N}]|$)`, 'giu');
    for (const match of sentence.matchAll(re)) {
      const word = match[2] ?? '';
      if (!entry.role && !/^\p{Lu}/u.test(word)) continue;
      const at = (match.index ?? 0) + (match[1]?.length ?? 0);
      if (!best || at < best.at || (at === best.at && word.length > best.len)) {
        best = { at, len: word.length, speaker: entry.speaker };
      }
    }
  }
  if (!best) return undefined;
  const span = sentence.slice(best.at, best.at + best.len).toLowerCase();
  const rivals = entries.some((entry) =>
    entry.speaker.id !== best!.speaker.id && entry.text.toLowerCase() === span
  );
  return rivals ? undefined : best.speaker;
}

function noteSubjects(narration: string, entries: LabelEntry[], last: SceneSpeaker | undefined): SceneSpeaker | undefined {
  let current = last;
  for (const sentence of sentencesOf(narration)) {
    const found = earliestSpeaker(sentence, entries);
    if (found) current = found;
  }
  return current;
}

function screenplayLead(before: string, speaker: SceneSpeaker, speakers: SceneSpeaker[], entries: LabelEntry[]): number {
  const match = before.match(/(?:^|\n)[ \t]*([^\n:]{1,48}):[ \t]*$/);
  if (!match || match.index === undefined) return 0;
  const tag = tagForPhrase((match[1] ?? '').trim(), speakers, entries, true);
  if (tag.kind !== 'speaker' || tag.speaker?.id !== speaker.id || !tag.screenplay) return 0;
  const lead = /^(?:\n)?/.exec(match[0])?.[0].length ?? 0;
  return before.length - (match.index + lead);
}

function quoteHits(
  source: string,
  speakers: SceneSpeaker[],
  entries: LabelEntry[],
  fallback: SceneSpeaker | undefined
): Hit[] {
  const matches = [...source.matchAll(QUOTE_RE)];
  const hits: Hit[] = [];
  let lastSubject: SceneSpeaker | undefined;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const quote = match[0];
    const qStart = match.index ?? 0;
    const qEnd = qStart + quote.length;
    const prevEnd = i === 0 ? 0 : (matches[i - 1].index ?? 0) + matches[i - 1][0].length;
    const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
    const before = source.slice(prevEnd, qStart);
    const after = source.slice(qEnd, nextStart);
    lastSubject = noteSubjects(before, entries, lastSubject);
    const beforeTag = tagBefore(before, speakers, entries);
    const tag = mergeTags(beforeTag, tagAfter(after, speakers, entries));
    const speaker = resolveTag(tag, lastSubject, fallback);
    if (speaker) lastSubject = speaker;
    let start = qStart;
    if (speaker && beforeTag.screenplay && beforeTag.speaker?.id === speaker.id) {
      start = qStart - screenplayLead(before, speaker, speakers, entries);
    }
    hits.push({ start, end: qEnd, text: quote.trim(), speaker });
  }
  return hits;
}

function addScreenplayHits(
  source: string,
  speakers: SceneSpeaker[],
  entries: LabelEntry[],
  hits: Hit[]
): void {
  const re = /(?:^|\n)[ \t]*([^\n:]{1,48}):[ \t]*([^\n]*)/g;
  for (const match of source.matchAll(re)) {
    const label = (match[1] ?? '').trim();
    const body = (match[2] ?? '').trim();
    if (!label || !body) continue;
    const tag = tagForPhrase(label, speakers, entries, true);
    if (tag.kind !== 'speaker' || !tag.speaker) continue;
    const full = match[0];
    const matchStart = match.index ?? 0;
    const lead = /^(?:\n)?[ \t]*/.exec(full)?.[0].length ?? 0;
    const start = matchStart + lead;
    const end = matchStart + full.length;
    if (hits.some((hit) => hit.speaker && start < hit.end && end > hit.start)) continue;
    for (let i = hits.length - 1; i >= 0; i--) {
      const hit = hits[i];
      if (!hit.speaker && start < hit.end && end > hit.start) hits.splice(i, 1);
    }
    const spoken = /[“"”]/.test(body) ? body : `"${body}"`;
    hits.push({ start, end, text: spoken, speaker: tag.speaker });
  }
}

function pushNarration(pieces: ScenePiece[], raw: string) {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (pieces[pieces.length - 1]?.role === 'character') {
    text = text.replace(/^[,.—–-]+\s*/, '').trim();
  }
  if (!text) return;
  const last = pieces[pieces.length - 1];
  if (last?.role === 'narrator') last.text = `${last.text} ${text}`.trim();
  else pieces.push({ role: 'narrator', text });
}

function piecesFrom(source: string, hits: Hit[]): ScenePiece[] {
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces: ScenePiece[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    pushNarration(pieces, source.slice(cursor, hit.start));
    if (hit.speaker && hit.text.trim()) {
      pieces.push({
        role: 'character',
        text: hit.text,
        speakerId: hit.speaker.id,
        kind: hit.speaker.kind
      });
    } else {
      pushNarration(pieces, source.slice(hit.start, hit.end));
    }
    cursor = Math.max(cursor, hit.end);
  }
  pushNarration(pieces, source.slice(cursor));
  return pieces;
}

/** Narration stays narration. A credited quote becomes that person's line. */
export function splitSceneReply(
  text: string,
  speakers: SceneSpeaker[],
  options?: SplitSceneOptions
): ScenePiece[] {
  const source = text.replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  const entries = labelEntries(speakers);
  const fallback = speakers.find((speaker) => speaker.id === options?.fallbackSpeakerId);
  const hits = quoteHits(source, speakers, entries, fallback);
  addScreenplayHits(source, speakers, entries, hits);
  if (hits.length === 0) return [{ role: 'narrator', text: source }];
  return piecesFrom(source, hits);
}
