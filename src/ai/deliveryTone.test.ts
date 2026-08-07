import { describe, expect, it } from 'vitest';
import { MODE_PREFIX } from './prompts';
import { applyDeliveryTone, parseDeliveryTone } from './deliveryTone';

describe('deliveryTone', () => {
  it('parses and applies preset tags', () => {
    expect(parseDeliveryTone('[sarcastic] Hello.')).toEqual({
      tone: 'sarcastic',
      body: 'Hello.'
    });
    expect(applyDeliveryTone('Hello.', 'mad')).toBe('[mad] Hello.');
    expect(parseDeliveryTone('[nope] Hello.').tone).toBeNull();
  });

  it('keeps the tag out of spoken quotes in MODE_PREFIX', () => {
    expect(MODE_PREFIX.speak('[sarcastic] "I see."')).toContain('with a sarcastic delivery');
    expect(MODE_PREFIX.speak('[sarcastic] "I see."')).toContain('"I see."');
    expect(MODE_PREFIX.speak('[sarcastic] "I see."')).not.toContain('[sarcastic]');
    expect(MODE_PREFIX.act('[mad] slam the door')).toContain('with a mad manner');
    expect(MODE_PREFIX.act('[mad] slam the door')).toContain('slam the door');
  });
});
