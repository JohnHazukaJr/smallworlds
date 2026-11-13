/**
 * Room social logic: who the player is talking to, who has been holding the floor,
 * and who has been standing there saying nothing.
 *
 * Pure functions over the transcript — no DB, no model calls. The director still
 * decides the plan; this only supplies signals and picks the fallback replier.
 */

import type { Character, CharacterImportance, EpisodeGuest, Turn, TurnLength } from '../types';
import { characterImportance, importanceSpeakScore } from './characterWeight';

export type SpeakerKind = 'cast' | 'guest';

export interface SpeakerCandidate {
  id: string;
  name: string;
  kind: SpeakerKind;
  /** Other ways this person is addressed. */
  aliases?: string[];
  /** Role line. A distinctive word is used only when one person owns it. */
  role?: string;
  /** Story weight. Missing reads as regular. */
  importance?: CharacterImportance;
}

/** How directly a line points at a person. */
export type AddressStrength = 'vocative' | 'directed' | 'mention';

export interface RankedSpeaker extends SpeakerCandidate {
  score: number;
  address: AddressStrength | null;
  /** Character turns since they last spoke; Infinity when they never have. */
  turnsSince: number;
}

/** Last voice, when nobody was named, outranks cast order. */
const LAST_VOICE_PULL = 24;

const RE_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Whole labels that are also ordinary words. A mention of "will" is not the
 * person Will. "Will," and "tell Will" still count.
 */
const COMMON_LABELS = new Set([
  'will', 'may', 'can', 'art', 'hope', 'mark', 'bill', 'pat', 'don', 'guy', 'rose', 'joy',
  'faith', 'grace', 'frank', 'amber', 'chase', 'summer', 'april', 'june', 'august', 'just',
  'like', 'well', 'come', 'look', 'tell', 'said', 'want', 'need', 'have', 'that', 'this',
  'with', 'from', 'your', 'what', 'when', 'then', 'than', 'them', 'they', 'were', 'been',
  'into', 'over', 'back', 'down', 'here', 'there', 'about', 'after', 'before', 'would',
  'could', 'should', 'shall', 'must', 'adult', 'person', 'people', 'their', 'which',
  'where', 'while', 'still', 'never', 'every'
]);

function escapeRe(text: string): string {
  return text.replace(RE_SPECIALS, '\\$&');
}

/** Verbs that mark the following name as the person being addressed, not discussed. */
const ADDRESS_VERBS =
  'ask|asks|asked|tell|tells|told|answer|answers|reply|replies|turn|turns|turned|' +
  'look|looks|looked|face|faces|faced|say|says|said|speak|speaks|spoke|' +
  'shout|shouts|whisper|whispers|nod|nods|glance|glances|greet|greets|call|calls';

/** Filler that may sit between an address verb and the person addressed. */
const ADDRESS_CONNECTORS =
  'to|at|toward|towards|over|up|down|across|back|again|straight|right|onto|on';

/**
 * Word-boundary match of a name in a line, graded by how directly it addresses them.
 * Substring matching is deliberately avoided — "Al" must not match "always".
 */
export function addressStrength(text: string, rawName: string): AddressStrength | null {
  const name = rawName.trim();
  const line = text.trim();
  if (name.length < 2 || !line) return null;
  const n = escapeRe(name);

  if (!new RegExp(`(^|[^\\p{L}\\p{N}])${n}([^\\p{L}\\p{N}]|$)`, 'iu').test(line)) {
    return null;
  }
  // "Ada, listen." / "Ada?" / "Ada!" — name followed by punctuation that turns it into address.
  let strength: AddressStrength = 'mention';
  if (new RegExp(`(^|["'*\\s])${n}\\s*[,!?:]`, 'iu').test(line)) strength = 'vocative';
  // "..., Ada?" — trailing vocative.
  else if (new RegExp(`,\\s*${n}\\s*["'*.!?]*$`, 'iu').test(line)) strength = 'vocative';
  // "Hey Ada" / "Hi registrar".
  else if (new RegExp(`\\b(?:hey|hi|hello)\\s+${n}\\b`, 'iu').test(line)) strength = 'vocative';
  // "ask Ada", "turn to Ada", "looks up at Ada" — only connectors may sit between verb and name,
  // so "tell Ada that Ben lied" leaves Ben a topic rather than an addressee.
  else if (new RegExp(`\\b(?:${ADDRESS_VERBS})\\b(?:\\s+(?:${ADDRESS_CONNECTORS}))*\\s+${n}\\b`, 'iu').test(line)) {
    strength = 'directed';
  } else if (new RegExp(`\\bto\\s+${n}\\b`, 'iu').test(line)) strength = 'directed';
  if (strength === 'mention' && COMMON_LABELS.has(name.toLowerCase())) return null;
  return strength;
}

