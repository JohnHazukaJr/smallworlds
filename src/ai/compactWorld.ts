/**
 * Fork an existing world into a new volume: rewrite bible/sheets/memory from canon,
 * persist a fresh Season 1 · Episode 1 with no transcript. Source world is never mutated.
 */
import { activeCalendarEvents, emptyCalendarEvent } from '../calendarEvents';
import { db, exportWorld, guardStorage, uid, type WorldExport } from '../db';
import { normalizeRelationships } from '../relationships';
import type {
  CalendarEvent, Character, CharacterState, ContinuityFact, Episode, EpisodeGuest,
  Location, OpenThread, PlotTarget, Relationship, Season, Turn, World
} from '../types';
import { CALENDAR_EVENT_CAP } from '../types';
import { calendarPatch, PLOT_TARGET_CAP, worldCalendar } from '../worldOps';
import { isContextOverflowError, streamChat } from './client';
import { utilityModelFor } from './models';
import { utilityCall } from './utilityCall';

export const VOLUME_DIGEST_SYSTEM =
  'You compress a longform interactive-fiction world into a canon digest for a new volume. ' +
  'Keep proper nouns, places, debts, revelations, injuries, promises, and who knows what. ' +
  'Stay highly specific. Do not flatten into themes. Do not invent people or places. ' +
  'Secrets stay secrets (note that they exist without spoiling them as public fact). ' +
  'Return only the digest.';

export const VOLUME_RECAP_SYSTEM =
  'You write a dense "previously on this world" recap for a new volume of longform interactive fiction. ' +
  '800–1400 words. Keep proper nouns, debts, injuries, promises, and revelations. ' +
  'Do not invent. Do not dump example lines or speech style. Secrets stay secrets. Return only the recap.';

export const VOLUME_LORE_SYSTEM =
  'You rewrite a story world as the opening of a new volume. Lived history is now established fact. ' +
  'Keep proper nouns and debts. Do not invent people or places. Do not soften behaviour anchors. ' +
  'Do not dump example lines into the bible. Secrets stay secrets. MUST NOT KNOW stays private. ' +
  'Call return_json. Do not write prose.';

export const VOLUME_CHARACTER_BATCH_SYSTEM =
  'You rewrite character sheets for a new volume so they describe who these people are NOW. ' +
  'Do not invent new people. Do not add unnamed NPCs. Match exact names from the batch. ' +
  'Do not soften anchors. Keep MUST NOT KNOW. Voice, appearance, and example-line rhythm stay ' +
  'unless the story earned a change. Backstory absorbs prior volume as history. ' +
  'Call return_json. Do not write prose.';

export const VOLUME_LOCATION_BATCH_SYSTEM =
  'You rewrite location sheets for a new volume: current state plus what happened there. ' +
  'Do not invent new places. Match exact names from the batch. Keep hard rules. ' +
  'Call return_json. Do not write prose.';

export const VOLUME_MEMORY_SYSTEM =
  'You distill a world memory ledger for a new volume. Keep pinned facts. Merge duplicates. ' +
  'Drop trivia and resolved threads. Do not invent. Call return_json. Do not write prose.';

const UTILITY_TIMEOUT_MS = 45_000;
const VOLUME_TIMEOUT_MS = 90_000;
const EPISODE_DIRECT_CHARS = 6000;
const CORPUS_DIRECT_CHARS = 48_000;
const CORPUS_HARD_CHARS = 60_000;
const CHAR_BATCH = 3;
const LOC_BATCH = 4;
const FACT_CAP = 40;

export type CompactProgress = (label: string) => void;

export interface CompactWorldOpts {
  onProgress?: CompactProgress;
  signal?: AbortSignal;
}

export interface CompactedGraph {
  world: World;
  season: Season;
  episode: Episode;
  characters: Character[];
  locations: Location[];
  continuity: ContinuityFact[];
  threads: OpenThread[];
  calendarEvents: CalendarEvent[];
}

export interface CharacterVolumePatch {
  name: string;
  role?: string;
  age?: string;
  appearance?: string;
  mannerisms?: string;
  backstory?: string;
  summary?: string;
  speechStyle?: string;
  exampleLines?: string[];
  traits?: string;
  desires?: string;
  fears?: string;
  flaws?: string;
  secrets?: string;
  mustNotKnow?: string;
  anchors?: string[];
  state?: Partial<CharacterState>;
  relationships?: { targetName?: string; kind?: string; note?: string }[];
}

