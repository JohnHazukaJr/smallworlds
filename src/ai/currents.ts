/**
 * Chapter currents: a living outline. Once per chapter the AI drafts a few
 * things already in motion — what people want, what the season brings, what
 * the player's own actions set off — from the story so far. As play goes on,
 * the live-memory pass notes when a current stirs, bends to the player's
 * choices, resolves, or fades. They are stored as plot targets with
 * `source: 'outline'`, so everything that reads plot targets sees them, and
 * the author's own targets always outrank them.
 *
 * Railroading guards, all here:
 * - Currents describe the world, never the player's next move.
 * - The writer is told to let one surface only where a scene touches it.
 * - "Where it could go" is never shown to the writer, only to the author.
 * - Being ignored never fades a current; only what happened moves one.
 *
 * Pure helpers. engine.ts makes the calls and writes the results.
 */

import type { CalendarEvent, Character, CurrentKind, Episode, PlotTarget, StoryStance, World } from '../types';
import { characterImportance } from './characterWeight';

/** Most currents a chapter holds at once. */
export const CURRENTS_CAP = 5;

const KINDS: CurrentKind[] = ['agenda', 'season', 'consequence', 'thread', 'texture'];

function clip(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** On unless the world turned it off. */
export function currentsOn(world: Pick<World, 'ai'>): boolean {
  return world.ai.chapterCurrents !== false;
}

export function isCurrent(t: PlotTarget): boolean {
  return t.source === 'outline';
}

/** Pending currents, oldest first. */
export function liveCurrents(targets: PlotTarget[] | undefined): PlotTarget[] {
  return (targets ?? []).filter((t) => isCurrent(t) && t.status === 'pending' && t.text.trim());
}

/** How many currents, and of what sort, suit how this world plays. */
export function stanceGuide(stance: StoryStance): { min: number; max: number; rule: string } {
  switch (stance) {
    case 'wander':
      return { min: 2, max: 3, rule: 'Texture and people only: the season, the place\'s routines, what people want. No ticking clocks, no crises, no arc.' };
    case 'intimate':
      return { min: 2, max: 3, rule: 'Centre on the people the player is with: their wants, moods, and what is unsaid between them. No outside crisis.' };
    case 'sandbox':
      return { min: 2, max: 3, rule: 'Things to discover: openings, rumours, people with wants. No arc and nothing that must happen.' };
    default:
      return { min: 3, max: 5, rule: 'A soft through-line is welcome. Pressure may build gently, but nothing is fated.' };
  }
}

export function currentsSystem(stance: StoryStance): string {
  const g = stanceGuide(stance);
  return (
    'You keep the living outline for an interactive story. List what is already in motion in the world as the next stretch of story begins. ' +
    `Write ${g.min}–${g.max} currents. ${g.rule} ` +
    'A current is a pressure or possibility in the world, never a plan for the player: do not say what the player will do, should do, or will feel. ' +
    'Every current must grow from something established: a person\'s goal, an open thread, something the player did, a dated event, or the time of year. ' +
    'Prefer a mix: someone acting on their own want; the season or a dated event when there is one; a consequence of the player\'s own actions when there is one. ' +
    'Keep each one chapter-sized. Do not invent major new characters, secrets, or twists. Do not repeat the author\'s targets; currents may support them. ' +
    'Earlier currents that are still alive may carry over (reworded if the story moved them); drop ones the story left behind. ' +
    'could: two or three different places it might lead, none required, at least one that the player could prevent or ignore. ' +
    'Return JSON only: {"currents":[{"text":"<one line, present tense, about the world>","kind":"agenda|season|consequence|thread|texture",' +
    '"who":["<exact names of people driving it>"],"could":["<short>","<short>"]}]}'
  );
}

export interface CurrentsInput {
  world: Pick<World, 'title' | 'bible'>;
  stance: StoryStance;
  /** "Thursday, 12 March, Year 1" */
  today: string;
  /** "March is month 3 of 12" plus any calendar system note. */
  timeOfYear: string;
  dueEvents: Pick<CalendarEvent, 'title' | 'summary' | 'storyDay'>[];
  todayDay: number;
  premise: string;
  authorTargets: string[];
  earlierCurrents: PlotTarget[];
  priorRecap: string;
  meanwhile: string;
  chapterSoFar: string;
  threads: string[];
  people: Character[];
  presentIds: string[];
  playerName: string;
}

function personLine(c: Character, present: boolean): string {
  const s = c.state;
  const bits = [
    c.role ? clip(c.role, 60) : '',
    s.goal ? `wants: ${clip(s.goal, 120)}` : (c.desires ? `wants: ${clip(c.desires, 120)}` : ''),
    s.emotion ? `mood: ${clip(s.emotion, 40)}` : '',
    present ? 'here now' : (s.location ? `at: ${clip(s.location, 60)}` : 'elsewhere')
  ].filter(Boolean);
  return `- ${c.name}${bits.length ? ` (${bits.join('; ')})` : ''}`;
}

export function currentsPrompt(input: CurrentsInput): string {
  const people = input.people
    .filter((c) => !c.isPlayer && c.name.trim() && characterImportance(c) !== 'background')
    .slice(0, 14)
    .map((c) => personLine(c, input.presentIds.includes(c.id)));
  const events = input.dueEvents
    .slice(0, 6)
    .map((e) => {
      const inDays = e.storyDay - input.todayDay;
      const when = inDays <= 0 ? 'today' : inDays === 1 ? 'tomorrow' : `in ${inDays} days`;
      return `- ${clip(e.title, 80)} (${when})${e.summary ? `: ${clip(e.summary, 160)}` : ''}`;
    });
  const earlier = input.earlierCurrents.map((t) => `- ${clip(t.text, 200)}${t.note ? ` (lately: ${clip(t.note, 120)})` : ''}`);
  return [
    `World: ${input.world.title}. ${clip(input.world.bible, 1400)}`,
    input.premise ? `Season premise: ${clip(input.premise, 400)}` : '',
    `Today: ${input.today}. ${input.timeOfYear}`,
    events.length ? `Dated events coming up:\n${events.join('\n')}` : 'No dated events coming up.',
    `The player is ${input.playerName || 'the protagonist'}.`,
    people.length ? `People:\n${people.join('\n')}` : '',
    input.threads.length ? `Open threads:\n${input.threads.slice(0, 10).map((t) => `- ${clip(t, 160)}`).join('\n')}` : '',
    input.authorTargets.length ? `The author's own targets (do not repeat):\n${input.authorTargets.map((t) => `- ${clip(t, 160)}`).join('\n')}` : '',
    input.priorRecap ? `Last chapter:\n${clip(input.priorRecap, 1200)}` : '',
    input.meanwhile ? `Meanwhile, off-screen:\n${input.meanwhile}` : '',
    earlier.length ? `Currents from before (carry, rework, or drop):\n${earlier.join('\n')}` : '',
    input.chapterSoFar ? `This chapter so far:\n${clip(input.chapterSoFar, 3000)}` : ''
  ].filter(Boolean).join('\n\n');
}

interface RawCurrent { text?: unknown; kind?: unknown; who?: unknown; could?: unknown }

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Clean the draft: real lines only, known names only, capped. */
export function cleanCurrents(
  raw: unknown,
  opts: { names: string[]; playerName: string; cap: number; makeId: () => string }
): PlotTarget[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { currents?: unknown }).currents))
    ? (raw as { currents: RawCurrent[] }).currents
    : [];
  const known = new Map(opts.names.map((n) => [n.trim().toLowerCase(), n.trim()]));
  const player = opts.playerName.trim().toLowerCase();
  const seen = new Set<string>();
  const out: PlotTarget[] = [];
  for (const row of list) {
    const text = clip(str(row?.text), 220);
    if (text.length < 12 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const kind = KINDS.includes(str(row.kind) as CurrentKind) ? (str(row.kind) as CurrentKind) : undefined;
    const who = (Array.isArray(row.who) ? row.who : [])
      .map((n) => known.get(str(n).trim().toLowerCase()))
      .filter((n): n is string => !!n && n.toLowerCase() !== player)
      .slice(0, 3);
    const could = (Array.isArray(row.could) ? row.could : [])
      .map((c) => clip(str(c), 140))
      .filter((c) => c.length >= 4)
      .slice(0, 3);
    out.push({
      id: opts.makeId(),
      text,
      status: 'pending',
      source: 'outline',
      ...(kind ? { kind } : {}),
      ...(who.length ? { who } : {}),
      ...(could.length ? { could } : {})
    });
    if (out.length >= opts.cap) break;
  }
  return out;
}

