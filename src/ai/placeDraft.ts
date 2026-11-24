import { isCommonLabel } from './nameMatch';

/** A cast member the place fill-in is allowed to name. */
export interface PlaceCastPerson {
  id: string;
  name: string;
  aliases?: string[];
}

export interface PlaceDraftModel {
  name?: string;
  tagline?: string;
  summary?: string;
  atmosphere?: string;
  features?: string;
  history?: string;
  inhabitants?: string;
  rules?: string[];
  secrets?: string;
  currentState?: string;
  /** Hidden: history and secrets the writer reveals only when earned. */
  hidden?: string;
  /** Exact name of an existing place this one sits inside. */
  inside?: string;
  area?: string;
  near?: string;
  residentNames?: string[];
  belongs?: { name?: string; how?: string }[];
}

export interface PlaceDraftSheet {
  name: string;
  tagline: string;
  summary: string;
  atmosphere: string;
  features: string;
  history: string;
  inhabitants: string;
  rules: string[];
  secrets: string;
  currentState: string;
  hidden?: string;
  /** Name of the existing place this one sits inside, as the model wrote it. */
  inside?: string;
  area?: string;
  near?: string;
  residentIds?: string[];
}

export interface PlaceDraftContext {
  /** What the author wrote. Model output does not belong here. */
  authorText: string;
  cast: PlaceCastPerson[];
  /** Final lock: named people plus anyone the author tapped, minus anyone they turned off. */
  allowed: PlaceCastPerson[];
  areas: string[];
  places: { name: string }[];
}

const AREA_SUFFIX = /^(neighborhood|neighbourhood|district|quarter|area|ward|borough)$/i;

const PERSON_CUE =
  /\b(lives?|lived|works?|sister|brother|wife|husband|son|daughter|roommate|mother|father|cousin|uncle|aunt|named|resident|residents)\b/i;