export interface LocationVolumePatch {
  name: string;
  tagline?: string;
  summary?: string;
  atmosphere?: string;
  features?: string;
  history?: string;
  inhabitants?: string;
  rules?: string[];
  secrets?: string;
  currentState?: string;
}

export interface VolumeLore {
  line?: string;
  bible?: string;
  premise?: string;
  timeGap?: string;
  storyDay?: number;
  dateNote?: string;
  openingLocationName?: string;
  openingCastNames?: string[];
  atmosphereNote?: string;
  offscreenChanges?: string;
  plotTargets?: string[];
}

export interface VolumeMemory {
  facts?: { text?: string; pinned?: boolean }[];
  threads?: { text?: string; pinned?: boolean }[];
  plotTargets?: string[];
}

export interface VolumeDistill {
  recap: string;
  lore: VolumeLore;
  characters: CharacterVolumePatch[];
  locations: LocationVolumePatch[];
  memory: VolumeMemory;
}

export function nextVolumeTitle(title: string): string {
  const trimmed = title.trim() || 'Untitled world';
  const hit = trimmed.match(/^(.*?)\s*·\s*Vol\.\s*(\d+)\s*$/i);
  if (hit) {
    const n = Number(hit[2]);
    const base = hit[1].trim() || 'Untitled world';
    return `${base} · Vol. ${Number.isFinite(n) && n >= 1 ? n + 1 : 2}`;
  }
  return `${trimmed} · Vol. 2`;
}

export function calendarEventsForVolume(events: CalendarEvent[], newStoryDay = 1): CalendarEvent[] {
  const day = Math.max(1, Math.floor(newStoryDay));
  return activeCalendarEvents(events)
    .filter((ev) => ev.status === 'due' || (ev.endDay ?? ev.storyDay) >= day)
    .slice()
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
      return a.storyDay - b.storyDay;
    })
    .slice(0, CALENDAR_EVENT_CAP);
}

export function factsSeedForVolume(facts: ContinuityFact[], cap = FACT_CAP): ContinuityFact[] {
  const pinned = facts.filter((f) => f.pinned && f.text.trim());
  const rest = facts
    .filter((f) => !f.pinned && f.text.trim())
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const out = [...pinned];
  for (const f of rest) {
    if (out.length >= cap) break;
    out.push(f);
  }
  return out;
}

export function threadsSeedForVolume(threads: OpenThread[]): OpenThread[] {
  return threads.filter((t) => t.status === 'open' && t.text.trim());
}

/** Pinned source facts always appear in the distilled list (AI may rephrase extras). */
export function mergePinnedFactTexts(
  aiFacts: { text?: string; pinned?: boolean }[],
  sourcePinned: ContinuityFact[]
): { text: string; pinned: boolean }[] {
  const out: { text: string; pinned: boolean }[] = [];
  const seen = new Set<string>();
  const push = (text: string, pinned: boolean) => {
    const t = text.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, pinned });
  };
  for (const f of sourcePinned) push(f.text, true);
  for (const f of aiFacts) push(f.text ?? '', !!f.pinned);
  return out.slice(0, FACT_CAP);
}

export function findByName<T>(name: string, items: T[], getName: (item: T) => string): T | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return items.find((item) => getName(item).trim().toLowerCase() === key);
}

function pickText(next: string | undefined, prev: string): string {
  const n = (next ?? '').trim();
  return n || prev;
}

function pickLines(next: string[] | undefined, prev: string[]): string[] {
  if (!next || next.length === 0) return prev;
  const cleaned = next.map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : prev;
}

export function remapRelationships(
  rels: Relationship[],
  idMap: Map<string, string>
): Relationship[] {
  const out: Relationship[] = [];
  for (const r of rels) {
    const targetId = idMap.get(r.targetId);
    if (!targetId) continue;
    out.push({ targetId, kind: r.kind, note: r.note });
  }
  return out;
}

function withTimeoutSignal(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  const timer = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  };
}

async function utilityJson<T>(
  world: World | null,
  system: string,
  user: string,
  maxTokens = 3000,
  signal?: AbortSignal,
  timeoutMs = UTILITY_TIMEOUT_MS
): Promise<T> {
  return utilityCall<T>({
    world, system, user, maxTokens, signal, timeoutMs, job: 'wrap'
  });
}

async function withOverflowRetry<T>(run: (tight: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(false);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    if (!isContextOverflowError(e)) throw e;
    return run(true);
  }
}

