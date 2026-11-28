/**
 * Rule checks for one eval reply. Pure: no model, no DB. A failed check is a
 * clear bug (wrong speaker, a forbidden phrase); a warning is a likely one that
 * needs a person or the judge to confirm.
 */

import type { EvalScenario } from './scenarios';
import { echoOf, opensWithEcho, playerSpokenWords } from '../ai/echo';

export { echoOf };

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

function wordList(text: string): string[] {
  return normalizeForMatch(text).replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean);
}

/** A reply played live before the graded one, with the move that drew it. */
export interface EarlierReply {
  input: string;
  pieces: EvalPiece[];
  /** Milliseconds writing the reply, then waiting on the memory pass after it. */
  writeMs?: number;
  memoryMs?: number;
}

const GRAM_STOP = new Set(
  ('the a an and or but of to in on at for with from by is are was were be it its this that his her their ' +
    'your you him she he they them i me my we our as into onto over then than not no so just one up out').split(' ')
);

/** Two-word phrases with no small words: "eyes narrowing", "taps ledger". */
function pairs(text: string): Set<string> {
  const w = wordList(text).filter((x) => x.length > 2 && !GRAM_STOP.has(x));
  const out = new Set<string>();
  for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
  return out;
}

/**
 * Phrases that come back in reply after reply: the same gesture or line, turn on turn.
 * Phrases from the player's own moves or the scene and cast sheets are topic, not a tic.
 */
export function repeatedPhrases(replies: string[], background: string): Array<{ phrase: string; replies: number }> {
  const topic = pairs(background);
  const counts = new Map<string, number>();
  for (const reply of replies) {
    for (const gram of pairs(reply)) {
      if (!topic.has(gram)) counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  const floor = Math.max(3, Math.ceil(replies.length / 2));
  return [...counts.entries()]
    .filter(([, n]) => n >= floor)
    .map(([phrase, n]) => ({ phrase, replies: n }))
    .sort((a, b) => b.replies - a.replies);
}

export function gradeReply(
  scenario: EvalScenario,
  pieces: EvalPiece[],
  opts: {
    playerName: string;
    /** Multi-turn scenes: the live replies before this one, oldest first. */
    earlier?: EarlierReply[];
    /** Scene, cast, and world text, so their phrases are not counted as repetition. */
    background?: string;
  }
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

  const playerLine = scenario.move.continue || scenario.move.direct ? '' : scenario.move.input.replace(/^\[[^\]]*\]\s*/, '');
  if (wordList(playerLine).length >= 4) {
    const spoken = filled.filter((p) => p.role === 'character').flatMap((p) => quotes(p.text));
    const { run, share } = echoOf(playerLine, spoken.join(' '));
    // Re-asking the line is an opening habit, so the first sentence spoken counts at a lower bar.
    const opener = (spoken[0] ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
    const openerRun = echoOf(playerLine, opener).run;
    const echoed = run >= 4 || share >= 0.6 || openerRun >= 3;
    add('echo', echoed ? 'warn' : 'pass', echoed
      ? `NPC repeats the player: ${run} words in a row, ${Math.round(share * 100)}% of their content words`
      : `${run}-word run, ${Math.round(share * 100)}% reuse`);
  }

  if (opts.earlier?.length) {
    const textOf = (ps: EvalPiece[]) => ps.map((p) => p.text).join('\n');
    const echoedTurns = opts.earlier.filter((e) => {
      const said = playerSpokenWords('play', e.input);
      return said && opensWithEcho(said, textOf(e.pieces));
    }).length;
    add('echo-over-turns', echoedTurns ? 'warn' : 'pass', echoedTurns
      ? `${echoedTurns} of ${opts.earlier.length} earlier replies opened by saying the player's line back`
      : `no echo in ${opts.earlier.length} earlier replies`);

    const all = [...opts.earlier.map((e) => textOf(e.pieces)), textOf(filled)];
    const background = [opts.background ?? '', ...opts.earlier.map((e) => e.input), scenario.move.input].join('\n');
    const repeats = repeatedPhrases(all, background);
    add('repetition', repeats.length ? 'warn' : 'pass', repeats.length
      ? `repeated across replies: ${repeats.slice(0, 3).map((r) => `"${r.phrase}" ×${r.replies}`).join(', ')}`
      : `no phrase repeated across ${all.length} replies`);

    const empty = opts.earlier.filter((e) => !e.pieces.some((p) => p.text.trim())).length;
    if (empty) add('earlier-replies', 'fail', `${empty} earlier move(s) got no reply`);
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
