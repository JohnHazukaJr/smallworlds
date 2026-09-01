// ---------- Core story records (persisted in IndexedDB) ----------

export type Visibility = 'private' | 'invited' | 'public';

export interface WorldAISettings {
  /** narrator point of view */
  pov: 'second' | 'first' | 'third';
  tense: 'present' | 'past';
  /** 0..100 — restrained to ornamental prose */
  proseDensity: number;
  /** 0..100 — slow-burn to propulsive */
  pacing: number;
  /** free text describing what is/isn't allowed in this world */
  contentNotes: string;
  /** hard rules the narrator must never break */
  narratorRules: string[];
  /** free-text world instructions passed verbatim to the model */
  customInstructions: string;
  mature: boolean;
}

export interface WorldCalendar {
  /** in-fiction day count since the story began — day 1 is the start */
  currentDay: number;
  /** free-text calendar system the narrator follows verbatim, e.g. month/season names — optional */
  system: string;
  /**
   * Weekday names in cycle order (e.g. Earth week, or a custom 5-day market week).
   * Omitted / empty → default Monday–Sunday via worldCalendar().
   */
  weekdays?: string[];
  /** Index into weekdays for what weekday story day 1 falls on (default 0). */
  dayOneWeekday?: number;
  /**
   * How many story days to advance when an episode ends and the next opens.
   * 0 = same day (overnight continuation), 1 = next morning (default), etc.
   */
  episodeAdvanceDays?: number;
  /** Month names in order. Omitted → January–December. */
  months?: string[];
  /** Days in each month (same length as months). Omitted → Earth lengths (non-leap). */
  monthLengths?: number[];
  /** Year number on story day 1 (default 1). */
  yearOne?: number;
  /** 0-based month index for story day 1 (default 0 = first month). */
  dayOneMonth?: number;
  /** 1-based day-of-month for story day 1 (default 1). */
  dayOneDate?: number;
}

export interface World {
  id: string;
  title: string;
  /** one-line logline shown on the card */
  line: string;
  /** the world bible: setting, rules, pressures — packed into narrator/character/guest prompts */
  bible: string;
  hue: number;
  visibility: Visibility;
  ai: WorldAISettings;
  /** provider/model override for prose; null = use global default */
  proseModel: ModelRef | null;
  /** provider/model override for utility tasks; null = use global default */
  utilityModel: ModelRef | null;
  activeSeasonId: string | null;
  /** in-fiction date tracker — worlds created before this field existed may lack it; read via worldCalendar() */
  calendar: WorldCalendar;
  /**
   * Calendar-tied season events prefs.
   * Omitted on older worlds → defaults via worldCalendarEventPrefs().
   */
  calendarEventPrefs?: WorldCalendarEventPrefs;
  createdAt: number;
  updatedAt: number;
}

export interface SeasonBible {
  /** recap written at the right altitude from kept/raised beats */
  recap: string;
  /** beats carried into this season, with dispositions */
  carriedBeats: CarriedBeat[];
  /** what changed off-screen during the time gap, per character name */
  offscreenChanges: string;
}

export interface CarriedBeat {
  text: string;
  consequence: string;
  disposition: BeatDisposition;
}

export type PlotTargetStatus = 'pending' | 'hit' | 'dropped';

/** Author-selected beat the director should work toward (not an open thread). */
export interface PlotTarget {
  id: string;
  text: string;
  status: PlotTargetStatus;
  /** where it was seeded from */
  source: 'wrap-beat' | 'season-raise' | 'manual' | 'carried';
}

export interface Season {
  id: string;
  worldId: string;
  number: number;
  title: string;
  premise: string;
  /** human label like "Two years" */
  timeGap: string | null;
  bible: SeasonBible | null;
  /** Season-arc plot targets (typically seeded from Raise at season handoff). */
  plotTargets?: PlotTarget[];
  status: 'active' | 'wrapped';
  createdAt: number;
  /** bumped on mutating writes — used for sync LWW */
  updatedAt?: number;
}

/** Walk-on NPC for one episode only — not a Cast card. */
export interface EpisodeGuest {
  id: string;
  name: string;
  /** who they are in this scene */
  brief: string;
  /** optional one-line speech note */
  voice?: string;
}

export interface EpisodeWrapBeat {
  text: string;
  consequence: string;
}

