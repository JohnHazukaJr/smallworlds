/** New passphrases (vault, file encryption). Existing passphrases still unlock at any length. */
export const MIN_NEW_PASSPHRASE = 12;

/**
 * @returns an error string, or null when the value is acceptable.
 * Empty is acceptable only when `allowEmpty` (plain export).
 */
export function newPassphraseError(value: string, allowEmpty = false): string | null {
  if (value.length === 0) return allowEmpty ? null : 'Enter a passphrase.';
  if (value.length < MIN_NEW_PASSPHRASE) return `Use at least ${MIN_NEW_PASSPHRASE} characters.`;
  return null;
}
