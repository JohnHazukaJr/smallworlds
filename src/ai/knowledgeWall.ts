/**
 * Detect when a spoken line states a fact the speaker must not know yet.
 * Ordinary words in a secret ("the capital", "her brother") are not a leak.
 * A leak needs two distinctive words, or one explicit proper-name hit plus another.
 */

const WALL_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'her', 'his', 'she', 'him', 'they', 'them', 'their',
  'into', 'about', 'what', 'when', 'where', 'who', 'how', 'its', 'our', 'did', 'does',
  'must', 'know', 'until', 'story', 'reveals', 'learn', 'cover', 'took', 'take', 'than',
  'then', 'them', 'been', 'being', 'will', 'would', 'could', 'should', 'just', 'only',
  'over', 'under', 'after', 'before', 'while', 'because', 'which', 'there', 'here',
  'said', 'says', 'told', 'tell', 'asks', 'asked'
]);

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/'s$/g, '').replace(/^'+|'+$/g, ''))
      .filter((w) => w.length >= 3 && !WALL_STOP.has(w))
  );
}

/** Token overlap; 0 unless at least two content words are shared. */
export function knowledgeWallScore(text: string, wall: string): number {
  const A = contentWords(text);
  const B = contentWords(wall);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter < 2) return 0;
  return inter / Math.min(A.size, B.size);
}

/** Drop must-not-know clauses that overlap a fact this character just learned. */
export function clearMustNotKnowClause(mustNotKnow: string, learned: string): string {
  const clear = learned.trim();
  if (!clear || !mustNotKnow.trim()) return mustNotKnow;
  const parts = mustNotKnow
    .split(/[.;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const pl = p.toLowerCase();
      const cl = clear.toLowerCase();
      return !(pl.includes(cl) || cl.includes(pl));
    });
  return parts.join('; ');
}

export function speakLeaksMustNotKnow(text: string, wall: string): boolean {
  if (!wall.trim() || !text.trim()) return false;
  return knowledgeWallScore(text, wall) > 0;
}

/** Retry text to keep. Null when it is empty or still states the forbidden fact. */
export function acceptWallRetry(retried: string, wall: string): string | null {
  const text = retried.trim();
  if (!text || speakLeaksMustNotKnow(text, wall)) return null;
  return text;
}

export const SPEAK_WALL_NUDGE =
  'You stated a fact this character must not know yet. Rewrite the same beat without that knowledge. ' +
  'Keep *action* and "speech". Do not hint at the forbidden fact.';
