/**
 * Seals story rows with the in-memory story key.
 * Index columns stay plaintext so Dexie queries keep working.
 * Everything else sits in one AES-GCM field. Tampered ciphertext fails decrypt.
 */
import Dexie, {
  type DBCore,
  type DBCoreAddRequest,
  type DBCoreCursor,
  type DBCoreGetManyRequest,
  type DBCoreGetRequest,
  type DBCoreMutateRequest,
  type DBCoreOpenCursorRequest,
  type DBCorePutRequest,
  type DBCoreQueryRequest,
  type DBCoreTable
} from 'dexie';
import { decryptString, encryptString, type CipherPayload } from './crypto';
import { getStoryKey, storySealSuspended } from './storyKey';

export const SEAL_FIELD = '_seal';

export const SEALED_IMPORT_MESSAGE = 'This file is encrypted. Unlock the app lock, then import it.';

/** Columns that stay readable so indexes and last-write-wins still work. */
const INDEX_KEYS = new Set([
  'id', 'worldId', 'seasonId', 'episodeId', 'updatedAt', 'createdAt', 'number', 'storyDay'
]);

export const STORY_TABLES = [
  'worlds', 'seasons', 'episodes', 'turns', 'characters',
  'locations', 'continuity', 'threads', 'wraps', 'calendarEvents'
] as const;

const SEALED_TABLES = new Set<string>(STORY_TABLES);

export function isSealedRecord(row: unknown): row is Record<string, unknown> & { _seal: CipherPayload } {
  if (!row || typeof row !== 'object') return false;
  const seal = (row as { _seal?: unknown })._seal;
  if (!seal || typeof seal !== 'object') return false;
  const payload = seal as CipherPayload;
  return typeof payload.iv === 'string' && typeof payload.ct === 'string';
}

export async function sealRecord(row: Record<string, unknown>, key: CryptoKey): Promise<Record<string, unknown>> {
  if (isSealedRecord(row)) return row;
  const head: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (INDEX_KEYS.has(k)) head[k] = v;
    else body[k] = v;
  }
  head[SEAL_FIELD] = await encryptString(key, JSON.stringify(body));
  return head;
}

/** Throws if the key is wrong or the ciphertext was tampered with. */
export async function openRecord<T extends Record<string, unknown>>(row: T, key: CryptoKey): Promise<T> {
  if (!isSealedRecord(row)) return row;
  const { _seal, ...head } = row;
  const body = JSON.parse(await decryptString(key, _seal)) as Record<string, unknown>;
  return { ...body, ...head } as T;
}

export async function sealPayload(table: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = getStoryKey();
  if (!key || !SEALED_TABLES.has(table)) return payload;
  return sealRecord(payload, key);
}

/** Read the object store directly so sync uploads ciphertext, not the decrypted view. */
export function readDiskRows(idb: IDBDatabase, table: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = idb.transaction(table, 'readonly');
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const req = tx.objectStore(table).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as Record<string, unknown>[]);
    req.onerror = () => reject(req.error ?? new Error('Could not read stored rows.'));
  });
}

export function clearStoryCache(): void {
  const cache = Dexie.cache as Record<string, unknown> | undefined;
  if (!cache) return;
  for (const key of Object.keys(cache)) delete cache[key];
}

function sealingOn(): CryptoKey | null {
  if (storySealSuspended()) return null;
  return getStoryKey();
}

async function decryptValue<T>(value: T): Promise<T> {
  const key = sealingOn();
  if (!key || value == null || typeof value !== 'object') return value;
  return openRecord(value as Record<string, unknown>, key) as Promise<T>;
}

async function mutateSealed(table: DBCoreTable, req: DBCoreMutateRequest) {
  const key = sealingOn();
  if (!key || req.type === 'delete' || req.type === 'deleteRange') return table.mutate(req);
  if (req.type !== 'add' && req.type !== 'put') return table.mutate(req);
  const values = req.values ?? [];
  if (values.length === 0) return table.mutate(req);
  const sealed = await Dexie.waitFor(
    Promise.all(values.map((v) => sealRecord(v as Record<string, unknown>, key)))
  );
  if (req.type === 'add') {
    const next: DBCoreAddRequest = { ...req, values: sealed };
    return table.mutate(next);
  }
  const next: DBCorePutRequest = {
    type: 'put',
    trans: req.trans,
    values: sealed,
    keys: req.keys,
    mutatedParts: req.mutatedParts,
    wantResults: req.wantResults,
    upsert: req.upsert,
    isAdditionalChunk: req.isAdditionalChunk
  };
  return table.mutate(next);
}

function wrapCursor(cursor: DBCoreCursor | null): DBCoreCursor | null {
  if (!cursor) return null;
  let value: unknown = cursor.value;
  const wrapped: DBCoreCursor = {
    get trans() { return cursor.trans; },
    get key() { return cursor.key; },
    get primaryKey() { return cursor.primaryKey; },
    get value() { return value; },
    get done() { return cursor.done; },
    continue(k) { cursor.continue(k); },
    continuePrimaryKey(k, pk) { cursor.continuePrimaryKey(k, pk); },
    advance(n) { cursor.advance(n); },
    start(onNext) {
      return cursor.start(() => {
        const key = sealingOn();
        const raw = cursor.value;
        if (!key || raw == null || typeof raw !== 'object') {
          value = raw;
          onNext();
          return;
        }
        void Dexie.waitFor(openRecord(raw as Record<string, unknown>, key)).then((opened) => {
          value = opened;
          onNext();
        }).catch((err: unknown) => {
          cursor.fail(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
    stop(v) { return cursor.stop(v); },
    next() {
      return cursor.next().then((n) => wrapCursor(n) ?? n);
    },
    fail(e) { cursor.fail(e); }
  };
  return wrapped;
}

export function installStorySeal(db: Dexie): void {
  db.use({
    stack: 'dbcore',
    name: 'storySeal',
    create(down: DBCore) {
      return {
        ...down,
        table(name: string) {
          const table = down.table(name);
          if (!SEALED_TABLES.has(name)) return table;
          return {
            ...table,
            mutate: (req: DBCoreMutateRequest) => mutateSealed(table, req),
            get: async (req: DBCoreGetRequest) => decryptValue(await table.get(req)),
            getMany: async (req: DBCoreGetManyRequest) => {
              const rows = await table.getMany(req);
              const key = sealingOn();
              if (!key) return rows;
              return Dexie.waitFor(Promise.all(rows.map((row) => decryptValue(row))));
            },
            query: async (req: DBCoreQueryRequest) => {
              const res = await table.query(req);
              const key = sealingOn();
              if (!key || req.values === false) return res;
              const result = await Dexie.waitFor(Promise.all(res.result.map((row) => decryptValue(row))));
              return { ...res, result };
            },
            openCursor: async (req: DBCoreOpenCursorRequest) => wrapCursor(await table.openCursor(req))
          };
        }
      };
    }
  });
}
