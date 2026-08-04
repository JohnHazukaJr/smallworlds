import Dexie, { type EntityTable } from 'dexie';
import { decryptString, deriveKey, encryptString, randomSalt } from './security/crypto';
import { isQuotaError, markStoragePressure } from './storage/quota';
import type {
  World, Season, Episode, Turn, Character, Location, ContinuityFact, OpenThread, SeasonWrap
} from './types';

/** Sync entity tables that support soft-delete tombstones. */
export type SyncTableName =
  | 'worlds' | 'seasons' | 'episodes' | 'turns' | 'characters'
  | 'locations' | 'continuity' | 'threads' | 'wraps';

export interface Tombstone {
  /** `${table}:${id}` */
  key: string;
  table: SyncTableName;
  id: string;
  worldId?: string;
  seasonId?: string;
  episodeId?: string;
  deletedAt: number;
  payload: Record<string, unknown>;
}

export const db = new Dexie('small-worlds') as Dexie & {
  worlds: EntityTable<World, 'id'>;
  seasons: EntityTable<Season, 'id'>;
  episodes: EntityTable<Episode, 'id'>;
  turns: EntityTable<Turn, 'id'>;
  characters: EntityTable<Character, 'id'>;
  locations: EntityTable<Location, 'id'>;
  continuity: EntityTable<ContinuityFact, 'id'>;
  threads: EntityTable<OpenThread, 'id'>;
  wraps: EntityTable<SeasonWrap, 'id'>;
  tombstones: EntityTable<Tombstone, 'key'>;
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

db.version(2).stores({
  locations: 'id, worldId'
});

db.version(3).stores({
  tombstones: 'key, table, deletedAt, worldId'
});

export const uid = () => crypto.randomUUID();

/** Run a Dexie write and flag storage pressure on QuotaExceededError. */
export async function guardStorage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isQuotaError(e)) markStoragePressure();
    throw e;
  }
}

export interface TombstoneInput {
  table: SyncTableName;
  id: string;
  worldId?: string;
  seasonId?: string;
  episodeId?: string;
  payload?: unknown;
}

export async function recordTombstones(items: TombstoneInput[]): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  await guardStorage(() => db.tombstones.bulkPut(items.map((item) => ({
    key: `${item.table}:${item.id}`,
    table: item.table,
    id: item.id,
    worldId: item.worldId,
    seasonId: item.seasonId,
    episodeId: item.episodeId,
    deletedAt: now,
    payload: (item.payload && typeof item.payload === 'object'
      ? item.payload as Record<string, unknown>
      : { id: item.id })
  }))));
}

export async function clearTombstones(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.tombstones.bulkDelete(keys);
}

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
  locations: Location[];
  continuity: ContinuityFact[];
  threads: OpenThread[];
  wraps: SeasonWrap[];
}

export async function exportWorld(worldId: string): Promise<WorldExport> {
  const world = await db.worlds.get(worldId);
  if (!world) throw new Error('World not found');
  const [seasons, episodes, turns, characters, locations, continuity, threads, wraps] = await Promise.all([
    db.seasons.where('worldId').equals(worldId).toArray(),
    db.episodes.where('worldId').equals(worldId).toArray(),
    db.turns.where('worldId').equals(worldId).toArray(),
    db.characters.where('worldId').equals(worldId).toArray(),
    db.locations.where('worldId').equals(worldId).toArray(),
    db.continuity.where('worldId').equals(worldId).toArray(),
    db.threads.where('worldId').equals(worldId).toArray(),
    db.wraps.where('worldId').equals(worldId).toArray()
  ]);
  return {
    format: 'small-worlds-world', version: 1, exportedAt: Date.now(),
    world, seasons, episodes, turns, characters, locations, continuity, threads, wraps
  };
}

export async function importWorld(data: WorldExport): Promise<string> {
  if (data.format !== 'small-worlds-world') throw new Error('Not a Small Worlds export file');
  await guardStorage(() => db.transaction('rw',
    [db.worlds, db.seasons, db.episodes, db.turns, db.characters, db.locations, db.continuity, db.threads, db.wraps],
    async () => {
      await db.worlds.put(data.world);
      await db.seasons.bulkPut(data.seasons);
      await db.episodes.bulkPut(data.episodes);
      await db.turns.bulkPut(data.turns);
      await db.characters.bulkPut(data.characters);
      await db.locations.bulkPut(data.locations ?? []);
      await db.continuity.bulkPut(data.continuity);
      await db.threads.bulkPut(data.threads);
      await db.wraps.bulkPut(data.wraps);
    }));
  return data.world.id;
}

export interface BackupExport {
  format: 'small-worlds-backup';
  version: 1;
  worlds: WorldExport[];
}

export interface EncryptedExport {
  format: 'small-worlds-encrypted';
  version: 1;
  salt: string;
  iv: string;
  ct: string;
}

export async function encryptExport(data: WorldExport | BackupExport, passphrase: string): Promise<EncryptedExport> {
  const salt = randomSalt();
  const key = await deriveKey(passphrase, salt);
  const { iv, ct } = await encryptString(key, JSON.stringify(data));
  return { format: 'small-worlds-encrypted', version: 1, salt, iv, ct };
}

