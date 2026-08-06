// Optional key vault: encrypts API keys at rest behind a user passphrase.
//
// When enabled:
// - localStorage holds only ciphertext (AES-256-GCM, key derived from the passphrase).
// - The settings store persists providers with blank apiKey fields (see partialize in store/settings.ts).
// - On unlock, keys are decrypted and held in memory only; locking wipes them from memory.
// - Losing the passphrase loses the keys (not the stories) — there is no recovery by design.
// - Lock always awaits a successful persistKeys write before blanking in-memory keys.

import { create } from 'zustand';
import { useSettings } from '../store/settings';
import { decryptString, deriveKey, encryptString, randomSalt, type CipherPayload } from './crypto';

export const VAULT_STORAGE_KEY = 'small-worlds-vault';
const CHECK_PLAINTEXT = 'small-worlds-vault-ok';

export interface VaultData {
  v: 1;
  salt: string;
  /** known plaintext encrypted with the vault key — verifies the passphrase */
  check: CipherPayload;
  /** Record<providerId, apiKey> as JSON, encrypted */
  keys: CipherPayload;
}

export class VaultCorruptError extends Error {
  readonly name = 'VaultCorruptError';
  constructor() {
    super('Vault data is unreadable.');
  }
}

function readVault(): VaultData | null {
  const raw = localStorage.getItem(VAULT_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VaultData;
  } catch {
    throw new VaultCorruptError();
  }
}

function probeVault(): { enabled: boolean; locked: boolean; corrupt: boolean } {
  const raw = localStorage.getItem(VAULT_STORAGE_KEY);
  if (!raw) return { enabled: false, locked: false, corrupt: false };
  try {
    JSON.parse(raw) as VaultData;
    return { enabled: true, locked: true, corrupt: false };
  } catch {
    return { enabled: true, locked: true, corrupt: true };
  }
}

function writeVault(data: VaultData): void {
  try {
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    void import('../storage/quota').then(({ markStoragePressure, isQuotaError }) => {
      if (isQuotaError(e)) markStoragePressure();
    });
    throw new Error('Could not write the key vault (storage may be full or blocked).');
  }
  // Confirm the write landed — protect against quota / private-mode failures.
  const verify = localStorage.getItem(VAULT_STORAGE_KEY);
  if (!verify) throw new Error('Could not write the key vault (storage may be full or blocked).');
}

function currentKeyMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of useSettings.getState().providers) out[p.id] = p.apiKey;
  return out;
}

/** Re-trigger the settings persist middleware so partialize runs with the new vault state. */
function repersistSettings() {
  useSettings.setState((s) => ({ providers: [...s.providers] }));
}

interface VaultStore {
  enabled: boolean;
  locked: boolean;
  /** True when localStorage holds vault bytes that do not parse as JSON. */
  corrupt: boolean;
  sessionKey: CryptoKey | null;
  enable: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<boolean>;
  /** Persist keys, then blank memory. Throws if the vault write fails — keys stay in memory. */
  lock: () => Promise<void>;
  /** Decrypts keys back into plaintext settings storage and removes the vault. Requires unlocked. */
  disable: () => Promise<void>;
  /** Re-encrypts the current in-memory keys. Called after any provider change while unlocked. */
  persistKeys: () => Promise<void>;
  changePassphrase: (oldPass: string, newPass: string) => Promise<boolean>;
  /** Forgot passphrase: deletes the encrypted keys (stories are untouched). */
  reset: () => void;
  /** Snapshot of the on-disk vault blob (for device backup). */
  exportVaultBlob: () => VaultData | null;
  /** Restore a vault blob from a device backup (leaves the app locked). */
  importVaultBlob: (data: VaultData) => void;
}

const initialVault = probeVault();

