import type { ComposeMode } from '../types';
import { applyDeliveryTone, type DeliveryTone } from './deliveryTone';

const SPEECH_OPENERS = /^(hey|hi|hello|yo|oi|ok|okay|yes|yeah|yep|no|nah|nope|sure|thanks|thank you|sorry|please|well|um|uh|hmm|listen|excuse me|what|why|how|who|where|when|which|can|could|would|will|do|does|did|are|is|isn't|aren't|don't|didn't|let's|come on|good|nice|wow|oh|ah|damn|fine|right|really)\b|^(look|wait),/i;
const ACTION_OPENERS = /^(i|i'm|im|i am|i'll|my|she|he|they|it|his|her|their)\b|^(open|close|grab|take|walk|run|sit|stand|look|pick|draw|attack|go|head|move|climb|push|pull|search|check|enter|leave|step|turn|reach|hand|give|drink|eat|sleep|wait|follow|hide|sneak|kneel|lean|nod|shrug|smile|sigh|laugh)\b/i;

/**
 * A bare line with no quotes. A question, a greeting, or words aimed at "you"
 * are speech. "I draw my sword" or "open the door" is an action. The rest is
 * sent as a move that may be either, and the scene reads it in context.
 */
export function bareLineMode(body: string): ComposeMode {
  const text = body.trim();
  if (/\?\s*$/.test(text) || SPEECH_OPENERS.test(text)) return 'speak';
  if (ACTION_OPENERS.test(text)) return 'act';
  if (/\b(you|your|you're|yours|y'all)\b/i.test(text)) return 'speak';
  return 'play';
}

/** What Write sends. Direct is author injection, not a spoken line. */
export function composeOutgoingLine(opts: {
  direct: boolean;
  asCharacterId: string | null;
  sceneHasOthers: boolean;
  tone: DeliveryTone | null;
  text: string;
}): { mode: ComposeMode; text: string; asCharacterId: string | null } {
  const body = opts.text.trim();
  if (opts.direct) {
    return { mode: 'steer', text: body, asCharacterId: null };
  }
  // Quotes or gestures: exactly as written. A bare line is read for what it most likely is.
  const marked = /["“”*]/.test(body);
  const mode: ComposeMode = marked ? 'play' : bareLineMode(body);
  return {
    mode,
    text: applyDeliveryTone(body, opts.tone),
    asCharacterId: opts.asCharacterId
  };
}

/**
 * Drop a running summary after an AI line is edited, so the next reply
 * rebuilds memory from the transcript. No summary means leave the episode alone.
 */
export function summaryClearPatch(
  runningSummary: string | null | undefined
): {
  runningSummary: null;
  runningSummaryAtChars: 0;
  liveStateAtChars: 0;
  liveCanonAtChars: 0;
} | null {
  if (!runningSummary?.trim()) return null;
  return {
    runningSummary: null,
    runningSummaryAtChars: 0,
    liveStateAtChars: 0,
    liveCanonAtChars: 0
  };
}
