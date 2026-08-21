import { db, uid } from './db';
import { evaluateCalendarEvents } from './calendarEvents';
import { useSettings } from './store/settings';
import type {
  Character, Episode, Location, PlotTarget, Season, World, WorldAISettings, WorldCalendar
} from './types';

/** Max pending plot targets stored on an episode or season. */
export const PLOT_TARGET_CAP = 8;

export function pendingPlotTargets(list?: PlotTarget[] | null): PlotTarget[] {
  return (list ?? []).filter((t) => t.status === 'pending' && t.text.trim());
}

/** Prefer newly aimed texts, then carried pending; dedupe by normalized text. */
export function buildEpisodePlotTargets(opts: {
  aimedTexts: string[];
  carried?: PlotTarget[] | null;
  cap?: number;
}): PlotTarget[] {
  const cap = opts.cap ?? PLOT_TARGET_CAP;
  const aimed: PlotTarget[] = opts.aimedTexts
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      id: uid(),
      text,
      status: 'pending' as const,
      source: 'wrap-beat' as const
    }));
  const carried: PlotTarget[] = pendingPlotTargets(opts.carried).map((t) => ({
    id: uid(),
    text: t.text.trim(),
    status: 'pending' as const,
    source: 'carried' as const
  }));
  const seen = new Set<string>();
  const out: PlotTarget[] = [];
  for (const t of [...aimed, ...carried]) {
    const key = t.text.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export function buildSeasonPlotTargets(raiseBeats: Array<{ text: string; consequence?: string }>): PlotTarget[] {
  const seen = new Set<string>();
  const out: PlotTarget[] = [];
  for (const b of raiseBeats) {
    const text = `${b.text.trim()}${b.consequence?.trim() ? ` → ${b.consequence.trim()}` : ''}`.trim();
    const key = text.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: uid(),
      text,
      status: 'pending',
      source: 'season-raise'
    });
    if (out.length >= PLOT_TARGET_CAP) break;
  }
  return out;
}

/**
 * Merge Raise beats + kept plot-arc proposals + carried pending season targets.
 * Dedupes by normalized text (strips trailing " → consequence"); Raise first, then arc, then carried.
 */
