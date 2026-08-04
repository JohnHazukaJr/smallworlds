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

/** Write = full chrome + composer; Read = distraction-free. Director is always an overlay. */
export type StoryLayout = 'write' | 'read';

/** Map legacy persisted layout ids onto write|read. */
export function normalizeStoryLayout(raw: unknown): StoryLayout {
  if (raw === 'read') return 'read';
  return 'write'; // immersive, director, write, or anything else
}

/** Map a location plate hue to the closest story mood. */
export function moodFromHue(hue: number): MoodId {
  const h = ((hue % 360) + 360) % 360;
  if (h < 45 || h >= 330) return 'ember';
  if (h < 100) return 'rot';
  if (h < 200) return 'frost';
  return 'ash';
}

interface AppStore {
  screen: Screen;
  currentWorldId: string | null;
  layout: StoryLayout;
  mood: MoodId;
  backdrop: BackdropId;
  display: DisplayPrefs;
  go: (screen: Screen) => void;
  openWorld: (worldId: string) => void;
  setLayout: (l: StoryLayout) => void;
  setMood: (m: MoodId) => void;
  setBackdrop: (b: BackdropId) => void;
  setDisplay: (p: Partial<DisplayPrefs>) => void;
}

export const useApp = create<AppStore>()(
  persist(
    (set) => ({
      screen: 'library',
      currentWorldId: null,
      layout: 'write',
      mood: 'ember',
      backdrop: 'scene',
      display: DEFAULT_DISPLAY,
      go: (screen) => set({ screen }),
      openWorld: (currentWorldId) => set({ currentWorldId, screen: 'story' }),
      setLayout: (layout) => set({ layout: normalizeStoryLayout(layout) }),
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
        return {
          ...current,
          ...p,
          layout: normalizeStoryLayout(p.layout),
          display: { ...DEFAULT_DISPLAY, ...(p.display ?? {}) }
        };
      }
    }
  )
);