function labelTurn(t: Turn, characters: Character[], guests: EpisodeGuest[] = []): string {
  if (t.role === 'user') return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
  if (t.role === 'character') {
    const name = t.guestId
      ? (guests.find((g) => g.id === t.guestId)?.name ?? 'Walk-on')
      : (characters.find((c) => c.id === t.characterId)?.name ?? 'NPC');
    return `[${name}]: ${t.text}`;
  }
  return `[narrator]: ${t.text}`;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function sheetSnapshot(characters: Character[], locations: Location[]): string {
  const cast = characters.map((c) => ({
    name: c.name,
    role: c.role,
    summary: c.summary,
    state: c.state,
    secrets: c.secrets,
    mustNotKnow: c.mustNotKnow,
    anchors: c.anchors
  }));
  const places = locations.map((l) => ({
    name: l.name,
    summary: l.summary,
    currentState: l.currentState,
    rules: l.rules
  }));
  return `Cast now:\n${JSON.stringify(cast, null, 2)}\n\nPlaces now:\n${JSON.stringify(places, null, 2)}`;
}

export function buildStaticCanon(source: WorldExport, tight: boolean): string {
  const seasons = [...source.seasons].sort((a, b) => a.number - b.number);
  const episodes = [...source.episodes].sort((a, b) => a.number - b.number);
  const parts: string[] = [];
  parts.push(`World: ${source.world.title} — ${source.world.line}`);
  parts.push(`Bible:\n${clip(source.world.bible, tight ? 1800 : 6000)}`);
  for (const s of seasons) {
    parts.push(
      `Season ${s.number} premise: ${s.premise || '(none)'}` +
      (s.timeGap ? ` (opens after ${s.timeGap})` : '')
    );
    if (s.bible?.recap) parts.push(`Season ${s.number} recap:\n${clip(s.bible.recap, tight ? 600 : 1600)}`);
    if (s.bible?.carriedBeats?.length) {
      parts.push(
        `Season ${s.number} carried beats:\n` +
        s.bible.carriedBeats.map((b) => `- [${b.disposition}] ${b.text} → ${b.consequence}`).join('\n')
      );
    }
    if (s.bible?.offscreenChanges) parts.push(`Off-screen:\n${clip(s.bible.offscreenChanges, 800)}`);
  }
  for (const ep of episodes) {
    const wrap = ep.wrap;
    if (!wrap?.recap && !(wrap?.beats?.length)) continue;
    const sn = seasons.find((s) => s.id === ep.seasonId)?.number ?? '?';
    const guests = (wrap.guestEffects ?? []).filter(Boolean);
    parts.push(
      `S${sn} E${ep.number}${ep.title ? ` — ${ep.title}` : ''} wrap:\n${clip(wrap.recap ?? '', tight ? 400 : 1200)}` +
      (wrap.beats?.length
        ? `\nBeats:\n${wrap.beats.map((b) => `- ${b.text} → ${b.consequence}`).join('\n')}`
        : '') +
      (guests.length ? `\nWalk-on effects:\n${guests.map((g) => `- ${g}`).join('\n')}` : '')
    );
  }
  const pinned = source.continuity.filter((f) => f.pinned);
  const facts = factsSeedForVolume(source.continuity);
  parts.push(
    `Pinned facts:\n${pinned.map((f) => `- ${f.text}`).join('\n') || '(none)'}\n\n` +
    `Continuity (capped):\n${facts.map((f) => `- ${f.text}`).join('\n') || '(none)'}`
  );
  const open = threadsSeedForVolume(source.threads);
  parts.push(`Open threads:\n${open.map((t) => `- ${t.text}`).join('\n') || '(none)'}`);
  const cal = calendarEventsForVolume(source.calendarEvents ?? [], source.world.calendar?.currentDay ?? 1);
  parts.push(
    `Upcoming / due calendar:\n` +
    (cal.map((e) => `- D${e.storyDay} ${e.title}: ${clip(e.summary, 120)}`).join('\n') || '(none)')
  );
  parts.push(sheetSnapshot(source.characters, source.locations ?? []));
  return parts.join('\n\n');
}

async function summarizeEpisode(
  world: World,
  ep: Episode,
  characters: Character[],
  signal?: AbortSignal
): Promise<string> {
  const turns = (await db.turns.where('episodeId').equals(ep.id).sortBy('createdAt')) as Turn[];
  if (turns.length === 0) {
    if (ep.wrap?.recap?.trim()) return `Episode ${ep.number} wrap: ${ep.wrap.recap.trim()}`;
    return '';
  }
  const guests = ep.guests ?? [];
  const text = turns.map((t) => labelTurn(t, characters, guests)).join('\n\n');
  const heading = `Episode ${ep.number}${ep.title ? ` (${ep.title})` : ''}`;
  if (text.length < EPISODE_DIRECT_CHARS) return `${heading}:\n${text}`;
  const { provider, model } = utilityModelFor(world);
  const { signal: timed, cancel } = withTimeoutSignal(signal, UTILITY_TIMEOUT_MS);
  try {
    const { text: summary } = await streamChat({
      provider, model,
      system:
        'Summarize this story episode in 150-250 words, keeping every event that could matter later: ' +
        'decisions, revelations, injuries, promises, relationship shifts, proper nouns.',
      messages: [{ role: 'user', content: text.slice(0, 48_000) }],
      maxTokens: 800, temperature: 0.3, signal: timed, job: 'wrap'
    });
    return `${heading} (summary):\n${summary}`;
  } catch (e) {
    if (isContextOverflowError(e)) {
      return `${heading} (clipped):\n${text.slice(0, 4000)}`;
    }
    throw e;
  } finally {
    cancel();
  }
}

async function buildCanonDigest(
  source: WorldExport,
  progress: CompactProgress,
  signal?: AbortSignal,
  tight = false
): Promise<string> {
  const staticCanon = buildStaticCanon(source, tight);
  if (tight) return clip(staticCanon, CORPUS_HARD_CHARS);

  progress('Reading episodes…');
  const seasons = [...source.seasons].sort((a, b) => a.number - b.number);
  const episodeBlocks: string[] = [];
  for (const season of seasons) {
    const eps = source.episodes.filter((e) => e.seasonId === season.id).sort((a, b) => a.number - b.number);
    for (const ep of eps) {
      const block = await summarizeEpisode(source.world, ep, source.characters, signal);
      if (block) episodeBlocks.push(`Season ${season.number} · ${block}`);
    }
  }
  let corpus = `${staticCanon}\n\n---\n\n${episodeBlocks.join('\n\n---\n\n')}`;
  if (corpus.length <= CORPUS_DIRECT_CHARS) return corpus;

  progress('Compressing canon…');
  const { provider, model } = utilityModelFor(source.world);
  const { signal: timed, cancel } = withTimeoutSignal(signal, VOLUME_TIMEOUT_MS);
  try {
    const { text } = await streamChat({
      provider, model,
      system: VOLUME_DIGEST_SYSTEM,
      messages: [{ role: 'user', content: clip(corpus, CORPUS_HARD_CHARS) }],
      maxTokens: 2200, temperature: 0.3, signal: timed, job: 'wrap'
    });
    return text.trim() || clip(corpus, CORPUS_HARD_CHARS);
  } finally {
    cancel();
  }
}

function resolveOpening(
  source: WorldExport,
  lore: VolumeLore,
  newChars: Character[],
  newLocs: Location[],
  charIdMap: Map<string, string>,
  locIdMap: Map<string, string>
): { location: string; locationId: string | null; castIds: string[] } {
  const player = newChars.find((c) => c.isPlayer);
  const namedLoc = lore.openingLocationName
    ? findByName(lore.openingLocationName, newLocs, (l) => l.name)
    : undefined;
  const lastEp = [...source.episodes].sort((a, b) => {
    if (a.seasonId !== b.seasonId) return 0;
    return b.number - a.number;
  }).sort((a, b) => {
    const sa = source.seasons.find((s) => s.id === a.seasonId)?.number ?? 0;
    const sb = source.seasons.find((s) => s.id === b.seasonId)?.number ?? 0;
    return sb - sa || b.number - a.number;
  })[0];
  const fallbackLoc = lastEp?.locationId ? newLocs.find((l) => l.id === locIdMap.get(lastEp.locationId!)) : undefined;
  const loc = namedLoc ?? fallbackLoc ?? newLocs[0];

  const namedCast = (lore.openingCastNames ?? [])
    .map((n) => findByName(n, newChars, (c) => c.name))
    .filter((c): c is Character => !!c);
  const lastCast = (lastEp?.castIds ?? [])
    .map((oldId) => newChars.find((c) => c.id === charIdMap.get(oldId)))
    .filter((c): c is Character => !!c);
  const cast: Character[] = [];
  const seen = new Set<string>();
  const push = (c: Character | undefined) => {
    if (!c || seen.has(c.id)) return;
    seen.add(c.id);
    cast.push(c);
  };
  push(player);
  for (const c of namedCast) push(c);
  if (cast.length <= 1) for (const c of lastCast) push(c);
  if (cast.length <= 1) for (const c of newChars.filter((x) => !x.isPlayer).slice(0, 4)) push(c);

  return {
    location: loc?.name ?? lastEp?.location ?? '',
    locationId: loc?.id ?? null,
    castIds: cast.map((c) => c.id)
  };
}

function applyCharacterPatch(
  source: Character,
  patch: CharacterVolumePatch | undefined,
  newId: string,
  worldId: string,
  now: number
): Omit<Character, 'relationships'> & { relationships: Relationship[] } {
  const p = patch;
  const state: CharacterState = {
    goal: pickText(p?.state?.goal, source.state.goal),
    emotion: pickText(p?.state?.emotion, source.state.emotion),
    location: pickText(p?.state?.location, source.state.location),
    condition: pickText(p?.state?.condition, source.state.condition)
  };
  return {
    ...source,
    id: newId,
    worldId,
    role: pickText(p?.role, source.role),
    age: pickText(p?.age, source.age),
    appearance: pickText(p?.appearance, source.appearance),
    mannerisms: pickText(p?.mannerisms, source.mannerisms),
    backstory: pickText(p?.backstory, source.backstory),
    summary: pickText(p?.summary, source.summary),
    speechStyle: pickText(p?.speechStyle, source.speechStyle),
    exampleLines: pickLines(p?.exampleLines, source.exampleLines),
    traits: pickText(p?.traits, source.traits),
    desires: pickText(p?.desires, source.desires),
    fears: pickText(p?.fears, source.fears),
    flaws: pickText(p?.flaws, source.flaws),
    secrets: pickText(p?.secrets, source.secrets),
    mustNotKnow: pickText(p?.mustNotKnow, source.mustNotKnow),
    anchors: pickLines(p?.anchors, source.anchors),
    state,
    relationships: source.relationships,
    createdAt: now,
    updatedAt: now
  };
}

export function assembleCompactedWorld(
  source: WorldExport,
  distill: VolumeDistill,
  opts?: { now?: number; uid?: () => string }
): CompactedGraph {
  const now = opts?.now ?? Date.now();
  const makeId = opts?.uid ?? uid;
  const worldId = makeId();
  const seasonId = makeId();
  const episodeId = makeId();
  const cal = worldCalendar(source.world);
  const storyDayRaw = Number(distill.lore.storyDay);
  const storyDay = Number.isFinite(storyDayRaw) && storyDayRaw >= 1
    ? Math.floor(storyDayRaw)
    : cal.currentDay;

  const charIdMap = new Map<string, string>();
  for (const c of source.characters) charIdMap.set(c.id, makeId());
  const locIdMap = new Map<string, string>();
  for (const l of source.locations ?? []) locIdMap.set(l.id, makeId());

  const patchesByName = distill.characters;
  const locPatches = distill.locations;

  const draftedChars = source.characters.map((c) => {
    const patch = findByName(c.name, patchesByName, (p) => p.name);
    return applyCharacterPatch(c, patch, charIdMap.get(c.id)!, worldId, now);
  });

  const newChars: Character[] = draftedChars.map((c) => {
    const patch = findByName(c.name, patchesByName, (p) => p.name);
    const incoming: Relationship[] = [];
    for (const r of patch?.relationships ?? []) {
      const target = findByName(r.targetName ?? '', draftedChars, (x) => x.name);
      if (!target) continue;
      incoming.push({
        targetId: target.id,
        kind: (r.kind ?? '').trim() || 'linked',
        note: r.note ?? ''
      });
    }
    const rels = incoming.length > 0
      ? incoming
      : remapRelationships(c.relationships, charIdMap);
    return {
      ...c,
      relationships: normalizeRelationships(rels, draftedChars.map((x) => x.id), c.id)
    };
  });

  const newLocs: Location[] = (source.locations ?? []).map((l) => {
    const p = findByName(l.name, locPatches, (x) => x.name);
    return {
      ...l,
      id: locIdMap.get(l.id)!,
      worldId,
      tagline: pickText(p?.tagline, l.tagline),
      summary: pickText(p?.summary, l.summary),
      atmosphere: pickText(p?.atmosphere, l.atmosphere),
      features: pickText(p?.features, l.features),
      history: pickText(p?.history, l.history),
      inhabitants: pickText(p?.inhabitants, l.inhabitants),
      rules: pickLines(p?.rules, l.rules),
      secrets: pickText(p?.secrets, l.secrets),
      currentState: pickText(p?.currentState, l.currentState),
      createdAt: now,
      updatedAt: now
    };
  });

  const opening = resolveOpening(source, distill.lore, newChars, newLocs, charIdMap, locIdMap);
  const pinnedSource = source.continuity.filter((f) => f.pinned);
  const factRows = mergePinnedFactTexts(distill.memory.facts ?? [], pinnedSource);
  const continuity: ContinuityFact[] = factRows.map((f) => ({
    id: makeId(),
    worldId,
    seasonId,
    episodeId,
    text: f.text,
    source: 'auto' as const,
    pinned: f.pinned,
    createdAt: now,
    updatedAt: now
  }));

  const pinnedThreads = threadsSeedForVolume(source.threads).filter((t) => t.pinned);
  const aiThreads = (distill.memory.threads ?? [])
    .map((t) => ({ text: (t.text ?? '').trim(), pinned: !!t.pinned }))
    .filter((t) => t.text);
  const threadSeen = new Set<string>();
  const threadRows: { text: string; pinned: boolean }[] = [];
  const pushThread = (text: string, pinned: boolean) => {
    const key = text.toLowerCase();
    if (threadSeen.has(key)) return;
    threadSeen.add(key);
    threadRows.push({ text, pinned });
  };
  for (const t of pinnedThreads) pushThread(t.text, true);
  for (const t of aiThreads) pushThread(t.text, t.pinned);

  const threads: OpenThread[] = threadRows.map((t) => ({
    id: makeId(),
    worldId,
    seasonId,
    text: t.text,
    openedLabel: 'Vol. open',
    status: 'open' as const,
    pinned: t.pinned,
    createdAt: now,
    updatedAt: now
  }));

  const plotTexts = [
    ...(distill.lore.plotTargets ?? []),
    ...(distill.memory.plotTargets ?? [])
  ].map((t) => t.trim()).filter(Boolean);
  const plotSeen = new Set<string>();
  const plotTargets: PlotTarget[] = [];
  for (const text of plotTexts) {
    const key = text.toLowerCase();
    if (plotSeen.has(key)) continue;
    plotSeen.add(key);
    plotTargets.push({ id: makeId(), text, status: 'pending', source: 'season-raise' });
    if (plotTargets.length >= PLOT_TARGET_CAP) break;
  }
  if (plotTargets.length === 0) {
    const active = source.seasons.find((s) => s.status === 'active') ?? [...source.seasons].sort((a, b) => b.number - a.number)[0];
    for (const t of active?.plotTargets ?? []) {
      if (t.status !== 'pending' || !t.text.trim()) continue;
      plotTargets.push({ id: makeId(), text: t.text.trim(), status: 'pending', source: 'carried' });
      if (plotTargets.length >= PLOT_TARGET_CAP) break;
    }
  }

  const world: World = {
    ...source.world,
    id: worldId,
    title: nextVolumeTitle(source.world.title),
    line: pickText(distill.lore.line, source.world.line),
    bible: pickText(distill.lore.bible, source.world.bible),
    activeSeasonId: seasonId,
    calendar: calendarPatch(source.world, { currentDay: storyDay }),
    createdAt: now,
    updatedAt: now
  };

  const season: Season = {
    id: seasonId,
    worldId,
    number: 1,
    title: '',
    premise: pickText(distill.lore.premise, source.seasons.find((s) => s.status === 'active')?.premise ?? ''),
    timeGap: pickText(distill.lore.timeGap, 'A new volume'),
    bible: {
      recap: distill.recap.trim(),
      carriedBeats: [],
      offscreenChanges: (distill.lore.offscreenChanges ?? '').trim()
    },
    plotTargets: plotTargets.length > 0 ? plotTargets : undefined,
    status: 'active',
    createdAt: now,
    updatedAt: now
  };

  const episode: Episode = {
    id: episodeId,
    seasonId,
    worldId,
    number: 1,
    title: '',
    location: opening.location,
    locationId: opening.locationId,
    atmosphereNote: (distill.lore.atmosphereNote ?? '').trim() || undefined,
    castIds: opening.castIds,
    storyDay,
    storyDayEnd: null,
    dateNote: (distill.lore.dateNote ?? '').trim() || null,
    status: 'active',
    createdAt: now,
    updatedAt: now
  };

  const calendarEvents: CalendarEvent[] = calendarEventsForVolume(source.calendarEvents ?? [], storyDay).map((ev) =>
    emptyCalendarEvent(worldId, seasonId, {
      title: ev.title,
      summary: ev.summary,
      kind: ev.kind,
      scale: ev.scale,
      storyDay: ev.storyDay,
      endDay: ev.endDay,
      visibility: ev.visibility,
      promptPolicy: ev.promptPolicy,
      status: ev.status,
      characterIds: (ev.characterIds ?? [])
        .map((id) => charIdMap.get(id))
        .filter((id): id is string => !!id),
      source: ev.source,
      pinned: ev.pinned
    }, { currentDay: storyDay })
  );

  return { world, season, episode, characters: newChars, locations: newLocs, continuity, threads, calendarEvents };
}

export async function persistCompactedWorld(graph: CompactedGraph): Promise<string> {
  await guardStorage(() => db.transaction(
    'rw',
    [db.worlds, db.seasons, db.episodes, db.characters, db.locations, db.continuity, db.threads, db.calendarEvents],
    async () => {
      await db.worlds.add(graph.world);
      await db.seasons.add(graph.season);
      await db.episodes.add(graph.episode);
      if (graph.characters.length) await db.characters.bulkAdd(graph.characters);
      if (graph.locations.length) await db.locations.bulkAdd(graph.locations);
      if (graph.continuity.length) await db.continuity.bulkAdd(graph.continuity);
      if (graph.threads.length) await db.threads.bulkAdd(graph.threads);
      if (graph.calendarEvents.length) await db.calendarEvents.bulkAdd(graph.calendarEvents);
    }
  ));
  return graph.world.id;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function distillLore(
  world: World,
  digest: string,
  signal?: AbortSignal
): Promise<{ recap: string; lore: VolumeLore }> {
  const recapChat = async (tight: boolean) => {
    const { provider, model } = utilityModelFor(world);
    const { signal: timed, cancel } = withTimeoutSignal(signal, VOLUME_TIMEOUT_MS);
    try {
      const { text } = await streamChat({
        provider, model,
        system: VOLUME_RECAP_SYSTEM,
        messages: [{ role: 'user', content: clip(digest, tight ? 20_000 : CORPUS_HARD_CHARS) }],
        maxTokens: 2200, temperature: 0.45, signal: timed, job: 'wrap'
      });
      return text.trim();
    } finally {
      cancel();
    }
  };
  const recap = (await withOverflowRetry(recapChat)) || clip(digest, 4000);

  const lore = await withOverflowRetry((tight) => utilityJson<VolumeLore>(
    world,
    VOLUME_LORE_SYSTEM +
    `\n{"line":"<one-sentence logline>","bible":"<800-1500 words: setting as it is NOW, lived history as fact>","premise":"<new volume situation, 2-5 sentences>","timeGap":"<human gap label>","storyDay":<int>,"dateNote":"<optional>","openingLocationName":"<exact existing place name>","openingCastNames":["<exact existing names>"],"atmosphereNote":"<sensory note for the opening scene>","offscreenChanges":"<what shifted during the gap>","plotTargets":["<aimed beats>"]}`,
    `Canon digest:\n${clip(digest, tight ? 20_000 : CORPUS_HARD_CHARS)}`,
    3500,
    signal,
    VOLUME_TIMEOUT_MS
  ));
  return { recap, lore };
}

async function distillCharacters(
  world: World,
  digest: string,
  characters: Character[],
  progress: CompactProgress,
  signal?: AbortSignal
): Promise<CharacterVolumePatch[]> {
  const out: CharacterVolumePatch[] = [];
  const batches = chunk(characters, CHAR_BATCH);
  let n = 0;
  for (const batch of batches) {
    n += 1;
    progress(`Rewriting cast (${n}/${batches.length})…`);
    const payload = batch.map((c) => ({
      name: c.name,
      isPlayer: c.isPlayer,
      role: c.role,
      age: c.age,
      appearance: c.appearance,
      mannerisms: c.mannerisms,
      backstory: c.backstory,
      summary: c.summary,
      speechStyle: c.speechStyle,
      exampleLines: c.exampleLines,
      traits: c.traits,
      desires: c.desires,
      fears: c.fears,
      flaws: c.flaws,
      secrets: c.secrets,
      mustNotKnow: c.mustNotKnow,
      anchors: c.anchors,
      state: c.state,
      relationships: c.relationships.map((r) => {
        const target = characters.find((x) => x.id === r.targetId);
        return { targetName: target?.name ?? '', kind: r.kind, note: r.note };
      })
    }));
    const result = await withOverflowRetry((tight) => utilityJson<{ characters?: CharacterVolumePatch[] }>(
      world,
      VOLUME_CHARACTER_BATCH_SYSTEM +
      `\n{"characters":[{"name":"<exact>","role":"","age":"","appearance":"","mannerisms":"","backstory":"","summary":"","speechStyle":"","exampleLines":[],"traits":"","desires":"","fears":"","flaws":"","secrets":"","mustNotKnow":"","anchors":[],"state":{"goal":"","emotion":"","location":"","condition":""},"relationships":[{"targetName":"","kind":"","note":""}]}]}`,
      `Digest:\n${clip(digest, tight ? 8_000 : 16_000)}\n\nBatch (rewrite only these names):\n${JSON.stringify(payload, null, 2)}`,
      3500,
      signal,
      VOLUME_TIMEOUT_MS
    ));
    const allowed = new Set(batch.map((c) => c.name.trim().toLowerCase()));
    for (const row of result.characters ?? []) {
      if (!row?.name || !allowed.has(row.name.trim().toLowerCase())) continue;
      out.push(row);
    }
  }
  return out;
}

async function distillLocations(
  world: World,
  digest: string,
  locations: Location[],
  progress: CompactProgress,
  signal?: AbortSignal
): Promise<LocationVolumePatch[]> {
  if (locations.length === 0) return [];
  const out: LocationVolumePatch[] = [];
  const batches = chunk(locations, LOC_BATCH);
  let n = 0;
  for (const batch of batches) {
    n += 1;
    progress(`Rewriting places (${n}/${batches.length})…`);
    const payload = batch.map((l) => ({
      name: l.name, tagline: l.tagline, summary: l.summary, atmosphere: l.atmosphere,
      features: l.features, history: l.history, inhabitants: l.inhabitants,
      rules: l.rules, secrets: l.secrets, currentState: l.currentState
    }));
    const result = await withOverflowRetry((tight) => utilityJson<{ locations?: LocationVolumePatch[] }>(
      world,
      VOLUME_LOCATION_BATCH_SYSTEM +
      `\n{"locations":[{"name":"<exact>","tagline":"","summary":"","atmosphere":"","features":"","history":"","inhabitants":"","rules":[],"secrets":"","currentState":""}]}`,
      `Digest:\n${clip(digest, tight ? 8_000 : 16_000)}\n\nBatch (rewrite only these names):\n${JSON.stringify(payload, null, 2)}`,
      2500,
      signal,
      VOLUME_TIMEOUT_MS
    ));
    const allowed = new Set(batch.map((l) => l.name.trim().toLowerCase()));
    for (const row of result.locations ?? []) {
      if (!row?.name || !allowed.has(row.name.trim().toLowerCase())) continue;
      out.push(row);
    }
  }
  return out;
}

async function distillMemory(
  world: World,
  digest: string,
  source: WorldExport,
  signal?: AbortSignal
): Promise<VolumeMemory> {
  const facts = factsSeedForVolume(source.continuity);
  const threads = threadsSeedForVolume(source.threads);
  return withOverflowRetry((tight) => utilityJson<VolumeMemory>(
    world,
    VOLUME_MEMORY_SYSTEM +
    `\n{"facts":[{"text":"...","pinned":false}],"threads":[{"text":"...","pinned":false}],"plotTargets":["..."]}\n` +
    `Keep every source fact marked pinned. Cap facts at ${FACT_CAP}. Only still-open threads.`,
    `Digest:\n${clip(digest, tight ? 8_000 : 16_000)}\n\n` +
    `Pinned + capped facts:\n${facts.map((f) => `- ${f.pinned ? '[pinned] ' : ''}${f.text}`).join('\n')}\n\n` +
    `Open threads:\n${threads.map((t) => `- ${t.pinned ? '[pinned] ' : ''}${t.text}`).join('\n') || '(none)'}`,
    2000,
    signal,
    VOLUME_TIMEOUT_MS
  ));
}

/**
 * Mint a new world from an existing one. Source is not written.
 * Returns the new world id.
 */
export async function compactWorldToVolume(
  sourceWorldId: string,
  opts: CompactWorldOpts = {}
): Promise<string> {
  const progress = opts.onProgress ?? (() => {});
  progress('Loading world…');
  const source = await exportWorld(sourceWorldId);
  utilityModelFor(source.world);

  const digest = await withOverflowRetry((tight) =>
    buildCanonDigest(source, progress, opts.signal, tight)
  );

  progress('Rewriting lore…');
  const { recap, lore } = await distillLore(source.world, digest, opts.signal);

  const characterPatches = await distillCharacters(
    source.world, digest, source.characters, progress, opts.signal
  );
  const locationPatches = await distillLocations(
    source.world, digest, source.locations ?? [], progress, opts.signal
  );

  progress('Distilling memory…');
  const memory = await distillMemory(source.world, digest, source, opts.signal);

  progress('Saving volume…');
  const graph = assembleCompactedWorld(source, {
    recap,
    lore,
    characters: characterPatches,
    locations: locationPatches,
    memory
  });
  return persistCompactedWorld(graph);
}
