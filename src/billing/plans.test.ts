import { describe, expect, it } from 'vitest';
import { DIRECTOR_PLAN_TOKENS } from '../ai/prompts';
import {
  COST_BEAT,
  COST_IMAGE,
  COST_UTILITY,
  HOSTED_IMAGE_MODEL,
  HOSTED_PROSE_MODEL,
  HOSTED_UTILITY_MODEL,
  UTILITY_PROMPT_CHAR_CAP,
  UTILITY_TOKEN_CEILING,
  chatCredit,
  subscriptionGrantsCredits
} from './plans';

describe('chatCredit', () => {
  it('prices utility calls under the ceiling and prose as beats', () => {
    expect(chatCredit(HOSTED_UTILITY_MODEL, 400)).toEqual({ cost: COST_UTILITY, reason: 'utility' });
    expect(chatCredit(HOSTED_UTILITY_MODEL, UTILITY_TOKEN_CEILING)).toEqual({ cost: COST_BEAT, reason: 'beat' });
    expect(chatCredit(HOSTED_PROSE_MODEL, 200)).toEqual({ cost: COST_BEAT, reason: 'beat' });
    expect(chatCredit(HOSTED_PROSE_MODEL, 200, 10)).toEqual({ cost: COST_BEAT, reason: 'beat' });
    expect(chatCredit(HOSTED_IMAGE_MODEL, 0)).toEqual({ cost: COST_IMAGE, reason: 'image' });
    expect(chatCredit('gpt-5', 200)).toBeNull();
  });

  it('bills an oversized utility prompt as a beat', () => {
    expect(chatCredit(HOSTED_UTILITY_MODEL, 400, UTILITY_PROMPT_CHAR_CAP)).toEqual({
      cost: COST_UTILITY,
      reason: 'utility'
    });
    expect(chatCredit(HOSTED_UTILITY_MODEL, 400, UTILITY_PROMPT_CHAR_CAP + 1)).toEqual({
      cost: COST_BEAT,
      reason: 'beat'
    });
  });

  it('prices the director plan as a utility call', () => {
    expect(DIRECTOR_PLAN_TOKENS).toBeLessThan(UTILITY_TOKEN_CEILING);
    expect(chatCredit(HOSTED_UTILITY_MODEL, DIRECTOR_PLAN_TOKENS)).toEqual({
      cost: COST_UTILITY,
      reason: 'utility'
    });
  });
});

describe('subscriptionGrantsCredits', () => {
  it('grants a month only for a paid start or renewal', () => {
    expect(subscriptionGrantsCredits('subscription_create', 1200)).toBe(true);
    expect(subscriptionGrantsCredits('subscription_cycle', 1)).toBe(true);
    expect(subscriptionGrantsCredits('subscription_cycle', 0)).toBe(false);
    expect(subscriptionGrantsCredits('subscription_update', 1200)).toBe(false);
    expect(subscriptionGrantsCredits(null, 1200)).toBe(false);
  });
});
