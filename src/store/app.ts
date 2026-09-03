import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeScrollBackdrop, type ScrollBackdrop } from '../ui/scrollBackdrop';

export type Screen = 'library' | 'story' | 'cast' | 'locations' | 'sequel' | 'profile' | 'settings' | 'onboard';
export type MoodId = 'ember' | 'ash' | 'frost' | 'rot' | 'dusk' | 'bloom' | 'storm' | 'brine';
export type BackdropId = 'scene' | 'moment' | 'character' | 'none';
export type AvatarSize = 'S' | 'M' | 'L';
/** How spoken turns sit on the page: running prose, or a staged cast list. */
export type DialogueStyle = 'prose' | 'staged';
export type { ScrollBackdrop };

/** How the story page renders on this device. */
export interface DisplayPrefs {
  /** prose = novel page with inline attribution; staged = avatar + name plate per line */
  dialogueStyle: DialogueStyle;
  /** portrait plate height in the story scroll */
  avatarSize: AvatarSize;
  /** prose font size in px */
  textSize: number;
  /** 0–80 — darkness of the air behind the story text */
  textScrim: number;
  /** 0–90 — dim wash laid over the scroll background photo */
  imageDim: number;
  /** 0–20 px blur on a scene image */
  imageBlur: number;
  /**
   * What sits behind the scroll, under the dim wash.
   * Auto: scene photo you or the AI set, else place photo, else climate.
   */
  scrollBackdrop: ScrollBackdrop;
  /** When true, generating a scene photo switches the scroll to Auto so it shows. */
  aiSetsScrollBg: boolean;
}

export const DEFAULT_DISPLAY: DisplayPrefs = {
  dialogueStyle: 'prose',
  avatarSize: 'M',
  textSize: 20,
  // Enough air for type to read, light enough that the place still shows through glass.
  textScrim: 22,
  imageDim: 22,
  imageBlur: 0,
  scrollBackdrop: 'auto',
  aiSetsScrollBg: true
};

export const AVATAR_PX: Record<AvatarSize, number> = { S: 56, M: 80, L: 104 };
/** Compact story scroll — keep a line of prose beside the plate. */
export const COMPACT_AVATAR_MAX = 72;

export function storyAvatarHeight(size: AvatarSize, compact: boolean): number {
  const raw = AVATAR_PX[size];
  return compact ? Math.min(raw, COMPACT_AVATAR_MAX) : raw;
}

/** Write = full chrome + composer; Read = distraction-free. Director is always an overlay. */
export type StoryLayout = 'write' | 'read';

/** Map legacy persisted layout ids onto write|read. Missing → Read (the scene is the default). */
export function normalizeStoryLayout(raw: unknown): StoryLayout {
  if (raw === 'write') return 'write';
  return 'read';
}

/** Map a location plate hue to the closest story mood (8 climates). */
export function moodFromHue(hue: number): MoodId {
  const h = ((hue % 360) + 360) % 360;
  if (h < 30 || h >= 345) return 'ember';
  if (h < 70) return 'bloom';
  if (h < 115) return 'rot';
  if (h < 160) return 'brine';
  if (h < 200) return 'frost';
  if (h < 245) return 'storm';
  if (h < 295) return 'ash';
  return 'dusk';
}

interface AppStore {
  screen: Screen;
  currentWorldId: string | null;
  layout: StoryLayout;
  mood: MoodId;
  backdrop: BackdropId;
  display: DisplayPrefs;
  /** One-shot: Cast selects this id when the screen opens (not persisted). */
  pendingCharacterId: string | null;
  /** One-shot: Locations selects this id when the screen opens (not persisted). */
  pendingLocationId: string | null;
  go: (screen: Screen) => void;
  /** Open Cast, optionally focusing a character sheet. */
  goCast: (characterId?: string | null) => void;
  /** Open Locations, optionally focusing a place sheet. */
  goLocations: (locationId?: string | null) => void;
  clearPendingCharacter: () => void;
  clearPendingLocation: () => void;
  openWorld: (worldId: string) => void;
  /** Drop the open-world pointer (deleted, discarded, or missing on disk). */
  closeWorld: () => void;
  /** Clear only if this id is the one currently open. */
  closeWorldIf: (worldId: string) => void;
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
      layout: 'read',
      mood: 'ember',
      backdrop: 'scene',
      display: DEFAULT_DISPLAY,
      pendingCharacterId: null,
      pendingLocationId: null,
      go: (screen) => set({ screen }),
      goCast: (characterId) => set({
        screen: 'cast',
        pendingCharacterId: characterId ?? null
      }),
      goLocations: (locationId) => set({
        screen: 'locations',
        pendingLocationId: locationId ?? null
      }),
      clearPendingCharacter: () => set({ pendingCharacterId: null }),
      clearPendingLocation: () => set({ pendingLocationId: null }),
      openWorld: (currentWorldId) => set({ currentWorldId, screen: 'story' }),
      closeWorld: () => set({ currentWorldId: null }),
      closeWorldIf: (worldId) => set((s) => (
        s.currentWorldId === worldId ? { currentWorldId: null } : s
      )),
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
          display: {
            ...DEFAULT_DISPLAY,
            ...(p.display ?? {}),
            scrollBackdrop: normalizeScrollBackdrop(
              (p.display as Partial<DisplayPrefs> | undefined)?.scrollBackdrop
            )
          },
          // Never restore one-shot focus from disk.
          pendingCharacterId: null,
          pendingLocationId: null
        };
      }
    }
  )
);