/** Filed when an episode ends — seeds the next episode's "previously" context. */
export interface EpisodeWrap {
  recap: string;
  beats: EpisodeWrapBeat[];
  guestEffects: string[];
}

export interface Episode {
  id: string;
  seasonId: string;
  worldId: string;
  number: number;
  title: string;
  /** where the episode takes place — feeds the scene plate + prompt */
  location: string;
  /** saved Location id when the scene is set from the library; null = free-text / unset */
  locationId?: string | null;
  /** optional scene image (data URL) shown behind the story text */
  image?: string | null;
  /** free-text weather / time of day / sensory note for this scene */
  atmosphereNote?: string;
  /** when true, location changes won't auto-retarget the global mood */
  moodPinned?: boolean;
  /** Story day this episode opened on (stamped from world calendar). */
  storyDay?: number | null;
  /** Story day this episode ended on (filed at wrap / end); null while active. */
  storyDayEnd?: number | null;
  /** Optional free-text date note from wrap analysis (e.g. "two nights; ends at dawn"). */
  dateNote?: string | null;
  /** character ids present in the current scene */
  castIds: string[];
  /** ephemeral walk-ons for this episode (not Cast cards) */
  guests?: EpisodeGuest[];
  /** guest ids currently in the scene; omitted means all guests are active */
  activeGuestIds?: string[];
  /** filled when the episode is ended via the wrap flow */
  wrap?: EpisodeWrap | null;
  /**
   * Compressed mid-episode digest when the transcript outgrows the history budget.
   * Injected into prompts so early beats survive packing.
   */
  runningSummary?: string | null;
  /** Episode transcript char count when runningSummary was last refreshed */
  runningSummaryAtChars?: number;
  /**
   * Physical details the prose has established in this scene — the rain that started,
   * the lamp that broke, who is holding what. Refreshed alongside live cast state and
   * replaced wholesale, so details that stop being true drop off.
   */
  sceneLedger?: string[];
  /**
   * Transcript char count when in-scene cast live state (goal/emotion/…) was last
   * lightly patched mid-episode. Throttles utility updates between wraps.
   */
  liveStateAtChars?: number;
  /** Episode plot targets the director should work toward (Aim-from-wrap / manual). */
  plotTargets?: PlotTarget[];
  /**
   * Leftover director beats after Stop/error mid-write.
   * Resume with Continue plan instead of a full re-plan.
   */
  pendingPlan?: {
    beats: Array<
      | { type: 'narration'; brief: string }
      | { type: 'speak'; characterId: string; brief: string }
      | { type: 'speak'; guestId: string; brief: string }
    >;
    length: TurnLength;
    createdAt: number;
  } | null;
  status: 'active' | 'ended';
  createdAt: number;
  /** bumped on mutating writes — used for sync LWW */
  updatedAt?: number;
}

export type TurnRole = 'user' | 'narrator' | 'character';
export type ComposeMode = 'continue' | 'steer' | 'speak' | 'act' | 'play';

/** Speak, Act, or combined Speak+Act — player agency turns that expect a reply. */
export function isPlayerAgencyMode(mode: ComposeMode): boolean {
  return mode === 'speak' || mode === 'act' || mode === 'play';
}

/** Resolve Continue/Steer base + Speak/Act toggles into a single compose mode. */
export function resolveComposeMode(
  base: 'continue' | 'steer',
  speakOn: boolean,
  actOn: boolean
): ComposeMode {
  if (speakOn && actOn) return 'play';
  if (speakOn) return 'speak';
  if (actOn) return 'act';
  return base;
}
/**
 * Reply-size preset for a Write-on (not story structure).
 * Story units remain Season → Episode → Turns; director plans micro-beats inside a turn.
 * UI labels: Short / Medium / Long.
 */
export type TurnLength = 'beat' | 'scene' | 'episode';

export const TURN_LENGTH_LABELS: Record<TurnLength, string> = {
  beat: 'Short',
  scene: 'Medium',
  episode: 'Long'
};

export interface Turn {
  id: string;
  episodeId: string;
  worldId: string;
  role: TurnRole;
  /** for user turns: which mode produced it */
  mode: ComposeMode | null;
  /** set when role === 'character' — which NPC Cast card spoke this turn */
  characterId?: string;
  /** set when role === 'character' — ephemeral episode guest spoke (no Cast card) */
  guestId?: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
}

// ---------- Characters ----------

export interface Relationship {
  targetId: string;
  /** ally, rival, lover, debt, family, ... */
  kind: string;
  note: string;
}

