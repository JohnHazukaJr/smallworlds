/**
 * Detect when an NPC rephrases a question the player already answered.
 * Soft prompts alone do not stop the loop — briefs and one speak retry use this.
 */

const REASK_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'her', 'his', 'she', 'him', 'they', 'them', 'their',
  'into', 'about', 'what', 'when', 'where', 'who', 'how', 'its', 'our', 'did', 'does',
  'why', 'will', 'would', 'could', 'should', 'can', 'may', 'might', 'just', 'only',
  'tell', 'ask', 'asked', 'says', 'said', 'know', 'think', 'want', 'need', 'please'
]);

const ADVANCE_HINT =
  /\b(register|use|take|accept|doubt|refuse|bargain|act|advance|push|answer|heard|acknowledge)\b/i;

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/'s$/g, '').replace(/^'+|'+$/g, ''))
      .filter((w) => w.length >= 3 && !REASK_STOP.has(w))
  );
}

/** Shared distinctive words between two lines; 0 unless at least two overlap. */
export function questionOverlapScore(a: string, b: string): number {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter < 2) return 0;
  return inter / Math.min(A.size, B.size);
}

/**
 * True when a spoken line still asks, and overlaps the prior open question.
 * Used after settle — never drops a landed line by itself.
 */
export function speakReasksPriorQuestion(line: string, priorQuestion: string): boolean {
  const text = line.trim();
  const prior = priorQuestion.trim();
  if (!text || !prior) return false;
  if (!/\?/.test(text)) return false;
  return questionOverlapScore(text, prior) > 0;
}

/**
 * True when a director speak brief looks like "ask that again" rather than
 * register-and-advance. Briefs with clear advance intent pass.
 */
export function speakBriefLooksLikeReask(brief: string, priorQuestion: string): boolean {
  const text = brief.trim();
  const prior = priorQuestion.trim();
  if (!text || !prior) return false;
  if (ADVANCE_HINT.test(text) && !/\?/.test(text)) return false;
  if (/\?/.test(text)) return true;
  return questionOverlapScore(text, prior) > 0;
}

/** Brief that forces the asker to use the player's answer. */
export function rewriteReaskSpeakBrief(askerName: string, playerMove: string): string {
  const name = askerName.trim() || 'Someone';
  const move = playerMove.trim().replace(/\s+/g, ' ').slice(0, 120);
  const moveBit = move ? ` They just said: "${move}".` : '';
  return (
    `As ${name}, register the player's answer as heard.${moveBit} ` +
    `Advance, refuse, bargain, or act on it — do not ask that same question again.`
  );
}

export const SPEAK_REASK_NUDGE =
  'You asked that question again after they already answered. ' +
  'Rewrite the same beat: register their answer, then advance, refuse, bargain, or act. ' +
  'Do not rephrase the same question. Keep *action* and "speech".';