export function buildNextSeasonPlotTargets(opts: {
  raiseBeats: Array<{ text: string; consequence?: string }>;
  plotArc?: Array<{ text: string; keep?: boolean }> | null;
  carried?: PlotTarget[] | null;
  cap?: number;
}): PlotTarget[] {
  const cap = opts.cap ?? PLOT_TARGET_CAP;
  const normalizeKey = (text: string) =>
    text.trim().toLowerCase().replace(/\s*→\s*.*$/, '').trim();
  const raised = buildSeasonPlotTargets(opts.raiseBeats);
  const arc: PlotTarget[] = (opts.plotArc ?? [])
    .filter((p) => p.keep !== false)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .map((text) => ({
      id: uid(),
      text,
      status: 'pending' as const,
      source: 'season-raise' as const
    }));
  const carried: PlotTarget[] = pendingPlotTargets(opts.carried).map((t) => ({
    id: uid(),
    text: t.text.trim(),
    status: 'pending' as const,
    source: 'carried' as const
  }));
  const seen = new Set<string>();
  const out: PlotTarget[] = [];
  for (const t of [...raised, ...arc, ...carried]) {
    const key = normalizeKey(t.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Default Earth-style week when the world hasn't defined its own. */
export const DEFAULT_WEEKDAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
];

export const DEFAULT_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/** Non-leap Earth month lengths. */
export const DEFAULT_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface ResolvedCalendar {
  currentDay: number;
  system: string;
  weekdays: string[];
  dayOneWeekday: number;
  episodeAdvanceDays: number;
  months: string[];
  monthLengths: number[];
  yearOne: number;
  dayOneMonth: number;
  dayOneDate: number;
}

export interface StoryDateParts {
  year: number;
  /** 0-based month index */
  monthIndex: number;
  monthName: string;
  dayOfMonth: number;
  weekday: string;
  /** Absolute story day */
  day: number;
}

/** Worlds created before the calendar field existed won't have it — always read through this. */
export function worldCalendar(world: World | null | undefined): ResolvedCalendar {
  const c = world?.calendar;
  const customDays = c?.weekdays?.map((w) => w.trim()).filter(Boolean) ?? [];
  const weekdays = customDays.length > 0 ? customDays : DEFAULT_WEEKDAYS;
  const customMonths = c?.months?.map((m) => m.trim()).filter(Boolean) ?? [];
  const months = customMonths.length > 0 ? customMonths : DEFAULT_MONTHS;
  const rawLengths = c?.monthLengths ?? [];
  const monthLengths = months.map((_, i) => {
    const n = rawLengths[i];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.min(90, Math.floor(n));
    return DEFAULT_MONTH_LENGTHS[i % DEFAULT_MONTH_LENGTHS.length] ?? 30;
  });
  const dayOne = typeof c?.dayOneWeekday === 'number' ? c.dayOneWeekday : 0;
  const advance = typeof c?.episodeAdvanceDays === 'number' ? c.episodeAdvanceDays : 1;
  const yearOne = typeof c?.yearOne === 'number' && Number.isFinite(c.yearOne) ? Math.floor(c.yearOne) : 1;
  const dayOneMonth = typeof c?.dayOneMonth === 'number' ? c.dayOneMonth : 0;
  const dayOneDate = typeof c?.dayOneDate === 'number' ? c.dayOneDate : 1;
  return {
    currentDay: Math.max(1, c?.currentDay || 1),
    system: c?.system ?? '',
    weekdays,
    dayOneWeekday: ((dayOne % weekdays.length) + weekdays.length) % weekdays.length,
    episodeAdvanceDays: Math.max(0, Math.min(365, advance)),
    months,
    monthLengths,
    yearOne,
    dayOneMonth: ((dayOneMonth % months.length) + months.length) % months.length,
    dayOneDate: Math.max(
      1,
      Math.min(
        monthLengths[((dayOneMonth % months.length) + months.length) % months.length] ?? 30,
        Math.floor(dayOneDate)
      )
    )
  };
}

/** Weekday name for an absolute story day. */
export function weekdayForDay(cal: ResolvedCalendar, day: number): string {
  const d = Math.max(1, day);
  const idx = (cal.dayOneWeekday + (d - 1)) % cal.weekdays.length;
  return cal.weekdays[idx] ?? cal.weekdays[0];
}

function monthLen(cal: ResolvedCalendar, monthIndex: number): number {
  const i = ((monthIndex % cal.months.length) + cal.months.length) % cal.months.length;
  return cal.monthLengths[i] ?? 30;
}

/** Convert absolute story day → year / month / day-of-month. */
export function partsForDay(cal: ResolvedCalendar, day: number): StoryDateParts {
  const abs = Math.max(1, Math.floor(day));
  let remaining = abs - 1;
  let year = cal.yearOne;
  let month = cal.dayOneMonth;
  let dom = Math.min(cal.dayOneDate, monthLen(cal, month));

  while (remaining > 0) {
    const len = monthLen(cal, month);
    const leftInMonth = len - dom + 1;
    if (remaining < leftInMonth) {
      dom += remaining;
      remaining = 0;
    } else {
      remaining -= leftInMonth;
      dom = 1;
      month += 1;
      if (month >= cal.months.length) {
        month = 0;
        year += 1;
      }
    }
  }

  return {
    year,
    monthIndex: month,
    monthName: cal.months[month] ?? `Month ${month + 1}`,
    dayOfMonth: dom,
    weekday: weekdayForDay(cal, abs),
    day: abs
  };
}

/** Days in a full calendar year (sum of month lengths). */
function yearLength(cal: ResolvedCalendar): number {
  return cal.monthLengths.reduce((a, b) => a + b, 0);
}

/** 1-based ordinal day within a year (Jan 1 → 1). */
function ordinalInYear(cal: ResolvedCalendar, monthIndex: number, dayOfMonth: number): number {
  const m = ((monthIndex % cal.months.length) + cal.months.length) % cal.months.length;
  const d = Math.max(1, Math.min(monthLen(cal, m), Math.floor(dayOfMonth)));
  let o = d;
  for (let i = 0; i < m; i++) o += monthLen(cal, i);
  return o;
}

/** Convert year / month / day-of-month → absolute story day (clamped). */
export function dayFromParts(
  cal: ResolvedCalendar,
  year: number,
  monthIndex: number,
  dayOfMonth: number
): number {
  const mCount = cal.months.length;
  const y = Math.floor(year);
  const m = ((Math.floor(monthIndex) % mCount) + mCount) % mCount;
  const d = Math.max(1, Math.min(monthLen(cal, m), Math.floor(dayOfMonth)));
  const yLen = yearLength(cal);
  if (yLen < 1) return 1;

  const anchorOrd = ordinalInYear(cal, cal.dayOneMonth, cal.dayOneDate);
  const targetOrd = ordinalInYear(cal, m, d);
  const abs = 1 + (y - cal.yearOne) * yLen + (targetOrd - anchorOrd);
  return Math.max(1, Math.floor(abs));
}

/** Advance absolute day by N calendar months (clamps day-of-month). */
export function advanceMonths(cal: ResolvedCalendar, day: number, months: number): number {
  const p = partsForDay(cal, day);
  let y = p.year;
  let m = p.monthIndex + Math.floor(months);
  while (m >= cal.months.length) {
    m -= cal.months.length;
    y += 1;
  }
  while (m < 0) {
    m += cal.months.length;
    y -= 1;
  }
  return dayFromParts(cal, y, m, p.dayOfMonth);
}

/** Human label: "Thursday, 12 March, Year 3 · day 72". */
export function formatStoryDate(cal: ResolvedCalendar, day: number): string {
  const p = partsForDay(cal, day);
  return `${p.weekday}, ${p.dayOfMonth} ${p.monthName}, Year ${p.year} · day ${p.day}`;
}

/** Compact label without absolute day (UI headers). */
export function formatStoryDateShort(cal: ResolvedCalendar, day: number): string {
  const p = partsForDay(cal, day);
  return `${p.weekday}, ${p.dayOfMonth} ${p.monthName} Y${p.year}`;
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
  return `${formatStoryDateShort(cal, start)} → ${formatStoryDateShort(cal, end)}`;
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
    episodeAdvanceDays: patch.episodeAdvanceDays ?? base.episodeAdvanceDays,
    months: patch.months ?? base.months,
    monthLengths: patch.monthLengths ?? base.monthLengths,
    yearOne: patch.yearOne ?? base.yearOne,
    dayOneMonth: patch.dayOneMonth ?? base.dayOneMonth,
    dayOneDate: patch.dayOneDate ?? base.dayOneDate
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
      episodeAdvanceDays: 1,
      months: [...DEFAULT_MONTHS],
      monthLengths: [...DEFAULT_MONTH_LENGTHS],
      yearOne: 1,
      dayOneMonth: 0,
      dayOneDate: 1
    },
    calendarEventPrefs: {
      enabled: true,
      aiSeedOnSeasonStart: false,
      defaultVisibility: 'title'
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

export interface WorldWriteReadyResult {
  ok: boolean;
  missing: string[];
  /** Soft warnings — do not block Enter. */
  warnings: string[];
}

const BIBLE_MIN_CHARS = 120;

/** Generic filler rule formerly auto-injected — soft-warn if still present. */
export const GENERIC_LOCATION_RULE =
  'Respect the place’s hard rules as written on this sheet.';

export function isGenericLocationRule(rule: string): boolean {
  const t = rule.trim().toLowerCase();
  return t === GENERIC_LOCATION_RULE.toLowerCase()
    || t.startsWith('respect the place');
}

/** Empty or stock speechStyle that will not distinguish an NPC. */
export function isVagueSpeechStyle(style: string): boolean {
  const t = style.trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return true;
  return /^(normal|casual|speaks?\s+normally|ordinary|average|typical|friendly|polite|regular|default)$/.test(t);
}

/**
 * Checklist for an onboard / day-0 world before Story.
 * Pure evaluation of loaded rows — no AI.
 * Hard blockers stay in `missing`; quality nudges stay in `warnings`.
 */
export function evaluateWorldWriteReady(opts: {
  world: World | null | undefined;
  season: Season | null | undefined;
  episode: Episode | null | undefined;
  characters: Character[];
  locations: Location[];
  continuityCount?: number;
}): WorldWriteReadyResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const { world, season, episode, characters, locations } = opts;

  if (!world) {
    return { ok: false, missing: ['Create the world first'], warnings: [] };
  }
  if (!world.title.trim() || world.title.trim() === 'Untitled world') {
    missing.push('Give the world a title');
  }
  if (!world.line.trim()) missing.push('Add a one-sentence world logline');
  if (world.bible.trim().length < BIBLE_MIN_CHARS) {
    missing.push(`Expand the world bible (at least ${BIBLE_MIN_CHARS} characters)`);
  }
  if (!season?.premise?.trim()) missing.push('Write a season premise');

  const player = characters.find((c) => c.isPlayer);
  if (!player) missing.push('Player character is missing');
  else if (!player.summary.trim() && !player.state.goal.trim()) {
    missing.push('Fill who you are (summary or current goal)');
  } else if (!player.appearance.trim() && !player.desires.trim()) {
    warnings.push('Player sheet is thin — appearance or desires help the first scene');
  }

  const castIds = new Set(episode?.castIds ?? []);
  const sceneNpcs = characters.filter((c) => !c.isPlayer && castIds.has(c.id));
  const readyNpc = sceneNpcs.find(
    (c) => c.summary.trim() && c.speechStyle.trim() && c.anchors.some((a) => a.trim())
  );
  if (!readyNpc) {
    missing.push('Add at least one NPC in the scene with voice, summary, and an anchor');
  } else {
    if (!readyNpc.exampleLines.some((l) => l.trim())) {
      warnings.push('Scene NPC has no example lines — voice lands cleaner with 1–2 samples');
    }
    if (isVagueSpeechStyle(readyNpc.speechStyle)) {
      warnings.push('Scene NPC voice is vague — replace “normal/casual” with rhythm, diction, or tic');
    }
    if (!readyNpc.mannerisms.trim()) {
      warnings.push('Scene NPC has no mannerisms — one recurring tic makes bodies feel real');
    }
  }

  const epNum = episode?.number ?? 1;
  const openLoc = episode?.locationId
    ? locations.find((l) => l.id === episode.locationId)
    : undefined;
  if (!openLoc) {
    missing.push(
      epNum <= 1
        ? 'Link an opening location to episode 1'
        : `Link a location to episode ${epNum}`
    );
  } else if (openLoc.rules.filter((r) => r.trim()).length === 0) {
    missing.push(
      epNum <= 1
        ? 'Give the opening location at least one hard rule'
        : 'Give this episode’s location at least one hard rule'
    );
  } else {
    if (!openLoc.atmosphere.trim()) {
      warnings.push(
        epNum <= 1
          ? 'Opening place has no atmosphere — sensory detail helps the narrator'
          : 'Place has no atmosphere — sensory detail helps the narrator'
      );
    }
    if (openLoc.rules.some(isGenericLocationRule)) {
      warnings.push('Replace the generic place rule with something specific to this location');
    }
  }

  if ((opts.continuityCount ?? 0) === 0) {
    warnings.push(
      epNum <= 1
        ? 'No opening continuity facts yet — seed memory before entering if you can'
        : 'No continuity facts yet — seed memory if the narrator needs prior beats'
    );
  }

  return { ok: missing.length === 0, missing, warnings };
}

/** Load world rows and evaluate write-readiness. */
export async function worldWriteReady(worldId: string): Promise<WorldWriteReadyResult> {
  const world = await db.worlds.get(worldId);
  if (!world) return { ok: false, missing: ['World not found'], warnings: [] };
  const season = world.activeSeasonId
    ? await db.seasons.get(world.activeSeasonId)
    : await db.seasons.where('worldId').equals(worldId).first();
  const episode = season
    ? await db.episodes.where('seasonId').equals(season.id).filter((e) => e.status === 'active').first()
      ?? await db.episodes.where('seasonId').equals(season.id).first()
    : undefined;
  const characters = await db.characters.where('worldId').equals(worldId).toArray();
  const locations = await db.locations.where('worldId').equals(worldId).toArray();
  const continuityCount = season
    ? await db.continuity.where('seasonId').equals(season.id).count()
    : 0;
  return evaluateWorldWriteReady({
    world, season, episode, characters, locations, continuityCount
  });
}

/** Highest-numbered ended episode in a season (wrap recovery when none is active). */
export function latestEndedEpisode(episodes: Episode[]): Episode | undefined {
  let best: Episode | undefined;
  for (const e of episodes) {
    if (e.status !== 'ended') continue;
    if (!best || e.number > best.number || (e.number === best.number && e.createdAt > best.createdAt)) {
      best = e;
    }
  }
  return best;
}

/** Prefer an already-open active episode over opening a duplicate (double-click recover). */
export function preferExistingActiveEpisode(
  seasonEpisodes: Episode[],
  endingId: string
): Episode | undefined {
  return seasonEpisodes.find((e) => e.status === 'active' && e.id !== endingId);
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
  /** Plot targets for the next episode (Aim + carried pending). */
  plotTargets?: PlotTarget[];
}

/**
 * End the current episode and open the next one, carrying the scene cast forward.
 * If the season already has another active episode, ends `current` (when still active)
 * and returns that existing row instead of creating a second active episode.
 */
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

  let created: Episode | null = null;
  let reused: Episode | null = null;

  await db.transaction('rw', [db.episodes, db.worlds], async () => {
    const siblings = await db.episodes.where('seasonId').equals(current.seasonId).toArray();
    const existing = preferExistingActiveEpisode(siblings, current.id);
    if (existing) {
      const liveCurrent = siblings.find((e) => e.id === current.id) ?? current;
      if (liveCurrent.status === 'active') {
        await db.episodes.update(current.id, {
          status: 'ended',
          storyDay: current.storyDay ?? dayEnd,
          storyDayEnd: dayEnd,
          pendingPlan: null,
          ...(opts.dateNote != null ? { dateNote: opts.dateNote } : {}),
          updatedAt: Date.now()
        });
      }
      reused = existing;
      return;
    }

    const next: Episode = {
      id: uid(), seasonId: current.seasonId, worldId: current.worldId,
      number: current.number + 1, title: '', location: current.location,
      locationId: current.locationId ?? null,
      castIds: current.castIds,
      guests: [],
      // Omit activeGuestIds — empty guests; prompts treat omitted as "all" when guests exist.
      wrap: null,
      runningSummary: null,
      runningSummaryAtChars: 0,
      liveStateAtChars: 0,
      storyDay: nextDay,
      storyDayEnd: null,
      dateNote: null,
      plotTargets: opts.plotTargets?.length ? opts.plotTargets : undefined,
      pendingPlan: null,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.episodes.update(current.id, {
      status: 'ended',
      storyDay: current.storyDay ?? dayEnd,
      storyDayEnd: dayEnd,
      pendingPlan: null,
      ...(opts.dateNote != null ? { dateNote: opts.dateNote } : {}),
      updatedAt: Date.now()
    });
    await db.episodes.add(next);
    if (world) {
      const live = await db.worlds.get(world.id);
      await db.worlds.update(world.id, {
        calendar: calendarPatch(live ?? world, { currentDay: nextDay }),
        updatedAt: Date.now()
      });
    }
    created = next;
  });

  if (reused) return reused;

  // Activate calendar events entered between episode end and next open.
  await evaluateCalendarEvents({
    worldId: current.worldId,
    seasonId: current.seasonId,
    fromDay: dayEnd,
    toDay: nextDay,
    mode: 'advance',
    world
  });
  return created!;
}
