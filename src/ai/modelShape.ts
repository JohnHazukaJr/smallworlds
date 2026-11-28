/**
 * Models bend the JSON shapes they are asked for: a list comes back as an object keyed by
 * name ({"Ada": {...}}), a list of strings as one string, a name as a number, a row as a bare
 * string. Code that trusts the shape throws ("x.map is not a function", "f.trim is not a
 * function") and the whole step is lost. These coerce a reply to the declared shape and drop
 * what cannot be used, so one odd field costs that field, not the chapter.
 */

export type Row = Record<string, unknown>;

/** Fields the code calls string methods on. A number or boolean becomes text; anything else is dropped. */
const STRING_KEYS = new Set([
  'name', 'text', 'feeling', 'from', 'to', 'kind', 'note', 'reason', 'goal', 'emotion', 'location',
  'condition', 'wearing', 'nowKnows', 'action', 'place', 'newPlace', 'currentState', 'atmosphere',
  'description', 'title', 'targetName', 'outcome', 'evolution', 'consequence', 'where', 'summary',
  'role', 'premise', 'recap', 'meaning'
]);
/** Fields the code does arithmetic on. Numeric text becomes a number; anything else is dropped. */
const NUMBER_KEYS = new Set(['shift', 'salience', 'qty', 'index', 'day', 'score']);
/** Keys that mark an object as one row, not a map of rows by name. */
const BARE_ROW_KEYS = ['name', 'text', 'from', 'to', 'n', 'action', 'index', 'description', 'title'];

export function isPlainObject(v: unknown): v is Row {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function cleanRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (STRING_KEYS.has(k)) {
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    } else if (NUMBER_KEYS.has(k)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A list of rows. `{"Ada": {...}}` and `{"Ada": ["...", "..."]}` become rows named Ada,
 * and one row sent bare instead of in a list is kept. `textKey` is where a bare string row
 * goes (a list of descriptions sent as plain strings).
 */
export function rowList<T = Row>(v: unknown, textKey = 'text'): T[] {
  const asRow = (item: unknown, name?: string): Row[] => {
    if (isPlainObject(item)) return [cleanRow(name ? { name, ...item } : item)];
    if (typeof item === 'string' && item.trim()) return [cleanRow(name ? { name, [textKey]: item } : { [textKey]: item })];
    return [];
  };
  if (Array.isArray(v)) return v.flatMap((item) => asRow(item)) as T[];
  if (!isPlainObject(v)) return [];
  if (BARE_ROW_KEYS.some((k) => typeof v[k] === 'string' || typeof v[k] === 'number')) return [cleanRow(v)] as T[];
  return Object.entries(v).flatMap(([name, value]) =>
    Array.isArray(value) ? value.flatMap((item) => asRow(item, name)) : asRow(value, name)
  ) as T[];
}

/** A list of strings. One string, or rows carrying `text`, are accepted. */
export function textList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return list.flatMap((item): string[] => {
    if (typeof item === 'string') return item.trim() ? [item] : [];
    if (typeof item === 'number') return [String(item)];
    if (isPlainObject(item) && typeof item.text === 'string' && item.text.trim()) return [item.text];
    return [];
  });
}

/** An object, or undefined. */
export function objectOr(v: unknown): Row | undefined {
  return isPlainObject(v) ? cleanRow(v) : undefined;
}