const NAME_STOP = new Set([
  'the', 'her', 'his', 'she', 'him', 'they', 'this', 'that', 'from', 'about', 'home', 'where',
  'when', 'with', 'and', 'but', 'for', 'not'
]);

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSpans(text: string, label: string): { start: number; end: number }[] {
  const name = label.trim();
  if (name.length < 2 || isCommonLabel(name)) return [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(name)})(?=[^\\p{L}\\p{N}]|$)`, 'giu');
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(re)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    spans.push({ start, end: start + (match[2]?.length ?? 0) });
  }
  return spans;
}

function labelsOf(person: PlaceCastPerson): string[] {
  return [person.name, ...(person.aliases ?? [])].map((label) => label.trim()).filter((label) => label.length >= 2);
}

function followedByCapitalWord(text: string, end: number): boolean {
  return /^\s+[A-Z][\p{L}'’.-]{2,}/u.test(text.slice(end));
}

interface NameHit {
  id: string;
  start: number;
  end: number;
  label: string;
}

function nameHits(text: string, cast: PlaceCastPerson[]): NameHit[] {
  const hits: NameHit[] = [];
  for (const person of cast) {
    if (!person.name.trim()) continue;
    for (const label of labelsOf(person)) {
      const single = !/\s/.test(label);
      for (const span of findSpans(text, label)) {
        if (single && followedByCapitalWord(text, span.end)) continue;
        hits.push({ id: person.id, label, ...span });
      }
    }
  }
  return hits.filter((hit) => !hits.some((other) =>
    other.start <= hit.start &&
    other.end >= hit.end &&
    other.end - other.start > hit.end - hit.start
  ));
}

function peopleFromHits(text: string, cast: PlaceCastPerson[], hits: NameHit[]): {
  people: PlaceCastPerson[];
  ambiguous: string[];
} {
  const groups = new Map<string, { ids: Set<string>; label: string }>();
  for (const hit of hits) {
    const key = `${hit.start}:${hit.end}`;
    const group = groups.get(key) ?? { ids: new Set<string>(), label: text.slice(hit.start, hit.end) || hit.label };
    group.ids.add(hit.id);
    groups.set(key, group);
  }
  const ids = new Set<string>();
  const ambiguous: string[] = [];
  for (const group of groups.values()) {
    if (group.ids.size === 1) {
      ids.add([...group.ids][0]);
      continue;
    }
    const label = group.label.trim();
    if (label && !ambiguous.some((have) => have.toLowerCase() === label.toLowerCase())) ambiguous.push(label);
  }
  return {
    people: cast.filter((person) => ids.has(person.id)),
    ambiguous
  };
}

/** Names the author actually wrote, ignoring a shorter name tucked inside a longer one. */
export function mentionedResidents(authorText: string, cast: PlaceCastPerson[]): PlaceCastPerson[] {
  return peopleFromHits(authorText, cast, nameHits(authorText, cast)).people;
}

/** Ask the author to tap when one short name matches more than one person. */
export function ambiguousResidentNote(authorText: string, cast: PlaceCastPerson[]): string | null {
  const { ambiguous } = peopleFromHits(authorText, cast, nameHits(authorText, cast));
  const label = ambiguous[0]?.trim();
  if (!label) return null;
  const matches = cast.filter((person) =>
    labelsOf(person).some((item) => item.toLowerCase() === label.toLowerCase())
  );
  const count = matches.length >= 2 ? matches.length : 2;
  const who = count === 2 ? 'Two people are' : `${count} people are`;
  return `${who} named ${label} — pick who this place is for.`;
}

export function resolveResidents(opts: {
  authorText: string;
  cast: PlaceCastPerson[];
  selectedIds?: string[];
  dismissedIds?: string[];
}): PlaceCastPerson[] {
  const ids = new Set(mentionedResidents(opts.authorText, opts.cast).map((person) => person.id));
  for (const id of opts.selectedIds ?? []) {
    if (opts.cast.some((person) => person.id === id)) ids.add(id);
  }
  for (const id of opts.dismissedIds ?? []) ids.delete(id);
  return opts.cast.filter((person) => ids.has(person.id) && person.name.trim());
}

function normalizeAreaPhrase(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ').replace(/^(the|a|an)\s+/i, '');
  const parts = text.split(' ').filter(Boolean);
  if (parts.length > 1 && AREA_SUFFIX.test(parts[parts.length - 1])) parts.pop();
  text = parts.join(' ').trim();
  return text;
}

function matchExistingArea(phrase: string, existing: string[]): string | null {
  const norm = normalizeAreaPhrase(phrase).toLowerCase();
  if (!norm) return null;
  const hit = existing.find((area) => normalizeAreaPhrase(area).toLowerCase() === norm);
  return hit?.trim() || null;
}

/** "Briar Park neighborhood" reuses an existing "Briar Park". A new phrase keeps its core name. */
export function reuseArea(candidate: string, existing: string[]): string {
  const norm = normalizeAreaPhrase(candidate);
  if (!norm) return '';
  return matchExistingArea(norm, existing) ?? norm;
}

function areaFromText(text: string, existing: string[]): string {
  const sorted = [...existing].filter((area) => area.trim()).sort((a, b) => b.trim().length - a.trim().length);
  for (const area of sorted) {
    const name = normalizeAreaPhrase(area);
    if (name && findSpans(text, name).length > 0) return area.trim();
  }
  const match = text.match(/\bin\s+(?:the\s+)?([A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,3})/u);
  if (!match) return '';
  return reuseArea(match[1], existing);
}

export function resolveArea(proposed: string, authorText: string, existing: string[], current = ''): string {
  const fromAuthor = areaFromText(authorText, existing);
  if (fromAuthor) return fromAuthor;
  const proposedName = normalizeAreaPhrase(proposed);
  if (!proposedName) return current.trim();
  const existingHit = matchExistingArea(proposedName, existing);
  if (existingHit) return existingHit;
  if (findSpans(authorText, proposedName).length > 0) return reuseArea(proposedName, existing);
  return current.trim();
}

function extractNearClause(text: string): string {
  const match = text.match(
    /\babout\s+\d+\s+[^.,;\n]+|\b\d+\s+minutes?\s+from\s+[^.,;\n]+|\ba\s+(?:short|long|quick)\s+(?:walk|drive|ride)\s+from\s+[^.,;\n]+/i
  );
  return match?.[0]?.trim() ?? '';
}

function replaceSpan(text: string, start: number, end: number, next: string): string {
  return `${text.slice(0, start)}${next}${text.slice(end)}`;
}

function applyExactPlaceNames(line: string, places: { name: string }[]): string {
  const named = places
    .map((place) => place.name.trim())
    .filter((name) => name.length >= 2)
    .sort((a, b) => b.length - a.length);
  let out = line;
  const used = new Set<string>();
  for (const name of named) {
    if (used.has(name.toLowerCase())) continue;
    const bare = name.replace(/^the\s+/i, '');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])((?:the\\s+)?${escapeRe(bare)})(?=[^\\p{L}\\p{N}]|$)`, 'iu');
    const match = re.exec(out);
    if (!match) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const end = start + (match[2]?.length ?? 0);
    out = replaceSpan(out, start, end, name);
    used.add(name.toLowerCase());
  }
  return out.replace(/\s+/g, ' ').trim();
}

