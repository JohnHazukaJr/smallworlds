/**
 * Light, narrative-first rules. A risky move rolls 2d6 + modifiers before the
 * reply is written; the tier becomes an order the prose must honour. The dice
 * stay out of the fiction: the reader sees a small chip, not numbers in prose.
 *
 *   12 on the dice ............ crit
 *   10+ ....................... success
 *   7–9 ....................... partial (it works, at a cost)
 *   6 or less ................. fail (and the story moves on)
 */

import type {
  Character, CheckDifficulty, CheckResult, CheckTier, InventoryItem, MechanicsDifficulty, StatDef, World,
  WorldMechanics
} from './types';

export const STAT_CAP = 4;
export const STAT_MIN = -1;
export const STAT_MAX = 3;
export const INVENTORY_CAP = 24;

export const DEFAULT_STATS: StatDef[] = [
  { key: 'might', name: 'Might', note: 'force, endurance, fighting' },
  { key: 'finesse', name: 'Finesse', note: 'speed, stealth, fine hands' },
  { key: 'wits', name: 'Wits', note: 'noticing, knowing, solving' },
  { key: 'presence', name: 'Presence', note: 'persuading, deceiving, commanding' }
];

export function defaultMechanics(): WorldMechanics {
  return { enabled: false, stats: DEFAULT_STATS.map((s) => ({ ...s })), difficulty: 'fair' };
}

/** The world's rules, or null when they are off. */
export function activeMechanics(world: Pick<World, 'mechanics'> | null | undefined): WorldMechanics | null {
  const m = world?.mechanics;
  if (!m?.enabled) return null;
  const stats = (m.stats?.length ? m.stats : DEFAULT_STATS).filter((s) => s.name.trim()).slice(0, STAT_CAP);
  return { enabled: true, stats, difficulty: m.difficulty ?? 'fair' };
}

const DIFFICULTY_MOD: Record<CheckDifficulty, number> = { easy: 1, normal: 0, hard: -1, dire: -2 };
const WORLD_MOD: Record<MechanicsDifficulty, number> = { forgiving: 1, fair: 0, harsh: -1 };

export function clampStat(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round(v)));
}

export function isCheckDifficulty(v: unknown): v is CheckDifficulty {
  return v === 'easy' || v === 'normal' || v === 'hard' || v === 'dire';
}

export function tierFor(dice: [number, number], total: number): CheckTier {
  if (dice[0] + dice[1] === 12) return 'crit';
  if (total >= 10) return 'success';
  if (total >= 7) return 'partial';
  return 'fail';
}

export type Rng = () => number;

function d6(rng: Rng): number {
  return Math.min(6, Math.max(1, Math.floor(rng() * 6) + 1));
}

/** Settle one risky move. `rng` is injectable so tests are deterministic. */
export function resolveCheck(input: {
  intent: string;
  stat?: StatDef;
  statValue?: number;
  difficulty: CheckDifficulty;
  world: MechanicsDifficulty;
  item?: string;
  rng?: Rng;
}): CheckResult {
  const rng = input.rng ?? Math.random;
  const dice: [number, number] = [d6(rng), d6(rng)];
  const modifier =
    (input.stat ? clampStat(input.statValue ?? 0) : 0) +
    DIFFICULTY_MOD[input.difficulty] +
    WORLD_MOD[input.world] +
    (input.item ? 1 : 0);
  const total = dice[0] + dice[1] + modifier;
  return {
    intent: input.intent.trim().slice(0, 120) || 'a risky move',
    ...(input.stat ? { stat: input.stat.name } : {}),
    difficulty: input.difficulty,
    dice,
    modifier,
    total,
    tier: tierFor(dice, total),
    ...(input.item ? { item: input.item } : {})
  };
}

const TIER_ORDERS: Record<CheckTier, string> = {
  crit: 'Clean success with a bonus: it goes better than they hoped, and they gain an edge or opening.',
  success: 'Success: the attempt works as intended.',
  partial: 'Partial success: it works, but with a real cost, complication, or hard choice that you make concrete.',
  fail: 'Failure: it does not work, and the situation gets worse in a way that pushes the story forward. Not a dead end, and never a joke at the player\'s expense.'
};

/** The order the scene writer must follow. Never mentions dice or numbers. */
export function checkDirective(check: CheckResult): string {
  return [
    `The player's attempt (${check.intent}) is already settled. Write the outcome as follows:`,
    TIER_ORDERS[check.tier],
    check.item ? `Their ${check.item} plays a part.` : '',
    'Do not mention dice, rolls, stats, or numbers. Do not soften or reverse the outcome.'
  ].filter(Boolean).join(' ');
}

