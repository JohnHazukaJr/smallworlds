/**
 * Places: a simple tree (a place can sit inside another), one current place
 * per chapter, and the helpers every screen and prompt share.
 *
 * The chapter's place is `episode.locationId`. `episode.location` is only a
 * cached display name, written by setScenePlace.
 */

import { db, recordTombstones } from './db';
import type { Character, Episode, Location } from './types';
import { emptyLocation } from './worldOps';

// ---------- pure helpers ----------

/** Ancestors, nearest first. Stops on a missing parent or a loop. */
export function placeAncestors(place: Pick<Location, 'id' | 'parentId'>, all: Location[]): Location[] {
  const out: Location[] = [];
  const seen = new Set<string>([place.id]);
  let parentId = place.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    const parent = all.find((p) => p.id === parentId);
    if (!parent) break;
    out.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId ?? null;
  }
  return out;
}

/** "Harbour · Saltmere": where this place sits. Empty for a top-level place. */
export function placeWhereLine(place: Pick<Location, 'id' | 'parentId'>, all: Location[]): string {
  return placeAncestors(place, all).map((p) => p.name.trim()).filter(Boolean).join(' · ');
}

/** "The Long Room, in Harbour · Saltmere". */
export function placeFullName(place: Location, all: Location[]): string {
  const name = place.name.trim() || 'Unnamed place';
  const where = placeWhereLine(place, all);
  return where ? `${name}, in ${where}` : name;
}

/** True when making `parentId` the parent of `placeId` would put the place inside itself. */
export function wouldCreateLoop(placeId: string, parentId: string | null | undefined, all: Location[]): boolean {
  if (!parentId) return false;
  if (parentId === placeId) return true;
  const parent = all.find((p) => p.id === parentId);
  if (!parent) return false;
  return placeAncestors(parent, all).some((p) => p.id === placeId);
}

export interface PlaceTreeRow {
  place: Location;
  depth: number;
  hasChildren: boolean;
}

/** Depth-first rows, siblings by name. A place whose parent is gone shows at the top. */
export function placeTree(all: Location[]): PlaceTreeRow[] {
  const ids = new Set(all.map((p) => p.id));
  const kids = new Map<string, Location[]>();
  const roots: Location[] = [];
  for (const place of all) {
    const parent = place.parentId && ids.has(place.parentId) && place.parentId !== place.id ? place.parentId : null;
    if (!parent) roots.push(place);
    else kids.set(parent, [...(kids.get(parent) ?? []), place]);
  }
  const byName = (a: Location, b: Location) => a.name.localeCompare(b.name);
  const rows: PlaceTreeRow[] = [];
  const seen = new Set<string>();
  const walk = (place: Location, depth: number) => {
    if (seen.has(place.id)) return;
    seen.add(place.id);
    const children = (kids.get(place.id) ?? []).sort(byName);
    rows.push({ place, depth, hasChildren: children.length > 0 });
    for (const child of children) walk(child, depth + 1);
  };
  for (const root of roots.sort(byName)) walk(root, 0);
  // Anything left is in a loop: show it at the top rather than lose it.
  for (const place of all) if (!seen.has(place.id)) walk(place, 0);
  return rows;
}

/** The chapter's place: by id, then an exact name match for older free-text chapters. */
export function resolveScenePlace(
  episode: Pick<Episode, 'locationId' | 'location'> | null | undefined,
  places: Location[]
): Location | undefined {
  if (!episode) return undefined;
  if (episode.locationId) {
    const hit = places.find((p) => p.id === episode.locationId);
    if (hit) return hit;
  }
  const name = (episode.location ?? '').trim().toLowerCase();
  if (!name) return undefined;
  return places.find((p) => p.name.trim().toLowerCase() === name);
}

/** Places worth naming to the writer from here: parent, children, nearby, siblings, then the rest. */
export function placesAround(current: Location | undefined, all: Location[], limit = 8): Location[] {
  if (!current) return all.slice(0, limit);
  const picked: Location[] = [];
  const add = (p: Location | undefined) => {
    if (p && p.id !== current.id && !picked.some((x) => x.id === p.id)) picked.push(p);
  };
  add(all.find((p) => p.id === current.parentId));
  for (const p of all.filter((x) => x.parentId === current.id)) add(p);
  for (const id of current.nearIds ?? []) add(all.find((p) => p.id === id));
  for (const p of all.filter((x) => current.parentId && x.parentId === current.parentId)) add(p);
  for (const p of all) add(p);
  return picked.slice(0, limit);
}