function knownPlacePhrase(name: string, places: { name: string }[], areas: string[]): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  if (places.some((place) => {
    const have = place.name.trim().toLowerCase();
    return have === key || have.replace(/^the\s+/, '') === key.replace(/^the\s+/, '');
  })) return true;
  return areas.some((area) => normalizeAreaPhrase(area).toLowerCase() === normalizeAreaPhrase(name).toLowerCase());
}

function stripUnknownPlaceNames(line: string, places: { name: string }[], areas: string[], authorText: string): string {
  const proper = line.match(/\b[A-Z][\p{L}'’.-]{2,}(?:\s+[A-Z][\p{L}'’.-]{2,})*/gu) ?? [];
  let out = line;
  for (const name of proper) {
    if (NAME_STOP.has(name.toLowerCase())) continue;
    if (knownPlacePhrase(name, places, areas)) continue;
    if (findSpans(authorText, name).length > 0) continue;
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'u'), ' ');
  }
  return out.replace(/\s+/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
}

export function resolveNear(
  proposed: string,
  authorText: string,
  places: { name: string }[],
  areas: string[] = [],
  current = ''
): string {
  const authorNear = extractNearClause(authorText);
  const line = (authorNear || proposed).trim();
  if (!line) return current.trim();
  const exact = applyExactPlaceNames(line, places);
  const cleaned = stripUnknownPlaceNames(exact, places, areas, authorText);
  if (!cleaned || /^about\s+minutes?\s+from$/i.test(cleaned)) return current.trim();
  return cleaned;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function belongsHow(person: PlaceCastPerson, model: PlaceDraftModel): string {
  const row = (model.belongs ?? []).find((item) => {
    const name = (item.name ?? '').trim();
    if (!name) return false;
    return labelsOf(person).some((label) => label.toLowerCase() === name.toLowerCase());
  });
  return (row?.how ?? '').trim();
}

function residentLead(allowed: PlaceCastPerson[], model: PlaceDraftModel): string {
  const homes: string[] = [];
  const works: string[] = [];
  for (const person of allowed) {
    const name = person.name.trim();
    if (!name) continue;
    if (/\bwork/.test(belongsHow(person, model))) works.push(name);
    else homes.push(name);
  }
  const bits: string[] = [];
  if (homes.length) bits.push(`Home of ${joinNames(homes)}`);
  if (works.length === 1) bits.push(`Where ${works[0]} works`);
  else if (works.length > 1) bits.push(`Where ${joinNames(works)} work`);
  return bits.join('. ');
}

function sentencesOf(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : (text.trim() ? [text.trim()] : []);
}

function properNames(sentence: string): string[] {
  const found = sentence.match(/\b[A-Z][\p{L}'’.-]{2,}(?:\s+[A-Z][\p{L}'’.-]{2,})*/gu) ?? [];
  return found.filter((name) => !NAME_STOP.has(name.toLowerCase()));
}

