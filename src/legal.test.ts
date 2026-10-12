import { describe, expect, it } from 'vitest';
import { COPYRIGHT_HOLDER, LEGAL_CONTACT, legalContactSentence } from './legal';

describe('legal contact', () => {
  it('names the operator and does not invent an address', () => {
    expect(LEGAL_CONTACT.trim()).toBe('');
    expect(legalContactSentence()).toContain(COPYRIGHT_HOLDER);
    expect(legalContactSentence()).not.toMatch(/@/);
  });
});
