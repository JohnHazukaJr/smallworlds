/**
 * Detect when a spoken line states a fact the speaker must not know yet.
 * Same content-word overlap as wrap matching: two shared tokens of length > 2.
 */

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
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

export function speakLeaksMustNotKnow(text: string, wall: string): boolean {
  if (!wall.trim() || !text.trim()) return false;
  return knowledgeWallScore(text, wall) > 0;
}

export const SPEAK_WALL_NUDGE =
  'You stated a fact this character must not know yet. Rewrite the same beat without that knowledge. ' +
  'Keep *action* and "speech". Do not hint at the forbidden fact.';
