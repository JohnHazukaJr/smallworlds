// ---------- Core story records (persisted in IndexedDB) ----------

export type Visibility = 'private' | 'invited' | 'public';

/** How the world wants to play — not a crisis slider. */
export type StoryStance = 'longform' | 'wander' | 'intimate' | 'sandbox';

export interface WorldAISettings {
  /** narrator point of view */
  pov: 'second' | 'first' | 'third';
  tense: 'present' | 'past';
  /** 0..100 — restrained to ornamental prose */
  proseDensity: number;
  /** 0..100 — slow-burn to propulsive */
  pacing: number;
  /**
   * How fast a tracked bond or player goal moves.
   * Missing means measured. Prose pacing is separate.
   */
  bondPace?: BondPace;
  /**
   * How often the room, scores, memories, and ideas update after a reply.
   * Missing means every turn. "few" waits for a few turns' worth of story (one call instead of several).
   */
  liveUpdates?: 'turn' | 'few';
  /**
   * When a chapter ends, people who were elsewhere act on their own goals and may hear
   * what happened. Missing means on; false turns it off.
   */
  offscreenLife?: boolean;
  /**
   * Each chapter drafts a few currents (what is in motion) from the story so far and keeps
   * them up to date as play moves them. Missing means on; false turns it off.
   */
  chapterCurrents?: boolean;
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
  /** the world bible: setting, rules — packed into narrator/character/guest prompts */
  bible: string;
  hue: number;
  visibility: Visibility;
  ai: WorldAISettings;
  /**
   * How this world wants to play. Omitted on older worlds → storyStanceOf() infers
   * from a generated Shape: customInstructions line, else longform.
   */
  storyStance?: StoryStance;
  /** provider/model override for prose; null = use global default */
  proseModel: ModelRef | null;
  /** provider/model override for utility tasks; null = use global default */
  utilityModel: ModelRef | null;
  /** provider/model override for scene images; null = use global default */
  imageModel?: ModelRef | null;
  activeSeasonId: string | null;
  /** in-fiction date tracker — worlds created before this field existed may lack it; read via worldCalendar() */
  calendar: WorldCalendar;
  /**
   * Calendar-tied season events prefs.
   * Omitted on older worlds → defaults via worldCalendarEventPrefs().
   */
  calendarEventPrefs?: WorldCalendarEventPrefs;
  /** Light game rules: hidden checks and a small inventory. Omitted or off = pure narrative. */
  mechanics?: WorldMechanics;
  createdAt: number;
  updatedAt: number;
}

/** How hard the world pushes back on a risky move. */
export type MechanicsDifficulty = 'forgiving' | 'fair' | 'harsh';

export interface StatDef {
  /** Stable key stored on characters. */
  key: string;
  /** Shown to the player and the referee, e.g. "Might". */
  name: string;
  /** What it covers, for the referee. */
  note?: string;
}

export interface WorldMechanics {
  enabled: boolean;
  /** At most four. */
  stats: StatDef[];
  difficulty: MechanicsDifficulty;
}

/** One thing a character carries. */
export interface InventoryItem {
  id: string;
  name: string;
  note?: string;
  qty: number;
}

export type CheckTier = 'crit' | 'success' | 'partial' | 'fail';
export type CheckDifficulty = 'easy' | 'normal' | 'hard' | 'dire';

