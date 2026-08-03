import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings, ModelRef, ProviderConfig } from '../types';

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
      addProvider: (p) => set((s) => ({ providers: [...s.providers, p] })),
      updateProvider: (id, patch) =>
        set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removeProvider: (id) =>
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== id),
          proseModel: s.proseModel?.providerId === id ? null : s.proseModel,
          utilityModel: s.utilityModel?.providerId === id ? null : s.utilityModel
        })),
      setProseModel: (proseModel) => set({ proseModel }),
      setUtilityModel: (utilityModel) => set({ utilityModel }),
      setMatureDefault: (matureDefault) => set({ matureDefault }),
      setDefaultVisibility: (defaultVisibility) => set({ defaultVisibility })
    }),
    { name: 'small-worlds-settings' }
  )
);

/** Resolve a ModelRef to its provider config, or null if unset/missing. */
export function resolveModel(ref: ModelRef | null): { provider: ProviderConfig; model: string } | null {
  if (!ref) return null;
  const provider = useSettings.getState().providers.find((p) => p.id === ref.providerId);
  if (!provider) return null;
  return { provider, model: ref.model };
}