/**
 * The chapter's targets with fresh currents: the author's targets are kept as they
 * are, older pending currents are replaced by the new draft, and settled currents
 * stay as history.
 */
export function withCurrents(targets: PlotTarget[] | undefined, fresh: PlotTarget[]): PlotTarget[] {
  const kept = (targets ?? []).filter((t) => !isCurrent(t) || t.status !== 'pending');
  return [...kept, ...fresh];
}

export type CurrentMove = 'stirred' | 'bent' | 'resolved' | 'faded';

export interface CurrentMoveRow {
  n?: unknown;
  status?: unknown;
  note?: unknown;
  now?: unknown;
}

/** Rules for the live-memory pass. Empty when there is nothing to track. */
export function currentsLiveRules(live: PlotTarget[]): string {
  if (live.length === 0) return '';
  return (
    'currents: only for listed Currents that the Newest beats actually touched, by number n. ' +
    'stirred = it moved a little; bent = the player\'s choices changed its direction (put the reshaped current in now, one line about the world); ' +
    'resolved = it is settled on the page; faded = the player\'s choices made it moot. ' +
    'A current the player has not engaged is untouched: omit it, never mark it faded for being ignored. ' +
    'note: one short clause of what happened. Judge only what happened, never what should.\n'
  );
}

export function currentsLiveList(live: PlotTarget[]): string {
  return live.map((t, i) => `${i + 1}. ${clip(t.text, 200)}`).join('\n');
}

