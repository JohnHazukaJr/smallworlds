import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Screen = 'library' | 'story' | 'cast' | 'locations' | 'sequel' | 'profile' | 'settings' | 'onboard';
export type MoodId = 'ember' | 'ash' | 'frost' | 'rot';
export type BackdropId = 'scene' | 'moment' | 'character' | 'none';
export type AvatarSize = 'S' | 'M' | 'L';

/** How the story page renders on this device. */
export interface DisplayPrefs {
  avatarSize: AvatarSize;
  /** prose font size in px */
  textSize: number;
  /** 0–80 — darkness of the plate behind the story text */
  textScrim: number;
  /** 0–90 — darkness laid over a scene image */
  imageDim: number;
  /** 0–20 px blur on a scene image */
  imageBlur: number;
}

export const DEFAULT_DISPLAY: DisplayPrefs = {
  avatarSize: 'S',
  textSize: 19,
  textScrim: 0,
  imageDim: 45,
  imageBlur: 0
};

export const AVATAR_PX: Record<AvatarSize, number> = { S: 34, M: 50, L: 68 };

interface AppStore {
  screen: Screen;
  currentWorldId: string | null;
  layout: 'immersive' | 'director';
  mood: MoodId;
  backdrop: BackdropId;
  display: DisplayPrefs;
  go: (screen: Screen) => void;
  openWorld: (worldId: string) => void;
  setLayout: (l: 'immersive' | 'director') => void;
  setMood: (m: MoodId) => void;
  setBackdrop: (b: BackdropId) => void;
  setDisplay: (p: Partial<DisplayPrefs>) => void;
}

export const useApp = create<AppStore>()(
  persist(
    (set) => ({
      screen: 'library',
      currentWorldId: null,
      layout: 'immersive',
      mood: 'ember',
      backdrop: 'scene',
      display: DEFAULT_DISPLAY,
      go: (screen) => set({ screen }),
      openWorld: (currentWorldId) => set({ currentWorldId, screen: 'story' }),
      setLayout: (layout) => set({ layout }),
      setMood: (mood) => set({ mood }),
      setBackdrop: (backdrop) => set({ backdrop }),
      setDisplay: (p) => set((s) => ({ display: { ...s.display, ...p } }))
    }),
    {
      name: 'small-worlds-app',
      partialize: (s) => ({
        currentWorldId: s.currentWorldId, layout: s.layout, mood: s.mood, backdrop: s.backdrop, display: s.display
      }) as Partial<AppStore>,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppStore>;
        return { ...current, ...p, display: { ...DEFAULT_DISPLAY, ...(p.display ?? {}) } };
      }
    }
  )
);
