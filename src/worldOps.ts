import { db, uid } from './db';
import { useSettings } from './store/settings';
import type { Character, Episode, Location, Season, World, WorldAISettings, WorldCalendar } from './types';

/** Default Earth-style week when the world hasn't defined its own. */
export const DEFAULT_WEEKDAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
];

export interface ResolvedCalendar {
  currentDay: number;
  system: string;
  weekdays: string[];
  dayOneWeekday: number;
  episodeAdvanceDays: number;
}

/** Worlds created before the calendar field existed won't have it — always read through this. */
export function worldCalendar(world: World | null | undefined): ResolvedCalendar {
  const c = world?.calendar;
  const customDays = c?.weekdays?.map((w) => w.trim()).filter(Boolean) ?? [];
  const weekdays = customDays.length > 0 ? customDays : DEFAULT_WEEKDAYS;
  const dayOne = typeof c?.dayOneWeekday === 'number' ? c.dayOneWeekday : 0;
  const advance = typeof c?.episodeAdvanceDays === 'number' ? c.episodeAdvanceDays : 1;
  return {
    currentDay: Math.max(1, c?.currentDay || 1),
    system: c?.system ?? '',
    weekdays,
    dayOneWeekday: ((dayOne % weekdays.length) + weekdays.length) % weekdays.length,
    episodeAdvanceDays: Math.max(0, Math.min(365, advance))
  };
}

/** Weekday name for an absolute story day. */
export function weekdayForDay(cal: ResolvedCalendar, day: number): string {
  const d = Math.max(1, day);
  const idx = (cal.dayOneWeekday + (d - 1)) % cal.weekdays.length;
  return cal.weekdays[idx] ?? cal.weekdays[0];
}

/** Human label: "Thursday, day 12". */
export function formatStoryDate(cal: ResolvedCalendar, day: number): string {
  return `${weekdayForDay(cal, day)}, day ${Math.max(1, day)}`;
}

/** Range label for an episode: single day or "Mon day 3 → Wed day 5". */
export function formatEpisodeDateRange(
  cal: ResolvedCalendar,
  startDay: number | null | undefined,
  endDay?: number | null
): string {
  const start = startDay && startDay > 0 ? startDay : cal.currentDay;
  const end = endDay && endDay > 0 ? endDay : null;
  if (!end || end === start) return formatStoryDate(cal, start);
  return `${formatStoryDate(cal, start)} → ${formatStoryDate(cal, end)}`;
}

/** Persistable calendar patch merged onto resolved defaults. */
export function calendarPatch(
  world: World,
  patch: Partial<WorldCalendar>
): WorldCalendar {
  const base = worldCalendar(world);
  return {
    currentDay: patch.currentDay ?? base.currentDay,
    system: patch.system ?? base.system,
    weekdays: patch.weekdays ?? base.weekdays,
    dayOneWeekday: patch.dayOneWeekday ?? base.dayOneWeekday,
    episodeAdvanceDays: patch.episodeAdvanceDays ?? base.episodeAdvanceDays
  };
}

export const DEFAULT_AI: WorldAISettings = {
  pov: 'second',
  tense: 'present',
  proseDensity: 45,
  pacing: 50,
  contentNotes: '',
  narratorRules: [],
  customInstructions: '',
  mature: true
};

export interface NewWorldInput {
  title: string;
  line: string;
  bible: string;
  premise: string;
  hue?: number;
  /** overrides for the world's narrator settings; merges onto defaults */
  ai?: Partial<WorldAISettings>;
}

/** Create a world with season 1 / episode 1 and a player character, ready to write. */
export async function createWorld(input: NewWorldInput): Promise<World> {
  const s = useSettings.getState();
  const now = Date.now();
  const worldId = uid();
  const seasonId = uid();

  const world: World = {
    id: worldId,
    title: input.title || 'Untitled world',
    line: input.line,
    bible: input.bible,
    hue: input.hue ?? Math.floor(Math.random() * 360),
    visibility: s.defaultVisibility,
    ai: { ...DEFAULT_AI, mature: s.matureDefault, ...input.ai },
    proseModel: null,
    utilityModel: null,
    activeSeasonId: seasonId,
    calendar: {
      currentDay: 1,
      system: '',
      weekdays: [...DEFAULT_WEEKDAYS],
      dayOneWeekday: 0,
      episodeAdvanceDays: 1
    },
    createdAt: now,
    updatedAt: now
  };

  const season: Season = {
    id: seasonId, worldId, number: 1, title: '',
    premise: input.premise, timeGap: null, bible: null, status: 'active', createdAt: now
  };

  const player: Character = emptyCharacter(worldId, {
    name: 'you', role: 'protagonist · second person', hue: 60, isPlayer: true
  });

  const episode: Episode = {
    id: uid(), seasonId, worldId, number: 1, title: '', location: '', locationId: null,
    castIds: [player.id], storyDay: 1, storyDayEnd: null, dateNote: null,
    status: 'active', createdAt: now
  };

  await db.transaction('rw', [db.worlds, db.seasons, db.episodes, db.characters], async () => {
    await db.worlds.add(world);
    await db.seasons.add(season);
    await db.episodes.add(episode);
    await db.characters.add(player);
  });

  return world;
}