function mentionsDenied(text: string, cast: PlaceCastPerson[], allowedIds: Set<string>): boolean {
  return nameHits(text, cast).some((hit) => !allowedIds.has(hit.id));
}

function inventedPerson(sentence: string, allowed: PlaceCastPerson[], authorText: string, places: { name: string }[], areas: string[]): boolean {
  if (!PERSON_CUE.test(sentence)) return false;
  return properNames(sentence).some((name) => {
    if (allowed.some((person) => labelsOf(person).some((label) => label.toLowerCase() === name.toLowerCase()))) return false;
    if (knownPlacePhrase(name, places, areas)) return false;
    if (findSpans(authorText, name).length > 0) return false;
    return true;
  });
}

function rejectedNames(model: PlaceDraftModel, allowed: PlaceCastPerson[]): string[] {
  const allowedKeys = new Set(allowed.flatMap((person) => labelsOf(person).map((label) => label.toLowerCase())));
  return (model.residentNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && !allowedKeys.has(name.toLowerCase()));
}

export function scrubPlaceProse(
  text: string,
  cast: PlaceCastPerson[],
  allowed: PlaceCastPerson[],
  authorText: string,
  places: { name: string }[],
  areas: string[],
  model: PlaceDraftModel = {}
): string {
  const allowedIds = new Set(allowed.map((person) => person.id));
  const rejected = rejectedNames(model, allowed);
  const kept = sentencesOf(text).filter((sentence) => {
    if (mentionsDenied(sentence, cast, allowedIds)) return false;
    if (rejected.some((name) => findSpans(sentence, name).length > 0)) return false;
    if (inventedPerson(sentence, allowed, authorText, places, areas)) return false;
    return true;
  });
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function keepText(existing: string, incoming: string | undefined): string {
  return incoming && incoming.trim() ? incoming.trim() : existing;
}

function mergeLines(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((line) => line.trim().toLowerCase()));
  return [...existing, ...incoming.filter((line) => line.trim() && !seen.has(line.trim().toLowerCase()))];
}

function composeInhabitants(
  existing: string,
  model: PlaceDraftModel,
  ctx: PlaceDraftContext
): string {
  const lead = residentLead(ctx.allowed, model);
  const body = scrubPlaceProse(
    keepText(existing, model.inhabitants),
    ctx.cast,
    ctx.allowed,
    ctx.authorText,
    ctx.places,
    ctx.areas,
    model
  );
  if (!lead) return body;
  if (!body) return lead;
  if (body.toLowerCase().includes(lead.toLowerCase())) return body;
  const rest = body
    .replace(/\bHome of [^.]+\.?/gi, '')
    .replace(/\bWhere [^.]+\bworks?\.?/gi, '')
    .trim();
  if (!rest) return lead;
  return `${lead}. ${rest}`.replace(/\s+/g, ' ').trim();
}

