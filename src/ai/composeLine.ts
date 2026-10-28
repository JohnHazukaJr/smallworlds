import type { ComposeMode } from '../types';
import { applyDeliveryTone, type DeliveryTone } from './deliveryTone';

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
  const mode: ComposeMode = opts.asCharacterId || !opts.sceneHasOthers ? 'act' : 'play';
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
