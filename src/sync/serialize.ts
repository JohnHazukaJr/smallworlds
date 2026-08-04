/**
 * Canonical device bundle: every world graph + app settings + optional vault ciphertext.
 * Used for encrypted file backup and as the shape mirrored into cloud sync.
 */

import {
  db,
  exportWorld,
  importWorld,
  type BackupExport,
  type EncryptedExport,
  type WorldExport
} from '../db';
import { decryptString, deriveKey, encryptString, randomSalt } from '../security/crypto';
import type { VaultData } from '../security/vault';
import { useVault } from '../security/vault';
import { settingsSnapshot, useSettings } from '../store/settings';
import type { AppSettings } from '../types';

export const DEVICE_FORMAT = 'small-worlds-device' as const;
export const DEVICE_VERSION = 1 as const;

export interface DeviceExport {
  format: typeof DEVICE_FORMAT;
  version: typeof DEVICE_VERSION;
  exportedAt: number;
  worlds: WorldExport[];
  settings: AppSettings;
  /** On-disk vault blob; when present, settings.providers.apiKey should be blank. */
  vault: VaultData | null;
}

export function isDeviceExport(data: unknown): data is DeviceExport {
  return !!data && typeof data === 'object' && (data as DeviceExport).format === DEVICE_FORMAT;
}

export function isBackupExport(data: unknown): data is BackupExport {
  return !!data && typeof data === 'object' && (data as BackupExport).format === 'small-worlds-backup';
}

/** True when the bundle carries provider secrets (plaintext keys or a vault). */
export function deviceHasSecrets(data: DeviceExport): boolean {
  if (data.vault) return true;
  return data.settings.providers.some((p) => !!p.apiKey?.trim());
}

export async function exportDevice(): Promise<DeviceExport> {
  // Flush vault ciphertext before snapshot so the backup is current.
  const vault = useVault.getState();
  if (vault.enabled && !vault.locked) {
    await vault.persistKeys();
  }
  const worlds = await db.worlds.toArray();
  const graphs = await Promise.all(worlds.map((w) => exportWorld(w.id)));
  const settings = settingsSnapshot();
  const vaultBlob = vault.exportVaultBlob();
  // When vault is on, never embed plaintext keys in the clear portion.
  const safeSettings: AppSettings = vaultBlob
    ? {
        ...settings,
        providers: settings.providers.map((p) => ({ ...p, apiKey: '' }))
      }
    : settings;
  return {
    format: DEVICE_FORMAT,
    version: DEVICE_VERSION,
    exportedAt: Date.now(),
    worlds: graphs,
    settings: safeSettings,
    vault: vaultBlob
  };
}

export async function importDevice(data: DeviceExport, opts?: { mergeWorlds?: boolean }): Promise<string[]> {
  if (!isDeviceExport(data)) throw new Error('Not a Small Worlds device backup.');
  if (data.version !== DEVICE_VERSION) {
    throw new Error(`Unsupported device backup version (${data.version}).`);
  }

  const ids: string[] = [];
  for (const w of data.worlds) {
    ids.push(await importWorld(w));
  }

  // Settings: restore provider shells + model picks. Keys come from vault or plaintext.
  useSettings.getState().hydrateFromBackup({
    providers: data.settings.providers.map((p) => ({ ...p })),
    proseModel: data.settings.proseModel,
    utilityModel: data.settings.utilityModel,
    matureDefault: data.settings.matureDefault,
    defaultVisibility: data.settings.defaultVisibility
  });

  if (data.vault) {
    useVault.getState().importVaultBlob(data.vault);
  } else {
    // Plaintext keys restored via hydrate — strip any leftover vault.
    if (useVault.getState().enabled && !data.vault) {
      localStorage.removeItem('small-worlds-vault');
      useVault.setState({ enabled: false, locked: false, sessionKey: null });
    }
  }

  void opts;
  return ids;
}

export async function encryptDeviceExport(data: DeviceExport, passphrase: string): Promise<EncryptedExport> {
  const salt = randomSalt();
  const key = await deriveKey(passphrase, salt);
  const { iv, ct } = await encryptString(key, JSON.stringify(data));
  return { format: 'small-worlds-encrypted', version: 1, salt, iv, ct };
}

export async function decryptDeviceExport(
  payload: EncryptedExport,
  passphrase: string
): Promise<DeviceExport | WorldExport | BackupExport> {
  const key = await deriveKey(passphrase, payload.salt);
  try {
    return JSON.parse(await decryptString(key, { iv: payload.iv, ct: payload.ct }));
  } catch {
    throw new Error('Wrong passphrase (or the file is corrupted).');
  }
}