/** Lock a model place sheet to the cast, areas, and places that already exist. */
export function applyPlaceDraft(
  existing: PlaceDraftSheet,
  model: PlaceDraftModel,
  ctx: PlaceDraftContext
): PlaceDraftSheet {
  const scrub = (existingText: string, incoming: string | undefined) => scrubPlaceProse(
    keepText(existingText, incoming),
    ctx.cast,
    ctx.allowed,
    ctx.authorText,
    ctx.places,
    ctx.areas,
    model
  );
  const rules = mergeLines(existing.rules, model.rules ?? []).filter((rule) => scrub(rule, rule) === rule.trim());
  return {
    name: keepText(existing.name, model.name),
    tagline: scrub(existing.tagline, model.tagline),
    summary: scrub(existing.summary, model.summary),
    atmosphere: scrub(existing.atmosphere, model.atmosphere),
    features: scrub(existing.features, model.features),
    history: scrub(existing.history, model.history),
    inhabitants: composeInhabitants(existing.inhabitants, model, ctx),
    rules,
    secrets: scrub(existing.secrets, model.secrets),
    currentState: scrub(existing.currentState, model.currentState),
    hidden: scrub(existing.hidden ?? '', model.hidden ?? [model.history, model.secrets].filter((x) => x?.trim()).join(' ')),
    inside: (model.inside ?? '').trim()
      && ctx.places.some((place) => place.name.trim().toLowerCase() === (model.inside ?? '').trim().toLowerCase())
      ? (model.inside ?? '').trim()
      : '',
    area: resolveArea(model.area ?? '', ctx.authorText, ctx.areas, existing.area ?? ''),
    near: resolveNear(model.near ?? '', ctx.authorText, ctx.places, ctx.areas, existing.near ?? ''),
    residentIds: ctx.allowed.map((person) => person.id)
  };
}

export function placeFillGuidance(opts: {
  cast: PlaceCastPerson[];
  allowed: PlaceCastPerson[];
  areas: string[];
  places: { name: string }[];
}): string {
  const allowed = opts.allowed.map((person) => person.name.trim()).filter(Boolean);
  const allowedKeys = new Set(allowed.map((name) => name.toLowerCase()));
  const denied = opts.cast
    .map((person) => person.name.trim())
    .filter((name) => name && !allowedKeys.has(name.toLowerCase()));
  const placeNames = opts.places.map((place) => place.name.trim()).filter(Boolean);
  return [
    'Named people on this sheet may only be the allowed residents. Do not invent a person. Do not substitute another cast member.',
    allowed.length
      ? `Allowed residents, exact names only: ${allowed.join(', ')}. This place is theirs.`
      : 'No resident was named. Do not invent a named resident. An unnamed role such as "a clerk" is fine.',
    denied.length ? `Do not mention these existing people: ${denied.join(', ')}.` : '',
    opts.areas.length
      ? `Existing areas, reuse the exact spelling when this place is in one: ${opts.areas.join(', ')}.`
      : 'Name a new area only if the author asked for one.',
    placeNames.length
      ? `Existing places, exact names only. "inside" may name one of these when this place sits within it: ${placeNames.join(', ')}.`
      : '"inside" stays empty: there are no other places yet.',
    'residentNames must be a subset of the allowed residents, or empty.'
  ].filter(Boolean).join('\n');
}

export function residentLocationSeeds(
  cast: { id: string; state?: { location?: string } }[],
  residentIds: string[],
  placeName: string
): { id: string; location: string }[] {
  const name = placeName.trim();
  if (!name) return [];
  const wanted = new Set(residentIds);
  return cast.flatMap((person) => {
    if (!wanted.has(person.id)) return [];
    if ((person.state?.location ?? '').trim()) return [];
    return [{ id: person.id, location: name }];
  });
}

export function groupLocationsByArea<T extends { area?: string }>(places: T[]): { area: string; places: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const place of places) {
    const area = place.area?.trim() || '';
    const list = groups.get(area);
    if (list) list.push(place);
    else groups.set(area, [place]);
  }
  const named = [...groups.entries()]
    .filter(([area]) => area)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const loose = groups.get('') ?? [];
  return [
    ...named.map(([area, rows]) => ({ area, places: rows })),
    ...(loose.length ? [{ area: '', places: loose }] : [])
  ];
}

export function placeAuthorText(place: {
  name?: string;
  tagline?: string;
  summary?: string;
  atmosphere?: string;
  features?: string;
  history?: string;
  inhabitants?: string;
  secrets?: string;
  currentState?: string;
  area?: string;
  near?: string;
}): string {
  return [
    place.name, place.tagline, place.summary, place.atmosphere, place.features,
    place.history, place.inhabitants, place.secrets, place.currentState, place.area, place.near
  ].map((part) => (part ?? '').trim()).filter(Boolean).join('\n');
}
