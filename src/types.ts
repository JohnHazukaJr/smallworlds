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
}

export interface World {
  id: string;
  title: string;
  /** one-line logline shown on the card */
  line: string;
  /** the world bible: setting, rules, pressures — packed into every prompt */
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

export interface Season {
  id: string;
  worldId: string;
  number: number;
  title: string;
  premise: string;
  /** human label like "Two years" */
  timeGap: string | null;
  bible: SeasonBible | null;
  status: 'active' | 'wrapped';
  createdAt: number;
}

export interface Episode {
  id: string;
  seasonId: string;
  worldId: string;
  number: number;
  title: string;
  /** where the episode takes place — feeds the scene plate + prompt */
  location: string;
  /** optional scene image (data URL) shown behind the story text */
  image?: string | null;
  /** character ids present in the current scene */
  castIds: string[];
  status: 'active' | 'ended';
  createdAt: number;
}

export type TurnRole = 'user' | 'narrator';
export type ComposeMode = 'continue' | 'steer' | 'speak' | 'act';
export type TurnLength = 'beat' | 'scene' | 'episode';

export interface Turn {
  id: string;
  episodeId: string;
  worldId: string;
  role: TurnRole;
  /** for user turns: which mode produced it */
  mode: ComposeMode | null;
  text: string;
  createdAt: number;
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
  /** uploaded portrait image, data URL — null/unset shows the placeholder plate */
  portrait?: string | null;
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
  text: string;
  source: 'auto' | 'manual';
  createdAt: number;
}

export interface OpenThread {
  id: string;
  worldId: string;
  seasonId: string;
  text: string;
  /** e.g. "opened S2 · E7" */
  openedLabel: string;
  status: 'open' | 'resolved';
  createdAt: number;
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
}

export interface SeasonWrap {
  id: string;
  seasonId: string;
  worldId: string;
  beats: WrapBeat[];
  characters: WrapCharacterOutcome[];
  /** index into GAP_LABELS */
  gap: number;
  premise: string;
  status: 'draft' | 'committed';
  createdAt: number;
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
