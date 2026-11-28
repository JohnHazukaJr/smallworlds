/**
 * The live-memory pass trusts the model's JSON shape, and models bend it: a list comes back
 * as an object keyed by name ({"Ada": {...}}), a string list as one string, a name as a number.
 * Any of those used to throw inside the pass ("(drafts ?? []) is not iterable"), which was
 * then reported as a network error and the turn's memory was lost. Everything is reshaped
 * here once, so the code after it can rely on the declared types.
 */

import type { InventoryChange } from '../mechanics';
import type { MemoryDraft } from '../npcMemory';
import type { CurrentMoveRow } from './currents';
import { cleanRow, isPlainObject, rowList, textList, type Row } from './modelShape';

export interface LiveMemoryResult {
  updates?: Array<{
    name?: string;
    goal?: string;
    emotion?: string;
    location?: string;
    condition?: string;
    wearing?: string;
  }>;
  scene?: string[];
  ties?: Array<{ from?: string; to?: string; kind?: string; note?: string }>;
  facts?: string[];
  threads?: string[];
  place?: { name?: string; currentState?: string; atmosphere?: string };
  movedTo?: { place?: string; newPlace?: string } | null;
  knowledge?: Array<{ name?: string; nowKnows?: string }>;
  memories?: MemoryDraft[];
  inventory?: InventoryChange[];
  suggestions?: string[];
  bonds?: Array<{ name?: string; shift?: number; reason?: string }>;
  goals?: Array<{ index?: number; text?: string; shift?: number; reason?: string }>;
  currents?: CurrentMoveRow[];
}

const ROW_FIELDS = ['updates', 'ties', 'knowledge', 'memories', 'inventory', 'bonds', 'goals', 'currents'] as const;
const TEXT_LIST_FIELDS = ['scene', 'facts', 'threads', 'suggestions'] as const;
const OBJECT_FIELDS = ['place', 'movedTo'] as const;

export function normalizeLiveMemory(raw: unknown): LiveMemoryResult {
  const src = isPlainObject(raw) ? raw : {};
  const out: Row = {};
  for (const k of ROW_FIELDS) if (k in src) out[k] = rowList(src[k]);
  for (const k of TEXT_LIST_FIELDS) if (k in src) out[k] = textList(src[k]);
  for (const k of OBJECT_FIELDS) {
    if (!(k in src)) continue;
    const v = src[k];
    if (isPlainObject(v)) out[k] = cleanRow(v);
    else if (k === 'movedTo' && typeof v === 'string' && v.trim()) out[k] = { place: v };
    else if (k === 'movedTo') out[k] = null;
  }
  return out as LiveMemoryResult;
}