/** Words long enough to tell people apart. Short and ordinary words are skipped. */
export function distinctiveTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 5 || COMMON_LABELS.has(raw) || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** "student" matches "students". "keeper" matches "innkeeper". */
export function tokensLooselyMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5) return false;
  if (long.startsWith(short)) {
    const extra = long.slice(short.length);
    return extra === 's' || extra === 'es';
  }
  return long.endsWith(short);
}

function uniqueRoleLabels(candidate: SpeakerCandidate, all: SpeakerCandidate[]): string[] {
  const mine = distinctiveTokens(candidate.role ?? '');
  return mine.filter((tok) => {
    const owners = all.filter((c) =>
      distinctiveTokens(c.role ?? '').some((t) => tokensLooselyMatch(t, tok))
    );
    return owners.length === 1;
  });
}

/**
 * Strongest hit across the name, aliases, and a role word only that person owns.
 */
export function candidateAddressStrength(
  text: string,
  candidate: SpeakerCandidate,
  all: SpeakerCandidate[]
): AddressStrength | null {
  const labels = [candidate.name, ...(candidate.aliases ?? []), ...uniqueRoleLabels(candidate, all)];
  const rank: Record<AddressStrength, number> = { vocative: 3, directed: 2, mention: 1 };
  let best: AddressStrength | null = null;
  for (const label of labels) {
    const strength = addressStrength(text, label);
    if (!strength) continue;
    if (!best || rank[strength] > rank[best]) best = strength;
  }
  return best;
}

/** Cast + active walk-ons as one addressable list (player excluded). */
export function speakerCandidates(
  inScene: Character[],
  guests: EpisodeGuest[]
): SpeakerCandidate[] {
  return [
    ...inScene.filter((c) => !c.isPlayer).map((c) => ({
      id: c.id,
      name: c.name.trim(),
      kind: 'cast' as const,
      aliases: (c.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      role: c.role,
      importance: characterImportance(c)
    })),
    ...guests.map((g) => ({ id: g.id, name: g.name.trim(), kind: 'guest' as const }))
  ].filter((c) => c.name.length > 0);
}

/**
 * Character turns since each candidate last spoke.
 * 0 = they were the most recent voice; Infinity = they have not spoken this episode.
 */
export function turnsSinceSpoke(
  turns: Turn[],
  candidates: SpeakerCandidate[]
): Map<string, number> {
  const lastSeen = new Map<string, number>();
  let spoken = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== 'character') continue;
    const id = t.guestId ?? t.characterId;
    if (id && !lastSeen.has(id)) lastSeen.set(id, spoken);
    spoken++;
  }
  const out = new Map<string, number>();
  for (const c of candidates) {
    out.set(c.id, lastSeen.get(c.id) ?? Number.POSITIVE_INFINITY);
  }
  return out;
}

