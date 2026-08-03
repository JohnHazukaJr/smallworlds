import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Screen = 'library' | 'story' | 'cast' | 'sequel' | 'profile' | 'settings' | 'onboard';
export type MoodId = 'ember' | 'ash' | 'frost' | 'rot';
export type BackdropId = 'scene' | 'moment' | 'character' | 'none';

interface AppStore {
  screen: Screen;
  currentWorldId: string | null;
  layout: 'immersive' | 'director';
  mood: MoodId;
  backdrop: BackdropId;
  go: (screen: Screen) => void;
  openWorld: (worldId: string) => void;
  setLayout: (l: 'immersive' | 'director') => void;
  setMood: (m: MoodId) => void;
  setBackdrop: (b: BackdropId) => void;
}

export const useApp = create<AppStore>()(
  persist(
    (set) => ({
      screen: 'library',
      currentWorldId: null,
      layout: 'immersive',
      mood: 'ember',
      backdrop: 'scene',
      go: (screen) => set({ screen }),
      openWorld: (currentWorldId) => set({ currentWorldId, screen: 'story' }),
      setLayout: (layout) => set({ layout }),
      setMood: (mood) => set({ mood }),
      setBackdrop: (backdrop) => set({ backdrop })
    }),
    {
      name: 'small-worlds-app',
      partialize: (s) => ({
        currentWorldId: s.currentWorldId, layout: s.layout, mood: s.mood, backdrop: s.backdrop
      }) as Partial<AppStore>
    }
  )
);
