import { db, uid } from './db';
import { useSettings } from './store/settings';
import type { Character, Episode, Season, World, WorldAISettings } from './types';

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
    ai: { ...DEFAULT_AI, mature: s.matureDefault },
    proseModel: null,
    utilityModel: null,
    activeSeasonId: seasonId,
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
    id: uid(), seasonId, worldId, number: 1, title: '', location: '',
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

export function emptyCharacter(worldId: string, patch: Partial<Character> = {}): Character {
  const now = Date.now();
  return {
    id: uid(), worldId,
    name: '', role: '', hue: Math.floor(Math.random() * 360), isPlayer: false,
    age: '', appearance: '', summary: '',
    speechStyle: '', exampleLines: [],
    traits: '', desires: '', fears: '', flaws: '',
    secrets: '', mustNotKnow: '',
    relationships: [], anchors: [], customInstructions: '',
    state: { goal: '', emotion: '', location: '', condition: '' },
    createdAt: now, updatedAt: now,
    ...patch
  };
}

/** End the current episode and open the next one, carrying the scene cast forward. */
export async function nextEpisode(current: Episode): Promise<Episode> {
  const next: Episode = {
    id: uid(), seasonId: current.seasonId, worldId: current.worldId,
    number: current.number + 1, title: '', location: current.location,
    castIds: current.castIds, status: 'active', createdAt: Date.now()
  };
  await db.transaction('rw', [db.episodes], async () => {
    await db.episodes.update(current.id, { status: 'ended' });
    await db.episodes.add(next);
  });
  return next;
}
