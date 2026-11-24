/**
 * The LLM judge for one eval reply. Builds the prompt and parses the scores;
 * the call itself happens in the page runner. The judge sees everything the
 * writer was hidden from (secrets, walls) so it can catch leaks by meaning,
 * not by shared words.
 */

import { CAST, EVAL_WORLD, personByKey, type EvalPerson, type EvalScenario } from './scenarios';
import type { EvalPiece } from './grade';

export const JUDGE_DIMENSIONS = ['voice', 'character', 'address', 'walls', 'agency', 'craft'] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

export interface JudgeVerdict {
  /** 1 (broken) to 5 (excellent) per dimension. */
  scores: Record<JudgeDimension, number>;
  /** One short reason per dimension. */
  notes: Partial<Record<JudgeDimension, string>>;
  /** The single biggest problem, or "none". */
  worst: string;
}

const RUBRIC: Record<JudgeDimension, string> = {
  voice: 'Each NPC sounds like their speech style and example lines, and no two NPCs are interchangeable.',
  character: 'NPCs act from their own traits, wants, fears, mood, memories, and stance toward the player.',
  address: 'The reply answers what the player actually did or said, and the person addressed is the one who answers.',
  walls: 'No one reveals a secret they would keep, and no one knows what they must not know. Judge by meaning, not wording. 5 = clean.',
  agency: 'The narrator never writes the player’s words, choices, thoughts, or feelings. Showing what the player physically sees is fine.',
  craft: 'Grounded, specific prose that fits the world; no repetition, purple padding, summarising, or breaking the fourth wall.'
};

function sheet(p: EvalPerson): string {
  return [
    `${p.name} (${p.role}, ${p.age})`,
    `  who: ${p.summary}`,
    `  speech: ${p.speechStyle}`,
    `  example lines: ${p.exampleLines.map((l) => `"${l}"`).join(' ')}`,
    `  traits: ${p.traits}; wants: ${p.desires}; fears: ${p.fears}`,
    p.emotion || p.goal ? `  right now: ${[p.emotion, p.goal].filter(Boolean).join('; ')}` : '',
    p.secrets ? `  SECRET (keeps it): ${p.secrets}` : '',
    p.mustNotKnow ? `  MUST NOT KNOW: ${p.mustNotKnow}` : '',
    p.anchors?.length ? `  never breaks: ${p.anchors.join(' ')}` : '',
    p.memories?.length ? `  remembers: ${p.memories.map((m) => `${m.text}${m.feeling ? ` (${m.feeling})` : ''}`).join('; ')}` : '',
    p.towardPlayer ? `  toward ${EVAL_WORLD.player.name}: ${p.towardPlayer.kind}, ${p.towardPlayer.note}` : ''
  ].filter(Boolean).join('\n');
}

function lineLabel(who: string): string {
  if (who === 'player') return EVAL_WORLD.player.name;
  if (who === 'narrator') return 'Narrator';
  return personByKey(who)?.name ?? who;
}

export function renderPieces(pieces: EvalPiece[]): string {
  return pieces
    .filter((p) => p.text.trim())
    .map((p) => (p.role === 'character' ? `[${p.name ?? p.who ?? 'Unknown'}] ${p.text.trim()}` : `[Narrator] ${p.text.trim()}`))
    .join('\n');
}

export function judgePrompt(scenario: EvalScenario, pieces: EvalPiece[]): { system: string; user: string } {
  const present = scenario.present.map((k) => personByKey(k)).filter((p): p is EvalPerson => !!p);
  const absent = CAST.filter((p) => !scenario.present.includes(p.key)).map((p) => p.name);
  const guests = (scenario.guests ?? []).map((g) => `${g.name} (walk-on): ${g.brief}${g.voice ? ` Voice: ${g.voice}` : ''}`);
  const move = scenario.move.continue
    ? '(Continue: the player gave no move; the scene should go on by itself.)'
    : scenario.move.direct
      ? `(Author instruction, not spoken in the story) ${scenario.move.input}`
      : `${EVAL_WORLD.player.name}: ${scenario.move.input}`;

  const system = [
    'You grade one reply from an interactive fiction engine where the player is a character and an AI writes the narrator and every NPC.',
    'Be strict and specific. A 3 is acceptable, 4 is good, 5 is hard to fault. Score each dimension 1 to 5:',
    ...JUDGE_DIMENSIONS.map((d) => `- ${d}: ${RUBRIC[d]}`),
    'If a dimension does not apply (e.g. no secrets at stake), score it 5.',
    'Reply with JSON only: {"scores":{"voice":n,"character":n,"address":n,"walls":n,"agency":n,"craft":n},' +
      '"notes":{"<dimension>":"<one short reason>"},"worst":"<the single biggest problem, or none>"}'
  ].join('\n');

  const user = [
    `WORLD: ${EVAL_WORLD.title}. ${EVAL_WORLD.bible}`,
    `PLACE: ${EVAL_WORLD.place.name}. ${EVAL_WORLD.place.summary}`,
    `PLAYER: ${EVAL_WORLD.player.name}, ${EVAL_WORLD.player.summary}`,
    '',
    'IN THE ROOM:',
    ...present.map(sheet),
    ...guests,
    absent.length ? `NOT PRESENT (must not speak): ${absent.join(', ')}` : '',
    '',
    'EARLIER:',
    ...scenario.history.map((l) => `[${lineLabel(l.who)}] ${l.text}`),
    '',
    `THE MOVE: ${move}`,
    '',
    'THE REPLY TO GRADE:',
    renderPieces(pieces) || '(empty)',
    '',
    `WEIGH MOST: ${scenario.judgeFocus}`
  ].filter((l) => l !== '').join('\n');

  return { system, user };
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(1, Math.min(5, Math.round(v)));
}

/** Parse the judge's JSON. Missing or junk scores become 0 so they stand out. */
export function parseVerdict(raw: unknown): JudgeVerdict {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (obj.scores && typeof obj.scores === 'object' ? obj.scores : {}) as Record<string, unknown>;
  const n = (obj.notes && typeof obj.notes === 'object' ? obj.notes : {}) as Record<string, unknown>;
  const scores = Object.fromEntries(
    JUDGE_DIMENSIONS.map((d) => [d, d in s ? clampScore(s[d]) : 0])
  ) as Record<JudgeDimension, number>;
  const notes: Partial<Record<JudgeDimension, string>> = {};
  for (const d of JUDGE_DIMENSIONS) {
    if (typeof n[d] === 'string' && n[d]) notes[d] = (n[d] as string).slice(0, 240);
  }
  const worst = typeof obj.worst === 'string' && obj.worst.trim() ? obj.worst.trim().slice(0, 300) : 'none';
  return { scores, notes, worst };
}

export function meanScore(v: JudgeVerdict): number {
  const vals = JUDGE_DIMENSIONS.map((d) => v.scores[d]).filter((x) => x > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
