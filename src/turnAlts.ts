/**
 * Kept versions of a rewritten reply. `alts` holds every version, the showing
 * one included; `altIndex` points at it. A rewrite adds a version instead of
 * throwing the old one away, and the reader can flip back.
 */

import type { Turn, TurnAlt, TurnBeat } from './types';

export const ALT_CAP = 5;

type AltPatch = Pick<Turn, 'text' | 'beats' | 'alts' | 'altIndex'>;

function currentAlt(turn: Pick<Turn, 'text' | 'beats' | 'createdAt' | 'updatedAt'>): TurnAlt {
  return {
    text: turn.text,
    ...(turn.beats?.length ? { beats: turn.beats } : {}),
    createdAt: turn.updatedAt ?? turn.createdAt
  };
}

/** The list of versions, with the showing text kept in sync (it may have been edited). */
function versions(turn: Pick<Turn, 'text' | 'beats' | 'alts' | 'altIndex' | 'createdAt' | 'updatedAt'>): {
  list: TurnAlt[];
  index: number;
} {
  const list = turn.alts?.length ? [...turn.alts] : [currentAlt(turn)];
  const index = Math.min(Math.max(0, turn.altIndex ?? list.length - 1), list.length - 1);
  if (list[index].text !== turn.text) list[index] = { ...currentAlt(turn), createdAt: list[index].createdAt };
  return { list, index };
}

/** A rewrite: add the new version and show it. Drops the oldest version past the cap. */
export function addAltPatch(
  turn: Pick<Turn, 'text' | 'beats' | 'alts' | 'altIndex' | 'createdAt' | 'updatedAt'>,
  text: string,
  beats: TurnBeat[] | undefined,
  now: number
): AltPatch {
  const { list } = versions(turn);
  const next: TurnAlt = { text, ...(beats?.length ? { beats } : {}), createdAt: now };
  const all = [...list, next].slice(-ALT_CAP);
  return { text, beats: next.beats, alts: all, altIndex: all.length - 1 };
}

/** Show another kept version. Null when the index is out of range or already showing. */
export function switchAltPatch(
  turn: Pick<Turn, 'text' | 'beats' | 'alts' | 'altIndex' | 'createdAt' | 'updatedAt'>,
  index: number
): AltPatch | null {
  if (!turn.alts || turn.alts.length < 2) return null;
  const { list, index: at } = versions(turn);
  if (index < 0 || index >= list.length || index === at) return null;
  const pick = list[index];
  return { text: pick.text, beats: pick.beats, alts: list, altIndex: index };
}

/** A hand edit replaces the showing version, so flipping away and back keeps it. */
export function editAltPatch(
  turn: Pick<Turn, 'alts' | 'altIndex'>,
  text: string,
  now: number
): Pick<Turn, 'alts'> | null {
  if (!turn.alts?.length) return null;
  const index = Math.min(Math.max(0, turn.altIndex ?? turn.alts.length - 1), turn.alts.length - 1);
  const alts = turn.alts.map((alt, i) => (i === index ? { text, createdAt: now } : alt));
  return { alts };
}

/** "2 / 3" style position, or null when there is nothing to flip through. */
export function altPosition(turn: Pick<Turn, 'alts' | 'altIndex'>): { index: number; count: number } | null {
  const count = turn.alts?.length ?? 0;
  if (count < 2) return null;
  const index = Math.min(Math.max(0, turn.altIndex ?? count - 1), count - 1);
  return { index, count };
}