/** Find a saved place by a name the model or the player wrote. */
export function findPlaceByName(name: string, all: Location[]): Location | undefined {
  const key = name.trim().toLowerCase().replace(/^the\s+/, '');
  if (!key) return undefined;
  const bare = (p: Location) => p.name.trim().toLowerCase().replace(/^the\s+/, '');
  return all.find((p) => bare(p) === key);
}

// ---------- migration from the old flat sheet ----------

const FILLER_RULES = [
  /keeps what is said here\s*[—-]\s*nothing leaves unnamed/i,
  /^in .+, .+ is not optional\.?$/i,
  /^respect the place/i
];

function isFillerRule(rule: string, place: Pick<Location, 'atmosphere'>): boolean {
  const t = rule.trim();
  if (!t) return true;
  if (place.atmosphere.trim() && t === place.atmosphere.trim()) return true;
  return FILLER_RULES.some((re) => re.test(t));
}

function joinParas(...parts: Array<string | undefined>): string {
  return parts.map((p) => (p ?? '').trim()).filter(Boolean).join('\n\n');
}

/** True when a place still carries fields from before the tree. */
export function placeNeedsMigration(place: Location): boolean {
  return !!(
    place.area?.trim() || place.near?.trim() || place.features?.trim()
    || place.history?.trim() || place.secrets?.trim() || place.tagline?.trim()
    || place.rules.some((r) => isFillerRule(r, place))
  );
}

/**
 * Fold the old flat sheet into the tree, for one world's places:
 * an area becomes a parent place, features join the summary, history and
 * secrets become Hidden, a near line becomes a Nearby link when it names a place.
 */
