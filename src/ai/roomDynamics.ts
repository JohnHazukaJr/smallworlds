/**
 * Room social logic: who the player is talking to, who has been holding the floor,
 * and who has been standing there saying nothing.
 *
 * Pure functions over the transcript — no DB, no model calls. The director still
 * decides the plan; this only supplies signals and picks the fallback replier.
 */

import type { Character, EpisodeGuest, Turn } from '../types';

export type SpeakerKind = 'cast' | 'guest';

export interface SpeakerCandidate {
  id: string;
  name: string;
  kind: SpeakerKind;
}

/** How directly a line points at a person. */
export type AddressStrength = 'vocative' | 'directed' | 'mention';

export interface RankedSpeaker extends SpeakerCandidate {
  score: number;
  address: AddressStrength | null;
  /** Character turns since they last spoke; Infinity when they never have. */
  turnsSince: number;
}

/** Never-spoken beats any finite silence gap, so newcomers get a voice. */
const NEVER_SPOKE_PULL = 26;
/** Cap on how much accumulated silence can pull a speaker forward. */
const SILENCE_GAP_CAP = 8;

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
  if (new RegExp(`(^|["'*\\s])${n}\\s*[,!?:]`, 'iu').test(line)) return 'vocative';
  // "..., Ada?" — trailing vocative.
  if (new RegExp(`,\\s*${n}\\s*["'*.!?]*$`, 'iu').test(line)) return 'vocative';
  // "ask Ada", "turn to Ada", "looks up at Ada" — only connectors may sit between verb and name,
  // so "tell Ada that Ben lied" leaves Ben a topic rather than an addressee.
  if (new RegExp(`\\b(?:${ADDRESS_VERBS})\\b(?:\\s+(?:${ADDRESS_CONNECTORS}))*\\s+${n}\\b`, 'iu').test(line)) {
    return 'directed';
  }
  if (new RegExp(`\\bto\\s+${n}\\b`, 'iu').test(line)) return 'directed';
  return 'mention';
}

/** Cast + active walk-ons as one addressable list (player excluded). */
export function speakerCandidates(
  inScene: Character[],
  guests: EpisodeGuest[]
): SpeakerCandidate[] {
  return [
    ...inScene.filter((c) => !c.isPlayer).map((c) => ({
      id: c.id, name: c.name.trim(), kind: 'cast' as const
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

/** Who the player's latest move points at, if anyone. */
export function detectAddressee(
  playerText: string,
  candidates: SpeakerCandidate[]
): SpeakerCandidate | null {
  let best: { c: SpeakerCandidate; rank: number } | null = null;
  const rank: Record<AddressStrength, number> = { vocative: 3, directed: 2, mention: 1 };
  for (const c of candidates) {
    const strength = addressStrength(playerText, c.name);
    if (!strength) continue;
    const r = rank[strength];
    if (!best || r > best.rank) best = { c, rank: r };
  }
  return best?.c ?? null;
}

/**
 * Rank who should answer when the plan has no speak beat.
 * Being addressed dominates; after that, whoever has been quiet longest gets the floor,
 * so one NPC cannot monopolise a scene just by being first in the cast list.
 */
export function rankReplySpeakers(opts: {
  candidates: SpeakerCandidate[];
  playerText: string;
  turns?: Turn[];
}): RankedSpeaker[] {
  const turns = opts.turns ?? [];
  const since = turnsSinceSpoke(turns, opts.candidates);
  let lastNarration = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'narrator') {
      lastNarration = turns[i].text;
      break;
    }
  }

  return opts.candidates
    .map((c, i) => {
      const address = addressStrength(opts.playerText, c.name);
      const turnsSince = since.get(c.id) ?? Number.POSITIVE_INFINITY;
      let score = 0;
      if (address === 'vocative') score += 100;
      else if (address === 'directed') score += 70;
      else if (address === 'mention') score += 30;

      if (!Number.isFinite(turnsSince)) score += NEVER_SPOKE_PULL;
      else score += Math.min(turnsSince, SILENCE_GAP_CAP) * 3;
      if (turnsSince === 0) score -= 12;

      if (lastNarration && addressStrength(lastNarration, c.name)) score += 8;
      if (c.kind === 'cast') score += 2;
      score -= i * 0.01;
      return { ...c, score, address, turnsSince };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Compact turn-taking signals for the director prompt.
 * Advisory only — the director may still choose anyone.
 */
export function roomDynamicsLines(opts: {
  candidates: SpeakerCandidate[];
  playerText: string;
  turns?: Turn[];
}): string[] {
  const { candidates } = opts;
  if (candidates.length === 0) return [];
  const turns = opts.turns ?? [];
  const since = turnsSinceSpoke(turns, candidates);
  const lines: string[] = [];

  const last = lastSpeaker(turns, candidates);
  if (last) lines.push(`Last voice in the room: ${last.name}.`);

  const silent = candidates
    .filter((c) => !Number.isFinite(since.get(c.id) ?? Number.POSITIVE_INFINITY))
    .map((c) => c.name)
    .slice(0, 4);
  if (silent.length > 0) {
    lines.push(`Has not spoken this episode: ${silent.join(', ')}.`);
  }

  const quiet = candidates
    .filter((c) => {
      const gap = since.get(c.id) ?? Number.POSITIVE_INFINITY;
      return Number.isFinite(gap) && gap >= 4;
    })
    .map((c) => `${c.name} (${since.get(c.id)} lines ago)`)
    .slice(0, 3);
  if (quiet.length > 0) {
    lines.push(`Quiet for a while: ${quiet.join(', ')}.`);
  }

  const addressee = detectAddressee(opts.playerText, candidates);
  if (addressee) {
    lines.push(`The player's move appears aimed at: ${addressee.name}.`);
  }

  return lines;
}