/**
 * Apply what play did to the currents. `live` is the numbered list the pass saw.
 * Returns the new target list, or null when nothing changed.
 */
export function applyCurrentMoves(
  targets: PlotTarget[] | undefined,
  live: PlotTarget[],
  rows: CurrentMoveRow[] | undefined
): PlotTarget[] | null {
  if (!rows?.length || live.length === 0) return null;
  const byId = new Map<string, PlotTarget>();
  for (const row of rows) {
    const n = Math.round(Number(row?.n));
    const target = Number.isFinite(n) ? live[n - 1] : undefined;
    const move = str(row?.status) as CurrentMove;
    if (!target || !['stirred', 'bent', 'resolved', 'faded'].includes(move) || byId.has(target.id)) continue;
    const note = clip(str(row.note), 160);
    const next: PlotTarget = { ...target, ...(note ? { note } : {}) };
    if (move === 'resolved') next.status = 'hit';
    else if (move === 'faded') next.status = 'dropped';
    else if (move === 'bent') {
      const now = clip(str(row.now), 220);
      if (now.length >= 12) next.text = now;
    }
    if (next.text === target.text && next.status === target.status && next.note === target.note) continue;
    byId.set(target.id, next);
  }
  if (byId.size === 0) return null;
  return (targets ?? []).map((t) => byId.get(t.id) ?? t);
}

/** What the writer sees. No "could": the writer never gets a direction to steer toward. */
export function currentsWriterSection(targets: PlotTarget[] | undefined): string | null {
  const live = liveCurrents(targets).slice(0, CURRENTS_CAP);
  if (live.length === 0) return null;
  const lines = live.map((t) =>
    `- ${clip(t.text, 220)}${t.who?.length ? ` (${t.who.join(', ')})` : ''}${t.note ? ` — lately: ${clip(t.note, 140)}` : ''}`
  );
  return [
    '## In motion (hidden from the player; pressures, not a script)',
    'Things already moving in the world. The player\'s choices come first, always.',
    '- Let a current surface only where the scene naturally touches it: a remark, a detail, someone acting on their own want.',
    '- Never steer the player toward one, never make the player\'s character pursue one, and never resolve one for them.',
    '- If the player is somewhere else, a current keeps moving off-stage; it follows them only if it plausibly would.',
    '- At most one current shows in a single reply. None is fine.',
    ...lines
  ].join('\n');
}

/** Earlier-chapter currents still worth carrying: pending ones only. */
export function carriedCurrents(episode: Pick<Episode, 'plotTargets'> | null | undefined): PlotTarget[] {
  return liveCurrents(episode?.plotTargets);
}

/** "March is month 3 of 12." plus the world's calendar note. */
export function timeOfYearLine(monthName: string, monthIndex: number, monthCount: number, system: string): string {
  const base = `${monthName} is month ${monthIndex + 1} of ${monthCount}.`;
  return system.trim() ? `${base} Calendar: ${clip(system, 300)}` : base;
}
