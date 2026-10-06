/**
 * Credit prices for the hosted provider.
 * Keep these numbers identical to supabase/functions/_shared/billing.ts.
 * The server is the source of truth at request time; this copy is for the UI.
 */

export const STARTER_CREDITS = 40;
export const MONTHLY_CREDITS = 600;
export const PACK_CREDITS = 200;
export const COST_BEAT = 4;
export const COST_UTILITY = 1;
export const COST_IMAGE = 8;
/** Utility-priced chat must stay under this completion ceiling. */
export const UTILITY_TOKEN_CEILING = 900;

export const HOSTED_PROSE_MODEL = 'small-worlds/prose';
export const HOSTED_UTILITY_MODEL = 'small-worlds/utility';
export const HOSTED_IMAGE_MODEL = 'small-worlds/image';

export const HOSTED_MODEL_IDS = [HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL, HOSTED_IMAGE_MODEL] as const;

export function chatCredit(
  model: string,
  maxTokens: number
): { cost: number; reason: 'beat' | 'utility' | 'image' } | null {
  if (model === HOSTED_IMAGE_MODEL) return { cost: COST_IMAGE, reason: 'image' };
  if (model !== HOSTED_PROSE_MODEL && model !== HOSTED_UTILITY_MODEL) return null;
  if (model === HOSTED_UTILITY_MODEL && maxTokens < UTILITY_TOKEN_CEILING) {
    return { cost: COST_UTILITY, reason: 'utility' };
  }
  return { cost: COST_BEAT, reason: 'beat' };
}
