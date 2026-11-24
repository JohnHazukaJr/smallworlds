/**
 * Off-screen life: when a chapter ends, the people who were not in it get a
 * turn too. Each acts on their own goal over the gap, and may hear about what
 * happened in the chapter from someone who was there. Their card moves with
 * them (place, goal, mood) and they remember it, so the next chapter meets a
 * world that kept going.
 *
 * Pure helpers. engine.ts makes the call and writes the results.
 */

import type { Character, OffscreenBeat, World } from '../types';
import { characterImportance } from './characterWeight';
import { speakLeaksMustNotKnow } from './knowledgeWall';
import { recallMemories } from '../npcMemory';
import type { MemoryDraft } from '../npcMemory';

/** Most people who get an off-screen turn per chapter. */
export const OFFSCREEN_CAP = 4;

const IMPORTANCE_SCORE: Record<string, number> = { lead: 3, regular: 2, occasional: 1, background: -10 };

function clip(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** On unless the world turned it off. */
export function offscreenLifeOn(world: Pick<World, 'ai'>): boolean {
  return world.ai.offscreenLife !== false;
}

/**
 * Who moves while the player is away: absent people who matter, those with a
 * live goal first, and those the chapter talked about.
 */
export function pickOffscreenCast(
  characters: Character[],
  presentIds: string[],
  chapterText: string,
  cap = OFFSCREEN_CAP
): Character[] {
  const present = new Set(presentIds);
  const text = chapterText.toLowerCase();
  return characters
    .filter((c) => !c.isPlayer && !present.has(c.id) && c.name.trim())
    .map((c) => {
      const importance = characterImportance(c);
      const goal = !!c.state?.goal?.trim();
      // Occasional people only move when they have somewhere to go.
      if (importance === 'background' || (importance === 'occasional' && !goal)) return null;
      const named = [c.name, ...(c.aliases ?? [])].some((n) => n.trim().length >= 3 && text.includes(n.trim().toLowerCase()));
      const score = (IMPORTANCE_SCORE[importance] ?? 2) + (goal ? 2 : 0) + (named ? 1.5 : 0) +
        (c.relationships?.length ? 0.5 : 0);
      return { c, score };
    })
    .filter((row): row is { c: Character; score: number } => !!row)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .slice(0, cap)
    .map((row) => row.c);
}

/** "the same night" / "overnight" / "3 days". */
export function gapPhrase(days: number): string {
  if (days <= 0) return 'a few hours, the same night';
  if (days === 1) return 'overnight, about a day';
  if (days < 14) return `${days} days`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks`;
  return `about ${Math.round(days / 30)} months`;
}

function personBlock(c: Character, everyone: Character[], recallQuery: string): string {
  const nameOf = (id: string) => everyone.find((x) => x.id === id)?.name;
  const ties = (c.relationships ?? [])
    .map((r) => {
      const who = nameOf(r.targetId);
      return who ? `${r.kind} of ${who}${r.note ? ` (${clip(r.note, 80)})` : ''}` : '';
    })
    .filter(Boolean)
    .slice(0, 5);
  const memories = recallMemories(c.memories, recallQuery, 3).map((m) => clip(m.text, 140));
  return [
    `### ${c.name}${c.role ? ` — ${clip(c.role, 80)}` : ''}`,
    c.state.goal ? `wants now: ${clip(c.state.goal, 160)}` : '',
    c.state.emotion ? `mood: ${clip(c.state.emotion, 60)}` : '',
    c.state.location ? `last seen: ${clip(c.state.location, 80)}` : '',
    c.state.condition ? `condition: ${clip(c.state.condition, 80)}` : '',
    c.desires ? `deeper want: ${clip(c.desires, 160)}` : '',
    c.fears ? `fears: ${clip(c.fears, 120)}` : '',
    c.traits ? `nature: ${clip(c.traits, 120)}` : '',
    c.secrets ? `keeps secret: ${clip(c.secrets, 200)}` : '',
    ties.length ? `ties: ${ties.join('; ')}` : '',
    memories.length ? `remembers: ${memories.join(' / ')}` : '',
    c.mustNotKnow ? `MUST NOT LEARN: ${clip(c.mustNotKnow, 200)}` : ''
  ].filter(Boolean).join('\n');
}

