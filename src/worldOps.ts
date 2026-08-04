import { db, uid } from './db';
import { useSettings } from './store/settings';
import type { Character, Episode, Location, Season, World, WorldAISettings, WorldCalendar } from './types';

/** Worlds created before the calendar field existed won't have it — always read through this. */
export function worldCalendar(world: World): WorldCalendar {
  return world.calendar ?? { currentDay: 1, system: '' };
}

export const DEFAULT_AI: WorldAISettings = {
  pov: 'second',
  tense: 'present',
  proseDensity: 45,
  pacing: 50,
  contentNotes: '',
  narratorRules: [],
  customInstructions: '',
  mature: true
};

export interface NewWorldInput {
  title: string;
  line: string;
  bible: string;
  premise: string;
  hue?: number;
  /** overrides for the world's narrator settings; merges onto defaults */
  ai?: Partial<WorldAISettings>;
}

/** Create a world with season 1 / episode 1 and a player character, ready to write. */
export async function createWorld(input: NewWorldInput): Promise<World> {
  const s = useSettings.getState();
  const now = Date.now();
  const worldId = uid();
  const seasonId = uid();

  const world: World = {
    id: worldId,
    title: input.title || 'Untitled world',
    line: input.line,
    bible: input.bible,
    hue: input.hue ?? Math.floor(Math.random() * 360),
    visibility: s.defaultVisibility,
    ai: { ...DEFAULT_AI, mature: s.matureDefault, ...input.ai },
    proseModel: null,
    utilityModel: null,
    activeSeasonId: seasonId,
    calendar: { currentDay: 1, system: '' },
    createdAt: now,
    updatedAt: now
  };

  const season: Season = {
    id: seasonId, worldId, number: 1, title: '',
    premise: input.premise, timeGap: null, bible: null, status: 'active', createdAt: now
  };

  const player: Character = emptyCharacter(worldId, {
    name: 'you', role: 'protagonist · second person', hue: 60, isPlayer: true
  });

  const episode: Episode = {
    id: uid(), seasonId, worldId, number: 1, title: '', location: '', locationId: null,
    castIds: [player.id], status: 'active', createdAt: now
  };

  await db.transaction('rw', [db.worlds, db.seasons, db.episodes, db.characters], async () => {
    await db.worlds.add(world);
    await db.seasons.add(season);
    await db.episodes.add(episode);
    await db.characters.add(player);
  });

  return world;
}

export const MAX_CHARACTER_PORTRAITS = 6;

/** Resolve the photo gallery, migrating a lone legacy `portrait` into the list. */
export function characterPortraits(c: Pick<Character, 'portrait' | 'portraits'>): string[] {
  if (c.portraits && c.portraits.length > 0) return c.portraits.filter(Boolean);
  return c.portrait ? [c.portrait] : [];
}

/** Patch that keeps `portrait` (primary) aligned with `portraits[0]`. */
export function portraitsPatch(urls: string[]): Pick<Character, 'portraits' | 'portrait'> {
  const portraits = urls.filter(Boolean).slice(0, MAX_CHARACTER_PORTRAITS);
  return { portraits, portrait: portraits[0] ?? null };
}

export function emptyCharacter(worldId: string, patch: Partial<Character> = {}): Character {
  const now = Date.now();
  const base: Character = {
    id: uid(), worldId,
    name: '', role: '', hue: Math.floor(Math.random() * 360), isPlayer: false, selfTag: false,
    portrait: null, portraits: [],
    age: '', appearance: '', mannerisms: '', backstory: '', summary: '',
    speechStyle: '', exampleLines: [],
    traits: '', desires: '', fears: '', flaws: '',
    secrets: '', mustNotKnow: '',
    relationships: [], anchors: [], customInstructions: '',
    state: { goal: '', emotion: '', location: '', condition: '' },
    createdAt: now, updatedAt: now,
    ...patch
  };
  // Normalize primary ↔ gallery if the patch only set one of them.
  const gallery = characterPortraits(base);
  return { ...base, ...portraitsPatch(gallery) };
}

export function emptyLocation(worldId: string, patch: Partial<Location> = {}): Location {
  const now = Date.now();
  return {
    id: uid(), worldId,
    name: '', tagline: '', hue: Math.floor(Math.random() * 360),
    summary: '', atmosphere: '', features: '', history: '', inhabitants: '',
    rules: [], secrets: '', currentState: '', customInstructions: '',
    createdAt: now, updatedAt: now,
    ...patch
  };
}

/** End the current episode and open the next one, carrying the scene cast forward. */
export async function nextEpisode(current: Episode): Promise<Episode> {
  const next: Episode = {
    id: uid(), seasonId: current.seasonId, worldId: current.worldId,
    number: current.number + 1, title: '', location: current.location,
    locationId: current.locationId ?? null,
    castIds: current.castIds, status: 'active', createdAt: Date.now()
  };
  await db.transaction('rw', [db.episodes, db.worlds], async () => {
    await db.episodes.update(current.id, { status: 'ended' });
    await db.episodes.add(next);
    const world = await db.worlds.get(current.worldId);
    if (world) {
      const cal = worldCalendar(world);
      await db.worlds.update(world.id, { calendar: { ...cal, currentDay: cal.currentDay + 1 } });
    }
  });
  return next;
}
