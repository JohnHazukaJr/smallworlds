/**
 * Shared name checks for room ranking and for crediting a quote.
 * Kept apart so those two modules can call each other without a cycle.
 */

/**
 * Whole labels that are also ordinary words. A mention of "will" is not the
 * person Will. "Will," and "tell Will" still count.
 */
const COMMON_LABELS = new Set([
  'will', 'may', 'can', 'art', 'hope', 'mark', 'bill', 'pat', 'don', 'guy', 'rose', 'joy',
  'faith', 'grace', 'frank', 'amber', 'chase', 'summer', 'april', 'june', 'august', 'just',
  'like', 'well', 'come', 'look', 'tell', 'said', 'want', 'need', 'have', 'that', 'this',
  'with', 'from', 'your', 'what', 'when', 'then', 'than', 'them', 'they', 'were', 'been',
  'into', 'over', 'back', 'down', 'here', 'there', 'about', 'after', 'before', 'would',
  'could', 'should', 'shall', 'must', 'adult', 'person', 'people', 'their', 'which',
  'where', 'while', 'still', 'never', 'every'
]);

/** A name that is also an ordinary word. "will you" is not the person Will. */
export function isCommonLabel(label: string): boolean {
  return COMMON_LABELS.has(label.trim().toLowerCase());
}

/** Words long enough to tell people apart. Short and ordinary words are skipped. */
export function distinctiveTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 5 || COMMON_LABELS.has(raw) || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** "student" matches "students". "keeper" matches "innkeeper". */
export function tokensLooselyMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5) return false;
  if (long.startsWith(short)) {
    const extra = long.slice(short.length);
    return extra === 's' || extra === 'es';
  }
  return long.endsWith(short);
}
