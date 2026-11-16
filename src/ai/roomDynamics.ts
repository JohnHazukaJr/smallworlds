/**
 * Room social logic: who the player is talking to, who has been holding the floor,
 * and who has been standing there saying nothing.
 *
 * Pure functions over the transcript — no DB, no model calls. The director still
 * decides the plan; this only supplies signals and picks the fallback replier.
 */

import type { Character, CharacterImportance, EpisodeGuest, Turn, TurnLength } from '../types';
import { characterImportance, importanceSpeakScore } from './characterWeight';
import { distinctiveTokens, isCommonLabel, tokensLooselyMatch } from './nameMatch';
import { splitSceneReply, type SceneSpeaker } from './sceneReply';

export { distinctiveTokens, isCommonLabel, tokensLooselyMatch };

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
  if (strength === 'mention' && isCommonLabel(name)) return null;
  return strength;
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

function sceneSpeakersOf(candidates: SpeakerCandidate[]): SceneSpeaker[] {
  return candidates.flatMap((c) => {
    const name = c.name.trim();
    if (!name) return [];
    return [{
      id: c.id,
      name,
      kind: c.kind,
      ...(c.aliases?.length ? { aliases: c.aliases } : {}),
      ...(c.role ? { role: c.role } : {})
    }];
  });
}

interface CreditedVoice {
  id: string;
  kind: SpeakerKind;
  text: string;
}

/** A stored character row, or a quote the scene prose itself credits. */
function creditedVoices(turn: Turn, speakers: SceneSpeaker[]): CreditedVoice[] {
  if (turn.role === 'character') {
    const id = turn.guestId ?? turn.characterId;
    if (!id) return [];
    return [{ id, kind: turn.guestId ? 'guest' : 'cast', text: turn.text }];
  }
  if (turn.role !== 'narrator') return [];
  return splitSceneReply(turn.text, speakers).flatMap((piece) => {
    if (piece.role !== 'character' || !piece.speakerId) return [];
    return [{
      id: piece.speakerId,
      kind: piece.kind === 'guest' ? 'guest' : 'cast',
      text: piece.text
    }];
  });
}

/**
 * Spoken lines since each candidate last spoke.
 * A scene reply counts each credited quote. 0 = most recent voice.
 */
export function turnsSinceSpoke(
  turns: Turn[],
  candidates: SpeakerCandidate[]
): Map<string, number> {
  const speakers = sceneSpeakersOf(candidates);
  const lastSeen = new Map<string, number>();
  let spoken = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const lines = creditedVoices(turns[i], speakers);
    for (let j = lines.length - 1; j >= 0; j--) {
      const id = lines[j].id;
      if (!lastSeen.has(id)) lastSeen.set(id, spoken);
      spoken++;
    }
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
  const speakers = sceneSpeakersOf(candidates);
  for (let i = turns.length - 1; i >= 0; i--) {
    const lines = creditedVoices(turns[i], speakers);
    for (let j = lines.length - 1; j >= 0; j--) {
      const hit = candidates.find((c) => c.id === lines[j].id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Who asked the question the player's latest line answers.
 * The asker is the last credited voice before that line, including a quote
 * inside a scene reply. A later voice that did not ask clears it. Lines after
 * the player's answer do not — the asker still has to take the answer as heard.
 */
function openQuestionBeforeLastUser(
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
  const speakers = sceneSpeakersOf(candidates);
  for (let i = userIdx - 1; i >= 0; i--) {
    const lines = creditedVoices(turns[i], speakers);
    if (lines.length === 0) continue;
    const last = lines[lines.length - 1];
    if (!/\?/.test(last.text)) return null;
    const asker = candidates.find((c) => c.id === last.id) ?? {
      id: last.id,
      name: 'Someone',
      kind: last.kind
    };
    return { asker, text: last.text };
  }
  return null;
}

export function lastOpenQuestion(
  turns: Turn[],
  candidates: SpeakerCandidate[]
): SpeakerCandidate | null {
  return openQuestionBeforeLastUser(turns, candidates)?.asker ?? null;
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
  return openQuestionBeforeLastUser(turns, candidates);
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
