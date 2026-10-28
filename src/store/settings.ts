import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isHostedProvider, presetFor, VENICE_ADULT_EDIT_MODEL } from '../ai/providers';
import { formatUserError, logAppError } from '../errors';
import type { AppSettings, ModelRef, ProviderConfig } from '../types';

// Checked via localStorage directly to avoid a circular import with security/vault.ts.
const vaultEnabled = () => !!localStorage.getItem('small-worlds-vault');

/** After any provider change, re-encrypt keys into the vault (no-op when the vault is off). */
async function syncVault() {
  const { useVault } = await import('../security/vault');
  await useVault.getState().persistKeys();
}

async function syncVaultSafe(set: (partial: Partial<SettingsStore>) => void) {
  try {
    await syncVault();
    set({ vaultPersistError: '' });
  } catch (e) {
    logAppError(e, 'vault persist');
    set({ vaultPersistError: formatUserError(e) });
  }
}

interface SettingsStore extends AppSettings {
  /** Surfaced when encrypting keys into the vault fails after a provider change. */
  vaultPersistError: string;
  clearVaultPersistError: () => void;
  addProvider: (p: ProviderConfig) => void;
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  setProseModel: (m: ModelRef | null) => void;
  setUtilityModel: (m: ModelRef | null) => void;
  setImageModel: (m: ModelRef | null) => void;
  setMatureImageModel: (m: ModelRef | null) => void;
  setMatureDefault: (v: boolean) => void;
  setDefaultVisibility: (v: AppSettings['defaultVisibility']) => void;
  /** Replace settings from a device restore (does not touch vault ciphertext). */
  hydrateFromBackup: (s: AppSettings) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      providers: [],
      proseModel: null,
      utilityModel: null,
      imageModel: null,
      matureImageModel: null,
      matureDefault: true,
      defaultVisibility: 'private',
      vaultPersistError: '',
      clearVaultPersistError: () => set({ vaultPersistError: '' }),
      addProvider: (p) => {
        const suggested = presetFor(p)?.suggestedModels.find((m) => m.trim()) ?? '';
        const ref: ModelRef | null = suggested ? { providerId: p.id, model: suggested } : null;
        const newIsHosted = isHostedProvider(p);
        set((s) => {
          const byId = new Map(s.providers.map((x) => [x.id, x]));
          // A BYOK provider claims a slot that is empty or still pointing at
          // hosted. It never steals a slot from another BYOK pick, and hosted
          // never steals a slot from BYOK.
          const claim = (slot: ModelRef | null): ModelRef | null => {
            if (!ref || !slot) return slot ?? ref;
            const current = byId.get(slot.providerId);
            if (!newIsHosted && current && isHostedProvider(current)) return ref;
            return slot;
          };
          const adult = presetFor(p)?.id === 'venice'
            ? { providerId: p.id, model: VENICE_ADULT_EDIT_MODEL }
            : null;
          return {
            providers: [...s.providers, p],
            proseModel: claim(s.proseModel),
            utilityModel: claim(s.utilityModel),
            matureImageModel: s.matureImageModel ?? adult
          };
        });
        void syncVaultSafe(set);
      },
      updateProvider: (id, patch) => {
        set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
        void syncVaultSafe(set);
      },
      removeProvider: (id) => {
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== id),
          proseModel: s.proseModel?.providerId === id ? null : s.proseModel,
          utilityModel: s.utilityModel?.providerId === id ? null : s.utilityModel,
          imageModel: s.imageModel?.providerId === id ? null : s.imageModel,
          matureImageModel: s.matureImageModel?.providerId === id ? null : s.matureImageModel
        }));
        void syncVaultSafe(set);
      },
      setProseModel: (proseModel) => set({ proseModel }),
      setUtilityModel: (utilityModel) => set({ utilityModel }),
      setImageModel: (imageModel) => set({ imageModel }),
      setMatureImageModel: (matureImageModel) => set({ matureImageModel }),
      setMatureDefault: (matureDefault) => set({ matureDefault }),
      setDefaultVisibility: (defaultVisibility) => set({ defaultVisibility }),
      hydrateFromBackup: (s) => set({
        providers: s.providers,
        proseModel: s.proseModel,
        utilityModel: s.utilityModel,
        imageModel: s.imageModel ?? null,
        matureImageModel: s.matureImageModel ?? null,
        matureDefault: s.matureDefault,
        defaultVisibility: s.defaultVisibility
      })
    }),
    {
      name: 'small-worlds-settings',
      // When the vault is enabled, API keys never touch disk in plaintext —
      // only the encrypted copy in the vault does.
      partialize: (s) => ({
        providers: vaultEnabled() ? s.providers.map((p) => ({ ...p, apiKey: '' })) : s.providers,
        proseModel: s.proseModel,
        utilityModel: s.utilityModel,
        imageModel: s.imageModel,
        matureImageModel: s.matureImageModel ?? null,
        matureDefault: s.matureDefault,
        defaultVisibility: s.defaultVisibility
        // vaultPersistError is session-only — not persisted
      })
    }
  )
);

/** Resolve a ModelRef to its provider config, or null if unset/missing. */
export function resolveModel(ref: ModelRef | null): { provider: ProviderConfig; model: string } | null {
  if (!ref) return null;
  const provider = useSettings.getState().providers.find((p) => p.id === ref.providerId);
  if (!provider) return null;
  return { provider, model: ref.model };
}

/** Snapshot of settings suitable for device backup (keys included when unlocked / no vault). */
export function settingsSnapshot(): AppSettings {
  const s = useSettings.getState();
  return {
    providers: s.providers.map((p) => ({ ...p })),
    proseModel: s.proseModel,
    utilityModel: s.utilityModel,
    imageModel: s.imageModel ?? null,
    matureImageModel: s.matureImageModel ?? null,
    matureDefault: s.matureDefault,
    defaultVisibility: s.defaultVisibility
  };
}
