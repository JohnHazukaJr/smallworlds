/**
 * Who belongs in this kind of place. Local string checks only — no model call.
 * A classroom holds the teacher and the students. An adult who is not staff
 * stays out unless this line brought them.
 */

import type { Character, Turn } from '../types';
import {
  addressStrength,
  detectHardAddressees,
  distinctiveTokens,
  speakerCandidates,
  tokensLooselyMatch
} from './roomDynamics';

/** Named bodies kept on the scene card when a place fits many people. */
export const ROOM_NAMED_CAP = 6;
/** Others who fit, shown to the director and not yet in the room. */
export const ALSO_FITS_CAP = 4;

const VAGUE_PLACE =
  /^(the\s+)?(city|town|village|world|area|district|region|kingdom|country|land|realm|place)$/i;

const OPEN_INHABITANTS =
  /\b(anyone|anybody|crowd|crowds|public|passersby|passers-by|patrons?|travell?ers?|customers?|whoever|everybody|everyone|guests?|visitors?)\b/i;

const YOUTH_PLACE =
  /\b(students?|pupils?|high\s*school|classroom)\b/i;

const YOUTH_OPEN =
  /\b(parents?|adults?)\b/i;

const ADULT_AGE =
  /\b(adult|grown|middle-aged|elder|parents?|fathers?|mothers?|thirties|forties|fifties|sixties|seventies)\b|\b[3-9]\d\b/i;

const STAFF_ROLE =
  /\b(teachers?|professors?|instructors?|principals?|headmasters?|headmistresses?|coaches?|nurses?|counsellors?|counselors?|registrars?|faculty|staff|aides?)\b/i;

const BRING =
  'with|bring|brings|brought|take|takes|took|taking';

export interface ScenePlace {
  name: string;
  inhabitants: string;
}