export const MAX_CHARACTER_PORTRAITS = 6;

/** Resolve the photo gallery, migrating a lone legacy `portrait` into the list. */
export function characterPortraits(c: Pick<Character, 'portrait' | 'portraits'>): string[] {
  if (c.portraits && c.portraits.length > 0) return c.portraits.filter(Boolean);
  return c.portrait ? [c.portrait] : [];
}

/** Patch that keeps `portrait` (primary) aligned with `portraits[0]`. */
export function portraitsPatch(urls: string[]): Pick<Character, 'portraits' | 'portrait'> {
  const portraits = urls.filter(Boolean).slice(0, MAX_CHARACTER_PORTRAITS);
  return { portraits, portrait: portraits[0] ?? null };
}

export function emptyCharacter(worldId: string, patch: Partial<Character> = {}): Character {
  const now = Date.now();
  const base: Character = {
    id: uid(), worldId,
    name: '', role: '', hue: Math.floor(Math.random() * 360), isPlayer: false, selfTag: false,
    portrait: null, portraits: [],
    age: '', appearance: '', mannerisms: '', backstory: '', summary: '',
    speechStyle: '', exampleLines: [],
    traits: '', desires: '', fears: '', flaws: '',
    secrets: '', mustNotKnow: '',
    relationships: [], anchors: [], customInstructions: '',
    state: { goal: '', emotion: '', location: '', condition: '' },
    createdAt: now, updatedAt: now,
    ...patch
  };
  // Normalize primary ↔ gallery if the patch only set one of them.
  const gallery = characterPortraits(base);
  return { ...base, ...portraitsPatch(gallery) };
}

export function emptyLocation(worldId: string, patch: Partial<Location> = {}): Location {
  const now = Date.now();
  return {
    id: uid(), worldId,
    name: '', tagline: '', hue: Math.floor(Math.random() * 360),
    summary: '', atmosphere: '', features: '', history: '', inhabitants: '',
    rules: [], secrets: '', currentState: '', customInstructions: '',
    createdAt: now, updatedAt: now,
    ...patch
  };
}

export interface NextEpisodeOpts {
  /** Story day the ending episode closed on; defaults to world.currentDay */
  storyDayEnd?: number;
  /**
   * Story day the next episode opens on.
   * When omitted, uses storyDayEnd + episodeAdvanceDays.
   */
  nextStoryDay?: number;
  /** Free-text date note from wrap analysis */
  dateNote?: string | null;
}

/** End the current episode and open the next one, carrying the scene cast forward. */
export async function nextEpisode(current: Episode, opts: NextEpisodeOpts = {}): Promise<Episode> {
  const world = await db.worlds.get(current.worldId);
  const cal = worldCalendar(world);
  const dayEnd = Math.max(
    current.storyDay ?? 1,
    opts.storyDayEnd ?? cal.currentDay
  );
  const nextDay = Math.max(
    dayEnd,
    opts.nextStoryDay != null && Number.isFinite(opts.nextStoryDay)
      ? Math.floor(opts.nextStoryDay)
      : dayEnd + cal.episodeAdvanceDays
  );
  const next: Episode = {
    id: uid(), seasonId: current.seasonId, worldId: current.worldId,
    number: current.number + 1, title: '', location: current.location,
    locationId: current.locationId ?? null,
    castIds: current.castIds,
    guests: [],
    activeGuestIds: [],
    wrap: null,
    runningSummary: null,
    runningSummaryAtChars: 0,
    storyDay: nextDay,
    storyDayEnd: null,
    dateNote: null,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await db.transaction('rw', [db.episodes, db.worlds], async () => {
    await db.episodes.update(current.id, {
      status: 'ended',
      storyDay: current.storyDay ?? dayEnd,
      storyDayEnd: dayEnd,
      ...(opts.dateNote != null ? { dateNote: opts.dateNote } : {}),
      updatedAt: Date.now()
    });
    await db.episodes.add(next);
    if (world) {
      await db.worlds.update(world.id, {
        calendar: {
          ...world.calendar,
          currentDay: nextDay,
          system: cal.system,
          weekdays: cal.weekdays,
          dayOneWeekday: cal.dayOneWeekday,
          episodeAdvanceDays: cal.episodeAdvanceDays
        },
        updatedAt: Date.now()
      });
    }
  });
  return next;
}
