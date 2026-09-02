/**
 * Infer a model's context window and a conservative prompt char budget.
 * Unknown ids default to 32k — the old 128k assumption overflowed smaller models.
 */

import { modelProfile, shouldReserveReasoningTokens } from './modelProfile';

const CHARS_PER_TOKEN = 3.2;
const TOKENIZER_RESERVE = 1024;
const REASONING_OUTPUT_RESERVE = 4000;
const PROMPT_FLOOR_CHARS = 12_000;
const PROMPT_CAP_CHARS = 110_000;
/** Ceiling for overflow safety — not the default send. */
const PROMPT_CAP_LARGE_CHARS = 180_000;

export function inferContextWindowTokens(model: string): number {
  return modelProfile(model).windowTokens;
}

export function isReasoningModel(model: string): boolean {
  return modelProfile(model).reasoningCapable;
}

/**
 * Character budget for system + history. Never shrinks the caller's maxTokens.
 * Extra output reserve only when this call will think (wrap/season/compact).
 */
export function promptCharBudget(
  model: string,
  maxTokens: number,
  opts?: { thinking?: boolean }
): number {
  const window = inferContextWindowTokens(model);
  const thinking = opts?.thinking ?? false;
  const reserve = TOKENIZER_RESERVE + (shouldReserveReasoningTokens(model, thinking) ? REASONING_OUTPUT_RESERVE : 0);
  const tokens = Math.max(0, window - Math.max(0, maxTokens) - reserve);
  const chars = Math.floor(tokens * CHARS_PER_TOKEN);
  const cap = window >= 128_000 ? PROMPT_CAP_LARGE_CHARS : PROMPT_CAP_CHARS;
  return Math.max(PROMPT_FLOOR_CHARS, Math.min(chars, cap));
}

export function isLargeContextWindow(model: string): boolean {
  return inferContextWindowTokens(model) >= 128_000;
}
