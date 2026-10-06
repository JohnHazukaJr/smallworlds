import { create } from 'zustand';

export type LegalDoc = 'privacy' | 'terms';

interface LegalNav {
  doc: LegalDoc | null;
  open: (doc: LegalDoc) => void;
  close: () => void;
}

export const useLegal = create<LegalNav>()((set) => ({
  doc: null,
  open: (doc) => set({ doc }),
  close: () => set({ doc: null })
}));
