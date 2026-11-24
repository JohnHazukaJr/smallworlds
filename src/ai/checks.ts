/**
 * The referee. Before the scene is written, decide whether the player's move
 * is genuinely risky, and if so which stat and how hard. The dice do the rest.
 */

import type { Character, CheckResult, World, WorldMechanics } from '../types';
import { inventoryLine, isCheckDifficulty, resolveCheck, statLine, type Rng } from '../mechanics';
import type { ToolSpec } from './client';
import { utilityCall } from './utilityCall';

export interface MoveRuling {
  risky: boolean;
  intent?: string;
  stat?: string;
  difficulty?: string;
  item?: string;
}

const REFEREE_TIMEOUT_MS = 15_000;

export const RULE_MOVE_TOOL: ToolSpec = {
  name: 'rule_move',
  description: 'Decide whether the player\'s move needs a check, and how hard it is.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      risky: { type: 'boolean' },
      intent: { type: 'string' },
      stat: { type: 'string' },
      difficulty: { type: 'string', enum: ['easy', 'normal', 'hard', 'dire'] },
      item: { type: 'string' }
    },
    required: ['risky']
  }
};

/** Turn a referee ruling into a settled check, or null when nothing is rolled. */
export function checkFromRuling(input: {
  ruling: MoveRuling | null | undefined;
  mechanics: WorldMechanics;
  player: Pick<Character, 'stats' | 'inventory'> | undefined;
  moveText: string;
  rng?: Rng;
}): CheckResult | null {
  const r = input.ruling;
  if (!r || r.risky !== true) return null;
  const statKey = (r.stat ?? '').trim().toLowerCase();
  const stat = input.mechanics.stats.find((s) =>
    s.name.trim().toLowerCase() === statKey || s.key.toLowerCase() === statKey
  );
  const itemKey = (r.item ?? '').trim().toLowerCase();
  const item = itemKey
    ? (input.player?.inventory ?? []).find((i) => {
      const name = i.name.trim().toLowerCase();
      return name === itemKey || name.includes(itemKey) || itemKey.includes(name);
    })
    : undefined;
  return resolveCheck({
    intent: r.intent?.trim() || input.moveText.slice(0, 80),
    ...(stat ? { stat, statValue: input.player?.stats?.[stat.key] ?? 0 } : {}),
    difficulty: isCheckDifficulty(r.difficulty) ? r.difficulty : 'normal',
    world: input.mechanics.difficulty,
    ...(item ? { item: item.name } : {}),
    ...(input.rng ? { rng: input.rng } : {})
  });
}

/**
 * Ask the utility model for a ruling. Any failure means no check: a referee
 * that cannot answer must never block the story.
 */
export async function ruleMove(input: {
  world: World;
  mechanics: WorldMechanics;
  player: Character | undefined;
  moveText: string;
  sceneTail: string;
  signal?: AbortSignal;
}): Promise<MoveRuling | null> {
  const move = input.moveText.trim();
  if (!move) return null;
  const stats = statLine(input.mechanics.stats, input.player);
  const carried = inventoryLine(input.player?.inventory);
  try {
    return await utilityCall<MoveRuling>({
      world: input.world,
      system:
        'You referee a story game. Call rule_move. Do not write story prose.\n' +
        'risky: true only when the outcome is genuinely uncertain AND failure would matter: ' +
        'fighting, sneaking, climbing, chasing, lying to someone wary, persuading someone unwilling, picking a lock, enduring harm. ' +
        'false for talking, asking, looking, walking, ordinary tasks, feelings, or anything that simply happens.\n' +
        'intent: what they attempt, under 10 words, starting with a verb.\n' +
        'stat: the one listed stat that fits best, by its exact name.\n' +
        'difficulty: easy, normal, hard, or dire, from the fiction (odds, opposition, preparation).\n' +
        'item: one carried item that clearly helps, by its exact name; omit otherwise.',
      user:
        `Stats: ${stats || '(none)'}\n` +
        `Carried: ${carried || '(nothing)'}\n\n` +
        `Scene so far (end):\n${input.sceneTail.slice(-1500) || '(opening)'}\n\n` +
        `Player's move:\n${move.slice(0, 800)}\n\nCall rule_move.`,
      maxTokens: 300,
      signal: input.signal,
      timeoutMs: REFEREE_TIMEOUT_MS,
      tool: RULE_MOVE_TOOL
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError' && input.signal?.aborted) throw e;
    return null;
  }
}
