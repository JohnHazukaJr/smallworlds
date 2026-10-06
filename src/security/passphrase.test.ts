import { describe, expect, it } from 'vitest';
import { newPassphraseError } from './passphrase';

describe('new passphrases', () => {
  it('requires 12 characters and still allows an empty export', () => {
    expect(newPassphraseError('short')).toMatch(/12/);
    expect(newPassphraseError('12345678901')).toMatch(/12/);
    expect(newPassphraseError('123456789012')).toBeNull();
    expect(newPassphraseError('', true)).toBeNull();
    expect(newPassphraseError('')).toMatch(/Enter/);
  });
});
