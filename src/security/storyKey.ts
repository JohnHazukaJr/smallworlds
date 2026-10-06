/** In-memory story key. Null while the vault is off or the app is locked. */

let storyKey: CryptoKey | null = null;
let suspended = false;

export function getStoryKey(): CryptoKey | null {
  return storyKey;
}

export function setStoryKey(key: CryptoKey | null): void {
  storyKey = key;
}

/** While suspended, Dexie writes land exactly as given (used when restoring a sealed backup). */
export function storySealSuspended(): boolean {
  return suspended;
}

export function setStorySealSuspended(next: boolean): void {
  suspended = next;
}