export const TIER_LABEL: Record<CheckTier, string> = {
  crit: 'critical',
  success: 'success',
  partial: 'partial',
  fail: 'setback'
};

/** Short chip text, e.g. "Finesse · partial · 8". */
export function checkChipText(check: CheckResult): string {
  return [check.stat, TIER_LABEL[check.tier], String(check.total)].filter(Boolean).join(' · ');
}

/** Tooltip detail for the chip. */
export function checkChipDetail(check: CheckResult): string {
  const sign = check.modifier >= 0 ? '+' : '−';
  return `${check.intent} — ${check.dice[0]} + ${check.dice[1]} ${sign} ${Math.abs(check.modifier)} = ${check.total} (${check.difficulty})` +
    (check.item ? `, helped by ${check.item}` : '');
}

// ---------- inventory ----------

export interface InventoryChange {
  action?: string;
  name?: string;
  note?: string;
  qty?: number;
}

function itemKey(name: string): string {
  return name.trim().toLowerCase().replace(/^(a|an|the|some)\s+/, '');
}

/**
 * Apply gains and losses the live pass saw. Names match loosely ("the key" is
 * "key"). Returns null when nothing changed.
 */
export function applyInventoryChanges(
  items: InventoryItem[] | undefined,
  changes: InventoryChange[] | undefined,
  makeId: () => string
): InventoryItem[] | null {
  let out = [...(items ?? [])];
  let changed = false;
  for (const change of changes ?? []) {
    const name = (change.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) continue;
    const qty = Math.max(1, Math.min(99, Math.round(Number(change.qty) || 1)));
    const key = itemKey(name);
    const at = out.findIndex((item) => itemKey(item.name) === key);
    const action = (change.action ?? '').toLowerCase();
    if (action === 'remove' || action === 'lose' || action === 'use') {
      if (at < 0) continue;
      const left = out[at].qty - qty;
      out = left > 0
        ? out.map((item, i) => (i === at ? { ...item, qty: left } : item))
        : out.filter((_, i) => i !== at);
      changed = true;
      continue;
    }
    if (action !== 'add' && action !== 'gain') continue;
    if (at >= 0) {
      out = out.map((item, i) => (i === at ? { ...item, qty: Math.min(99, item.qty + qty) } : item));
    } else {
      if (out.length >= INVENTORY_CAP) continue;
      const note = change.note?.trim().slice(0, 120);
      out.push({ id: makeId(), name, ...(note ? { note } : {}), qty });
    }
    changed = true;
  }
  return changed ? out : null;
}

/** One line for prompts: "rope, lantern, silver coin ×3". */
export function inventoryLine(items: InventoryItem[] | undefined): string {
  return (items ?? [])
    .map((item) => (item.qty > 1 ? `${item.name} ×${item.qty}` : item.name))
    .join(', ');
}

/** The player's stat line for the referee: "Might +1, Wits +2". */
export function statLine(stats: StatDef[], person: Pick<Character, 'stats'> | undefined): string {
  return stats
    .map((s) => {
      const v = clampStat(person?.stats?.[s.key] ?? 0);
      return `${s.name} ${v >= 0 ? '+' : ''}${v}${s.note ? ` (${s.note})` : ''}`;
    })
    .join(', ');
}

// ---------- when to ask the referee ----------

/** Words in a spoken line that put something at stake with the listener. */
const SOCIAL_STAKES = /\b(lie|lying|bluff|swear|promise|trust me|convince|persuade|threat|or else|bribe|pay you|a deal|bargain|surrender|confess|give me|hand (it|them|that) over|let me (in|go|through|pass)|(stand|step) aside|back off|i order|i command|kill you|hurt you|you owe)\b/i;

/** Delivery tones that push on someone. */
const PRESSING_TONES = new Set(['threatening', 'pleading', 'desperate', 'flirty', 'defiant', 'furious', 'evasive']);

/**
 * Cheap filter before the referee call. An action always asks. A line of pure
 * speech asks only when it presses on someone (a threat, a bluff, a plea), so
 * ordinary conversation never waits on a utility call.
 */
export function needsReferee(mode: string, text: string): boolean {
  if (mode === 'act') return true;
  if (mode !== 'play' && mode !== 'speak') return false;
  const tagged = /^\[([a-z][a-z-]*)\]\s*/i.exec(text.trim());
  const tone = tagged?.[1]?.toLowerCase() ?? '';
  const body = tagged ? text.trim().slice(tagged[0].length) : text.trim();
  if (body.includes('*')) return true;
  const outside = body.replace(/[“"][^“”"]*[”"]/g, ' ').replace(/[^\p{L}]+/gu, '');
  if (outside.length > 3) return true;
  return PRESSING_TONES.has(tone) || SOCIAL_STAKES.test(body);
}
