/**
 * Structured canon filed *during* play — facts, threads, place, knowledge —
 * so wrap is a chapter close rather than the first time anything is remembered.
 *
 * Pure helpers: no DB, no model. Engine applies the extract.
 */

import { normalizePlacePatch, type PlacePatch } from './worldMemory';

export const LIVE_CANON_FACT_CAP = 5;
export const LIVE_CANON_THREAD_CAP = 2;
/** Max auto facts we will add from live extract for one episode. */
export const LIVE_CANON_EPISODE_FACT_BUDGET = 18;
/** Wrap review: only genuinely new facts after live filing. */
export const WRAP_NEW_FACT_CAP = 8;
export const WRAP_NEW_THREAD_CAP = 6;
const KNOWLEDGE_CAP = 3;
const LINE_MAX = 220;
const OVERLAP_MIN = 0.62;

export interface LiveCanonKnowledge {
  name: string;
  nowKnows: string;
}

export interface LiveCanonExtract {
  facts: string[];
  threads: string[];
  place: PlacePatch | null;
  knowledge: LiveCanonKnowledge[];
}

function clipLine(text: string, max = LINE_MAX): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, max);
}

/** Token overlap; 0 unless at least two shared content words. */
export function lineOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter < 2) return 0;
  return inter / Math.min(A.size, B.size);
}

export function isNearDuplicate(candidate: string, existing: string[], minScore = OVERLAP_MIN): boolean {
  const c = clipLine(candidate);
  if (!c) return true;
  const cl = c.toLowerCase();
  for (const raw of existing) {
    const e = clipLine(raw);
    if (!e) continue;
    const el = e.toLowerCase();
    if (el === cl) return true;
    const shorter = Math.min(el.length, cl.length);
    if (shorter >= 12 && (el.includes(cl) || cl.includes(el))) return true;
    if (lineOverlap(c, e) >= minScore) return true;
  }
  return false;
}

/** First `cap` proposed lines that are not near-duplicates of existing (or each other). */
export function novelLines(proposed: string[], existing: string[], cap: number): string[] {
  if (cap <= 0) return [];
  const out: string[] = [];
  const pool = existing.map((s) => clipLine(s)).filter(Boolean);
  for (const raw of proposed) {
    const t = clipLine(raw);
    if (!t) continue;
    if (isNearDuplicate(t, pool)) continue;
    out.push(t);
    pool.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export function knowledgeFactLine(name: string, nowKnows: string): string {
  return `${name.trim()} now knows: ${clipLine(nowKnows, 180)}`;
}

export function liveCanonHasWork(extract: LiveCanonExtract): boolean {
  return (
    extract.facts.length > 0
    || extract.threads.length > 0
    || !!extract.place?.currentState
    || !!extract.place?.atmosphere
    || extract.knowledge.length > 0
  );
}

/**
 * Canonical existing fact texts that wrap proposed as stale (no longer true).
 * Unmatched proposals are dropped — we only prune what is already on file.
 */
export function selectStaleFactTexts(proposed: string[], existing: string[], cap = 8): string[] {
  const out: string[] = [];
  for (const raw of proposed) {
    const t = clipLine(raw);
    if (!t) continue;
    const hit = existing.find((e) => isNearDuplicate(t, [e]) || isNearDuplicate(e, [t]));
    if (!hit) continue;
    if (out.some((x) => x.toLowerCase() === hit.toLowerCase() || isNearDuplicate(hit, [x]))) continue;
    out.push(hit);
    if (out.length >= cap) break;
  }
  return out;
}

/** False when this knowledge line is already filed as a continuity fact. */
export function knowledgeStillNovel(
  name: string,
  nowKnows: string | undefined,
  existingFacts: string[]
): boolean {
  if (!nowKnows?.trim()) return true;
  const payload = nowKnows.trim();
  const samePersonKnows = existingFacts
    .filter((f) => f.toLowerCase().startsWith(`${name.trim().toLowerCase()} now knows:`))
    .map((f) => f.replace(/^.*?now knows:\s*/i, '').trim());
  return !isNearDuplicate(payload, samePersonKnows);
}

export function normalizeLiveCanonExtract(
  raw: {
    facts?: string[];
    threads?: string[];
    place?: { name?: string; currentState?: string; atmosphere?: string };
    knowledge?: Array<{ name?: string; nowKnows?: string }>;
  },
  opts: {
    existingFacts: string[];
    existingThreads: string[];
    inSceneNames: Set<string>;
    episodeFactCount: number;
  }
): LiveCanonExtract {
  const factRoom = Math.max(0, LIVE_CANON_EPISODE_FACT_BUDGET - Math.max(0, opts.episodeFactCount));
  const facts = novelLines(
    raw.facts ?? [],
    opts.existingFacts,
    Math.min(LIVE_CANON_FACT_CAP, factRoom)
  );
  const threads = novelLines(raw.threads ?? [], opts.existingThreads, LIVE_CANON_THREAD_CAP);

  const knownFacts = [...opts.existingFacts, ...facts];
  const knowledge: LiveCanonKnowledge[] = [];
  for (const k of raw.knowledge ?? []) {
    const name = (k.name ?? '').trim();
    const nowKnows = clipLine(k.nowKnows ?? '', 180);
    if (!name || !nowKnows) continue;
    if (!opts.inSceneNames.has(name.toLowerCase())) continue;
    const line = knowledgeFactLine(name, nowKnows);
    const samePersonKnows = knownFacts
      .filter((f) => f.toLowerCase().startsWith(`${name.toLowerCase()} now knows:`))
      .map((f) => f.replace(/^.*?now knows:\s*/i, '').trim());
    if (isNearDuplicate(nowKnows, samePersonKnows)) continue;
    knowledge.push({ name, nowKnows });
    knownFacts.push(line);
    if (knowledge.length >= KNOWLEDGE_CAP) break;
  }

  return {
    facts,
    threads,
    place: normalizePlacePatch(raw.place),
    knowledge
  };
}