export interface CastDeltaInput {
  enter?: string[];
  leave?: string[];
  introduce?: Array<{ name?: string; brief?: string; voice?: string }>;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordIn(hay: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 3 || !hay.trim()) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}([^\\p{L}\\p{N}]|$)`, 'iu').test(hay);
}

function stripArticle(text: string): string {
  return text.trim().replace(/^the\s+/i, '').trim();
}

function isVaguePlace(text: string): boolean {
  return VAGUE_PLACE.test(text.trim());
}

/** A limited set of roles, rather than a public room anyone can walk into. */
export function placeIsClosed(inhabitants: string): boolean {
  const text = inhabitants.trim();
  if (!text || OPEN_INHABITANTS.test(text)) return false;
  return distinctiveTokens(text).length > 0;
}

function youthClass(inhabitants: string): boolean {
  return YOUTH_PLACE.test(inhabitants) && !YOUTH_OPEN.test(inhabitants);
}

function readsAsAdult(age: string): boolean {
  return ADULT_AGE.test(age);
}

function staffRole(role: string): boolean {
  return STAFF_ROLE.test(role);
}

function locationsMatch(charLoc: string, placeName: string): boolean {
  const a = stripArticle(charLoc);
  const b = stripArticle(placeName);
  if (a.length < 4 || b.length < 4) return false;
  if (isVaguePlace(charLoc) || isVaguePlace(placeName)) return false;
  return wordIn(a, b) || wordIn(b, a);
}

function roleOverlaps(character: Character, inhabitants: string): boolean {
  if (!inhabitants.trim()) return false;
  const inhab = distinctiveTokens(inhabitants);
  const labels = [
    character.name,
    ...(character.aliases ?? []),
    ...distinctiveTokens(character.role)
  ];
  return labels.some((label) => {
    const token = label.trim().toLowerCase();
    if (!token) return false;
    if (wordIn(inhabitants, label.trim())) return true;
    return inhab.some((h) => tokensLooselyMatch(h, token));
  });
}

/** True when this person is the kind of person that place already holds. */
export function characterFitsPlace(character: Character, place: ScenePlace): boolean {
  if (character.isPlayer) return false;
  if (roleOverlaps(character, place.inhabitants)) return true;
  if (youthClass(place.inhabitants) && readsAsAdult(character.age) && !staffRole(character.role)) {
    return false;
  }
  return locationsMatch(character.state?.location ?? '', place.name);
}

/** The line summons them by name, alias, role, or "I take my uncle". */
export function lineBringsCharacter(playerText: string, character: Character): boolean {
  const labels = [
    character.name,
    ...(character.aliases ?? []),
    ...distinctiveTokens(character.role)
  ].map((l) => l.trim()).filter((l) => l.length >= 3);
  for (const label of labels) {
    const strength = addressStrength(playerText, label);
    if (strength === 'vocative' || strength === 'directed') return true;
    const n = escapeRe(label);
    if (new RegExp(`\\b(?:${BRING})\\b(?:\\s+\\w+){0,4}\\s+${n}\\b`, 'iu').test(playerText)) {
      return true;
    }
  }
  return false;
}

/** A move toward a place, so company is re-checked against the new room. */
export function inferPlaceChanged(playerText: string, placeName: string): boolean {
  const line = playerText.trim();
  if (!line || !placeName.trim()) return false;
  const moves = /\b(go|goes|went|head|heads|headed|walk|walks|walked|enter|enters|entered|step|steps|stepped|arrive|arrives|arrived|leave|leaves|left)\b/i;
  if (!moves.test(line) || !/\b(to|into|inside|toward|towards)\b/i.test(line)) return false;
  const place = stripArticle(placeName);
  if (place.length >= 4 && (wordIn(line, place) || wordIn(line, place.split(/\s+/)[0] ?? ''))) {
    return true;
  }
  return /\b(class|classroom|school|office|inn|bar|street|shop|room)\b/i.test(line);
}

function unfilledRoleTokens(inhabitants: string, present: Character[]): string[] {
  return distinctiveTokens(inhabitants).filter((tok) =>
    !present.some((c) =>
      tokensLooselyMatch(tok, c.name.toLowerCase()) ||
      distinctiveTokens(c.role).some((t) => tokensLooselyMatch(t, tok)) ||
      (c.aliases ?? []).some((a) => tokensLooselyMatch(tok, a.trim().toLowerCase()))
    )
  );
}

function allowIntroduce(
  row: { name?: string; brief?: string },
  inhabitants: string,
  present: Character[],
  playerText: string,
  someoneAddressed: boolean
): boolean {
  if (someoneAddressed) return false;
  const name = (row.name ?? '').trim();
  const blob = `${name} ${row.brief ?? ''}`;
  if (name && wordIn(playerText, name)) return true;
  const unfilled = unfilledRoleTokens(inhabitants, present);
  if (unfilled.some((tok) => wordIn(blob, tok) || wordIn(playerText, tok))) return true;
  return false;
}

function resolveCharacter(raw: string, characters: Character[]): Character | undefined {
  const key = raw.trim();
  if (!key) return undefined;
  const byId = characters.find((c) => c.id === key && !c.isPlayer);
  if (byId) return byId;
  return characters.find((c) => !c.isPlayer && c.name.trim().toLowerCase() === key.toLowerCase());
}

/**
 * Drop enters for people who do not fit and were not brought.
 * A walk-on stays only to fill a role this place names and nobody here holds,
 * or when the line names them. A line already aimed at someone in the room
 * does not invent a new speaker.
 */
export function filterCastDelta(opts: {
  delta?: CastDeltaInput | null;
  playerText: string;
  characters: Character[];
  castIds: string[];
  placeName: string;
  inhabitants: string;
}): CastDeltaInput | null {
  const delta = opts.delta;
  if (!delta) return null;
  const place = { name: opts.placeName, inhabitants: opts.inhabitants };
  const present = opts.characters.filter((c) => opts.castIds.includes(c.id) && !c.isPlayer);
  const addressed = detectHardAddressees(opts.playerText, speakerCandidates(present, [])).length > 0;
  const enter = (delta.enter ?? []).filter((raw) => {
    const c = resolveCharacter(raw, opts.characters);
    if (!c) return false;
    return characterFitsPlace(c, place) || lineBringsCharacter(opts.playerText, c);
  });
  const introduce = (delta.introduce ?? []).filter((row) =>
    allowIntroduce(row, opts.inhabitants, present, opts.playerText, addressed)
  );
  return { enter, leave: delta.leave, introduce };
}

/**
 * The scene card for this place.
 * People who fit are here. Company stays in an open place and in the same room.
 * A closed room drops outsiders when the place changes, unless this line brought them.
 */
export function stageSceneCast(opts: {
  castIds: string[];
  characters: Character[];
  placeName: string;
  inhabitants: string;
  playerText: string;
  turns?: Turn[];
  placeChanged: boolean;
}): { castIds: string[]; alsoFits: Character[] } {
  const player = opts.characters.find((c) => c.isPlayer);
  const npcs = opts.characters.filter((c) => !c.isPlayer);
  const place = { name: opts.placeName, inhabitants: opts.inhabitants };
  const closed = placeIsClosed(opts.inhabitants);
  const fitting = npcs.filter((c) => characterFitsPlace(c, place));
  const brought = new Set(npcs.filter((c) => lineBringsCharacter(opts.playerText, c)).map((c) => c.id));
  const spoken = new Set(
    (opts.turns ?? []).filter((t) => t.role === 'character' && t.characterId).map((t) => t.characterId as string)
  );

  const keepExisting = (c: Character): boolean => {
    if (brought.has(c.id)) return true;
    if (fitting.some((f) => f.id === c.id)) return true;
    if (!opts.placeChanged) return true;
    if (!closed) return true;
    return false;
  };

  const ids: string[] = [];
  const push = (id: string) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  if (player) push(player.id);

  for (const id of opts.castIds) {
    if (player && id === player.id) continue;
    const c = npcs.find((x) => x.id === id);
    if (c && keepExisting(c)) push(c.id);
  }

  const namedCount = () => ids.filter((id) => id !== player?.id).length;
  const fittingToAdd = fitting.filter((c) => !ids.includes(c.id));
  if (fitting.length <= ROOM_NAMED_CAP) {
    for (const c of fittingToAdd) push(c.id);
  } else {
    const prioritized = [
      ...fittingToAdd.filter((c) => spoken.has(c.id) || brought.has(c.id)),
      ...fittingToAdd
    ];
    const seen = new Set<string>();
    for (const c of prioritized) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (namedCount() >= ROOM_NAMED_CAP) break;
      push(c.id);
    }
  }

  for (const id of brought) push(id);

  const alsoFits = fitting.filter((c) => !ids.includes(c.id)).slice(0, ALSO_FITS_CAP);
  return { castIds: ids, alsoFits };
}
