import { describe, expect, it } from 'vitest';
import { MODE_PREFIX } from './prompts';
import {
  applyDeliveryTone,
  deliveryPhrase,
  DELIVERY_TONES,
  DELIVERY_TONE_GROUPS,
  isDeliveryTone,
  parseDeliveryTone
} from './deliveryTone';

describe('deliveryTone', () => {
  it('parses and applies preset tags', () => {
    expect(parseDeliveryTone('[sarcastic] Hello.')).toEqual({
      tone: 'sarcastic',
      body: 'Hello.'
    });
    expect(applyDeliveryTone('Hello.', 'mad')).toBe('[mad] Hello.');
    expect(parseDeliveryTone('[nope] Hello.').tone).toBeNull();
  });

  it('round-trips hyphenated tags', () => {
    expect(applyDeliveryTone('Hello.', 'matter-of-fact')).toBe('[matter-of-fact] Hello.');
    expect(parseDeliveryTone('[matter-of-fact] Hello.')).toEqual({
      tone: 'matter-of-fact',
      body: 'Hello.'
    });
  });

  it('keeps every tag ever written to a turn parseable', () => {
    // These ids are persisted inside saved turns — dropping one would leave the
    // raw "[tag]" showing in old prose.
    const shipped = [
      'mad', 'sarcastic', 'happy', 'sad', 'scared', 'quietly', 'whispered',
      'cold', 'warm', 'nervous', 'bitter', 'playful', 'tired', 'gentle'
    ];
    for (const tone of shipped) {
      expect(isDeliveryTone(tone)).toBe(true);
    }
  });

  it('covers a wide emotional range without duplicate ids', () => {
    expect(DELIVERY_TONES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(DELIVERY_TONES).size).toBe(DELIVERY_TONES.length);
  });

  it('puts every tone in exactly one picker group', () => {
    const grouped = DELIVERY_TONE_GROUPS.flatMap((g) => g.tones);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...DELIVERY_TONES].sort());
  });

  it('gives every tone a non-empty stage direction', () => {
    for (const tone of DELIVERY_TONES) {
      expect(deliveryPhrase(tone).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('MODE_PREFIX delivery framing', () => {
  it('keeps the tag out of spoken quotes and reads as direction', () => {
    const spoken = MODE_PREFIX.speak('[sarcastic] "I see."');
    expect(spoken).toContain('says the following aloud with sarcasm');
    expect(spoken).toContain('"I see."');
    expect(spoken).not.toContain('[sarcastic]');

    const acted = MODE_PREFIX.act('[mad] slam the door');
    expect(acted).toContain('does the following in anger');
    expect(acted).toContain('slam the door');
    expect(acted).not.toContain('[mad]');
  });

  it('frames play as speak+act without stripping gestures', () => {
    const framed = MODE_PREFIX.play('[quietly] *opens the door* "Anyone home?"');
    expect(framed).toContain('acts and speaks quietly');
    expect(framed).toContain('*opens the door*');
    expect(framed).toContain('"Anyone home?"');
    expect(framed).not.toContain('[quietly]');
  });

  it('avoids the broken article that a bare adjective produced', () => {
    // "with a eager delivery" was the old failure mode for vowel-initial tones.
    const spoken = MODE_PREFIX.speak('[eager] "Now?"');
    expect(spoken).toContain('eagerly');
    expect(spoken).not.toMatch(/\ba eager\b/);
    expect(MODE_PREFIX.act('[whispered] lean in')).toContain('in a whisper');
  });

  it('leaves untagged input unchanged', () => {
    expect(MODE_PREFIX.speak('"Plain line."')).toContain('says the following aloud, and nothing more');
  });
});
