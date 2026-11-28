/**
 * Echo: an NPC opening by saying the player's line back ("See who took it? Aye…")
 * instead of answering it. Small models do this even when told not to, so the
 * scene writer checks for it in code and asks once for a rewrite.
 */

import { parseDeliveryTone } from './deliveryTone';
import type { ComposeMode, TurnBeat } from '../types';

const STOP = new Set(
  ('the a an and or but of to in on at for with from by is are was were be been it its this that these those ' +
    'i you he she we they me him her us them my your his our their what who why how when where do does did not ' +
    'no yes just so if then there here have has had will would can could should ' +
    // Light verbs: "do you think", "you know", "did you see" carry no topic of their own.
    'think know see say said tell mean want get got like about all any').split(' ')
);

const QUOTED = /["“]([^"”“]{2,})["”]/g;

function words(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function isContent(word: string): boolean {
  return word.length > 2 && !STOP.has(word);
}

/**
 * How much of the player's line a reply says back: the longest run of the player's
 * words in a row (and whether that run holds a real word, not just "do you think"),
 * and the share of the player's content words reused.
 */
export function echoOf(playerLine: string, reply: string): { run: number; runHasContent: boolean; share: number } {
  const p = words(playerLine);
  const r = words(reply);
  let run = 0;
  let at = 0;
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < r.length; j++) {
      let k = 0;
      while (i + k < p.length && j + k < r.length && p[i + k] === r[j + k]) k++;
      if (k > run) { run = k; at = i; }
    }
  }
  const content = [...new Set(p.filter(isContent))];
  const said = new Set(r);
  const share = content.length ? content.filter((w) => said.has(w)).length / content.length : 0;
  return { run, runHasContent: p.slice(at, at + run).some(isContent), share };
}

/** What the player said aloud on this move, or '' when they only acted or directed. */
export function playerSpokenWords(mode: ComposeMode, input: string): string {
  const { body } = parseDeliveryTone(input.trim());
  if (mode === 'speak') return body.replace(/^"|"$/g, '').trim();
  if (mode === 'play') {
    const quoted = [...body.matchAll(QUOTED)].map((m) => m[1].trim());
    if (quoted.length > 0) return quoted.join(' ');
    // No quotes: the move reads as speech when it is aimed at someone, so judge all of it.
    return body.replace(/\*[^*]*\*/g, ' ').trim();
  }
  return '';
}

/** The first sentence the first NPC speaks. */
export function openingSpokenSentence(text: string, beats?: TurnBeat[]): string {
  const source = beats?.find((b) => b.role === 'character')?.text ?? text;
  const first = [...source.matchAll(QUOTED)][0]?.[1] ?? '';
  return (first.trim().match(/^.*?[.!?…]+(?=\s|$)/)?.[0] ?? first).trim();
}

/**
 * True when the reply opens by saying the player's line back: re-asking it as a question,
 * or repeating five or more of its words verbatim. "I signed this page." after
 * "Who signed this page?" is an answer, not an echo, and passes.
 */
export function opensWithEcho(playerLine: string, text: string, beats?: TurnBeat[]): string | null {
  if (words(playerLine).length < 4) return null;
  const opener = openingSpokenSentence(text, beats);
  if (!opener) return null;
  const { run, runHasContent } = echoOf(playerLine, opener);
  const reAsked = run >= 3 && runHasContent && /\?\s*$/.test(opener);
  return reAsked || run >= 5 ? opener : null;
}
