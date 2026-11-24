/**
 * "Let time pass": the world takes a turn without the player. One person here
 * acts on what they want; with nobody here, the world itself shifts.
 */

import type { CalendarEvent, Character } from './types';

export interface MoverCandidate {
  id: string;
  name: string;
  /** What they want right now. */
  goal?: string;
  /** Spoken lines since they last spoke; Infinity when they never have. */
  silence: number;
  importance?: string;
}

const IMPORTANCE_WEIGHT: Record<string, number> = { lead: 3, regular: 2, occasional: 1, background: -2 };

/**
 * Who moves: someone with a live goal, who has been quiet a while, weighted by
 * how central they are. `rng` breaks ties so it is not always the same person.
 */
export function pickWorldMover(candidates: MoverCandidate[], rng: () => number = Math.random): MoverCandidate | null {
  if (candidates.length === 0) return null;
  let best: MoverCandidate | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const quiet = Number.isFinite(c.silence) ? Math.min(c.silence, 6) : 6;
    const score =
      (c.goal?.trim() ? 4 : 0) +
      quiet * 0.6 +
      (IMPORTANCE_WEIGHT[c.importance ?? 'regular'] ?? 2) +
      rng() * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Calendar events due today or tomorrow, as a short clause. */
export function dueEventsLine(events: CalendarEvent[], today: number): string {
  return events
    .filter((e) => typeof e.storyDay === 'number' && e.storyDay >= today && e.storyDay <= today + 1)
    .map((e) => e.title?.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('; ');
}

/** The instruction for a world turn. */
export function worldMoveCue(input: { mover: Pick<Character, 'name'> & { goal?: string } | null; due?: string }): string {
  const due = input.due?.trim() ? ` If it fits, let this bear on it: ${input.due.trim()}.` : '';
  if (!input.mover) {
    return 'Time moves without waiting for the player. Something in the world shifts on its own: news arrives, ' +
      'a consequence of earlier events catches up, the weather or the crowd turns, a stranger appears at the edge. ' +
      `Make it concrete, and end on something the player can answer.${due} Do not write the player's response.`;
  }
  const goal = input.mover.goal?.trim();
  return `Time moves without waiting for the player. ${input.mover.name} acts on what they want` +
    (goal ? ` (${goal})` : '') +
    ': a concrete move that changes the situation here, not small talk and not a recap. ' +
    `Others here may react. End on something the player can answer.${due} Do not write the player's response.`;
}

/** Clean the live pass's next-move ideas: short, distinct, at most three. */
export function cleanSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim().slice(0, 140);
    const key = text.toLowerCase();
    if (text.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 3) break;
  }
  return out;
}