export interface CharacterState {
  goal: string;
  emotion: string;
  location: string;
  condition: string;
}

export interface Character {
  id: string;
  worldId: string;
  name: string;
  /** short role line, e.g. "harbour registrar · reluctant ally" */
  role: string;
  hue: number;
  isPlayer: boolean;
  /** marks this card as representing the author, for reference only — never changes who the narrator writes as "you" */
  selfTag: boolean;
  /**
   * Primary face for story avatars and list chips — kept in sync with portraits[0].
   * Null/unset shows the hue placeholder plate.
   */
  portrait?: string | null;
  /** All uploaded photos as data URLs; index 0 is the primary face */
  portraits?: string[];
  // identity
  age: string;
  appearance: string;
  /** recurring physical habits, gestures, tics the narrator weaves in */
  mannerisms: string;
  /** the history that shaped them — informs behaviour, never dumped as exposition */
  backstory: string;
  /** prose description — who they are */
  summary: string;
  // voice
  speechStyle: string;
  exampleLines: string[];
  // psychology
  traits: string;
  desires: string;
  fears: string;
  flaws: string;
  // secrets & knowledge
  secrets: string;
  /** things this character must NOT know yet — the AI must not leak these */
  mustNotKnow: string;
  relationships: Relationship[];
  /** hard behavioural rules, never broken */
  anchors: string[];
  /** free-text per-character AI directives, passed verbatim */
  customInstructions: string;
  state: CharacterState;
  createdAt: number;
  updatedAt: number;
}

// ---------- Locations ----------

export interface Location {
  id: string;
  worldId: string;
  name: string;
  /** short tagline, e.g. "harbour district · public square" */
  tagline: string;
  hue: number;
  /** uploaded portrait image, data URL — null/unset shows the placeholder plate */
  portrait?: string | null;
  /** prose description — what the place is, first impression */
  summary: string;
  /** sensory detail: sight, sound, smell, feel — what the narrator leans on */
  atmosphere: string;
  /** notable landmarks, rooms, or features within it */
  features: string;
  /** how it came to be / what happened here — revealed only in earned fragments */
  history: string;
  /** who or what is typically found here */
  inhabitants: string;
  /** hazards, laws, or hard rules specific to this place — never broken */
  rules: string[];
  /** things hidden here, not common knowledge */
  secrets: string;
  /** current condition/status, e.g. "burned in the siege, still rebuilding" */
  currentState: string;
  /** free-text per-location AI directives, passed verbatim */
  customInstructions: string;
  createdAt: number;
  updatedAt: number;
}

// ---------- Continuity ----------