/** A settled risky move. The prose must honour the tier. */
export interface CheckResult {
  /** What was attempted, in a few words. */
  intent: string;
  /** Stat name used, when one applied. */
  stat?: string;
  difficulty: CheckDifficulty;
  /** The two dice. */
  dice: [number, number];
  /** Stat + difficulty + world + item. */
  modifier: number;
  total: number;
  tier: CheckTier;
  /** An item that helped. */
  item?: string;
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

/** What kind of pressure an AI-drafted current is. */
export type CurrentKind = 'agenda' | 'season' | 'consequence' | 'thread' | 'texture';

/**
 * A beat the director should work toward (not an open thread).
 * `source: 'outline'` marks a current: something already in motion in the world that the
 * AI drafted from the story so far. Currents are pressures, never a script; the author's
 * own targets (every other source) always outrank them.
 */
export interface PlotTarget {
  id: string;
  text: string;
  status: PlotTargetStatus;
  /** where it was seeded from */
  source: 'wrap-beat' | 'season-raise' | 'manual' | 'carried' | 'outline';
  /** Currents only. */
  kind?: CurrentKind;
  /** Currents only: who is driving it, by name. */
  who?: string[];
  /** Currents only: places it could go. None is required. */
  could?: string[];
  /** Currents only: the latest way play moved it. */
  note?: string;
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
  /** What people who were elsewhere did while this chapter happened. Filed once, at End chapter. */
  offscreen?: OffscreenBeat[];
}

/** One person's off-screen turn between chapters. */
export interface OffscreenBeat {
  characterId: string;
  name: string;
  /** What they did, one sentence. */
  did: string;
  /** News of the chapter that reached them, and from whom. */
  heard?: string;
}

export interface ChapterIllustration {
  id: string;
  prompt: string;
  /** JPEG data URL */
  dataUrl: string;
  createdAt: number;
  /** The passage it pictures. It sits right after that line; without one, after the latest line when it was made. */
  afterTurnId?: string;
}

export interface Episode {
  id: string;
  seasonId: string;
  worldId: string;
  number: number;
  title: string;
  /** Display copy of the current place's name. Written by setScenePlace; read locationId first. */
  location: string;
  /** The chapter's current place. The one source of truth for where the scene is. */
  locationId?: string | null;
  /** Optional detail within the place, e.g. "the back room". Does not change the place. */
  placeNote?: string;
  /** optional scene image (data URL) shown behind the story text */
  image?: string | null;
  /** Pictures made in this chapter. Shown in the prose; not sent back as narration. */
  illustrations?: ChapterIllustration[];
  /** Weather, light, or time of day right now. The live-state pass writes it; the prompt reads it. */
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
  /**
   * Transcript char count when live canon (facts / threads / place / knowledge)
   * was last filed mid-episode. Throttles the utility pass between wraps.
   */
  liveCanonAtChars?: number;
  /** Episode plot targets the director should work toward (Aim-from-wrap / manual / outline currents). */
  plotTargets?: PlotTarget[];
  /** When this chapter's currents were drafted. Set once, so deleting them does not bring them back. */
  currentsAt?: number;
  /** Next-move ideas for the player, written after the latest turn. Stale once a newer turn lands. */
  suggestions?: { afterTurnId: string; items: string[] };
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

/** Speak / Play must land quoted NPC speech. Act may be a look, a nod, silence. */
export function requiresSpokenReply(mode: ComposeMode): boolean {
  return mode === 'speak' || mode === 'play';
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
 * Story units are chapters. Stored length ids stay beat / scene / episode.
 * UI labels: Short / Medium / Long.
 */
export type TurnLength = 'beat' | 'scene' | 'episode';

export const TURN_LENGTH_LABELS: Record<TurnLength, string> = {
  beat: 'Short',
  scene: 'Medium',
  episode: 'Long'
};

/** How long the book writes back. Stored values stay beat / scene / episode. */
export const PAGE_LENGTH_LABELS: Record<TurnLength, string> = {
  beat: 'A shorter page',
  scene: 'A page',
  episode: 'A longer page'
};

export type ActionWeight = 'moment' | 'matters';

export interface Turn {
  id: string;
  episodeId: string;
  worldId: string;
  role: TurnRole;
  /** for user turns: which mode produced it */
  mode: ComposeMode | null;
  /** Whether this action may move people, places, and threads. Omitted on older turns. */
  weight?: ActionWeight;
  /** When set, the player took this action with that person's hands. Omitted means the player. */
  asCharacterId?: string;
  /** Who this line was said to. A cast id, including the player when an NPC speaks to them. */
  toCharacterId?: string;
  /** Who this line was said to, when they are a walk-on. */
  toGuestId?: string;
  /** set when role === 'character' — which NPC Cast card spoke this turn */
  characterId?: string;
  /** set when role === 'character' — ephemeral episode guest spoke (no Cast card) */
  guestId?: string;
  text: string;
  /**
   * Scene replies written with beat tags: who said what, exactly. Trusted only
   * while it still renders to `text` (an edit falls back to the prose splitter).
   */
  beats?: TurnBeat[];
  /** For a player move: the hidden check settled before the reply was written. */
  check?: CheckResult;
  /** Kept versions of a rewritten reply, current one included. */
  alts?: TurnAlt[];
  /** Which of `alts` is showing. */
  altIndex?: number;
  createdAt: number;
  updatedAt?: number;
}

/** One kept version of a reply. */
export interface TurnAlt {
  text: string;
  beats?: TurnBeat[];
  createdAt: number;
}

/** One block of a tagged scene reply. */
export interface TurnBeat {
  role: 'narrator' | 'character';
  text: string;
  /** Cast or walk-on id, for a credited line. */
  speakerId?: string;
  kind?: 'cast' | 'guest';
  /** Name as tagged, so the stored prose survives a rename. */
  name?: string;
}

// ---------- Characters ----------

/** How often this person belongs in the story. Missing on older cards means regular. */
export type CharacterImportance = 'lead' | 'regular' | 'occasional' | 'background';

/** World default for how fast a tracked score moves. */
export type BondPace = 'slow' | 'measured' | 'quick';

/** A track can follow the world, pick its own speed, or stay put until edited. */
export type TrackPace = BondPace | 'manual';

/** What a score means once it reaches `at`. */
export interface ScoreMark {
  at: number;
  text: string;
}

/** A longer aim on the player card. Separate from the scene goal and from plot targets. */
export interface PlayerGoal {
  id: string;
  text: string;
  /** 0–100. Missing on an old row is treated as 0. */
  score: number;
  pace?: TrackPace;
  marks?: ScoreMark[];
}

export interface Relationship {
  targetId: string;
  /** ally, rival, lover, debt, family, ... */
  kind: string;
  note: string;
  /**
   * Opt-in score on this person's tie toward the player.
   * Absent means the tie stays kind and note only.
   */
  track?: true;
  /** 0–100. Present only while tracking is on. */
  score?: number;
  pace?: TrackPace;
  /** Play may move the score, and kind and note stay as written. */
  locked?: true;
  marks?: ScoreMark[];
}

export interface CharacterState {
  goal: string;
  emotion: string;
  location: string;
  condition: string;
  /** What they have on right now, when it differs from their usual clothing. Cleared at chapter end. */
  wearing?: string;
}

/** Appearance broken into parts. The character's `appearance` is the overall impression. */
export interface CharacterLooks {
  face?: string;
  hair?: string;
  body?: string;
  /** Their usual outfit. The story's `state.wearing` tracks changes. */
  clothing?: string;
  /** Scars, tattoos, piercings, jewellery, glasses. */
  details?: string;
  /** Voice and scent: how they sound and smell. */
  senses?: string;
  /** Adult worlds and adult characters only. */
  intimate?: string;
}

export interface Character {
  id: string;
  worldId: string;
  name: string;
  /** short role line, e.g. "harbour registrar · reluctant ally" */
  role: string;
  /**
   * How often they belong on stage. Missing means regular.
   * The player card has no weight.
   */
  importance?: CharacterImportance;
  /** Nicknames and forms of address. Missing on older cards means none. */
  aliases?: string[];
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
  /**
   * The art style each generated portrait was made in, keyed by portraitKey(url).
   * Uploads have none. A picture in one style prefers a face reference in that style.
   */
  portraitStyles?: Record<string, 'realistic' | 'comic'>;
  /**
   * Full-body and scene pictures of this person. Kept apart from `portraits`
   * so they never become the avatar or the face reference.
   */
  figures?: string[];
  // identity
  age: string;
  /** "she/her", "they/them", … Missing or empty means the story must not guess. */
  pronouns?: string;
  appearance: string;
  /** Face, hair, body, clothing, and more. Optional; `appearance` stays the overall line. */
  looks?: CharacterLooks;
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
  /**
   * Longer aims, each with its own score. Empty until the author adds one.
   * Not `state.goal`, and not the chapter's plot targets.
   */
  goals?: PlayerGoal[];
  /** hard behavioural rules, never broken */
  anchors: string[];
  /** free-text per-character AI directives, passed verbatim */
  customInstructions: string;
  state: CharacterState;
  /**
   * What this person lived through on the page, in their own view. Filed after
   * each turn they were present for; the strongest and most relevant few ride
   * on their scene card. Capped and pruned by salience and age.
   */
  memories?: NpcMemory[];
  /** Stat modifiers by StatDef key, -1 to 3. Used when the world has mechanics on. */
  stats?: Record<string, number>;
  /** What they carry. Used when the world has mechanics on. */
  inventory?: InventoryItem[];
  createdAt: number;
  updatedAt: number;
}

/** One remembered moment, from the character's side. */
export interface NpcMemory {
  id: string;
  text: string;
  /** A word or two: how it left them. */
  feeling?: string;
  /** 1 passing, 2 notable, 3 they will never forget. */
  salience: 1 | 2 | 3;
  episodeId: string;
  createdAt: number;
}

// ---------- Locations ----------

export interface Location {
  id: string;
  worldId: string;
  name: string;
  /** The place this one sits inside (Saltmere > Harbour > The Long Room). Null or missing = top level. */
  parentId?: string | null;
  /** Story tint: the mood colour the Story screen takes while the scene is here. */
  hue: number;
  /** uploaded portrait image, data URL — null/unset shows the placeholder plate */
  portrait?: string | null;
  /** What it is: first impression and what is here. */
  summary: string;
  /** Feel: sight, sound, smell, texture — what the writer leans on. */
  atmosphere: string;
  /** Who's here: who or what is usually found here. */
  inhabitants: string;
  /**
   * Cast who belong here (home or work). Missing on older places means none.
   * Separate from Character.state.location, which play still moves.
   */
  residentIds?: string[];
  /** Places a short walk or ride away, by id. */
  nearIds?: string[];
  /** Optional rules that hold here (laws, hazards). Not required. */
  rules: string[];
  /** Hidden: history and secrets the writer knows and reveals only when earned. */
  hidden?: string;
  /** Right now: its condition at the moment. Play updates it. */
  currentState: string;
  /** Notes for the AI while the scene is here. */
  customInstructions: string;
  /** Before the tree. Folded into the fields above on first open; kept so old rows and imports still load. */
  tagline: string;
  features: string;
  history: string;
  secrets: string;
  area?: string;
  near?: string;
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
  /** Lorebook keys. When set, a beat that mentions one of these pulls the fact even if the wording differs. */
  keys?: string[];
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
  /** Extra season-arc situations beyond Raise beats — staged until Begin. */
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
  /** global default for scene image generation */
  imageModel: ModelRef | null;
  /** Adult chapter pictures. Null keeps every picture on imageModel. */
  matureImageModel: ModelRef | null;
  matureDefault: boolean;
  defaultVisibility: Visibility;
  /**
   * Author override for the prose context window, in tokens.
   * Null means infer it from the model id.
   */
  contextWindowTokens: number | null;
}
