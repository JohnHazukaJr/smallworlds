/**
 * Rule checks for one eval reply. Pure: no model, no DB. A failed check is a
 * clear bug (wrong speaker, a forbidden phrase); a warning is a likely one that
 * needs a person or the judge to confirm.
 */

import type { EvalScenario } from './scenarios';

/** One credited block of the reply, as the reader sees it. */
export interface EvalPiece {
  role: 'narrator' | 'character';
  text: string;
  /** Scenario key of the speaker, 'player' for the player card, or undefined when unknown. */
  who?: string;
  /** Display name, for reports. */
  name?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface EvalCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}

/** A quoted run of at least two characters. */
const QUOTED = /["“]([^"”“]{2,})["”]/g;
const SAY_VERBS = 'say|says|said|ask|asks|asked|reply|replies|replied|tell|tells|told|answer|answers|answered|whisper|whispers|whispered|murmur|murmurs|murmured|mutter|mutters|muttered';

function quotes(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => m[1].trim());
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Straight apostrophes and quotes, single spaces, lower case. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function spokeAloud(piece: EvalPiece): boolean {
  return piece.role === 'character' && quotes(piece.text).length > 0;
}

function who(pieces: EvalPiece[]): string {
  const names = [...new Set(pieces.filter((p) => p.role === 'character').map((p) => p.name ?? p.who ?? '?'))];
  return names.length ? names.join(', ') : 'only the narrator';
}

/** Narration that puts words in the player's mouth: `you say "..."` or `"...," Rowan said`. */
export function narratorVoicesPlayer(text: string, playerName: string): boolean {
  const name = playerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subject = name ? `(?:you|${name})` : 'you';
  const before = new RegExp(`\\b${subject}\\s+(?:${SAY_VERBS})\\b[^.!?"“]{0,40}["“]`, 'i');
  const after = new RegExp(`["”][,]?\\s+${subject}\\s+(?:${SAY_VERBS})\\b`, 'i');
  return before.test(text) || after.test(text);
}

export function gradeReply(
  scenario: EvalScenario,
  pieces: EvalPiece[],
  opts: { playerName: string }
): EvalCheck[] {
  const checks: EvalCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });
  const filled = pieces.filter((p) => p.text.trim());

  add('reply', filled.length ? 'pass' : 'fail', filled.length ? `${filled.length} piece(s)` : 'empty reply');
  if (!filled.length) return checks;

  const { expect } = scenario;

  if (expect.replier) {
    const theirs = filled.filter((p) => p.who === expect.replier);
    if (theirs.some(spokeAloud)) add('replier', 'pass', `${expect.replier} spoke`);
    else if (theirs.length) add('replier', 'warn', `${expect.replier} only acted, no quoted line`);
    else add('replier', 'fail', `${expect.replier} never spoke; voiced: ${who(filled)}`);
  }

  for (const key of expect.silent ?? []) {
    const theirs = filled.filter((p) => p.who === key);
    add(`silent:${key}`, theirs.length ? 'fail' : 'pass', theirs.length ? `${key} was credited ${theirs.length} line(s)` : `${key} stayed silent`);
  }

  if (expect.spoken) {
    const any = filled.some(spokeAloud);
    add('spoken', any ? 'pass' : 'fail', any ? 'an NPC spoke' : 'no quoted NPC line');
  }

  for (const [i, rule] of (expect.forbidden ?? []).entries()) {
    const scope = rule.who ? filled.filter((p) => p.who === rule.who) : filled;
    const text = normalizeForMatch(scope.map((p) => p.text).join('\n'));
    const hits = rule.phrases.filter((phrase) => text.includes(normalizeForMatch(phrase)));
    add(
      `forbidden${rule.who ? `:${rule.who}` : ''}#${i + 1}`,
      hits.length ? 'fail' : 'pass',
      hits.length ? `said ${hits.map((h) => `"${h}"`).join(', ')} (${rule.why})` : 'clean'
    );
  }

  const voicedPlayer = filled.filter((p) => p.who === 'player');
  if (voicedPlayer.length) {
    add('player-voice', 'fail', `the player card was credited ${voicedPlayer.length} line(s)`);
  } else if (filled.some((p) => p.role === 'narrator' && narratorVoicesPlayer(p.text, opts.playerName))) {
    add('player-voice', 'warn', 'narration may put words in the player’s mouth');
  } else {
    add('player-voice', 'pass', 'player not voiced');
  }

  const loose = filled
    .filter((p) => p.role === 'narrator')
    .flatMap((p) => quotes(p.text))
    .filter((q) => words(q) >= 3);
  add(
    'attribution',
    loose.length ? 'warn' : 'pass',
    loose.length ? `uncredited speech in narration: "${loose[0].slice(0, 60)}"` : 'all speech credited'
  );

  return checks;
}

export function worstStatus(checks: EvalCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}
