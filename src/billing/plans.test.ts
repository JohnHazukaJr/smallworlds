import { describe, expect, it } from 'vitest';
import {
  COST_BEAT,
  COST_IMAGE,
  COST_UTILITY,
  HOSTED_IMAGE_MODEL,
  HOSTED_PROSE_MODEL,
  HOSTED_UTILITY_MODEL,
  UTILITY_TOKEN_CEILING,
  chatCredit
} from './plans';

describe('chatCredit', () => {
  it('prices utility calls under the ceiling and prose as beats', () => {
    expect(chatCredit(HOSTED_UTILITY_MODEL, 400)).toEqual({ cost: COST_UTILITY, reason: 'utility' });
    expect(chatCredit(HOSTED_UTILITY_MODEL, UTILITY_TOKEN_CEILING)).toEqual({ cost: COST_BEAT, reason: 'beat' });
    expect(chatCredit(HOSTED_PROSE_MODEL, 200)).toEqual({ cost: COST_BEAT, reason: 'beat' });
    expect(chatCredit(HOSTED_IMAGE_MODEL, 0)).toEqual({ cost: COST_IMAGE, reason: 'image' });
    expect(chatCredit('gpt-5', 200)).toBeNull();
  });
});
