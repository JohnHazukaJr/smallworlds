/**
 * Credit prices for the hosted provider.
 * Keep these numbers identical to src/billing/plans.ts.
 */

export const STARTER_CREDITS = 40;
export const MONTHLY_CREDITS = 600;
export const PACK_CREDITS = 200;
export const COST_BEAT = 4;
export const COST_UTILITY = 1;
export const COST_IMAGE = 8;
/** Utility-priced chat must stay under this completion ceiling. */
export const UTILITY_TOKEN_CEILING = 900;
/** Input size above which a utility-model call is billed as a beat. */
export const UTILITY_PROMPT_CHAR_CAP = 32_000;

export const HOSTED_PROSE_MODEL = 'small-worlds/prose';
export const HOSTED_UTILITY_MODEL = 'small-worlds/utility';
export const HOSTED_IMAGE_MODEL = 'small-worlds/image';

/** Characters of system text plus message content. Non-text parts are ignored. */
export function hostedPromptChars(body: { system?: unknown; messages?: unknown }): number {
  let n = typeof body.system === 'string' ? body.system.length : 0;
  if (!Array.isArray(body.messages)) return n;
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') n += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          n += (part as { text: string }).text.length;
        }
      }
    }
  }
  return n;
}

export function chatCredit(
  model: string,
  maxTokens: number,
  promptChars = 0
): { cost: number; reason: 'beat' | 'utility' | 'image' } | null {
  if (model === HOSTED_IMAGE_MODEL) return { cost: COST_IMAGE, reason: 'image' };
  if (model !== HOSTED_PROSE_MODEL && model !== HOSTED_UTILITY_MODEL) return null;
  if (
    model === HOSTED_UTILITY_MODEL
    && maxTokens < UTILITY_TOKEN_CEILING
    && promptChars <= UTILITY_PROMPT_CHAR_CAP
  ) {
    return { cost: COST_UTILITY, reason: 'utility' };
  }
  return { cost: COST_BEAT, reason: 'beat' };
}

/** A full month of credits is only for a paid subscription start or renewal. */
export function subscriptionGrantsCredits(reason: string | null, amountPaid: number): boolean {
  if (reason !== 'subscription_create' && reason !== 'subscription_cycle') return false;
  return amountPaid > 0;
}
