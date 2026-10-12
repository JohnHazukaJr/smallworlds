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
import { formatUserError } from '../errors';
import { decryptString, deriveKey, encryptString, randomSalt, type CipherPayload } from '../security/crypto';
import { getStoryKey } from '../security/storyKey';
import { isSealedRecord, openRecord, readDiskRows } from '../security/storySeal';
import { useSettings } from '../store/settings';
import { syncSide } from './lww';
import type {
  CalendarEvent, Character, ContinuityFact, Episode, Location, OpenThread, Season, SeasonWrap, Turn, World
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

const META_PAGE = 1000;
const ID_CHUNK = 100;

interface RemoteMeta {
  id: string;
  updated_at: string;
  deleted_at: string | null;
}

async function listRemoteMeta(table: SyncTableName, userId: string): Promise<RemoteMeta[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const rows: RemoteMeta[] = [];
  for (let from = 0; ; from += META_PAGE) {
    const { data, error } = await sb
      .from(table)
      .select('id, updated_at, deleted_at')
      .eq('user_id', userId)
      .range(from, from + META_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as RemoteMeta[];
    rows.push(...batch);
    if (batch.length < META_PAGE) break;
  }
  return rows;
}

async function fetchRemoteRows(table: SyncTableName, userId: string, ids: string[]): Promise<SyncRow[]> {
  const sb = getSupabase();
  if (!sb || ids.length === 0) return [];
  const rows: SyncRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await sb.from(table).select('*').eq('user_id', userId).in('id', slice);
    if (error) throw error;
    rows.push(...((data ?? []) as SyncRow[]));
  }
  return rows;
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

/** Confirm a sealed cloud row opens with this device's story key, then store it still sealed. */
async function inboundPayload<T>(payload: T): Promise<T> {
  if (!isSealedRecord(payload)) return payload;
  const key = getStoryKey();
  if (!key) throw new Error('This cloud copy is encrypted. Unlock the app lock, then sync again.');
  try {
    await openRecord(payload, key);
  } catch {
    throw new Error('Could not decrypt a synced world. Unlock with the same passphrase that sealed it.');
  }
  return payload;
}

async function diskRows<T>(table: SyncTableName): Promise<T[]> {
  await db.open();
  const idb = db.backendDB();
  return readDiskRows(idb, table) as Promise<T[]>;
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

type Stamped = { id: string; updatedAt?: number; createdAt?: number };

interface PushShape {
  id: string;
  world_id?: string;
  season_id?: string;
  episode_id?: string;
  payload: unknown;
  updated_at: string;
  deleted_at?: string | null;
}

/** Pull rows the server has newer; push rows this device has newer. Tombstone ids are not pushed back. */
async function reconcileTable<T extends Stamped>(
  table: SyncTableName,
  userId: string,
  localRows: T[],
  skipIds: Set<string>,
  apply: (payload: T, deleted: boolean, remoteUpdated: number) => Promise<void>,
  toPush: (row: T) => PushShape
): Promise<{ pulled: number; pushed: number }> {
  const remote = await listRemoteMeta(table, userId);
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const localById = new Map(localRows.map((row) => [row.id, row]));

  const pullIds: string[] = [];
  for (const row of remote) {
    if (skipIds.has(row.id)) continue;
    const local = localById.get(row.id);
    const localMs = local ? entityUpdatedAt(local) : null;
    if (syncSide(localMs, rowUpdatedMs(row.updated_at)) === 'pull') pullIds.push(row.id);
  }

  const payloads = await fetchRemoteRows(table, userId, pullIds);
  for (const row of payloads) {
    const payload = await inboundPayload(row.payload as T);
    await apply(payload, !!row.deleted_at, rowUpdatedMs(row.updated_at));
  }

  const push: PushShape[] = [];
  for (const row of localRows) {
    if (skipIds.has(row.id)) continue;
    const remoteRow = remoteById.get(row.id);
    const remoteMs = remoteRow ? rowUpdatedMs(remoteRow.updated_at) : null;
    if (syncSide(entityUpdatedAt(row), remoteMs) === 'push') push.push(toPush(row));
  }
  await pushRows(table, userId, push);
  return { pulled: payloads.length, pushed: push.length };
}

export async function syncNow(): Promise<{ pulled: number; pushed: number }> {
  const sb = getSupabase();
  if (!sb) throw new Error('Cloud sync is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user) throw new Error('Sign in to sync.');

  const userId = session.user.id;
  useSyncMeta.setState({ busy: true, error: '', lastResult: '' });

  try {
    const tombs = await db.tombstones.toArray();
    const skipIds = new Map<SyncTableName, Set<string>>();
    for (const tomb of tombs) {
      const ids = skipIds.get(tomb.table) ?? new Set<string>();
      ids.add(tomb.id);
      skipIds.set(tomb.table, ids);
    }
    const tombPushed = await pushTombstones(userId);
    const skip = (table: SyncTableName) => skipIds.get(table) ?? new Set<string>();

    const [worlds, seasons, episodes, turns, characters, locations, continuity, threads, wraps, calendarEvents] = await Promise.all([
      diskRows<World>('worlds'),
      diskRows<Season>('seasons'),
      diskRows<Episode>('episodes'),
      diskRows<Turn>('turns'),
      diskRows<Character>('characters'),
      diskRows<Location>('locations'),
      diskRows<ContinuityFact>('continuity'),
      diskRows<OpenThread>('threads'),
      diskRows<SeasonWrap>('wraps'),
      diskRows<CalendarEvent>('calendarEvents')
    ]);

    const parts = [
      await reconcileTable('worlds', userId, worlds, skip('worlds'), lwwPutWorld, (w) => ({
        id: w.id, payload: w, updated_at: isoFromEntity(w), deleted_at: null
      })),
      await reconcileTable('seasons', userId, seasons, skip('seasons'), (p, d, m) => lwwPut(db.seasons, p, d, m), (s) => ({
        id: s.id, world_id: s.worldId, payload: s, updated_at: isoFromEntity(s), deleted_at: null
      })),
      await reconcileTable('episodes', userId, episodes, skip('episodes'), (p, d, m) => lwwPut(db.episodes, p, d, m), (e) => ({
        id: e.id, world_id: e.worldId, season_id: e.seasonId, payload: e, updated_at: isoFromEntity(e), deleted_at: null
      })),
      await reconcileTable('turns', userId, turns, skip('turns'), (p, d, m) => lwwPut(db.turns, p, d, m), (t) => ({
        id: t.id, world_id: t.worldId, episode_id: t.episodeId, payload: t, updated_at: isoFromEntity(t), deleted_at: null
      })),
      await reconcileTable('characters', userId, characters, skip('characters'), (p, d, m) => lwwPut(db.characters, p, d, m), (c) => ({
        id: c.id, world_id: c.worldId, payload: c, updated_at: isoFromEntity(c), deleted_at: null
      })),
      await reconcileTable('locations', userId, locations, skip('locations'), (p, d, m) => lwwPut(db.locations, p, d, m), (l) => ({
        id: l.id, world_id: l.worldId, payload: l, updated_at: isoFromEntity(l), deleted_at: null
      })),
      await reconcileTable('continuity', userId, continuity, skip('continuity'), (p, d, m) => lwwPut(db.continuity, p, d, m), (c) => ({
        id: c.id, world_id: c.worldId, season_id: c.seasonId, payload: c, updated_at: isoFromEntity(c), deleted_at: null
      })),
      await reconcileTable('threads', userId, threads, skip('threads'), (p, d, m) => lwwPut(db.threads, p, d, m), (t) => ({
        id: t.id, world_id: t.worldId, season_id: t.seasonId, payload: t, updated_at: isoFromEntity(t), deleted_at: null
      })),
      await reconcileTable('wraps', userId, wraps, skip('wraps'), (p, d, m) => lwwPut(db.wraps, p, d, m), (w) => ({
        id: w.id, world_id: w.worldId, season_id: w.seasonId, payload: w, updated_at: isoFromEntity(w), deleted_at: null
      })),
      await reconcileTable('calendarEvents', userId, calendarEvents, skip('calendarEvents'), (p, d, m) => lwwPut(db.calendarEvents, p, d, m), (e) => ({
        id: e.id, world_id: e.worldId, season_id: e.seasonId, payload: e, updated_at: isoFromEntity(e), deleted_at: null
      }))
    ];

    let pulled = 0;
    let pushed = tombPushed;
    for (const part of parts) {
      pulled += part.pulled;
      pushed += part.pushed;
    }

    useSyncMeta.setState({
      lastSyncedAt: Date.now(),
      busy: false,
      error: '',
      lastResult: `Synced · pulled ${pulled} · pushed ${pushed}`
    });
    return { pulled, pushed };
  } catch (e) {
    useSyncMeta.setState({ busy: false, error: formatUserError(e), lastResult: '' });
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
  const { useVault } = await import('../security/vault');
  const story = useVault.getState().exportVaultBlob()?.story ?? null;
  const { iv, ct } = await encryptString(key, JSON.stringify({ v: 2, keys: keyMap, story }));
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(await decryptString(key, { iv: data.iv, ct: data.ct }));
  } catch {
    throw new Error('Wrong secrets passphrase (or the ciphertext is corrupted).');
  }
  const { keys: keyMap, story } = splitSecrets(parsed);

  useSettings.setState((s) => ({
    providers: s.providers.map((p) => ({ ...p, apiKey: keyMap[p.id] ?? p.apiKey }))
  }));
  // Also add any providers that exist only in the cloud map? Keep shell providers local.
  const { useVault } = await import('../security/vault');
  if (story) await useVault.getState().adoptStoryWrap(story);
  await useVault.getState().persistKeys();
  return Object.keys(keyMap).length;
}

function splitSecrets(parsed: unknown): { keys: Record<string, string>; story: CipherPayload | null } {
  if (parsed && typeof parsed === 'object' && (parsed as { v?: unknown }).v === 2) {
    const env = parsed as { keys?: Record<string, string>; story?: CipherPayload | null };
    return { keys: env.keys ?? {}, story: env.story ?? null };
  }
  return { keys: (parsed ?? {}) as Record<string, string>, story: null };
}
