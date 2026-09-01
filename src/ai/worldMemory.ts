/**
 * How play writes back onto the world — places remember what happened in them,
 * and a gap between episodes is not a freeze-frame.
 *
 * Pure helpers: no DB, no model calls. The wrap pipeline applies the patches.
 */

import type { Location } from '../types';

export interface PlacePatch {
  /** Exact library name when known; empty is allowed for the scene location (matched by id). */
  name: string;
  /** Lasting condition of the place — smashed lamp, empty quay, lock forced. */
  currentState?: string;
  /** Weather / light / smell for the *next* opening, not the place's identity. */
  atmosphere?: string;
}

const STATE_MAX = 240;
const ATMOS_MAX = 180;
const MEANWHILE_MAX = 720;

function clipField(text: string | undefined, max: number): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function clipPlaceState(text: string | undefined): string {
  return clipField(text, STATE_MAX);
}

export function clipPlaceAtmosphere(text: string | undefined): string {
  return clipField(text, ATMOS_MAX);
}

export function clipMeanwhile(text: string | undefined): string {
  return clipField(text, MEANWHILE_MAX);
}

export function normalizePlacePatch(
  raw: { name?: string; currentState?: string; atmosphere?: string } | null | undefined
): PlacePatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = (raw.name ?? '').trim();
  const currentState = clipPlaceState(raw.currentState) || undefined;
  const atmosphere = clipPlaceAtmosphere(raw.atmosphere) || undefined;
  if (!currentState && !atmosphere) return null;
  return { name, currentState, atmosphere };
}

export function normalizePlacePatches(raw: unknown, cap = 4): PlacePatch[] {
  if (!Array.isArray(raw)) return [];
  const out: PlacePatch[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const p = normalizePlacePatch(item as { name?: string; currentState?: string; atmosphere?: string });
    if (!p) continue;
    const key = p.name.toLowerCase();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

export function gapDays(storyDayEnd: number, nextStoryDay: number): number {
  const end = Number.isFinite(storyDayEnd) ? Math.floor(storyDayEnd) : 0;
  const next = Number.isFinite(nextStoryDay) ? Math.floor(nextStoryDay) : end;
  return Math.max(0, next - end);
}

/**
 * Continuity line for time that passed off-screen.
 * Same-day continuation returns null — nothing happened "meanwhile".
 */
export function meanwhileFact(opts: {
  episodeNumber: number;
  gap: number;
  text: string;
}): string | null {
  const text = clipMeanwhile(opts.text);
  if (!text || opts.gap <= 0) return null;
  const span = opts.gap === 1 ? '1 day' : `${opts.gap} days`;
  return `Meanwhile (${span} after episode ${opts.episodeNumber}): ${text}`;
}

export function matchLocationForPatch(
  locations: Location[],
  patch: PlacePatch,
  preferId?: string | null
): Location | undefined {
  if (preferId) {
    const byId = locations.find((l) => l.id === preferId);
    if (byId) return byId;
  }
  const key = patch.name.trim().toLowerCase();
  if (!key) return undefined;
  const exact = locations.find((l) => l.name.trim().toLowerCase() === key);
  if (exact) return exact;
  return locations.find((l) => {
    const n = l.name.trim().toLowerCase();
    if (n.length < 3 || key.length < 3) return false;
    return n.includes(key) || key.includes(n);
  });
}

/**
 * Merge a patch onto a location sheet.
 * Only currentState is written — that is the room as you left it.
 * Atmosphere on the patch is weather for the *next episode*, not the place's identity scent.
 */
export function mergeLocationPatch(loc: Location, patch: PlacePatch): { currentState: string } {
  return {
    currentState: patch.currentState?.trim() || loc.currentState
  };
}

/**
 * Weather from last night should not still be falling a week later.
 * Same-day continuation keeps the scene's atmosphere unless wrap overrides it.
 */
export function nextAtmosphereNote(opts: {
  carried?: string;
  override?: string | null;
  gap: number;
}): string | undefined {
  const override = (opts.override ?? '').trim();
  if (override) return override;
  if (opts.gap > 0) return undefined;
  const carried = (opts.carried ?? '').trim();
  return carried || undefined;
}
