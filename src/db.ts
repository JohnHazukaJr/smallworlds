import Dexie, { type EntityTable } from 'dexie';
import type {
  World, Season, Episode, Turn, Character, ContinuityFact, OpenThread, SeasonWrap
} from './types';

export const db = new Dexie('small-worlds') as Dexie & {
  worlds: EntityTable<World, 'id'>;
  seasons: EntityTable<Season, 'id'>;
  episodes: EntityTable<Episode, 'id'>;
  turns: EntityTable<Turn, 'id'>;
  characters: EntityTable<Character, 'id'>;
  continuity: EntityTable<ContinuityFact, 'id'>;
  threads: EntityTable<OpenThread, 'id'>;
  wraps: EntityTable<SeasonWrap, 'id'>;
};

db.version(1).stores({
  worlds: 'id, updatedAt',
  seasons: 'id, worldId, [worldId+number]',
  episodes: 'id, seasonId, worldId, [seasonId+number]',
  turns: 'id, episodeId, worldId, createdAt',
  characters: 'id, worldId',
  continuity: 'id, worldId, seasonId',
  threads: 'id, worldId, seasonId',
  wraps: 'id, seasonId, worldId'
});

export const uid = () => crypto.randomUUID();

// ---------- Export / import (whole-world JSON for moving between devices) ----------

export interface WorldExport {
  format: 'small-worlds-world';
  version: 1;
  exportedAt: number;
  world: World;
  seasons: Season[];
  episodes: Episode[];
  turns: Turn[];
  characters: Character[];
  continuity: ContinuityFact[];
  threads: OpenThread[];
  wraps: SeasonWrap[];
}

export async function exportWorld(worldId: string): Promise<WorldExport> {
  const world = await db.worlds.get(worldId);
  if (!world) throw new Error('World not found');
  const [seasons, episodes, turns, characters, continuity, threads, wraps] = await Promise.all([
    db.seasons.where('worldId').equals(worldId).toArray(),
    db.episodes.where('worldId').equals(worldId).toArray(),
    db.turns.where('worldId').equals(worldId).toArray(),
    db.characters.where('worldId').equals(worldId).toArray(),
    db.continuity.where('worldId').equals(worldId).toArray(),
    db.threads.where('worldId').equals(worldId).toArray(),
    db.wraps.where('worldId').equals(worldId).toArray()
  ]);
  return {
    format: 'small-worlds-world', version: 1, exportedAt: Date.now(),
    world, seasons, episodes, turns, characters, continuity, threads, wraps
  };
}

export async function importWorld(data: WorldExport): Promise<string> {
  if (data.format !== 'small-worlds-world') throw new Error('Not a Small Worlds export file');
  await db.transaction('rw',
    [db.worlds, db.seasons, db.episodes, db.turns, db.characters, db.continuity, db.threads, db.wraps],
    async () => {
      await db.worlds.put(data.world);
      await db.seasons.bulkPut(data.seasons);
      await db.episodes.bulkPut(data.episodes);
      await db.turns.bulkPut(data.turns);
      await db.characters.bulkPut(data.characters);
      await db.continuity.bulkPut(data.continuity);
      await db.threads.bulkPut(data.threads);
      await db.wraps.bulkPut(data.wraps);
    });
  return data.world.id;
}

export async function deleteWorld(worldId: string): Promise<void> {
  await db.transaction('rw',
    [db.worlds, db.seasons, db.episodes, db.turns, db.characters, db.continuity, db.threads, db.wraps],
    async () => {
      await db.worlds.delete(worldId);
      await db.seasons.where('worldId').equals(worldId).delete();
      await db.episodes.where('worldId').equals(worldId).delete();
      await db.turns.where('worldId').equals(worldId).delete();
      await db.characters.where('worldId').equals(worldId).delete();
      await db.continuity.where('worldId').equals(worldId).delete();
      await db.threads.where('worldId').equals(worldId).delete();
      await db.wraps.where('worldId').equals(worldId).delete();
    });
}