export const OFFSCREEN_SYSTEM =
  'You decide what people did off-stage between two chapters of an interactive story. ' +
  'For each person listed: one concrete thing they did over the gap in pursuit of what they want, true to their nature. ' +
  'Keep it small enough that it does not resolve the main story or anything the player is pursuing; it may set up something the player could meet later. ' +
  'Only move someone to the player\'s place if their goal clearly takes them there. ' +
  'Then, only if plausible, what news of this chapter reached them: they were nearby, or someone who was there would tell them (say who). ' +
  'Never let anyone learn what is listed under MUST NOT LEARN. Do not invent new named people. ' +
  'Return JSON only: {"people":[{"name":"<exact name>","did":"<one sentence, past tense>",' +
  '"location":"<where they are now; use a listed place name when one fits>","goal":"<what they want now, or empty if unchanged>",' +
  '"emotion":"<a word or two, or empty>","heard":"<what they heard and from whom, or empty>",' +
  '"feeling":"<how it left them>","salience":1}]}. Salience: 1 passing, 2 notable, 3 unforgettable.';

export function offscreenPrompt(opts: {
  world: Pick<World, 'title' | 'bible'>;
  movers: Character[];
  everyone: Character[];
  presentNames: string[];
  placeNames: string[];
  recap: string;
  gapDays: number;
}): string {
  const query = opts.recap;
  return [
    `World: ${opts.world.title}. ${clip(opts.world.bible, 1500)}`,
    opts.placeNames.length ? `Places: ${opts.placeNames.slice(0, 30).join(', ')}` : '',
    `Time before the next chapter: ${gapPhrase(opts.gapDays)}.`,
    '',
    `## The chapter that just ended (these people were there: ${opts.presentNames.join(', ') || 'the player alone'})`,
    clip(opts.recap, 2000),
    '',
    '## People who were elsewhere',
    ...opts.movers.map((c) => personBlock(c, opts.everyone, query))
  ].filter((l) => l !== '').join('\n');
}

export interface OffscreenResult {
  character: Character;
  beat: OffscreenBeat;
  state: { goal?: string; emotion?: string; location?: string };
  memories: MemoryDraft[];
}

interface RawPerson {
  name?: unknown;
  did?: unknown;
  location?: unknown;
  goal?: unknown;
  emotion?: unknown;
  heard?: unknown;
  feeling?: unknown;
  salience?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const EMPTY = /^(none|n\/a|nothing|unchanged|empty|-|—)\.?$/i;
const filled = (v: unknown, max: number) => {
  const t = clip(str(v), max);
  return t && !EMPTY.test(t) ? t : '';
};

/**
 * Keep only people we asked about, one entry each, with a real action. Heard
 * news that would break a must-not-know wall is dropped, not softened.
 */
export function cleanOffscreen(raw: unknown, movers: Character[]): OffscreenResult[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { people?: unknown }).people))
    ? (raw as { people: RawPerson[] }).people
    : [];
  const out: OffscreenResult[] = [];
  const done = new Set<string>();
  for (const row of list) {
    const name = str(row?.name).trim().toLowerCase();
    if (!name) continue;
    const c = movers.find((m) =>
      m.name.trim().toLowerCase() === name ||
      (m.aliases ?? []).some((a) => a.trim().toLowerCase() === name)
    );
    if (!c || done.has(c.id)) continue;
    const did = filled(row.did, 240);
    if (did.length < 8) continue;
    done.add(c.id);

    let heard = filled(row.heard, 220);
    if (heard && c.mustNotKnow?.trim() && speakLeaksMustNotKnow(heard, c.mustNotKnow)) heard = '';
    const feeling = filled(row.feeling, 40);
    const salience = Math.max(1, Math.min(3, Math.round(Number(row.salience) || 1)));

    const memories: MemoryDraft[] = [{ text: did, feeling, salience: Math.min(salience, 2) }];
    if (heard) memories.push({ text: `Heard: ${heard}`, feeling, salience });

    const state: OffscreenResult['state'] = {};
    const location = filled(row.location, 80);
    const goal = filled(row.goal, 160);
    const emotion = filled(row.emotion, 40);
    if (location) state.location = location;
    if (goal) state.goal = goal;
    if (emotion) state.emotion = emotion;

    out.push({
      character: c,
      beat: { characterId: c.id, name: c.name, did, ...(heard ? { heard } : {}) },
      state,
      memories
    });
  }
  return out;
}

/** The lines the next chapter's writer reads. */
export function offscreenLines(beats: OffscreenBeat[] | undefined, max = OFFSCREEN_CAP): string {
  return (beats ?? [])
    .slice(0, max)
    .map((b) => `- ${b.name}: ${clip(b.did, 240)}${b.heard ? ` (Heard: ${clip(b.heard, 200)})` : ''}`)
    .join('\n');
}

/** "Brannoc Hale and Sister Ilse" / "A, B, and C". Full names: a first word may be a title. */
export function namesPhrase(names: string[]): string {
  const first = names.map((n) => n.trim()).filter(Boolean);
  if (first.length <= 1) return first[0] ?? '';
  if (first.length === 2) return `${first[0]} and ${first[1]}`;
  return `${first.slice(0, -1).join(', ')}, and ${first[first.length - 1]}`;
}
