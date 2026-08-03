import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings, ModelRef, ProviderConfig } from '../types';

// Checked via localStorage directly to avoid a circular import with security/vault.ts.
const vaultEnabled = () => !!localStorage.getItem('small-worlds-vault');

/** After any provider change, re-encrypt keys into the vault (no-op when the vault is off). */
function syncVault() {
  void import('../security/vault').then(({ useVault }) => useVault.getState().persistKeys());
}

interface SettingsStore extends AppSettings {
  addProvider: (p: ProviderConfig) => void;
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  setProseModel: (m: ModelRef | null) => void;
  setUtilityModel: (m: ModelRef | null) => void;
  setMatureDefault: (v: boolean) => void;
  setDefaultVisibility: (v: AppSettings['defaultVisibility']) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      providers: [],
      proseModel: null,
      utilityModel: null,
      matureDefault: true,
      defaultVisibility: 'private',
      addProvider: (p) => {
        set((s) => ({ providers: [...s.providers, p] }));
        syncVault();
      },
      updateProvider: (id, patch) => {
        set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
        syncVault();
      },
      removeProvider: (id) => {
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== id),
          proseModel: s.proseModel?.providerId === id ? null : s.proseModel,
          utilityModel: s.utilityModel?.providerId === id ? null : s.utilityModel
        }));
        syncVault();
      },
      setProseModel: (proseModel) => set({ proseModel }),
      setUtilityModel: (utilityModel) => set({ utilityModel }),
      setMatureDefault: (matureDefault) => set({ matureDefault }),
      setDefaultVisibility: (defaultVisibility) => set({ defaultVisibility })
    }),
    {
      name: 'small-worlds-settings',
      // When the vault is enabled, API keys never touch disk in plaintext —
      // only the encrypted copy in the vault does.
      partialize: (s) => ({
        providers: vaultEnabled() ? s.providers.map((p) => ({ ...p, apiKey: '' })) : s.providers,
        proseModel: s.proseModel,
        utilityModel: s.utilityModel,
        matureDefault: s.matureDefault,
        defaultVisibility: s.defaultVisibility
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