/** The most recent NPC/walk-on voice, if any. */
export function lastSpeaker(
  turns: Turn[],
  candidates: SpeakerCandidate[]
): SpeakerCandidate | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== 'character') continue;
    const id = t.guestId ?? t.characterId;
    const hit = candidates.find((c) => c.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Who asked the question the player's latest line answers.
 * Later NPC lines in the same Write (Ben speaks after you answered Ada) do not
 * clear this — the asker still has to take the answer as heard.
 */
export function lastOpenQuestion(
  turns: Turn[],
  candidates: SpeakerCandidate[]
): SpeakerCandidate | null {
  let userIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return null;

  let i = userIdx - 1;
  while (i >= 0 && turns[i].role === 'narrator') i--;
  if (i < 0 || turns[i].role !== 'character') return null;
  if (!/\?/.test(turns[i].text)) return null;
  const id = turns[i].guestId ?? turns[i].characterId;
  if (!id) return null;
  return candidates.find((c) => c.id === id) ?? {
    id,
    name: 'Someone',
    kind: turns[i].guestId ? 'guest' : 'cast'
  };
}

/** Who the player's latest move points at, if anyone (includes bare mention). */
export function detectAddressee(
  playerText: string,
  candidates: SpeakerCandidate[]
): SpeakerCandidate | null {
  let best: { c: SpeakerCandidate; rank: number } | null = null;
  const rank: Record<AddressStrength, number> = { vocative: 3, directed: 2, mention: 1 };
  for (const c of candidates) {
    const strength = candidateAddressStrength(playerText, c, candidates);
    if (!strength) continue;
    const r = rank[strength];
    if (!best || r > best.rank) best = { c, rank: r };
  }
  return best?.c ?? null;
}

/**
 * Everyone the player is speaking straight to — vocative or directed only.
 * Bare mentions ("tell Ada that Ben lied") do not count; Ben stays a topic.
 */
export function detectHardAddressees(
  playerText: string,
  candidates: SpeakerCandidate[]
): SpeakerCandidate[] {
  const hits = candidates.flatMap((c) => {
    const strength = candidateAddressStrength(playerText, c, candidates);
    if (strength !== 'vocative' && strength !== 'directed') return [];
    return [{ c, rank: strength === 'vocative' ? 3 : 2 }];
  });
  hits.sort((a, b) => b.rank - a.rank);
  const vocatives = hits.filter((h) => h.rank === 3);
  // "Ada, tell Ben" names Ada. Ben is what she is told, not a second voice.
  if (vocatives.length > 0) return vocatives.map((h) => h.c);
  return hits.map((h) => h.c);
}

/**
 * Who the player is speaking straight to — the strongest vocative or directed hit.
 * Bare mentions ("tell Ada that Ben lied") do not count; Ben stays a topic.
 */
export function detectHardAddressee(
  playerText: string,
  candidates: SpeakerCandidate[]
): SpeakerCandidate | null {
  return detectHardAddressees(playerText, candidates)[0] ?? null;
}

/**
 * The open-question asker's prior line text, when the player just answered them.
 * Used for re-ask detection on speak briefs and spoken lines.
 */
export function priorOpenQuestionText(
  turns: Turn[],
  candidates: SpeakerCandidate[]
): { asker: SpeakerCandidate; text: string } | null {
  let userIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return null;
  let i = userIdx - 1;
  while (i >= 0 && turns[i].role === 'narrator') i--;
  if (i < 0 || turns[i].role !== 'character') return null;
  if (!/\?/.test(turns[i].text)) return null;
  const id = turns[i].guestId ?? turns[i].characterId;
  if (!id) return null;
  const asker = candidates.find((c) => c.id === id) ?? {
    id,
    name: 'Someone',
    kind: (turns[i].guestId ? 'guest' : 'cast') as SpeakerKind
  };
  return { asker, text: turns[i].text };
}

/**
 * Rank who should answer when the plan has no speak beat.
 * Being addressed dominates. A bare mention does not. After that, the person
 * who just spoke, then the person whose question is still open.
 */
export function rankReplySpeakers(opts: {
  candidates: SpeakerCandidate[];
  playerText: string;
  turns?: Turn[];
}): RankedSpeaker[] {
  const turns = opts.turns ?? [];
  const since = turnsSinceSpoke(turns, opts.candidates);
  const openAsker = lastOpenQuestion(turns, opts.candidates);
  const hard = detectHardAddressee(opts.playerText, opts.candidates);

  return opts.candidates
    .map((c, i) => {
      const address = candidateAddressStrength(opts.playerText, c, opts.candidates);
      const turnsSince = since.get(c.id) ?? Number.POSITIVE_INFINITY;
      let score = 0;
      if (address === 'vocative') score += 100;
      else if (address === 'directed') score += 70;

      // Player answered this person's question and did not hard-address someone else.
      if (openAsker && openAsker.id === c.id && !hard) score += 55;

      if (turnsSince === 0) score += LAST_VOICE_PULL;

      if (c.kind === 'guest') score += 2;
      else score += importanceSpeakScore(c);
      score -= i * 0.01;
      return { ...c, score, address, turnsSince };
    })
    .sort((a, b) => b.score - a.score);
}

/** How many people may answer on this reply length. A ceiling, not a quota. */
export function answererCap(length: TurnLength): number {
  if (length === 'beat') return 1;
  if (length === 'scene') return 2;
  return 3;
}

/**
 * Voices who may have a spoken line in one scene reply.
 * A short reply is one voice. A second voice only when two people were
 * addressed, or the reply itself is long.
 */
export function sceneReplySpeakerCap(length: TurnLength, addressed: number): number {
  if (length === 'beat') return 1;
  if (length === 'episode') return 2;
  return addressed >= 2 ? 2 : 1;
}

/**
 * Who speaks after the player.
 * The people actually addressed, up to the length cap.
 * If nobody was addressed: the person whose question was just answered,
 * otherwise the last voice, otherwise the first person already here.
 * A pinned id goes first and counts toward the cap.
 */
export function selectAnswerers(opts: {
  length: TurnLength;
  playerText: string;
  candidates: SpeakerCandidate[];
  turns?: Turn[];
  preferId?: string;
}): SpeakerCandidate[] {
  const cap = answererCap(opts.length);
  const ranked = rankReplySpeakers({
    candidates: opts.candidates,
    playerText: opts.playerText,
    turns: opts.turns
  });
  const picked: RankedSpeaker[] = [];
  const take = (c: RankedSpeaker | undefined) => {
    if (!c || picked.length >= cap) return;
    if (picked.some((p) => p.id === c.id)) return;
    picked.push(c);
  };

  if (opts.preferId) take(ranked.find((c) => c.id === opts.preferId));

  const addressed = ranked.filter((c) => c.address === 'vocative' || c.address === 'directed');
  const vocatives = addressed.filter((c) => c.address === 'vocative');
  const chosen = vocatives.length > 0 ? vocatives : addressed;
  if (chosen.length > 0) {
    for (const c of chosen) take(c);
  } else if (picked.length === 0) {
    const asker = lastOpenQuestion(opts.turns ?? [], opts.candidates);
    if (asker) take(ranked.find((c) => c.id === asker.id));
    if (picked.length === 0) {
      const last = lastSpeaker(opts.turns ?? [], opts.candidates);
      const lastRanked = last ? ranked.find((c) => c.id === last.id) : undefined;
      take(lastRanked ?? ranked[0]);
    }
  }

  if (picked.length === 0 && ranked[0]) picked.push(ranked[0]);
  return picked.slice(0, cap).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
}

/**
 * Compact turn-taking signals for the director prompt.
 * The hard addressee and an open question only — silence is not a claim on the line.
 */
export function roomDynamicsLines(opts: {
  candidates: SpeakerCandidate[];
  playerText: string;
  turns?: Turn[];
}): string[] {
  const { candidates } = opts;
  if (candidates.length === 0) return [];
  const turns = opts.turns ?? [];
  const lines: string[] = [];

  const last = lastSpeaker(turns, candidates);
  if (last) lines.push(`Last voice in the room: ${last.name}.`);

  const addressed = detectHardAddressees(opts.playerText, candidates);
  if (addressed.length > 0) {
    lines.push(`The player's move is addressed to: ${addressed.map((c) => c.name).join(', ')}.`);
  }

  const asked = lastOpenQuestion(turns, candidates);
  if (asked) {
    lines.push(
      `${asked.name} asked a question; the player's last move answers it. ` +
      `Take the answer as heard — do not brief the same question again.`
    );
  }

  return lines;
}
