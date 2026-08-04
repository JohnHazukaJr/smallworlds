/**
 * Revisioned pull/push sync against Supabase.
 * Conflict policy: last-write-wins by updatedAt (ms). Soft deletes via deleted_at.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getSupabase } from '../cloud/supabase';
import {
  clearTombstones, db, deleteWorld, type SyncTableName, type Tombstone
} from '../db';
import { decryptString, deriveKey, encryptString, randomSalt } from '../security/crypto';
import { useSettings } from '../store/settings';
import type {
  Character, ContinuityFact, Episode, Location, OpenThread, Season, SeasonWrap, Turn, World
} from '../types';

const SYNC_META_KEY = 'small-worlds-sync-meta';

interface SyncRow {
  id: string;
  user_id: string;
  world_id?: string;
  season_id?: string;
  episode_id?: string;
  payload: unknown;
  updated_at: string;
  deleted_at: string | null;
}

interface SyncState {
  lastSyncedAt: number | null;
  busy: boolean;
  error: string;
  lastResult: string;
  setLastSynced: (ts: number | null) => void;
}

export const useSyncMeta = create<SyncState>()(
  persist(
    (set) => ({
      lastSyncedAt: null,
      busy: false,
      error: '',
      lastResult: '',
      setLastSynced: (lastSyncedAt) => set({ lastSyncedAt })
    }),
    { name: SYNC_META_KEY, partialize: (s) => ({ lastSyncedAt: s.lastSyncedAt }) }
  )
);

function rowUpdatedMs(iso: string): number {
  return new Date(iso).getTime();
}

function entityUpdatedAt(payload: { updatedAt?: number; createdAt?: number }): number {
  return payload.updatedAt ?? payload.createdAt ?? 0;
}

function isoFromEntity(payload: { updatedAt?: number; createdAt?: number }): string {
  return new Date(entityUpdatedAt(payload) || Date.now()).toISOString();
}

async function pullTable<T extends { id: string }>(
  table: SyncTableName,
  userId: string,
  since: number | null,
  apply: (payload: T, deleted: boolean, remoteUpdated: number) => Promise<void>
): Promise<number> {
  const sb = getSupabase();
  if (!sb) return 0;
  let q = sb.from(table).select('*').eq('user_id', userId);
  if (since) q = q.gte('updated_at', new Date(since).toISOString());
  const { data, error } = await q;
  if (error) throw error;
  let n = 0;
  for (const row of (data ?? []) as SyncRow[]) {
    await apply(row.payload as T, !!row.deleted_at, rowUpdatedMs(row.updated_at));
    n++;
  }
  return n;
}

async function pushRows(
  table: SyncTableName,
  userId: string,
  rows: Array<{
    id: string;
    world_id?: string;
    season_id?: string;
    episode_id?: string;
    payload: unknown;
    updated_at: string;
    deleted_at?: string | null;
  }>
): Promise<void> {
  if (rows.length === 0) return;
  const sb = getSupabase();
  if (!sb) return;
  const batch = rows.map((r) => ({
    ...r,
    user_id: userId
  }));
  // Upsert in chunks to stay under payload limits.
  const CHUNK = 200;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const { error } = await sb.from(table).upsert(batch.slice(i, i + CHUNK), { onConflict: 'id' });
    if (error) throw error;
  }
}

async function lwwPutWorld(remote: World, deleted: boolean, remoteMs: number) {
  if (deleted) {
    const local = await db.worlds.get(remote.id);
    if (local && entityUpdatedAt(local) <= remoteMs) await deleteWorld(remote.id, { fromRemote: true });
    return;
  }
  const local = await db.worlds.get(remote.id);
  if (!local || entityUpdatedAt(local) < remoteMs) await db.worlds.put(remote);
}

async function lwwPut<T extends { id: string; updatedAt?: number; createdAt?: number }>(
  // Dexie EntityTable put/get generics are awkward across entity shapes — keep this narrow helper loose.
  table: { get: (id: string) => Promise<unknown>; delete: (id: string) => Promise<unknown>; put: (item: T) => Promise<unknown> },
  remote: T,
  deleted: boolean,
  remoteMs: number
) {
  if (deleted) {
    const local = await table.get(remote.id) as T | undefined;
    if (local && entityUpdatedAt(local) <= remoteMs) await table.delete(remote.id);
    return;
  }
  const local = await table.get(remote.id) as T | undefined;
  if (!local || entityUpdatedAt(local) < remoteMs) await table.put(remote);
}

function tombstonePushRow(t: Tombstone) {
  return {
    id: t.id,
    world_id: t.worldId,
    season_id: t.seasonId,
    episode_id: t.episodeId,
    payload: t.payload,
    updated_at: new Date(t.deletedAt).toISOString(),
    deleted_at: new Date(t.deletedAt).toISOString()
  };
}

async function pushTombstones(userId: string): Promise<number> {
  const tombs = await db.tombstones.toArray();
  if (tombs.length === 0) return 0;
  const byTable = new Map<SyncTableName, Tombstone[]>();
  for (const t of tombs) {
    const list = byTable.get(t.table) ?? [];
    list.push(t);
    byTable.set(t.table, list);
  }
  for (const [table, rows] of byTable) {
    await pushRows(table, userId, rows.map(tombstonePushRow));
  }
  await clearTombstones(tombs.map((t) => t.key));
  return tombs.length;
}

export async function syncNow(): Promise<{ pulled: number; pushed: number }> {
  const sb = getSupabase();
  if (!sb) throw new Error('Cloud sync is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user) throw new Error('Sign in to sync.');

  const userId = session.user.id;
  const since = useSyncMeta.getState().lastSyncedAt;
  useSyncMeta.setState({ busy: true, error: '', lastResult: '' });

  try {
    let pulled = 0;
    pulled += await pullTable<World>('worlds', userId, since, lwwPutWorld);
    pulled += await pullTable<Season>('seasons', userId, since, (p, d, m) => lwwPut(db.seasons, p, d, m));
    pulled += await pullTable<Episode>('episodes', userId, since, (p, d, m) => lwwPut(db.episodes, p, d, m));
    pulled += await pullTable<Turn>('turns', userId, since, (p, d, m) => lwwPut(db.turns, p, d, m));
    pulled += await pullTable<Character>('characters', userId, since, (p, d, m) => lwwPut(db.characters, p, d, m));
    pulled += await pullTable<Location>('locations', userId, since, (p, d, m) => lwwPut(db.locations, p, d, m));
    pulled += await pullTable<ContinuityFact>('continuity', userId, since, (p, d, m) => lwwPut(db.continuity, p, d, m));
    pulled += await pullTable<OpenThread>('threads', userId, since, (p, d, m) => lwwPut(db.threads, p, d, m));
    pulled += await pullTable<SeasonWrap>('wraps', userId, since, (p, d, m) => lwwPut(db.wraps, p, d, m));

    const tombPushed = await pushTombstones(userId);

    // Push full local snapshot (LWW on server via upsert; remote older rows lose on next pull).
    const [worlds, seasons, episodes, turns, characters, locations, continuity, threads, wraps] = await Promise.all([
      db.worlds.toArray(),
      db.seasons.toArray(),
      db.episodes.toArray(),
      db.turns.toArray(),
      db.characters.toArray(),
      db.locations.toArray(),
      db.continuity.toArray(),
      db.threads.toArray(),
      db.wraps.toArray()
    ]);

    await pushRows('worlds', userId, worlds.map((w) => ({
      id: w.id, payload: w, updated_at: isoFromEntity(w), deleted_at: null
    })));
    await pushRows('seasons', userId, seasons.map((s) => ({
      id: s.id, world_id: s.worldId, payload: s, updated_at: isoFromEntity(s), deleted_at: null
    })));
    await pushRows('episodes', userId, episodes.map((e) => ({
      id: e.id, world_id: e.worldId, season_id: e.seasonId, payload: e, updated_at: isoFromEntity(e), deleted_at: null
    })));
    await pushRows('turns', userId, turns.map((t) => ({
      id: t.id, world_id: t.worldId, episode_id: t.episodeId, payload: t, updated_at: isoFromEntity(t), deleted_at: null
    })));
    await pushRows('characters', userId, characters.map((c) => ({
      id: c.id, world_id: c.worldId, payload: c, updated_at: isoFromEntity(c), deleted_at: null
    })));
    await pushRows('locations', userId, locations.map((l) => ({
      id: l.id, world_id: l.worldId, payload: l, updated_at: isoFromEntity(l), deleted_at: null
    })));
    await pushRows('continuity', userId, continuity.map((c) => ({
      id: c.id, world_id: c.worldId, season_id: c.seasonId, payload: c, updated_at: isoFromEntity(c), deleted_at: null
    })));
    await pushRows('threads', userId, threads.map((t) => ({
      id: t.id, world_id: t.worldId, season_id: t.seasonId, payload: t, updated_at: isoFromEntity(t), deleted_at: null
    })));
    await pushRows('wraps', userId, wraps.map((w) => ({
      id: w.id, world_id: w.worldId, season_id: w.seasonId, payload: w, updated_at: isoFromEntity(w), deleted_at: null
    })));

    const pushed =
      tombPushed +
      worlds.length + seasons.length + episodes.length + turns.length +
      characters.length + locations.length + continuity.length + threads.length + wraps.length;

    const now = Date.now();
    useSyncMeta.setState({
      lastSyncedAt: now,
      busy: false,
      error: '',
      lastResult: `Synced · pulled ${pulled} · pushed ${pushed}`
    });
    return { pulled, pushed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useSyncMeta.setState({ busy: false, error: msg, lastResult: '' });
    throw e;
  }
}

/** Encrypt provider keys with a secrets passphrase (≠ account password) and upsert. */
export async function pushEncryptedSecrets(secretsPassphrase: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Cloud sync is not configured.');
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user) throw new Error('Sign in first.');

  const keyMap: Record<string, string> = {};
  for (const p of useSettings.getState().providers) {
    if (p.apiKey.trim()) keyMap[p.id] = p.apiKey;
  }
  const salt = randomSalt();
  const key = await deriveKey(secretsPassphrase, salt);
  const { iv, ct } = await encryptString(key, JSON.stringify(keyMap));
  const { error } = await sb.from('encrypted_secrets').upsert({
    user_id: session.user.id,
    salt, iv, ct,
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
}

/** Pull and decrypt provider keys into the local settings store. */
export async function pullEncryptedSecrets(secretsPassphrase: string): Promise<number> {
  const sb = getSupabase();
  if (!sb) throw new Error('Cloud sync is not configured.');
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user) throw new Error('Sign in first.');

  const { data, error } = await sb.from('encrypted_secrets').select('*').eq('user_id', session.user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('No encrypted keys found for this account.');

  const key = await deriveKey(secretsPassphrase, data.salt);
  let keyMap: Record<string, string>;
  try {
    keyMap = JSON.parse(await decryptString(key, { iv: data.iv, ct: data.ct }));
  } catch {
    throw new Error('Wrong secrets passphrase (or the ciphertext is corrupted).');
  }

  useSettings.setState((s) => ({
    providers: s.providers.map((p) => ({ ...p, apiKey: keyMap[p.id] ?? p.apiKey }))
  }));
  // Also add any providers that exist only in the cloud map? Keep shell providers local.
  const { useVault } = await import('../security/vault');
  await useVault.getState().persistKeys();
  return Object.keys(keyMap).length;
}