export const useVault = create<VaultStore>()((set, get) => ({
  enabled: initialVault.enabled,
  locked: initialVault.locked,
  corrupt: initialVault.corrupt,
  sessionKey: null,

  enable: async (passphrase) => {
    const salt = randomSalt();
    const key = await deriveKey(passphrase, salt);
    const data: VaultData = {
      v: 1,
      salt,
      check: await encryptString(key, CHECK_PLAINTEXT),
      keys: await encryptString(key, JSON.stringify(currentKeyMap()))
    };
    writeVault(data);
    set({ enabled: true, locked: false, corrupt: false, sessionKey: key });
    repersistSettings(); // strips plaintext keys from localStorage
  },

  unlock: async (passphrase) => {
    let data: VaultData | null;
    try {
      data = readVault();
    } catch (e) {
      if (e instanceof VaultCorruptError) {
        set({ enabled: true, locked: true, corrupt: true, sessionKey: null });
        throw e;
      }
      throw e;
    }
    if (!data) {
      set({ enabled: false, locked: false, corrupt: false, sessionKey: null });
      return true;
    }
    const key = await deriveKey(passphrase, data.salt);
    try {
      const check = await decryptString(key, data.check);
      if (check !== CHECK_PLAINTEXT) return false;
    } catch {
      return false;
    }
    const keyMap = JSON.parse(await decryptString(key, data.keys)) as Record<string, string>;
    useSettings.setState((s) => ({
      providers: s.providers.map((p) => ({ ...p, apiKey: keyMap[p.id] ?? '' }))
    }));
    set({ locked: false, sessionKey: key });
    return true;
  },

  lock: async () => {
    if (!get().enabled) return;
    // Never blank in-memory keys until the ciphertext write succeeds.
    await get().persistKeys();
    useSettings.setState((s) => ({ providers: s.providers.map((p) => ({ ...p, apiKey: '' })) }));
    set({ locked: true, sessionKey: null });
  },

  disable: async () => {
    if (get().locked && !get().corrupt) throw new Error('Unlock first');
    localStorage.removeItem(VAULT_STORAGE_KEY);
    set({ enabled: false, locked: false, corrupt: false, sessionKey: null });
    repersistSettings(); // keys persist in plaintext again
  },

  persistKeys: async () => {
    const { enabled, locked, sessionKey, corrupt } = get();
    if (!enabled || locked || !sessionKey || corrupt) return;
    const data = readVault();
    if (!data) return;
    data.keys = await encryptString(sessionKey, JSON.stringify(currentKeyMap()));
    writeVault(data);
  },

  changePassphrase: async (oldPass, newPass) => {
    const data = readVault();
    if (!data) return false;
    const oldKey = await deriveKey(oldPass, data.salt);
    let keyMapJson: string;
    try {
      const check = await decryptString(oldKey, data.check);
      if (check !== CHECK_PLAINTEXT) return false;
      keyMapJson = await decryptString(oldKey, data.keys);
    } catch {
      return false;
    }
    const salt = randomSalt();
    const newKey = await deriveKey(newPass, salt);
    const next: VaultData = {
      v: 1,
      salt,
      check: await encryptString(newKey, CHECK_PLAINTEXT),
      keys: await encryptString(newKey, keyMapJson)
    };
    writeVault(next);
    set({ sessionKey: newKey, locked: false });
    return true;
  },

  reset: () => {
    localStorage.removeItem(VAULT_STORAGE_KEY);
    useSettings.setState((s) => ({ providers: s.providers.map((p) => ({ ...p, apiKey: '' })) }));
    set({ enabled: false, locked: false, corrupt: false, sessionKey: null });
    repersistSettings();
  },

  exportVaultBlob: () => {
    try {
      return readVault();
    } catch {
      return null;
    }
  },

  importVaultBlob: (data) => {
    writeVault(data);
    useSettings.setState((s) => ({ providers: s.providers.map((p) => ({ ...p, apiKey: '' })) }));
    set({ enabled: true, locked: true, corrupt: false, sessionKey: null });
    repersistSettings();
  }
}));