export async function decryptExport(payload: EncryptedExport, passphrase: string): Promise<WorldExport | BackupExport> {
  const key = await deriveKey(passphrase, payload.salt);
  try {
    return JSON.parse(await decryptString(key, { iv: payload.iv, ct: payload.ct }));
  } catch {
    throw new Error('Wrong passphrase (or the file is corrupted).');
  }
}

export function isEncryptedExport(data: unknown): data is EncryptedExport {
  return !!data && typeof data === 'object' && (data as EncryptedExport).format === 'small-worlds-encrypted';
}

/** Import a single-world export or a full worlds-only backup. Returns the imported world ids. */
export async function importAny(data: WorldExport | BackupExport): Promise<string[]> {
  if (data.format === 'small-worlds-world') {
    return [await importWorld(data)];
  }
  if (data.format === 'small-worlds-backup') {
    const ids: string[] = [];
    for (const w of data.worlds) ids.push(await importWorld(w));
    return ids;
  }
  throw new Error('Not a Small Worlds file.');
}

/**
 * Import world, backup, or full device bundle (settings + vault).
 * Device format is handled in sync/serialize to avoid circular imports.
 */
export async function importAnyFile(data: unknown): Promise<string[]> {
  const { isDeviceExport, importDevice } = await import('./sync/serialize');
  if (isDeviceExport(data)) return importDevice(data);
  if (data && typeof data === 'object' && 'format' in data) {
    const fmt = (data as { format: string }).format;
    if (fmt === 'small-worlds-world' || fmt === 'small-worlds-backup') {
      return importAny(data as WorldExport | BackupExport);
    }
  }
  throw new Error('Not a Small Worlds file.');
}

/** Deletes everything: stories, characters, settings, keys, vault. Irreversible. */
export async function wipeAllData(): Promise<void> {
  await db.delete();
  localStorage.removeItem('small-worlds-settings');
  localStorage.removeItem('small-worlds-app');
  localStorage.removeItem('small-worlds-vault');
  localStorage.removeItem('small-worlds-sync-meta');
  localStorage.removeItem('small-worlds-auth');
  localStorage.removeItem('small-worlds-storage-pressure');
  location.reload();
}

/**
 * Hard-delete a world and all child rows locally.
 * By default records sync tombstones so cloud sync does not resurrect them.
 * Pass `{ fromRemote: true }` when applying a remote soft-delete (no re-push).
 */
export async function deleteWorld(
  worldId: string,
  opts?: { fromRemote?: boolean }
): Promise<void> {
  await guardStorage(async () => {
    await db.transaction('rw',
      [db.worlds, db.seasons, db.episodes, db.turns, db.characters, db.locations, db.continuity, db.threads, db.wraps, db.tombstones],
      async () => {
        if (!opts?.fromRemote) {
          const [world, seasons, episodes, turns, characters, locations, continuity, threads, wraps] = await Promise.all([
            db.worlds.get(worldId),
            db.seasons.where('worldId').equals(worldId).toArray(),
            db.episodes.where('worldId').equals(worldId).toArray(),
            db.turns.where('worldId').equals(worldId).toArray(),
            db.characters.where('worldId').equals(worldId).toArray(),
            db.locations.where('worldId').equals(worldId).toArray(),
            db.continuity.where('worldId').equals(worldId).toArray(),
            db.threads.where('worldId').equals(worldId).toArray(),
            db.wraps.where('worldId').equals(worldId).toArray()
          ]);
          const now = Date.now();
          const tombs: Tombstone[] = [];
          const add = (
            table: SyncTableName,
            id: string,
            payload: unknown,
            extra?: { seasonId?: string; episodeId?: string }
          ) => {
            tombs.push({
              key: `${table}:${id}`,
              table,
              id,
              worldId,
              seasonId: extra?.seasonId,
              episodeId: extra?.episodeId,
              deletedAt: now,
              payload: (payload && typeof payload === 'object'
                ? payload as Record<string, unknown>
                : { id })
            });
          };
          if (world) add('worlds', world.id, world);
          for (const s of seasons) add('seasons', s.id, s);
          for (const e of episodes) add('episodes', e.id, e, { seasonId: e.seasonId });
          for (const t of turns) add('turns', t.id, t, { episodeId: t.episodeId });
          for (const c of characters) add('characters', c.id, c);
          for (const l of locations) add('locations', l.id, l);
          for (const c of continuity) add('continuity', c.id, c, { seasonId: c.seasonId });
          for (const t of threads) add('threads', t.id, t, { seasonId: t.seasonId });
          for (const w of wraps) add('wraps', w.id, w, { seasonId: w.seasonId });
          if (tombs.length > 0) await db.tombstones.bulkPut(tombs);
        }

        await db.worlds.delete(worldId);
        await db.seasons.where('worldId').equals(worldId).delete();
        await db.episodes.where('worldId').equals(worldId).delete();
        await db.turns.where('worldId').equals(worldId).delete();
        await db.characters.where('worldId').equals(worldId).delete();
        await db.locations.where('worldId').equals(worldId).delete();
        await db.continuity.where('worldId').equals(worldId).delete();
        await db.threads.where('worldId').equals(worldId).delete();
        await db.wraps.where('worldId').equals(worldId).delete();
      });
  });
}
