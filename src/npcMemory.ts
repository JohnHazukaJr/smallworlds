/**
 * Per-character episodic memory. The live-memory pass files what each person
 * present lived through; their scene card recalls the few that matter now.
 * Stored on the Character row, so sync, sealing, export, and delete already
 * cover it.
 */

import { lineOverlap } from './ai/liveCanon';
import type { NpcMemory } from './types';

/** Most memories kept per character. */
export const NPC_MEMORY_CAP = 40;
/** Most memories one live pass may file for one person. */
export const NPC_MEMORY_PER_PASS = 2;
/** Memories shown on a scene card. */
export const NPC_MEMORY_RECALL = 3;

const TEXT_MAX = 200;
const FEELING_MAX = 40;
const DAY_MS = 86_400_000;

export interface MemoryDraft {
  name?: string;
  text?: string;
  feeling?: string;
  salience?: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function clampSalience(n: unknown): 1 | 2 | 3 {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 1;
  return v >= 3 ? 3 : v <= 1 ? 1 : 2;
}

/** Older memories fade unless they marked the person. Higher keeps longer. */
function keepScore(m: NpcMemory, now: number, newest: number): number {
  const ageDays = Math.max(0, (now - m.createdAt) / DAY_MS);
  const order = newest > 0 ? m.createdAt / newest : 1;
  return m.salience * 10 + order * 4 - Math.min(ageDays, 30) * 0.1;
}

/**
 * Add new memories: cleaned, deduplicated against what they already remember,
 * then pruned to the cap. Salience-3 memories are the last to go.
 */
export function addMemories(
  existing: NpcMemory[] | undefined,
  drafts: MemoryDraft[],
  ctx: { episodeId: string; now: number; makeId: () => string }
): NpcMemory[] {
  const out = [...(existing ?? [])];
  let added = 0;
  for (const draft of drafts) {
    if (added >= NPC_MEMORY_PER_PASS) break;
    const text = clip(draft.text ?? '', TEXT_MAX);
    if (text.length < 8) continue;
    if (out.some((m) => m.text.toLowerCase() === text.toLowerCase() || lineOverlap(m.text, text) >= 0.8)) continue;
    const feeling = clip(draft.feeling ?? '', FEELING_MAX);
    out.push({
      id: ctx.makeId(),
      text,
      ...(feeling && feeling.toLowerCase() !== 'none' ? { feeling } : {}),
      salience: clampSalience(draft.salience),
      episodeId: ctx.episodeId,
      createdAt: ctx.now + added
    });
    added += 1;
  }
  if (out.length <= NPC_MEMORY_CAP) return out;
  const newest = Math.max(...out.map((m) => m.createdAt));
  const keep = new Set(
    [...out]
      .sort((a, b) => keepScore(b, ctx.now, newest) - keepScore(a, ctx.now, newest))
      .slice(0, NPC_MEMORY_CAP)
      .map((m) => m.id)
  );
  return out.filter((m) => keep.has(m.id));
}

/**
 * The memories this person would reach for right now: what the moment is
 * about first, then how much it marked them, then how recent it is.
 */
export function recallMemories(
  memories: NpcMemory[] | undefined,
  query: string,
  limit = NPC_MEMORY_RECALL
): NpcMemory[] {
  const list = memories ?? [];
  if (list.length === 0 || limit <= 0) return [];
  const newest = Math.max(...list.map((m) => m.createdAt));
  const oldest = Math.min(...list.map((m) => m.createdAt));
  const span = Math.max(1, newest - oldest);
  const q = query.trim();
  const scored = list.map((m) => {
    const relevance = q ? lineOverlap(m.text, q) : 0;
    const recency = (m.createdAt - oldest) / span;
    return { m, score: relevance * 6 + m.salience * 1.5 + recency * 2 };
  });
  return scored
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
    .slice(0, limit)
    .map((row) => row.m)
    // Told in the order they happened.
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** One card line per memory. */
export function memoryCardLine(m: NpcMemory): string {
  return m.feeling ? `${m.text} (left them ${m.feeling})` : m.text;
}

/**
 * Memories left after a rewind removes this chapter's turns from `since` on.
 * Null when nothing changes, so callers skip the write.
 */
export function forgetFiledSince(
  memories: NpcMemory[] | undefined,
  episodeId: string,
  since: number
): NpcMemory[] | null {
  if (!memories?.length) return null;
  const kept = memories.filter((m) => m.episodeId !== episodeId || m.createdAt < since);
  return kept.length === memories.length ? null : kept;
}