export interface ContinuityFact {
  id: string;
  worldId: string;
  seasonId: string;
  /** Episode that filed this fact (optional for older rows). Used to keep cross-episode coverage in prompt caps. */
  episodeId?: string;
  text: string;
  source: 'auto' | 'manual';
  /** When true, always included in the director fact cap before soft picks. */
  pinned?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface OpenThread {
  id: string;
  worldId: string;
  seasonId: string;
  text: string;
  /** e.g. "opened S2 · E7" */
  openedLabel: string;
  status: 'open' | 'resolved';
  /** When true, always included in the director thread cap before soft picks. */
  pinned?: boolean;
  createdAt: number;
  updatedAt?: number;
}

// ---------- Calendar-tied season events ----------

export type CalendarEventKind =
  | 'holiday'
  | 'festival'
  | 'ceremony'
  | 'gathering'
  | 'sport'
  | 'disaster'
  | 'personal'
  | 'mundane'
  | 'custom';

export type CalendarEventScale = 'small' | 'medium' | 'large';

/** UI spoil policy — model always receives full summary for due events. */
export type CalendarEventVisibility = 'spoiler' | 'title' | 'hidden';

export type CalendarEventPromptPolicy = 'soft' | 'hard';

export type CalendarEventStatus =
  | 'scheduled'
  | 'due'
  | 'played'
  | 'missed'
  | 'cancelled';

export type CalendarEventSource = 'manual' | 'ai-seed' | 'ai-suggest';

/** Dated season texture / pressure — separate from undated PlotTarget. */
export interface CalendarEvent {
  id: string;
  worldId: string;
  seasonId: string;
  title: string;
  /** Full beat for the model; may be hidden in UI when visibility ≠ spoiler. */
  summary: string;
  kind: CalendarEventKind;
  scale: CalendarEventScale;
  /** Absolute story day the event becomes due. */
  storyDay: number;
  /** Optional multi-day window end (inclusive). */
  endDay?: number;
  visibility: CalendarEventVisibility;
  promptPolicy: CalendarEventPromptPolicy;
  status: CalendarEventStatus;
  characterIds?: string[];
  source: CalendarEventSource;
  pinned?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface WorldCalendarEventPrefs {
  /** Master switch — when false, events are ignored in prompts/evaluation. */
  enabled: boolean;
  /** Opt-in: seed AI texture when a new season begins. */
  aiSeedOnSeasonStart: boolean;
  /** Default visibility for newly created manual events. */
  defaultVisibility: CalendarEventVisibility;
}

export const DEFAULT_CALENDAR_EVENT_PREFS: WorldCalendarEventPrefs = {
  enabled: true,
  aiSeedOnSeasonStart: false,
  defaultVisibility: 'title'
};

export const CALENDAR_EVENT_CAP = 12;

export function worldCalendarEventPrefs(
  world: Pick<World, 'calendarEventPrefs'> | null | undefined
): WorldCalendarEventPrefs {
  const p = world?.calendarEventPrefs;
  return {
    enabled: p?.enabled ?? DEFAULT_CALENDAR_EVENT_PREFS.enabled,
    aiSeedOnSeasonStart: p?.aiSeedOnSeasonStart ?? DEFAULT_CALENDAR_EVENT_PREFS.aiSeedOnSeasonStart,
    defaultVisibility: p?.defaultVisibility ?? DEFAULT_CALENDAR_EVENT_PREFS.defaultVisibility
  };
}

/** Default UI visibility for AI-seeded kinds. */
export function defaultVisibilityForKind(kind: CalendarEventKind): CalendarEventVisibility {
  if (kind === 'personal' || kind === 'disaster') return 'hidden';
  return 'title';
}

// ---------- Season wrap / sequel ----------

export type BeatDisposition = 'drop' | 'soften' | 'keep' | 'raise';

export interface WrapBeat {
  where: string;
  text: string;
  consequence: string;
  disposition: BeatDisposition;
}

export interface WrapCharacterOutcome {
  characterId: string;
  name: string;
  /** proposed end-of-season state / epilogue */
  outcome: string;
  /** what changed off-screen during the time gap (filled in step 3) */
  evolution: string;
  returning: boolean;
  /**
   * Earned psychology / role shifts proposed at season handoff.
   * Never includes voice, anchors, or customInstructions.
   */
  sheetPatch?: {
    role?: string;
    summary?: string;
    traits?: string;
    desires?: string;
    fears?: string;
    flaws?: string;
  };
  /** How they open season N+1 (live state). */
  statePatch?: Partial<CharacterState>;
  knowledge?: {
    nowKnows?: string;
    clearMustNotKnow?: string;
  };
  /** Author Keep flags — default true when patches are present. */
  keepSheet?: boolean;
  keepState?: boolean;
  keepKnowledge?: boolean;
}

export interface SeasonWrapRelationshipUpdate {
  from: string;
  to: string;
  kind?: string;
  note?: string;
  /** Author Keep — default true. */
  keep?: boolean;
}

export interface SeasonWrapPlotArc {
  text: string;
  /** Author Keep — default true. */
  keep?: boolean;
}

export interface SeasonWrap {
  id: string;
  seasonId: string;
  worldId: string;
  beats: WrapBeat[];
  characters: WrapCharacterOutcome[];
  /** Relationship edges that shifted over the gap — staged until Begin. */
  relationshipUpdates?: SeasonWrapRelationshipUpdate[];
  /** Extra season-arc pressures beyond Raise beats — staged until Begin. */
  plotArc?: SeasonWrapPlotArc[];
  /** index into GAP_LABELS */
  gap: number;
  premise: string;
  status: 'draft' | 'committed';
  createdAt: number;
  updatedAt?: number;
}

// ---------- Providers & settings (persisted in localStorage) ----------

export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelRef {
  providerId: string;
  model: string;
}

export interface AppSettings {
  providers: ProviderConfig[];
  /** global default for prose generation */
  proseModel: ModelRef | null;
  /** global default for background/utility tasks */
  utilityModel: ModelRef | null;
  matureDefault: boolean;
  defaultVisibility: Visibility;
}