export function planPlaceMigration(places: Location[], worldId: string): {
  creates: Location[];
  patches: Array<{ id: string; patch: Partial<Location> }>;
} {
  const creates: Location[] = [];
  const patches: Array<{ id: string; patch: Partial<Location> }> = [];
  const pool = [...places];
  const parentFor = (area: string): Location => {
    const hit = findPlaceByName(area, pool);
    if (hit) return hit;
    const made = emptyLocation(worldId, { name: area.trim(), summary: '' });
    creates.push(made);
    pool.push(made);
    return made;
  };
  for (const place of places) {
    if (!placeNeedsMigration(place)) continue;
    const patch: Partial<Location> = {};
    const area = place.area?.trim() ?? '';
    if (area && !place.parentId) {
      const parent = parentFor(area);
      if (parent.id !== place.id) patch.parentId = parent.id;
    }
    const near = place.near?.trim() ?? '';
    const nearHits = near
      ? pool.filter((p) => p.id !== place.id && p.name.trim().length >= 3
        && new RegExp(`\\b${p.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(near))
      : [];
    if (nearHits.length > 0) patch.nearIds = [...new Set([...(place.nearIds ?? []), ...nearHits.map((p) => p.id)])];
    const tagline = place.tagline?.trim() ?? '';
    const taglineIsArea = !!tagline && !!area && tagline.toLowerCase().includes(area.toLowerCase());
    patch.summary = joinParas(
      place.summary,
      taglineIsArea || !tagline || place.summary.toLowerCase().includes(tagline.toLowerCase()) ? '' : tagline,
      place.features ? `Features: ${place.features.trim()}` : '',
      near && nearHits.length === 0 ? `Nearby: ${near}` : ''
    );
    patch.hidden = joinParas(place.hidden, place.history, place.secrets ? `Secret: ${place.secrets.trim()}` : '');
    patch.rules = place.rules.filter((r) => !isFillerRule(r, place));
    patch.area = '';
    patch.near = '';
    patch.features = '';
    patch.history = '';
    patch.secrets = '';
    patch.tagline = '';
    patches.push({ id: place.id, patch });
  }
  return { creates, patches };
}

/** Run the fold once per world. Safe to call on every open: a migrated world does nothing. */
export async function ensurePlacesMigrated(worldId: string): Promise<void> {
  const places = await db.locations.where('worldId').equals(worldId).toArray();
  if (!places.some(placeNeedsMigration)) return;
  const { creates, patches } = planPlaceMigration(places, worldId);
  const now = Date.now();
  await db.transaction('rw', db.locations, async () => {
    if (creates.length) await db.locations.bulkAdd(creates);
    for (const { id, patch } of patches) await db.locations.update(id, { ...patch, updatedAt: now });
  });
}

// ---------- the chapter's place ----------

/**
 * Move a chapter to a place (or to none). The display name follows, and a
 * chapter title that only named the old place follows too.
 */
export async function setScenePlace(episodeId: string, placeId: string | null): Promise<Episode | undefined> {
  const episode = await db.episodes.get(episodeId);
  if (!episode) return undefined;
  const place = placeId ? await db.locations.get(placeId) : undefined;
  const old = episode.locationId ? await db.locations.get(episode.locationId) : undefined;
  const name = place?.name.trim() ?? '';
  const title = episode.title?.trim() ?? '';
  const titleWasPlace = !title || (!!old && title === old.name.trim()) || title === episode.location.trim();
  const patch: Partial<Episode> = {
    locationId: place?.id ?? null,
    location: name,
    ...(titleWasPlace && name ? { title: name } : {}),
    updatedAt: Date.now()
  };
  await db.episodes.update(episodeId, patch);
  return { ...episode, ...patch };
}

/** Rename everywhere the old name was only a copy: chapter caches and titles, and residents' whereabouts. */
export async function renamePlace(place: Location, nextName: string): Promise<void> {
  const name = nextName.trim();
  const oldName = place.name.trim();
  const now = Date.now();
  await db.locations.update(place.id, { name: nextName, updatedAt: now });
  if (!name || name === oldName) return;
  const episodes = await db.episodes.where('worldId').equals(place.worldId).toArray();
  for (const ep of episodes) {
    if (ep.locationId !== place.id) continue;
    const patch: Partial<Episode> = { location: name, updatedAt: now };
    if (oldName && ep.title?.trim() === oldName) patch.title = name;
    await db.episodes.update(ep.id, patch);
  }
  if (!oldName) return;
  const people = await db.characters.where('worldId').equals(place.worldId).toArray();
  for (const person of people) {
    if ((person.state?.location ?? '').trim() !== oldName) continue;
    await db.characters.update(person.id, { state: { ...person.state, location: name }, updatedAt: now });
  }
}

/** Remove a place: its children move up a level, chapters there lose the link, nearby links drop it. */
export async function removePlace(place: Location): Promise<void> {
  const now = Date.now();
  const siblings = await db.locations.where('worldId').equals(place.worldId).toArray();
  const episodes = await db.episodes.where('worldId').equals(place.worldId).toArray();
  await recordTombstones([{ table: 'locations', id: place.id, worldId: place.worldId, payload: { id: place.id } }]);
  await db.transaction('rw', db.locations, db.episodes, async () => {
    for (const other of siblings) {
      if (other.id === place.id) continue;
      const patch: Partial<Location> = {};
      if (other.parentId === place.id) patch.parentId = place.parentId ?? null;
      if (other.nearIds?.includes(place.id)) patch.nearIds = other.nearIds.filter((id) => id !== place.id);
      if (Object.keys(patch).length) await db.locations.update(other.id, { ...patch, updatedAt: now });
    }
    for (const ep of episodes) {
      if (ep.locationId === place.id) await db.episodes.update(ep.id, { locationId: null, location: '', updatedAt: now });
    }
    await db.locations.delete(place.id);
  });
}

/** People who belong to a place, by id. */
export function residentsOf(place: Location, cast: Character[]): Character[] {
  const ids = new Set(place.residentIds ?? []);
  return cast.filter((c) => ids.has(c.id));
}

// ---------- moves during play ----------

export interface SceneMove {
  episodeId: string;
  fromId: string | null;
  toId: string;
  toName: string;
  created: boolean;
}

const moveListeners = new Set<(move: SceneMove) => void>();

/** Story listens so it can say "Moved to …" and offer undo. */
export function onSceneMoved(listener: (move: SceneMove) => void): () => void {
  moveListeners.add(listener);
  return () => moveListeners.delete(listener);
}

export function announceSceneMove(move: SceneMove): void {
  for (const listener of moveListeners) {
    try {
      listener(move);
    } catch {
      // A screen that unmounted mid-call must not break the pass.
    }
  }
}

/**
 * Where the live-state pass says the scene went. A saved place by name, or a
 * new one placed beside the current place. Null when it did not move.
 */
export function planSceneMove(
  moved: { place?: string; newPlace?: string } | null | undefined,
  current: Location | undefined,
  all: Location[]
): { kind: 'saved'; place: Location } | { kind: 'new'; name: string; parentId: string | null } | null {
  if (!moved) return null;
  const named = (moved.place ?? '').trim();
  if (named && !/^(none|null|same|unchanged)$/i.test(named)) {
    const hit = findPlaceByName(named, all);
    if (hit && hit.id !== current?.id) return { kind: 'saved', place: hit };
    if (hit) return null;
  }
  const fresh = (moved.newPlace ?? named).trim().replace(/[.]+$/, '');
  if (!fresh || /^(none|null|same|unchanged)$/i.test(fresh) || fresh.length > 60) return null;
  const existing = findPlaceByName(fresh, all);
  if (existing) return existing.id === current?.id ? null : { kind: 'saved', place: existing };
  return { kind: 'new', name: fresh, parentId: current?.parentId ?? null };
}
