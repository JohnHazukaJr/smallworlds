import type {
  CalendarEvent, Character, ComposeMode, ContinuityFact, Episode, EpisodeGuest, Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
import { isPlayerAgencyMode, worldCalendarEventPrefs } from '../types';
import { selectCalendarEventsForPrompt } from '../calendarEvents';
import { formatEpisodeDateRange, formatStoryDate, PLOT_TARGET_CAP, worldCalendar } from '../worldOps';
import type { ChatMessage } from './client';
import { deliveryPhrase, parseDeliveryTone } from './deliveryTone';
import { SPEAK_FORMAT_RULES } from './dialogueFormat';
import { roomDynamicsLines, speakerCandidates } from './roomDynamics';

/** Shorter budgets when a narrator beat is one slice of a multi-agent turn. */
const NARRATION_BEAT_TOKENS: Record<TurnLength, number> = {
  beat: 400,
  scene: 700,
  episode: 1100
};

/**
 * Character/guest speak budgets — sized for tight *action* + "dialogue".
 * Soft word hints in speak messages do the real anti-ramble work; tokens are a hard ceiling.
 */
const CHARACTER_SPEAK_TOKENS: Record<TurnLength, number> = {
  beat: 160,
  scene: 280,
  episode: 400
};

export function narrationBeatTokens(length: TurnLength): number {
  return NARRATION_BEAT_TOKENS[length];
}

export function characterSpeakTokens(length: TurnLength = 'scene'): number {
  return CHARACTER_SPEAK_TOKENS[length];
}

/** Soft word budgets for narration slices (reply-size chips). */
export function narrationSizeHint(length: TurnLength): string {
  if (length === 'beat') return 'Keep this narration slice short (about 40–100 words).';
  if (length === 'scene') return 'This narration slice: about 80–180 words.';
  return 'This narration slice: about 120–250 words.';
}

/** Soft word budgets for character/guest speak — keep replies focused. */
export function speakSizeHint(length: TurnLength): string {
  if (length === 'beat') {
    return (
      'Keep this reply short (about 20–50 words of speech, plus a brief *action* if needed). ' +
      'One reaction only — no monologue, no restating what just happened.'
    );
  }
  if (length === 'scene') {
    return (
      'Aim for about 30–80 words of speech (plus a short *action*). ' +
      'Say what this beat needs and stop — leave room for the player.'
    );
  }
  return (
    'About 50–120 words of speech max (plus short *actions*). ' +
    'Still one focused reply, not a speech; cut any filler or repeated points.'
  );
}

/** Shared anti-generic-prose rules for narrator and speak agents. */
export const ANTI_SLOP_PROSE =
  `## Against generic prose\n` +
  `- Prefer concrete verbs and one named physical tic over mood adverbs (softly, gently, knowingly).\n` +
  `- Avoid stock filler: "couldn't help but", "a shiver ran down", "eyes sparkled/gleamed", ` +
  `"voice like velvet/silk", "smirked knowingly", "heart raced", "the air was thick with", ` +
  `"breathed a sigh of relief", "let out a breath they didn't know they were holding".\n` +
  `- Do not name the feeling when the body can show it. One specific detail beats a mood summary.\n` +
  `- Each speaker keeps their own cadence — never a shared polite chatbot register.`;


export type PromptPack = 'normal' | 'tight';

/** Per-beat prompt targeting + overflow pack. */
export interface PromptBuildOpts {
  focusIds?: string[];
  focusGuestIds?: string[];
  pack?: PromptPack;
  totalCap?: number;
  skipOmittedDigest?: boolean;
}

function playerRelLine(c: Character, all: Character[]): string | null {
  const player = all.find((x) => x.isPlayer);
  if (!player || c.isPlayer) return null;
  const out = c.relationships.find((r) => r.targetId === player.id);
  if (out) {
    const note = (out.note ?? '').trim();
    return `- ${out.kind || 'linked'} of ${player.name}${note ? `: ${clipText(note, 80)}` : ''}`;
  }
  const inbound = player.relationships.find((r) => r.targetId === c.id);
  if (!inbound) return null;
  const note = (inbound.note ?? '').trim();
  return `- ${player.name} sees them as ${inbound.kind}${note ? `: ${clipText(note, 80)}` : ''}`;
}

function liveStateBlock(c: Character, includeGoal: boolean): string | null {
  const bits = [
    includeGoal && c.state.goal && `  goal — ${c.state.goal}`,
    c.state.emotion && `  emotional — ${c.state.emotion}`,
    c.state.location && `  location — ${c.state.location}`,
    c.state.condition && `  condition — ${c.state.condition}`
  ].filter(Boolean);
  if (bits.length === 0) return null;
  return (
    `Current state (live — may evolve with the story; colors this moment, does not rewrite Voice/anchors):\n` +
    bits.join('\n')
  );
}

/** Physical body in the room — never cut for anyone on stage. */
export function presenceSheet(c: Character, all: Character[]): string {
  const rel = playerRelLine(c, all);
  const lines = [
    `### ${c.name}${c.isPlayer ? ' (THE PLAYER — never write their dialogue, decisions, or inner thoughts)' : ''}`,
    c.role && `Role: ${c.role}`,
    c.age && `Age/read: ${c.age}`,
    c.appearance && `Appearance: ${c.appearance}`,
    c.mannerisms && `Mannerisms (recurring physical habits and tics — weave them in naturally, never all at once): ${c.mannerisms}`,
    rel && `Tie to the player:\n${rel}`,
    liveStateBlock(c, true)
  ];
  return lines.filter(Boolean).join('\n');
}

/** Presence plus want / fear / anchors for the beat's focus. */
export function psycheSheet(c: Character, all: Character[]): string {
  const lines = [
    presenceSheet(c, all),
    c.summary && `Who they are: ${c.summary}`,
    c.desires && `Desires: ${c.desires}`,
    c.fears && `Fears: ${c.fears}`,
    c.mustNotKnow &&
      `MUST NOT KNOW YET (never let this character learn, reference, or act on this): ${c.mustNotKnow}`,
    c.anchors.length > 0 &&
      `BEHAVIOUR ANCHORS — non-negotiable, never break these under any circumstances:\n${c.anchors.map((a, i) => `  ${String(i + 1).padStart(2, '0')}. ${a}`).join('\n')}`
  ];
  return lines.filter(Boolean).join('\n');
}

/** Speak-agent self: psyche plus voice, example lines, backstory. */
export function voiceSheet(c: Character, all: Character[]): string {
  const rel = c.relationships
    .map((r) => {
      const target = all.find((x) => x.id === r.targetId);
      return target ? `- ${r.kind} of ${target.name}: ${r.note}` : null;
    })
    .filter(Boolean)
    .join('\n');
  const knownTo = all
    .filter((other) => other.id !== c.id)
    .flatMap((other) =>
      other.relationships
        .filter((r) => r.targetId === c.id)
        .map((r) => `- ${other.name} sees them as ${r.kind}${r.note ? `: ${r.note}` : ''}`)
    )
    .slice(0, 4)
    .join('\n');
  const lines = [
    psycheSheet(c, all),
    c.backstory && `Backstory (informs behaviour; reveal only in earned fragments, never as exposition): ${c.backstory}`,
    c.speechStyle && `Voice (stable identity — keep this cadence even as mood/goals shift): ${c.speechStyle}`,
    c.exampleLines.length > 0 &&
      `Example lines (imitate the rhythm, never reuse verbatim):\n${c.exampleLines.map((l) => `  "${l}"`).join('\n')}`,
    c.traits && `Traits: ${c.traits}`,
    c.flaws && `Flaws: ${c.flaws}`,
    c.secrets && `Secrets they carry (may act on, never announce): ${c.secrets}`,
    rel && `Relationships:\n${rel}`,
    knownTo && `Known to others:\n${knownTo}`,
    c.customInstructions && `Author's directives for this character (follow verbatim): ${c.customInstructions}`
  ];
  return lines.filter(Boolean).join('\n');
}

function locationHardRules(l: Location): string | null {
  if (l.rules.length === 0) return null;
  return (
    `HARD RULES for this place — non-negotiable, never broken:\n` +
    l.rules.map((r, i) => `  ${String(i + 1).padStart(2, '0')}. ${r}`).join('\n')
  );
}

/** Lore body without HARD RULES — used when clipping so rules can be kept first. */
function locationLoreSheet(l: Location): string {
  const lines = [
    `### ${l.name}`,
    l.tagline && `Tagline: ${l.tagline}`,
    l.summary && `Overview: ${l.summary}`,
    l.atmosphere && `Atmosphere (sensory detail to lean on): ${l.atmosphere}`,
    l.features && `Notable features: ${l.features}`,
    l.history && `History (reveal only in earned fragments, never as exposition): ${l.history}`,
    l.inhabitants && `Typically found here: ${l.inhabitants}`,
    l.secrets && `Secrets hidden here (may surface, never announced): ${l.secrets}`,
    l.currentState && `Current state: ${l.currentState}`,
    l.customInstructions && `Author's directives for this location (follow verbatim): ${l.customInstructions}`
  ];
  return lines.filter(Boolean).join('\n');
}

function locationSheet(l: Location): string {
  const rules = locationHardRules(l);
  return [locationLoreSheet(l), rules].filter(Boolean).join('\n');
}

/** Atmosphere + hard rules only — never-cut location payload for tight packs. */
function locationAtmosphereSheet(l: Location): string {
  const lines = [
    `### ${l.name}`,
    l.tagline && `Tagline: ${l.tagline}`,
    l.atmosphere && `Atmosphere (sensory detail to lean on): ${l.atmosphere}`,
    l.currentState && `Current state: ${l.currentState}`,
    locationHardRules(l)
  ];
  return lines.filter(Boolean).join('\n');
}

/** Director path: HARD RULES first (uncut), then lore clipped into remaining budget. */
function locationSheetClipped(l: Location, clipChars: number): string {
  const header = `### ${l.name}`;
  const rules = locationHardRules(l);
  const priority = [header, rules].filter(Boolean).join('\n');
  const lore = [
    l.tagline && `Tagline: ${l.tagline}`,
    l.summary && `Overview: ${l.summary}`,
    l.atmosphere && `Atmosphere (sensory detail to lean on): ${l.atmosphere}`,
    l.features && `Notable features: ${l.features}`,
    l.history && `History (reveal only in earned fragments, never as exposition): ${l.history}`,
    l.inhabitants && `Typically found here: ${l.inhabitants}`,
    l.secrets && `Secrets hidden here (may surface, never announced): ${l.secrets}`,
    l.currentState && `Current state: ${l.currentState}`,
    l.customInstructions && `Author's directives for this location (follow verbatim): ${l.customInstructions}`
  ].filter(Boolean).join('\n');
  const remaining = Math.max(0, clipChars - priority.length - (lore ? 1 : 0));
  if (!lore || remaining < 40) return priority;
  return `${priority}\n${clipText(lore, remaining)}`;
}

function locationBrief(l: Location): string {
  return `- ${l.name}${l.tagline ? ` (${l.tagline})` : ''}: ${l.summary.slice(0, 160) || 'no notes'}`;
}

export interface PromptContext {
  world: World;
  season: Season;
  episode: Episode;
  characters: Character[];
  locations: Location[];
  continuity: ContinuityFact[];
  threads: OpenThread[];
  turns: Turn[];
  /** Season calendar events (scheduled/due/played/…). */
  calendarEvents?: CalendarEvent[];
  /** Immediately prior wrapped episode in this season (newest of priorEpisodes). */
  priorEpisode?: Episode | null;
  /** Up to 3 most recent wrapped episodes before the current one (oldest → newest). */
  priorEpisodes?: Episode[];
}

/** Guests currently in the scene (activeGuestIds omitted ⇒ all guests). */
export function activeGuests(episode: Episode): EpisodeGuest[] {
  const all = episode.guests ?? [];
  if (!episode.activeGuestIds) return all;
  const active = new Set(episode.activeGuestIds);
  return all.filter((g) => active.has(g.id));
}

export function resolveSpeakerName(
  turn: Turn,
  characters: Character[],
  guests: EpisodeGuest[] = []
): string {
  if (turn.guestId) {
    return guests.find((g) => g.id === turn.guestId)?.name ?? 'Someone';
  }
  if (turn.characterId) {
    return characters.find((c) => c.id === turn.characterId)?.name ?? 'Someone';
  }
  return 'Someone';
}

/** One-line leftover director beat for the Continue plan banner (final string clipped). */
export function pendingBeatLabel(
  beat: DirectorBeat,
  characters: Character[],
  guests: EpisodeGuest[] = [],
  clipChars = 80
): string {
  const brief = beat.brief.trim();
  let label: string;
  if (beat.type === 'narration') {
    label = brief || 'Narration';
  } else if (beat.type === 'speak' && 'guestId' in beat) {
    const name = guests.find((g) => g.id === beat.guestId)?.name?.trim() || 'Someone';
    label = brief ? `${name}: ${brief}` : name;
  } else if (beat.type === 'speak' && 'characterId' in beat) {
    const name = characters.find((c) => c.id === beat.characterId)?.name?.trim() || 'Someone';
    label = brief ? `${name}: ${brief}` : name;
  } else {
    label = brief || 'Narration';
  }
  return clipText(label, clipChars);
}

function proseDensityLine(ai: World['ai']): string {
  return ai.proseDensity < 34 ? 'Restrained, concrete prose. Few adverbs, no ornament for its own sake.'
    : ai.proseDensity < 67 ? 'Balanced literary prose. Texture where it earns its place.'
    : 'Rich, atmospheric prose. Lean into imagery and interiority.';
}

function pacingLine(ai: World['ai']): string {
  return ai.pacing < 34 ? 'Slow-burn pacing: linger in moments, let tension accumulate.'
    : ai.pacing < 67 ? 'Measured pacing: scenes develop naturally, no rushing to payoffs.'
    : 'Propulsive pacing: keep events moving, cut the connective tissue.';
}

/** Cap for continuity bullets in narrator / speak frames. */
const CONTINUITY_FACT_CAP = 24;
/** Cap open threads so the system frame does not drown the transcript. */
const THREAD_CAP = 12;
/** Tighter caps for the director utility prompt. */
export const DIRECTOR_FACT_CAP = 16;
export const DIRECTOR_THREAD_CAP = 10;
/** How many recent packed turns the director sees (after history packing). */
export const DIRECTOR_TRANSCRIPT_TURNS = 8;
/** How many prior wrapped episodes to surface in prompts. */
const PRIOR_EPISODE_DIGEST_COUNT = 3;

type PromptAgent = 'narrator' | 'character' | 'guest' | 'director';

type PriorCapPreset = {
  beatCapImmediate: number;
  beatCapDigest: number;
  recapDigestChars: number;
  recapImmediateChars: number;
  runningCap: number;
};

/** Agent-specific prior-wrap + running-summary budgets (largest → leanest). */
const PRIOR_CAPS: Record<PromptAgent, PriorCapPreset> = {
  narrator: {
    beatCapImmediate: 6, beatCapDigest: 2,
    recapDigestChars: 280, recapImmediateChars: 1800, runningCap: 1400
  },
  character: {
    beatCapImmediate: 4, beatCapDigest: 2,
    recapDigestChars: 220, recapImmediateChars: 1200, runningCap: 1200
  },
  guest: {
    beatCapImmediate: 3, beatCapDigest: 1,
    recapDigestChars: 200, recapImmediateChars: 900, runningCap: 900
  },
  director: {
    beatCapImmediate: 6, beatCapDigest: 2,
    recapDigestChars: 220, recapImmediateChars: 720, runningCap: 700
  }
};

const FACT_CAPS: Record<PromptAgent, { facts: number; threads: number }> = {
  narrator: { facts: CONTINUITY_FACT_CAP, threads: THREAD_CAP },
  character: { facts: CONTINUITY_FACT_CAP, threads: THREAD_CAP },
  guest: { facts: CONTINUITY_FACT_CAP, threads: THREAD_CAP },
  director: { facts: DIRECTOR_FACT_CAP, threads: DIRECTOR_THREAD_CAP }
};

/**
 * Pick up to `cap` items while keeping coverage across episode buckets
 * (not pure newest-first, which erases early-episode memory mid-season).
 */
function pickAcrossBuckets<T extends { id: string; createdAt: number }>(
  items: T[],
  bucketOf: (t: T) => string,
  cap: number,
  preferBuckets: string[] = []
): T[] {
  if (items.length <= cap) {
    return [...items].sort((a, b) => b.createdAt - a.createdAt);
  }
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  const byBucket = new Map<string, T[]>();
  for (const item of sorted) {
    const key = bucketOf(item);
    const list = byBucket.get(key);
    if (list) list.push(item);
    else byBucket.set(key, [item]);
  }
  const buckets: string[] = [];
  for (const b of preferBuckets) {
    if (byBucket.has(b) && !buckets.includes(b)) buckets.push(b);
  }
  for (const b of byBucket.keys()) {
    if (!buckets.includes(b)) buckets.push(b);
  }
  const minPer = Math.max(1, Math.floor(cap / Math.max(buckets.length, 1)));
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const b of buckets) {
    for (const item of (byBucket.get(b) ?? []).slice(0, minPer)) {
      if (picked.length >= cap) break;
      if (seen.has(item.id)) continue;
      picked.push(item);
      seen.add(item.id);
    }
  }
  for (const item of sorted) {
    if (picked.length >= cap) break;
    if (seen.has(item.id)) continue;
    picked.push(item);
    seen.add(item.id);
  }
  return picked.sort((a, b) => b.createdAt - a.createdAt);
}

function episodeNumFromOpenedLabel(label: string): string | null {
  const m = label.match(/E(\d+)/i);
  return m ? `E${m[1]}` : null;
}

function preferEpisodeBuckets(ctx: PromptContext): string[] {
  const priors = resolvedPriorEpisodes(ctx);
  // Newest episode buckets first so round-robin still favours recent pressure.
  return [
    ...[...priors].reverse().map((e) => e.id),
    ...[...priors].reverse().map((e) => `E${e.number}`),
    'legacy'
  ];
}

/** Prefer buckets for Context UI (same order as director). */
export function preferBucketsForEpisodes(priorEpisodes: Episode[], current?: Episode): string[] {
  const priors = priorEpisodes.filter((e) => !current || e.number < current.number);
  return [
    ...[...priors].reverse().map((e) => e.id),
    ...[...priors].reverse().map((e) => `E${e.number}`),
    'legacy'
  ];
}

function factBucket(f: ContinuityFact): string {
  return f.episodeId || 'legacy';
}

function threadBucket(t: OpenThread): string {
  return episodeNumFromOpenedLabel(t.openedLabel) || t.seasonId || 'legacy';
}

/** Pinned facts fill the cap first, then bucket-balanced rest. Used by director and all agents. */
export function selectFactsPinnedFirst(
  continuity: ContinuityFact[],
  preferBuckets: string[] = [],
  cap: number
): ContinuityFact[] {
  const pinned = continuity
    .filter((f) => f.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cap);
  const pinnedIds = new Set(pinned.map((f) => f.id));
  const restCap = Math.max(0, cap - pinned.length);
  const rest = restCap > 0
    ? pickAcrossBuckets(
      continuity.filter((f) => !pinnedIds.has(f.id)),
      factBucket,
      restCap,
      preferBuckets
    )
    : [];
  return [...pinned, ...rest].sort((a, b) => b.createdAt - a.createdAt);
}

/** Same fact selection the director prompt uses. Pinned facts fill the cap first. */
export function selectDirectorFacts(
  continuity: ContinuityFact[],
  preferBuckets: string[] = []
): ContinuityFact[] {
  return selectFactsPinnedFirst(continuity, preferBuckets, DIRECTOR_FACT_CAP);
}

/** Pinned open threads fill the cap first. */
export function selectThreadsPinnedFirst(
  threads: OpenThread[],
  preferBuckets: string[] = [],
  cap: number
): OpenThread[] {
  const open = threads.filter((t) => t.status === 'open');
  const pinned = open
    .filter((t) => t.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cap);
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const restCap = Math.max(0, cap - pinned.length);
  const rest = restCap > 0
    ? pickAcrossBuckets(
      open.filter((t) => !pinnedIds.has(t.id)),
      threadBucket,
      restCap,
      preferBuckets
    )
    : [];
  return [...pinned, ...rest].sort((a, b) => b.createdAt - a.createdAt);
}

/** Same thread selection the director prompt uses. Pinned threads fill the cap first. */
export function selectDirectorThreads(
  threads: OpenThread[],
  preferBuckets: string[] = []
): OpenThread[] {
  return selectThreadsPinnedFirst(threads, preferBuckets, DIRECTOR_THREAD_CAP);
}

/** Absolute day that counts as "now" in the active episode scene. */
export function episodeSceneDay(episode: Episode, cal: ReturnType<typeof worldCalendar>): number {
  if (episode.storyDayEnd && episode.storyDayEnd > 0) return episode.storyDayEnd;
  if (episode.storyDay && episode.storyDay > 0) return episode.storyDay;
  return cal.currentDay;
}

/**
 * Unified calendar / "now" lines.
 * - full: narrator calendar section (owns all dates)
 * - compact: speak-agent current episode + today
 * - directorLine: one-line header dates for the planner
 */
function calendarBlock(
  world: World,
  episode: Episode,
  mode: 'full' | 'compact' | 'directorLine'
): string {
  const cal = worldCalendar(world);
  const scene = episodeSceneDay(episode, cal);
  const dateLine = formatEpisodeDateRange(cal, episode.storyDay, episode.storyDayEnd);
  const note = episode.dateNote?.trim();
  if (mode === 'full') {
    const worldClock = cal.currentDay !== scene
      ? `\nWorld clock (not this scene): ${formatStoryDate(cal, cal.currentDay)}.`
      : '';
    return (
      `## Calendar\n` +
      (cal.system ? `${cal.system}\n` : '') +
      `Week cycle: ${cal.weekdays.join(', ')} (day 1 of the story was a ${cal.weekdays[cal.dayOneWeekday]}).\n` +
      `Months: ${cal.months.join(', ')}.\n` +
      `Today (this scene) is ${formatStoryDate(cal, scene)}.\n` +
      `This episode's date: ${dateLine}.` +
      worldClock +
      (note ? `\nDate note: ${note}` : '')
    );
  }
  if (mode === 'directorLine') {
    return (
      `Episode ${episode.number}${episode.location ? ` @ ${episode.location}` : ''} · ${dateLine}` +
      (note ? ` · ${note}` : '') + `\n` +
      `Today (this scene): ${formatStoryDate(cal, scene)}` +
      (cal.currentDay !== scene ? ` · World clock: ${formatStoryDate(cal, cal.currentDay)}` : '')
    );
  }
  // compact
  const worldClock = cal.currentDay !== scene
    ? ` World clock: ${formatStoryDate(cal, cal.currentDay)}.`
    : '';
  return (
    `## Current episode\nEpisode ${episode.number}${episode.title ? ` — ${episode.title}` : ''}.` +
    `${episode.location ? ` Location: ${episode.location}.` : ''} Date: ${dateLine}.` +
    ` Today (this scene): ${formatStoryDate(cal, scene)}.` +
    worldClock +
    (note ? ` Note: ${note}.` : '')
  );
}

/** Episode title + location only (dates live in calendarBlock). */
function episodeHeader(episode: Episode): string {
  return (
    `## Current episode\nEpisode ${episode.number}${episode.title ? ` — ${episode.title}` : ''}.` +
    `${episode.location ? ` Location: ${episode.location}.` : ''}`
  );
}

function cappedThreadLines(
  threads: OpenThread[],
  preferBuckets: string[] = [],
  cap = THREAD_CAP
): string[] {
  return selectThreadsPinnedFirst(threads, preferBuckets, cap)
    .map((t) => `- ${t.text} (${t.openedLabel})`);
}

function cappedContinuityLines(
  continuity: ContinuityFact[],
  preferBuckets: string[] = [],
  cap = CONTINUITY_FACT_CAP
): string[] {
  return selectFactsPinnedFirst(continuity, preferBuckets, cap)
    .map((f) => `- ${f.text}`);
}

function worldBibleSection(world: World, cap = WORLD_BIBLE_CAP): string {
  return `## The world\n${clipText(world.bible || world.line, cap)}`;
}

/**
 * Physical facts the prose has already put in the room this episode.
 * Without this the narrator re-introduces the same rain every few turns, or quietly
 * drops the lamp it broke — the tell that nothing is actually persisting.
 */
export function sceneLedgerSection(episode: Episode, cap = 8): string | null {
  const details = (episode.sceneLedger ?? [])
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, cap);
  if (details.length === 0) return null;
  return (
    `## Already true in this room (established earlier in this scene)\n` +
    `Stay consistent with these. Do not re-introduce them as if new, and do not quietly ` +
    `undo one without showing it change:\n` +
    details.map((d) => `- ${d}`).join('\n')
  );
}

function runningSummaryFor(episode: Episode, cap: number): string | null {
  const running = episode.runningSummary?.trim();
  if (!running) return null;
  return (
    `## Earlier this episode (running summary)\n` +
    `Glue only — what just happened after early turns dropped. Continuity facts and the room ledger outrank this if they conflict.\n` +
    clipText(running, cap)
  );
}

function priorMemoryFor(ctx: PromptContext, agent: PromptAgent): string | null {
  const caps = PRIOR_CAPS[agent];
  return formatPriorEpisodesSection(ctx, {
    beatCapImmediate: caps.beatCapImmediate,
    beatCapDigest: caps.beatCapDigest,
    recapDigestChars: caps.recapDigestChars,
    recapImmediateChars: caps.recapImmediateChars
  });
}

function continuityBlock(
  ctx: PromptContext,
  agent: Exclude<PromptAgent, 'director'>,
  tone: 'hard' | 'plausible',
  cap = FACT_CAPS[agent].facts
): string | null {
  const prefer = preferEpisodeBuckets(ctx);
  const lines = cappedContinuityLines(ctx.continuity, prefer, cap);
  if (lines.length === 0) return null;
  const heading = tone === 'hard'
    ? '## Continuity — established facts, never contradict these'
    : '## Continuity — facts you may know if you could plausibly know them';
  return `${heading}\n${lines.join('\n')}`;
}

function threadsBlock(
  ctx: PromptContext,
  agent: PromptAgent,
  tone: 'narrator' | 'speak' | 'director',
  capOverride?: number
): string | null {
  const prefer = preferEpisodeBuckets(ctx);
  const cap = capOverride ?? FACT_CAPS[agent].threads;
  const lines = agent === 'director'
    ? selectThreadsPinnedFirst(ctx.threads, prefer, cap).map((t) => `- ${t.text}`)
    : cappedThreadLines(ctx.threads, prefer, cap);
  if (lines.length === 0) return null;
  if (tone === 'director') {
    return `Open threads (draw on sparingly; soft tensions, not the plot-target hit-list):\n${lines.join('\n')}`;
  }
  if (tone === 'speak') {
    return `## Open threads — tensions you may lean on if you know them\n${lines.join('\n')}`;
  }
  return (
    `## Open threads — unresolved tensions to draw on sparingly (do not resolve them all at once; soft backlog, not the plot-target hit-list)\n` +
    lines.join('\n')
  );
}

/** Premise (+ optional plot targets). Threads stay separate so order stays premise → targets → … → threads. */
function pressurePremise(ctx: PromptContext, opts?: { includeSeasonMeta?: boolean }): string {
  const { season } = ctx;
  if (opts?.includeSeasonMeta) {
    return (
      `## This season\nSeason ${season.number}${season.title ? ` — ${season.title}` : ''}. ` +
      `Premise (current pressure): ${season.premise || 'unwritten; discover it in play.'}` +
      `${season.timeGap ? ` It opens ${season.timeGap.toLowerCase()} after the previous season.` : ''}`
    );
  }
  return `## This season\nPremise (current pressure): ${season.premise || 'unwritten; discover it in play.'}`;
}

function currentLocationBlock(
  ctx: PromptContext,
  opts?: { clipChars?: number; includeOthers?: boolean; atmosphereOnly?: boolean }
): string[] {
  const current = resolveCurrentLocations(ctx.episode, ctx.locations);
  const out: string[] = [];
  if (current.length > 0) {
    const sheet = opts?.atmosphereOnly
      ? current.map(locationAtmosphereSheet).join('\n\n')
      : opts?.clipChars
        ? current.map((l) => locationSheetClipped(l, Math.floor(opts.clipChars! / current.length))).join('\n\n')
        : current.map(locationSheet).join('\n\n');
    out.push(
      opts?.clipChars
        ? `## Current location (honour HARD RULES when planning)\n${sheet}`
        : `## Current location\n${sheet}`
    );
  }
  if (opts?.includeOthers && ctx.locations.length > 0) {
    const others = ctx.locations.filter((l) => !current.includes(l));
    if (others.length > 0) {
      out.push(
        `## Other established locations (may be referenced or visited)\n${others.map(locationBrief).join('\n')}`
      );
    }
  }
  return out;
}

function resolvedPriorEpisodes(ctx: PromptContext): Episode[] {
  const fromList = (ctx.priorEpisodes ?? []).filter(
    (e) => e.number < ctx.episode.number && e.status === 'ended' && !!e.wrap?.recap?.trim()
  );
  if (fromList.length > 0) return fromList.slice(-PRIOR_EPISODE_DIGEST_COUNT);
  if (
    ctx.priorEpisode &&
    ctx.priorEpisode.number < ctx.episode.number &&
    ctx.priorEpisode.status === 'ended' &&
    ctx.priorEpisode.wrap?.recap?.trim()
  ) {
    return [ctx.priorEpisode];
  }
  return [];
}

function clipText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Immediate prior: capped wrap. Older priors: shorter digests. */
function formatPriorEpisodesSection(
  ctx: PromptContext,
  opts: {
    beatCapImmediate: number;
    beatCapDigest: number;
    recapDigestChars: number;
    recapImmediateChars?: number;
  }
): string | null {
  const priors = resolvedPriorEpisodes(ctx);
  if (priors.length === 0) return null;
  const immediateCap = opts.recapImmediateChars ?? PRIOR_CAPS.narrator.recapImmediateChars;
  const blocks = [...priors].reverse().map((ep, idx) => {
    const immediate = idx === 0;
    const recap = (ep.wrap?.recap ?? '').trim();
    const beats = (ep.wrap?.beats ?? [])
      .slice(0, immediate ? opts.beatCapImmediate : opts.beatCapDigest)
      .map((b) => `- ${clipText(b.text, 220)}${b.consequence ? ` → ${clipText(b.consequence, 160)}` : ''}`)
      .join('\n');
    const guestFx = immediate
      ? (ep.wrap?.guestEffects ?? [])
        .map((g) => g.trim())
        .filter(Boolean)
        .slice(0, 4)
        .map((g) => `- ${clipText(g, 180)}`)
        .join('\n')
      : '';
    const title = ep.title ? ` — ${ep.title}` : '';
    const body = clipText(recap, immediate ? immediateCap : opts.recapDigestChars);
    const heading = immediate
      ? `### Episode ${ep.number}${title} (immediate prior)`
      : `### Episode ${ep.number}${title}`;
    return (
      `${heading}\n${body}` +
      (beats ? `\n\n${immediate ? 'Carried episode beats' : 'Beats that still matter'}:\n${beats}` : '') +
      (guestFx ? `\n\nWalk-on effects that still matter:\n${guestFx}` : '')
    );
  });
  return `## Recent episodes this season\n${blocks.join('\n\n')}`;
}

function seasonBibleSection(season: Season, recapCap = SEASON_BIBLE_RECAP_CAP): string | null {
  if (!season.bible) return null;
  const beats = season.bible.carriedBeats
    .filter((b) => b.disposition !== 'drop')
    .slice(0, 8)
    .map((b) => `- [${b.disposition.toUpperCase()}] ${clipText(b.text, 200)} → ${clipText(b.consequence, 160)}`)
    .join('\n');
  return (
    `## Previously (season ${season.number - 1} recap)\n${clipText(season.bible.recap, recapCap)}` +
    (beats
      ? `\n\nCarried beats — ambient pressure from the prior season (RAISE = hot background, KEEP = alive, SOFTEN = distant echo; not the author hit-list):\n${beats}`
      : '') +
    (season.bible.offscreenChanges
      ? `\n\nWhat changed during the gap:\n${clipText(season.bible.offscreenChanges, 800)}`
      : '')
  );
}

function plotTargetsSection(episode: Episode, season: Season): string | null {
  const ep = (episode.plotTargets ?? [])
    .filter((t) => t.status === 'pending' && t.text.trim())
    .slice(0, PLOT_TARGET_CAP)
    .map((t) => `- ${clipText(t.text.trim(), 220)}`);
  const sea = (season.plotTargets ?? [])
    .filter((t) => t.status === 'pending' && t.text.trim())
    .slice(0, PLOT_TARGET_CAP)
    .map((t) => `- ${clipText(t.text.trim(), 220)}`);
  if (ep.length === 0 && sea.length === 0) return null;
  const parts: string[] = [
    '## Plot targets — work toward these when natural; do not force every target in one turn; prefer story-driven progress over checklist completion'
  ];
  if (ep.length > 0) parts.push(`Episode:\n${ep.join('\n')}`);
  if (sea.length > 0) parts.push(`Season arc:\n${sea.join('\n')}`);
  return parts.join('\n');
}

function formatCalendarEventLine(ev: CalendarEvent, opts: { includeSummary: boolean }): string {
  const scaleNote = ev.scale !== 'small' ? ` · ${ev.scale}` : '';
  const policyNote = ev.promptPolicy === 'hard' ? ' · address while due' : '';
  const head = `- [${ev.kind}${scaleNote}${policyNote}] ${ev.title.trim() || '(untitled)'}`;
  if (!opts.includeSummary || !ev.summary.trim()) return head;
  return `${head} — ${clipText(ev.summary.trim(), 180)}`;
}

/** Due / upcoming calendar texture for narrator (full) or director (compact). */
function calendarEventsSection(
  ctx: PromptContext,
  mode: 'full' | 'compact',
  opts?: { includeUpcoming?: boolean }
): string | null {
  if (!worldCalendarEventPrefs(ctx.world).enabled) return null;
  const events = ctx.calendarEvents ?? [];
  if (events.length === 0) return null;
  const cal = worldCalendar(ctx.world);
  const scene = episodeSceneDay(ctx.episode, cal);
  const { due, upcoming } = selectCalendarEventsForPrompt(events, { sceneDay: scene });
  const showUpcoming = (opts?.includeUpcoming ?? true) && upcoming.length > 0;
  if (due.length === 0 && !showUpcoming) return null;

  if (mode === 'compact') {
    const lines: string[] = [];
    if (due.length > 0) {
      lines.push(
        'Calendar due now (texture / pressure — hard+large should land; soft+small only if natural):'
      );
      for (const ev of due) lines.push(formatCalendarEventLine(ev, { includeSummary: true }));
    }
    if (showUpcoming) {
      lines.push('Calendar upcoming (~7 days):');
      for (const ev of upcoming) lines.push(formatCalendarEventLine(ev, { includeSummary: false }));
    }
    return lines.join('\n') + '\n';
  }

  const parts: string[] = [
    '## Calendar events — dated season texture (not plot targets)',
    'Due events may color the scene; hard + large should be felt. Soft + small = ambient only — do not force every item.'
  ];
  if (due.length > 0) {
    parts.push(`Due now:\n${due.map((ev) => formatCalendarEventLine(ev, { includeSummary: true })).join('\n')}`);
  }
  if (showUpcoming) {
    parts.push(
      `Upcoming (next week of story days — foreshadow lightly if at all):\n` +
      upcoming.map((ev) => formatCalendarEventLine(ev, { includeSummary: false })).join('\n')
    );
  }
  return parts.join('\n');
}

function resolveCurrentLocations(episode: Episode, locations: Location[]): Location[] {
  if (locations.length === 0) return [];
  const byId = episode.locationId
    ? locations.filter((l) => l.id === episode.locationId)
    : [];
  const epLoc = episode.location.trim().toLowerCase();
  const byName = byId.length === 0 && epLoc
    ? locations.filter((l) => l.name.trim() && (epLoc.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(epLoc)))
    : [];
  return byId.length > 0 ? byId : byName;
}

/**
 * Byte-stable prefix for one episode/cast snapshot.
 * Shared by narrator and speak so later beats in a Write can hit implicit cache.
 * Presence sheets only — focused psyche / off-scene names go after this.
 */
export function storyCachePrefix(ctx: PromptContext, opts: PromptBuildOpts = {}): string {
  return storyCacheSections(ctx, opts).join('\n\n');
}

function storyCacheSections(ctx: PromptContext, opts: PromptBuildOpts = {}): string[] {
  const { world, season, episode, characters } = ctx;
  const tight = opts.pack === 'tight';
  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const player = characters.find((c) => c.isPlayer);
  const sections: string[] = [];

  sections.push(worldBibleSection(world, tight ? 1800 : WORLD_BIBLE_CAP));
  const bible = seasonBibleSection(season, tight ? 600 : SEASON_BIBLE_RECAP_CAP);
  if (bible) sections.push(bible);
  sections.push(pressurePremise(ctx, { includeSeasonMeta: true }));
  sections.push(episodeHeader(episode));

  sections.push(...currentLocationBlock(ctx, {
    includeOthers: !tight,
    atmosphereOnly: tight
  }));

  const sensoryBits = [
    episode.atmosphereNote,
    !episode.atmosphereNote?.trim()
      ? resolveCurrentLocations(episode, ctx.locations)[0]?.atmosphere
      : undefined
  ].filter((s) => s && s.trim());
  if (sensoryBits.length > 0) {
    sections.push(
      `## Sensory contract for this scene\n` +
      `Hold the place in the body of the prose. From the notes below, keep returning to one or two concrete sensory anchors (sight, sound, smell, temperature, or touch) — never all at once, never as a tourist catalogue:\n` +
      sensoryBits.map((s) => `- ${s!.trim()}`).join('\n')
    );
  }

  if (player) {
    sections.push(`## The player\n${presenceSheet(player, characters)}`);
  }
  if (inScene.length > 0) {
    sections.push(
      `## Characters in the scene\n` +
      inScene.map((c) => presenceSheet(c, characters)).join('\n\n')
    );
  }

  const guests = activeGuests(episode);
  if (guests.length > 0) {
    sections.push(
      `## Walk-ons in this episode (not Cast cards — temporary)\n` +
      guests.map((g) => `- ${g.name}: ${g.brief}${g.voice ? ` Voice: ${g.voice}` : ''}`).join('\n')
    );
  }

  return sections;
}

function worldSpineSections(
  ctx: PromptContext,
  agent: Exclude<PromptAgent, 'director'>,
  opts: PromptBuildOpts = {}
): string[] {
  const tight = opts.pack === 'tight';
  const sections: string[] = [];
  const targets = plotTargetsSection(ctx.episode, ctx.season);
  if (targets) sections.push(targets);

  const priorEps = tight
    ? formatPriorEpisodesSection(ctx, {
      beatCapImmediate: 3, beatCapDigest: 1,
      recapDigestChars: 160, recapImmediateChars: 700
    })
    : priorMemoryFor(ctx, agent);
  if (priorEps) sections.push(priorEps);

  const factCap = tight ? 8 : FACT_CAPS[agent].facts;
  const threadCap = tight ? 4 : FACT_CAPS[agent].threads;
  const tone = agent === 'narrator' ? 'hard' : 'plausible';
  const threadKind = agent === 'narrator' ? 'narrator' : 'speak';
  const cont = continuityBlock(ctx, agent, tone, factCap);
  const threads = threadsBlock(ctx, agent, threadKind, threadCap);
  if (cont) sections.push(cont);
  if (threads) sections.push(threads);

  sections.push(calendarBlock(ctx.world, ctx.episode, agent === 'narrator' ? 'full' : 'compact'));
  const calEvents = calendarEventsSection(ctx, agent === 'narrator' ? 'full' : 'compact', {
    includeUpcoming: !tight
  });
  if (calEvents) {
    sections.push(calEvents.startsWith('##') ? calEvents : `## Calendar texture\n${calEvents}`);
  }

  const ledger = sceneLedgerSection(ctx.episode, tight ? 4 : agent === 'narrator' ? 8 : 5);
  if (ledger) sections.push(ledger);
  return sections;
}

function worldGlueSection(ctx: PromptContext, agent: PromptAgent): string | null {
  return runningSummaryFor(ctx.episode, PRIOR_CAPS[agent].runningCap);
}

function narratorFocusTail(ctx: PromptContext, opts: PromptBuildOpts = {}): string[] {
  const focus = new Set(opts.focusIds ?? []);
  if (focus.size === 0) return [];
  const { characters, episode } = ctx;
  const sections: string[] = [];
  const focusedInScene = characters.filter(
    (c) => !c.isPlayer && episode.castIds.includes(c.id) && focus.has(c.id)
  );
  if (focusedInScene.length > 0) {
    sections.push(
      `## This beat (deeper sheet)\n` +
      focusedInScene.map((c) => psycheSheet(c, characters)).join('\n\n')
    );
  }
  const offSceneFocused = characters.filter(
    (c) => !episode.castIds.includes(c.id) && !c.isPlayer && focus.has(c.id)
  );
  if (offSceneFocused.length > 0) {
    sections.push(
      `## Named off-scene (this beat only)\n` +
      offSceneFocused.map((c) => presenceSheet(c, characters)).join('\n\n')
    );
  }
  return sections;
}

/**
 * Soft situation pressure for speak agents — due calendar + aimed beats without a
 * narrator-style checklist. Characters react if it touches them; they do not force it.
 */
function speakSituationPressure(ctx: PromptContext): string | null {
  const lines: string[] = [];
  if (worldCalendarEventPrefs(ctx.world).enabled) {
    const cal = worldCalendar(ctx.world);
    const scene = episodeSceneDay(ctx.episode, cal);
    const { due } = selectCalendarEventsForPrompt(ctx.calendarEvents ?? [], { sceneDay: scene });
    for (const ev of due.slice(0, 6)) {
      const hard = ev.promptPolicy === 'hard' || ev.scale === 'large';
      lines.push(
        `- Calendar${hard ? ' (should be felt)' : ''}: ${ev.title.trim() || '(untitled)'}` +
        (ev.summary.trim() ? ` — ${clipText(ev.summary.trim(), 120)}` : '')
      );
    }
  }
  const pending = [
    ...(ctx.episode.plotTargets ?? []),
    ...(ctx.season.plotTargets ?? [])
  ].filter((t) => t.status === 'pending' && t.text.trim()).slice(0, 4);
  for (const t of pending) {
    lines.push(`- Aimed pressure: ${clipText(t.text.trim(), 160)}`);
  }
  if (lines.length === 0) return null;
  return (
    `## Situation pressure (ambient — react if it touches you; do not force or checklist)\n` +
    lines.join('\n')
  );
}

/**
 * Shared lean frame for character / guest speak agents (no plot-target checklist).
 * Role sheets go between this and continuity/threads (callers append those next).
 */
function leanAgentFrame(
  ctx: PromptContext,
  agent: 'character' | 'guest',
  opts: PromptBuildOpts = {}
): string[] {
  const sections: string[] = [];
  const pressure = speakSituationPressure(ctx);
  if (pressure) sections.push(pressure);
  sections.push(...worldSpineSections(ctx, agent, opts));
  const running = worldGlueSection(ctx, agent);
  if (running) sections.push(running);
  return sections;
}

function contentSection(ai: World['ai']): string {
  return (
    `## Content\n${ai.mature
      ? 'This is a private adult world. Mature themes, violence, and explicit content are permitted where the story calls for them; write them with craft, not gratuitously.'
      : 'Keep content at a general-audience level. Imply rather than depict.'}${ai.contentNotes ? `\nWorld-specific boundaries: ${ai.contentNotes}` : ''}`
  );
}

/**
 * Narrator writes atmosphere, physical action, and sensory detail only.
 * NPC dialogue is produced by separate character agents.
 */
export function buildNarratorSystemPrompt(ctx: PromptContext, opts: PromptBuildOpts = {}): string {
  const { world } = ctx;
  const ai = world.ai;
  const sections: string[] = [];

  sections.push(storyCachePrefix(ctx, opts));

  sections.push(
    `You are the narrator of "${world.title}", a longform interactive story written in collaboration with one player. ` +
    `You write narration only: setting, atmosphere, physical action, and what can be seen or felt. ` +
    `You never write spoken dialogue for any character. Named characters speak through their own voices in separate turns.`
  );

  sections.push(...narratorFocusTail(ctx, opts));
  sections.push(...worldSpineSections(ctx, 'narrator', opts));
  const running = worldGlueSection(ctx, 'narrator');
  if (running) sections.push(running);

  sections.push(
    `## Character conduct (for what you show, not what they say)\n` +
    `- NPCs are proactive in body and situation. They pursue desires, remember slights, and can refuse or surprise through action.\n` +
    `- Prefer one named mannerism or physical tic over abstract mood adverbs when you describe someone.\n` +
    `- Never soften a character to be agreeable. Behaviour anchors are absolute.\n` +
    `- Characters only know what they could plausibly know. Honour every MUST NOT KNOW instruction silently.\n` +
    `- Trust moves slowly. Relationships shift in small, earned steps.`
  );

  sections.push(ANTI_SLOP_PROSE);

  const rules = ai.narratorRules.filter((r) => r.trim());
  sections.push(
    `## Narration rules\n` +
    `- Point of view: ${ai.pov} person, ${ai.tense} tense, addressed to the player.\n` +
    `- ${proseDensityLine(ai)}\n` +
    `- ${pacingLine(ai)}\n` +
    `- Never write the player's dialogue, decisions, or inner monologue. Leave space for them to act.\n` +
    `- NEVER write spoken dialogue, quoted speech, or lines in the form CharacterName: "…". Named characters speak in separate turns — do not stage mute pantomime, prolonged silence, or "about to answer" beats in place of their words; cover setting and physical action, then stop.\n` +
    `- End every response on tension or an opening, never on a tidy resolution.` +
    (rules.length > 0 ? `\n${rules.map((r) => `- ${r}`).join('\n')}` : '')
  );

  sections.push(contentSection(ai));

  if (ai.customInstructions.trim()) {
    sections.push(`## Author's instructions (follow verbatim)\n${ai.customInstructions}`);
  }

  return sections.join('\n\n');
}

/**
 * Character agent: first-person as this NPC. Speaks as themselves.
 */
export function buildCharacterSystemPrompt(
  ctx: PromptContext,
  character: Character,
  opts: PromptBuildOpts = {}
): string {
  const { world, characters } = ctx;
  const ai = world.ai;
  const focus = new Set(opts.focusIds ?? []);
  const others = characters.filter(
    (c) => c.id !== character.id && ctx.episode.castIds.includes(c.id)
  );
  const namedOff = characters.filter(
    (c) => c.id !== character.id && !ctx.episode.castIds.includes(c.id) && focus.has(c.id)
  );
  const guests = activeGuests(ctx.episode);
  const sections: string[] = [];

  sections.push(storyCachePrefix(ctx, opts));

  sections.push(
    `You ARE ${character.name} in the story "${world.title}". You speak and act only as yourself. ` +
    `You are not the narrator. You do not write other characters' dialogue or the player's lines. ` +
    `Reply in your own voice — looks/mannerisms plus what you say aloud.`
  );

  sections.push(...leanAgentFrame(ctx, 'character', opts));

  sections.push(`## You\n${voiceSheet(character, characters)}`);

  if (others.length > 0) {
    sections.push(
      `## Others present\n` +
      others.map((c) => presenceSheet(c, characters)).join('\n\n')
    );
  }
  if (namedOff.length > 0) {
    sections.push(
      `## Named off-scene (this beat only)\n` +
      namedOff.map((c) => presenceSheet(c, characters)).join('\n\n')
    );
  }
  if (guests.length > 0) {
    sections.push(
      `## Walk-ons present\n` +
      guests.map((g) => `- ${g.name}: ${g.brief}`).join('\n')
    );
  }

  // Speak format lives on the user message only (buildCharacterSpeakMessages).
  sections.push(
    `## How you respond\n` +
    `- Speak as ${character.name}. Match your Voice and example-line rhythm exactly — that identity stays fixed.\n` +
    `- Let Current state (goal, emotion, condition) color *this* moment; do not invent a new personality because the plot moved.\n` +
    `- Be concise: one clear reaction for this beat. Do not ramble, lecture, recap the scene, or pad with filler.\n` +
    `- Short *action* + spoken line(s). Blank line only if tone truly shifts.\n` +
    `- Never prefix your reply with your name or "Name:". History may show "Name: …" for clarity — your output must be only *action* and "speech".\n` +
    `- Mark vocal stress with *asterisks* or **double asterisks** inside your quoted lines. Physical beats stay in *asterisks* outside the quotes.\n` +
    `- No narration of the room, weather, or other people — only your body and your words.\n` +
    `- Honour behaviour anchors and MUST NOT KNOW. Never soften yourself to please the player.\n` +
    (character.speechStyle ? `- Voice guide: ${character.speechStyle}\n` : '') +
    (character.exampleLines.length > 0
      ? `- Example spoken rhythm (wording only — still emit *actions* and "quotes" as required):\n${character.exampleLines.map((l) => `  ${l}`).join('\n')}\n`
      : '') +
    `- Stay in ${ai.tense} tense for any physical beat.`
  );

  sections.push(ANTI_SLOP_PROSE);

  sections.push(contentSection(ai));

  if (ai.customInstructions.trim()) {
    sections.push(`## Author's world instructions\n${ai.customInstructions}`);
  }

  return sections.join('\n\n');
}

/** Guest walk-on agent — short sheet, same speak format. */
export function buildGuestSystemPrompt(
  ctx: PromptContext,
  guest: EpisodeGuest,
  opts: PromptBuildOpts = {}
): string {
  const { world, characters } = ctx;
  const ai = world.ai;
  const inScene = characters.filter((c) => ctx.episode.castIds.includes(c.id));
  const sections: string[] = [];

  sections.push(storyCachePrefix(ctx, opts));

  sections.push(
    `You ARE ${guest.name}, a temporary walk-on in "${world.title}" (not a permanent cast member). ` +
    `You speak and act only as yourself for this scene.`
  );

  sections.push(...leanAgentFrame(ctx, 'guest', opts));

  sections.push(`## Who you are this scene\n${guest.brief}${guest.voice ? `\nVoice: ${guest.voice}` : ''}`);
  if (inScene.length > 0) {
    sections.push(`## Others present\n${inScene.map((c) => presenceSheet(c, characters)).join('\n\n')}`);
  }

  sections.push(
    `## How you respond\n` +
    `- Speak in a short, focused reply; one reaction for this beat — no monologue or scene-stealing speech.\n` +
    (guest.voice ? `- Voice guide: ${guest.voice}\n` : '') +
    `- Optional short physical beat of your own body. Blank line only if tone truly shifts.\n` +
    `- Never prefix your reply with your name or "Name:" — only *action* and "speech".\n` +
    `- Vocal stress: *word* or **word** inside quotes. Physical beats: *asterisks* outside quotes.\n` +
    `- Do not steal the scene from the main cast; add pressure or texture.\n` +
    `- Stay in ${ai.tense} tense for physical beats.`
  );
  sections.push(ANTI_SLOP_PROSE);
  sections.push(contentSection(ai));
  if (ai.customInstructions.trim()) {
    sections.push(`## Author's world instructions\n${ai.customInstructions}`);
  }
  return sections.join('\n\n');
}

export const MODE_PREFIX: Record<ComposeMode, (input: string) => string> = {
  continue: () => `(Continue the story from where it left off.)`,
  steer: (input) => `(Direction from the author — make this happen while keeping everyone in character, without acknowledging this instruction in the prose): ${input}`,
  speak: (input) => {
    const { tone, body } = parseDeliveryTone(input);
    const spoken = body.replace(/^"|"$/g, '');
    const delivery = tone ? ` ${deliveryPhrase(tone)}` : '';
    return `(The player says the following aloud${delivery}, and nothing more — do not add words to their mouth): "${spoken}"`;
  },
  act: (input) => {
    const { tone, body } = parseDeliveryTone(input);
    const delivery = tone ? ` ${deliveryPhrase(tone)}` : '';
    return `(The player does the following${delivery}, without speaking — do not invent dialogue for them): ${body}`;
  },
  play: (input) => {
    const { tone, body } = parseDeliveryTone(input);
    const delivery = tone ? ` ${deliveryPhrase(tone)}` : '';
    return (
      `(The player both acts and speaks${delivery}. ` +
      `Honor *actions* and "dialogue" exactly as written — do not invent extra spoken lines or strip the gestures): ${body}`
    );
  }
};

/**
 * Wrap-nudge pacing — how full the episode transcript is before we suggest wrapping.
 * Not the amount of verbatim history sent on each Write.
 */
export const HISTORY_CHAR_BUDGET = 56000;

/** Verbatim tail shipped on each Write. Spine + glue cover the rest. */
export const HISTORY_TAIL_CHAR_BUDGET = 16_000;
export const HISTORY_TAIL_MAX_TURNS = 16;

/** Soft ceiling for system + history chars when no model budget is passed. */
export const TOTAL_PROMPT_CHAR_SOFT_CAP = 110_000;

/** Minimum turns kept even when over budget. */
const PACK_MIN_TURNS = 4;

/** Cap world bible / season bible slices in agent frames. */
const WORLD_BIBLE_CAP = 6000;
const SEASON_BIBLE_RECAP_CAP = 1600;
/** Target size for deterministic omitted-turn digests (head / mid / tail). */
const OMITTED_DIGEST_CHARS = 1800;

/** Sum of turn text lengths for an episode — used for context-pressure UI. */
export function episodeHistoryChars(turns: Array<{ text: string }>): number {
  return turns.reduce((n, t) => n + t.text.length, 0);
}

/**
 * How close the episode transcript is to rolling older beats out of the prompt.
 * warm ≈ 35% (start keeping a running summary), warn ≈ 55%, escalate ≈ 75%.
 */
export function episodeContextPressure(chars: number): 'ok' | 'warm' | 'warn' | 'escalate' {
  if (chars >= HISTORY_CHAR_BUDGET * 0.75) return 'escalate';
  if (chars >= HISTORY_CHAR_BUDGET * 0.55) return 'warn';
  if (chars >= HISTORY_CHAR_BUDGET * 0.35) return 'warm';
  return 'ok';
}

function turnToChatContent(
  t: Turn,
  characters: Character[],
  guests: EpisodeGuest[] = []
): { role: 'user' | 'assistant'; content: string } {
  if (t.role === 'user') {
    return {
      role: 'user',
      content: t.mode ? MODE_PREFIX[t.mode](t.text) : t.text
    };
  }
  if (t.role === 'character') {
    const name = resolveSpeakerName(t, characters, guests);
    // Keep canonical *action* "speech" markers in history so models continue the format.
    return { role: 'assistant', content: `${name}: ${t.text}` };
  }
  return { role: 'assistant', content: t.text };
}

function labelTurnCompact(
  t: Turn,
  characters: Character[],
  guests: EpisodeGuest[] = []
): string {
  if (t.role === 'user') return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
  if (t.role === 'character') {
    return `[${resolveSpeakerName(t, characters, guests)}]: ${t.text}`;
  }
  return `[narrator]: ${t.text}`;
}

export interface PackedTurns {
  kept: Turn[];
  omitted: Turn[];
}

/**
 * Pack newest turns into the char budget; expose what fell off the front.
 * Pass `systemChars` so large system frames shrink history instead of overflowing.
 * When `totalCap` or `systemChars` is set, there is no 20k history floor.
 */
export function packTurnsDetailed(
  turns: Turn[],
  systemChars = 0,
  totalCap = TOTAL_PROMPT_CHAR_SOFT_CAP
): PackedTurns {
  const room = totalCap - Math.max(0, systemChars);
  const budget = Math.min(HISTORY_TAIL_CHAR_BUDGET, Math.max(0, room));
  let used = 0;
  const reversed = [...turns].reverse();
  const keptRev: Turn[] = [];
  for (const t of reversed) {
    used += t.text.length;
    if (used > budget && keptRev.length >= PACK_MIN_TURNS) break;
    keptRev.push(t);
  }
  keptRev.reverse();
  const kept = keptRev.length > HISTORY_TAIL_MAX_TURNS
    ? keptRev.slice(-HISTORY_TAIL_MAX_TURNS)
    : keptRev;
  const omitCount = turns.length - kept.length;
  const omitted = omitCount > 0 ? turns.slice(0, omitCount) : [];
  return { kept, omitted };
}

/**
 * Deterministic compressed digest of turns dropped by packing.
 * Takes head + tail slices so early setup and the cutover survive.
 */
export function compressOmittedTurns(
  omitted: Turn[],
  characters: Character[],
  guests: EpisodeGuest[] = []
): string {
  if (omitted.length === 0) return '';
  const labeled = omitted.map((t) => labelTurnCompact(t, characters, guests)).join('\n\n');
  if (labeled.length <= OMITTED_DIGEST_CHARS) return labeled;
  // Head + mid + tail so early setup, mid-episode turns, and the cutover all survive.
  const third = Math.max(120, Math.floor(OMITTED_DIGEST_CHARS / 3) - 12);
  const midStart = Math.max(0, Math.floor((labeled.length - third) / 2));
  return (
    labeled.slice(0, third).trimEnd() +
    '\n\n…\n\n' +
    labeled.slice(midStart, midStart + third).trim() +
    '\n\n…\n\n' +
    labeled.slice(-third).trimStart()
  );
}

/**
 * History prefix when older turns were packed out.
 * If a running summary already covers those beats, skip the digest (never send both).
 */
function earlierEpisodePrefix(
  episode: Episode | undefined,
  omitted: Turn[],
  characters: Character[],
  guests: EpisodeGuest[]
): ChatMessage | null {
  if (episode?.runningSummary?.trim()) return null;
  const digest = compressOmittedTurns(omitted, characters, guests);
  if (!digest) return null;
  return {
    role: 'user',
    content: `(Earlier this episode — compressed; recent turns follow.)\n\nCompressed earlier beats:\n${digest}`
  };
}

function historyMessages(
  turns: Turn[],
  characters: Character[],
  guests: EpisodeGuest[] = [],
  episode?: Episode,
  systemChars = 0,
  pack?: Pick<PromptBuildOpts, 'totalCap' | 'skipOmittedDigest'>
): ChatMessage[] {
  const { kept, omitted } = packTurnsDetailed(turns, systemChars, pack?.totalCap ?? TOTAL_PROMPT_CHAR_SOFT_CAP);
  const messages: ChatMessage[] = kept.map((t) => turnToChatContent(t, characters, guests));
  if (!pack?.skipOmittedDigest) {
    const prefix = earlierEpisodePrefix(episode, omitted, characters, guests);
    if (prefix) messages.unshift(prefix);
  }
  return messages;
}

function mergeMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  if (merged[0]?.role === 'assistant') {
    merged.unshift({ role: 'user', content: '(The story so far follows.)' });
  }
  return merged;
}

/** History + a narration-beat instruction. */
export function buildNarrationBeatMessages(
  turns: Turn[],
  characters: Character[],
  brief: string,
  length: TurnLength,
  guests: EpisodeGuest[] = [],
  episode?: Episode,
  systemChars = 0,
  pack?: Pick<PromptBuildOpts, 'totalCap' | 'skipOmittedDigest'>
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, episode, systemChars, pack);
  const userContent =
    `(Narration only — no spoken dialogue, no CharacterName: "…" lines.)\n` +
    `Beat brief: ${brief}\n` +
    `Show this beat on named bodies in the room; do not recap; one or two sensory anchors from the scene contract.\n\n` +
    `${narrationSizeHint(length)}`;
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

/** Extra rule when the player just spoke or acted — action-only replies are not enough. */
export const SPEAK_MUST_DIALOGUE =
  'This reply MUST include at least one spoken line in "double quotes". ' +
  'Action-only (*gestures*) is not enough — answer the player aloud.';

export type SpeakMessageOpts = {
  requireDialogue?: boolean;
  episode?: Episode;
  systemChars?: number;
  length?: TurnLength;
  totalCap?: number;
  skipOmittedDigest?: boolean;
};

/** Clip helper for speak cues (mirrors clipText; kept local so this stays near callers). */
function cueClip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * When the director skips a speak beat, inject a brief that still carries this speaker's voice/want.
 * Avoids every NPC answering with the same generic "stay in character" line.
 */
export function injectedSpeakBrief(opts: {
  name: string;
  speechStyle?: string;
  mannerisms?: string;
  emotion?: string;
  goal?: string;
  anchor?: string;
  /** one-line "who you are here" for walk-ons with no cast card */
  role?: string;
  /** where they stand in the room's turn-taking right now */
  situation?: string;
}): string {
  const bits: string[] = [`Answer the player's last move as ${opts.name.trim() || 'Someone'}`];
  const role = (opts.role ?? '').trim();
  if (role) bits.push(`who you are here: ${cueClip(role, 64)}`);
  const voice = (opts.speechStyle ?? '').trim();
  if (voice) bits.push(`voice: ${cueClip(voice, 56)}`);
  const feel = (opts.emotion ?? '').trim();
  if (feel) bits.push(`mood: ${cueClip(feel, 36)}`);
  const goal = (opts.goal ?? '').trim();
  if (goal) bits.push(`pushing: ${cueClip(goal, 48)}`);
  const tic = (opts.mannerisms ?? '').split(/[.;\n]/)[0]?.trim() ?? '';
  if (tic) bits.push(`one tic: ${cueClip(tic, 40)}`);
  const hold = (opts.anchor ?? '').trim();
  if (hold) bits.push(`hold: ${cueClip(hold, 44)}`);
  const situation = (opts.situation ?? '').trim();
  if (situation) bits.push(cueClip(situation, 88));
  bits.push('do not soften; leave room for the player');
  return `${bits.join('; ')}.`;
}

export function injectedSpeakBriefForCharacter(c: Character, situation?: string): string {
  return injectedSpeakBrief({
    name: c.name,
    speechStyle: c.speechStyle,
    mannerisms: c.mannerisms,
    emotion: c.state?.emotion,
    goal: c.state?.goal,
    anchor: c.anchors.find((a) => a.trim()),
    situation
  });
}

export function injectedSpeakBriefForGuest(g: EpisodeGuest, situation?: string): string {
  return injectedSpeakBrief({
    name: g.name,
    speechStyle: g.voice,
    role: g.brief,
    situation
  });
}

function speakVoiceReminder(speaking: Character): string {
  const parts: string[] = [];
  if (speaking.speechStyle.trim()) {
    parts.push(`Voice: ${cueClip(speaking.speechStyle, 100)}`);
  }
  const sample = speaking.exampleLines.map((l) => l.trim()).find(Boolean);
  if (sample) {
    parts.push(`Rhythm sample (do not copy): "${cueClip(sample, 80)}"`);
  }
  return parts.length > 0 ? `${parts.join('\n')}\n\n` : '';
}

/** History + a character-speak instruction. */
export function buildCharacterSpeakMessages(
  turns: Turn[],
  characters: Character[],
  speaking: Character,
  brief: string,
  guests: EpisodeGuest[] = [],
  opts?: SpeakMessageOpts
): ChatMessage[] {
  const messages = historyMessages(
    turns, characters, guests, opts?.episode, opts?.systemChars ?? 0,
    { totalCap: opts?.totalCap, skipOmittedDigest: opts?.skipOmittedDigest }
  );
  const length = opts?.length ?? 'scene';
  const userContent =
    `(You are ${speaking.name}. Respond now in character.)\n` +
    speakVoiceReminder(speaking) +
    `Intent for this line: ${brief}\n\n` +
    `Use the required *action* "dialogue" format. No other speakers.\n` +
    `${speakSizeHint(length)}\n\n` +
    SPEAK_FORMAT_RULES +
    (opts?.requireDialogue ? `\n\n${SPEAK_MUST_DIALOGUE}` : '');
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

/** History + a guest-speak instruction. */
export function buildGuestSpeakMessages(
  turns: Turn[],
  characters: Character[],
  guest: EpisodeGuest,
  brief: string,
  guests: EpisodeGuest[] = [],
  opts?: SpeakMessageOpts
): ChatMessage[] {
  const messages = historyMessages(
    turns, characters, guests, opts?.episode, opts?.systemChars ?? 0,
    { totalCap: opts?.totalCap, skipOmittedDigest: opts?.skipOmittedDigest }
  );
  const length = opts?.length ?? 'scene';
  const guestVoice = (guest.voice ?? '').trim();
  const voiceLine = guestVoice
    ? `Voice: ${cueClip(guestVoice, 100)}\n\n`
    : '';
  const userContent =
    `(You are ${guest.name}, a walk-on. Respond now.)\n` +
    voiceLine +
    `Intent for this line: ${brief}\n\n` +
    `${speakSizeHint(length)}\n\n` +
    SPEAK_FORMAT_RULES +
    (opts?.requireDialogue ? `\n\n${SPEAK_MUST_DIALOGUE}` : '');
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

export type DirectorBeat =
  | { type: 'narration'; brief: string }
  | { type: 'speak'; characterId: string; brief: string }
  | { type: 'speak'; guestId: string; brief: string };

/** People this beat is about — speaker, enters, names in the brief. */
export function focusFromBeat(
  beat: DirectorBeat,
  characters: Character[],
  guests: EpisodeGuest[],
  enterIds: string[] = []
): { characterIds: string[]; guestIds: string[] } {
  const lower = beat.brief.toLowerCase();
  const characterIds = new Set<string>(enterIds);
  const guestIds = new Set<string>();
  if (beat.type === 'speak' && 'characterId' in beat) characterIds.add(beat.characterId);
  if (beat.type === 'speak' && 'guestId' in beat) guestIds.add(beat.guestId);
  for (const c of characters) {
    const name = c.name.trim();
    if (name && lower.includes(name.toLowerCase())) characterIds.add(c.id);
  }
  for (const g of guests) {
    const name = g.name.trim();
    if (name && lower.includes(name.toLowerCase())) guestIds.add(g.id);
  }
  return { characterIds: [...characterIds], guestIds: [...guestIds] };
}

/** Hard caps on director plan shape by reply-size chip. */
export function planCapsForLength(length: TurnLength): { maxSpeak: number; maxTotal: number } {
  if (length === 'beat') return { maxSpeak: 1, maxTotal: 2 };
  if (length === 'scene') return { maxSpeak: 2, maxTotal: 4 };
  return { maxSpeak: 3, maxTotal: 5 };
}

export function directorSystemPrompt(
  mode: ComposeMode,
  hasSpeakers: boolean,
  length: TurnLength = 'scene'
): string {
  const { maxSpeak, maxTotal } = planCapsForLength(length);
  const sizeLabel = length === 'beat' ? 'Short' : length === 'scene' ? 'Medium' : 'Long';
  const engageReply =
    hasSpeakers && isPlayerAgencyMode(mode)
      ? 'CRITICAL: The player just spoke or acted with at least one NPC/walk-on present. ' +
        'You MUST include at least one speak beat that responds directly to that move. ' +
        'Narration-only plans are forbidden in this case. '
      : 'Not everyone must speak on every turn. ';

  const sizeGuidance =
    length === 'beat'
      ? 'Reply size is Short: prefer 1 narration + 1 speak (or speak-only if an immediate reply is natural). No multi-character pile-on. '
      : length === 'scene'
        ? 'Reply size is Medium: a tight exchange — typically 1–2 narration and at most 2 speak beats. '
        : 'Reply size is Long: room for a fuller beat sequence, still sharp — do not fill the cap without reason. ';

  return (
    'You are the scene director for an interactive story. ' +
    'Call plan_turn. Do not write story prose. ' +
    'Fallback shape if tools are unavailable: ' +
    '{"castDelta":{' +
    '"enter":["<characterId>",...],' +
    '"leave":["<characterIdOrGuestId>",...],' +
    '"introduce":[{"name":"<walk-on name>","brief":"<one sentence who they are>","voice":"<optional speech note>"}]' +
    '},' +
    '"beats":[' +
    '{"type":"narration","brief":"..."}|' +
    '{"type":"speak","characterId":"<id-or-exact-name>","brief":"..."}|' +
    '{"type":"speak","guestId":"<id-or-NEW-or-name>","brief":"..."}' +
    ']}' +
    '\n' +
    'castDelta.enter: saved Cast NPCs who arrive — use character id OR exact name. ' +
    'castDelta.leave: Cast ids/names or guest ids who exit the scene. ' +
    'Never contradict Continuity facts or Knowledge walls below. ' +
    'castDelta.introduce: optional walk-ons who are NOT Cast cards — temporary for this episode only. At most 2 per plan. ' +
    'For a newly introduced guest\'s speak beat, set guestId to the exact name string from introduce (the app will bind ids). ' +
    'For an existing guest already listed, use their guest id or exact name. ' +
    'Speak characterId may be the cast id OR the exact character name (never the player). ' +
    'Narration briefs name who moves in the room and one sensory job (sight, sound, smell, temperature, or touch) — never a weather catalogue, never finished dialogue. ' +
    'Speak briefs name want or friction (answer, refuse, deflect, bargain, stall) plus tone — a single intent, never the finished line, never "give a speech" or a multi-point monologue. ' +
    'The room is not a queue: the right voice is whoever has the most at stake, not whoever spoke last or stands first in the cast list. ' +
    'A brief may have someone answer for another, cut them off, or talk past the player — see Room dynamics below. ' +
    engageReply +
    sizeGuidance +
    `Hard cap for ${sizeLabel}: at most ${maxSpeak} speak beat${maxSpeak === 1 ? '' : 's'} and at most ${maxTotal} beats total. ` +
    'Prefer fewer, sharper speak beats over several characters holding the floor. ' +
    'Always include at least one narration beat unless the player just spoke and an immediate reply is natural — then you may open with speak. ' +
    'End the plan on tension or an opening for the player.'
  );
}

/**
 * Relationship edges between NPCs who are both on stage.
 * The speak agents already see their own ties; the director needs them to plan
 * cross-talk — a rival cutting in, an ally covering for someone.
 */
export function inSceneDyadLines(inScene: Character[], cap: number): string[] {
  const byId = new Map(inScene.map((c) => [c.id, c]));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const c of inScene) {
    for (const r of c.relationships) {
      const target = byId.get(r.targetId);
      if (!target || target.id === c.id) continue;
      const key = `${c.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const note = (r.note ?? '').trim();
      lines.push(
        `- ${c.name} → ${target.name}: ${r.kind || 'linked'}` +
        (note ? ` — ${clipText(note, 72)}` : '')
      );
      if (lines.length >= cap) return lines;
    }
  }
  return lines;
}

export function directorUserPrompt(
  ctx: PromptContext,
  mode: ComposeMode,
  input: string,
  opts?: {
    preferCharacterId?: string;
    preferGuestId?: string;
    pack?: PromptPack;
    totalCap?: number;
    enterIds?: string[];
  }
): string {
  const tight = opts?.pack === 'tight';
  const inScene = ctx.characters.filter((c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer);
  const offScene = ctx.characters.filter((c) => !ctx.episode.castIds.includes(c.id) && !c.isPlayer);
  const guests = activeGuests(ctx.episode);
  const castList = inScene.length > 0
    ? inScene.map((c) => {
      const emotion = c.state?.emotion?.trim();
      const goal = c.state?.goal?.trim();
      const anchor = (c.anchors ?? []).map((a) => a.trim()).filter(Boolean)[0];
      const bits = [
        emotion ? `feeling ${clipText(emotion, 40)}` : '',
        goal ? `wants ${clipText(goal, 48)}` : '',
        anchor ? `anchor: ${clipText(anchor, 56)}` : ''
      ].filter(Boolean);
      const detail = bits.length ? ` — ${bits.join('; ')}` : '';
      return `- ${c.id} · ${c.name}${c.role ? ` (${c.role})` : ''}${detail}`;
    }).join('\n')
    : '(no NPCs in scene yet)';
  const offCap = tight ? 6 : 12;
  const offShown = offScene.slice(0, offCap);
  const offRest = offScene.length - offShown.length;
  const offList = offScene.length > 0
    ? offShown.map((c) => `- ${c.id} · ${c.name}${c.role ? ` (${c.role})` : ''}`).join('\n') +
      (offRest > 0 ? `\n- …and ${offRest} others` : '')
    : '(none)';
  const guestList = guests.length > 0
    ? guests.map((g) => `- ${g.id} · ${g.name}: ${g.brief}`).join('\n')
    : '(none yet — you may introduce walk-ons via castDelta.introduce)';

  const dyads = inSceneDyadLines(inScene, tight ? 3 : 6);
  const dyadBlock = dyads.length > 0
    ? `Ties inside the room (play NPCs off each other, not only off the player):\n${dyads.join('\n')}\n\n`
    : '';

  const dynamics = roomDynamicsLines({
    candidates: speakerCandidates(inScene, guests),
    playerText: input,
    turns: ctx.turns
  });
  const dynamicsBlock = dynamics.length > 0
    ? `Room dynamics (advisory — vary who carries a scene; a silent NPC who has a stake ` +
      `is often the sharper answer than whoever spoke last):\n${dynamics.map((l) => `- ${l}`).join('\n')}\n\n`
    : '';

  const preferCast = opts?.preferCharacterId
    ? inScene.find((c) => c.id === opts.preferCharacterId)
    : undefined;
  const preferGuest = opts?.preferGuestId
    ? guests.find((g) => g.id === opts.preferGuestId)
    : undefined;
  const preferLine = preferCast
    ? `Player preference: the speak reply should be from ${preferCast.name} (${preferCast.id}) unless they have left the scene.\n`
    : preferGuest
      ? `Player preference: the speak reply should be from walk-on ${preferGuest.name} (${preferGuest.id}) unless they have left.\n`
      : '';

  const recentPacked = packTurnsDetailed(
    ctx.turns,
    0,
    Math.max(4000, (opts?.totalCap ?? 80_000) - 24_000)
  ).kept.slice(-DIRECTOR_TRANSCRIPT_TURNS);
  const allGuests = ctx.episode.guests ?? [];
  const transcript = recentPacked.map((t) => {
    if (t.role === 'user') {
      const mode = t.mode ?? 'steer';
      return `[player ${mode}]: ${MODE_PREFIX[mode](t.text)}`;
    }
    if (t.role === 'character') {
      const name = resolveSpeakerName(t, ctx.characters, allGuests);
      return `[${name}]: ${t.text}`;
    }
    return `[narrator]: ${t.text}`;
  }).join('\n\n');

  const prefer = preferEpisodeBuckets(ctx);
  const factCap = tight ? 8 : DIRECTOR_FACT_CAP;
  const factLines = selectFactsPinnedFirst(ctx.continuity, prefer, factCap)
    .map((f) => `- ${f.text}`)
    .join('\n');
  const threadSec = threadsBlock(ctx, 'director', 'director', tight ? 4 : DIRECTOR_THREAD_CAP);
  const wallCast = ctx.characters.filter((c) => {
    if (c.isPlayer || !c.mustNotKnow.trim()) return false;
    if (ctx.episode.castIds.includes(c.id)) return true;
    if ((opts?.enterIds ?? []).includes(c.id)) return true;
    return false;
  });
  const extraWalls = tight
    ? []
    : ctx.characters.filter((c) =>
      !c.isPlayer &&
      !!c.mustNotKnow.trim() &&
      !ctx.episode.castIds.includes(c.id) &&
      !(opts?.enterIds ?? []).includes(c.id)
    ).slice(0, 8);
  const knowledgeWalls = [...wallCast, ...extraWalls]
    .map((c) => `- ${c.name}: must not know — ${c.mustNotKnow.trim()}`)
    .join('\n');

  const bible = ctx.season.bible;
  const seasonBibleClip = bible
    ? `Season bible (prior season): ${clipText(bible.recap, 320)}` +
      (bible.carriedBeats.some((b) => b.disposition === 'raise' || b.disposition === 'keep')
        ? `\nCarried season beats (ambient; plot targets are listed separately):\n${bible.carriedBeats
          .filter((b) => b.disposition === 'raise' || b.disposition === 'keep')
          .slice(0, 4)
          .map((b) => `- [${b.disposition.toUpperCase()}] ${b.text}`)
          .join('\n')}`
        : '')
    : '';

  const priorSection = priorMemoryFor(ctx, 'director');
  const priorMemory = priorSection
    ? priorSection.replace(/^## Recent episodes this season\n/, '')
    : '';
  const running = runningSummaryFor(ctx.episode, PRIOR_CAPS.director.runningCap);
  const runningLine = running
    ? running.replace(
      '## Earlier this episode (running summary)\n' +
      'Glue only — what just happened after early turns dropped. Continuity facts and the room ledger outrank this if they conflict.\n',
      'Earlier this episode (summary — glue only; Continuity facts outrank this): '
    )
    : '';
  const targets = plotTargetsSection(ctx.episode, ctx.season);
  const targetsCompact = targets
    ? targets
      .replace(
        '## Plot targets — work toward these when natural; do not force every target in one turn; prefer story-driven progress over checklist completion\n',
        'Plot targets (work toward when natural; do not force all at once):\n'
      ) + '\n'
    : '';
  const calEventsCompact = calendarEventsSection(ctx, 'compact', { includeUpcoming: !tight }) ?? '';
  const locBlocks = currentLocationBlock(ctx, {
    clipChars: tight ? 600 : 1200,
    atmosphereOnly: tight
  });
  const locLine = locBlocks.length > 0
    ? locBlocks[0].replace(/^## /, '') + '\n'
    : '';

  return (
    `World: ${ctx.world.title}\n` +
    `${calendarBlock(ctx.world, ctx.episode, 'directorLine')}\n` +
    `Premise (current pressure): ${ctx.season.premise || '(unwritten)'}\n` +
    targetsCompact +
    calEventsCompact +
    (seasonBibleClip ? `${seasonBibleClip}\n` : '') +
    (priorMemory ? `\nRecent episode memory:\n${priorMemory}\n` : '') +
    `Continuity (do not contradict — these outrank any running summary):\n${factLines || '(none)'}\n\n` +
    `${threadSec ?? 'Open threads (draw on sparingly; soft tensions, not the plot-target hit-list):\n(none)'}\n\n` +
    (runningLine ? `${runningLine}\n` : '') +
    (locLine ? `\n${locLine}` : '') +
    `\n` +
    `In-scene cast:\n${castList}\n\n` +
    `Off-scene cast (may enter via castDelta.enter):\n${offList}\n\n` +
    `Active walk-ons (guest ids):\n${guestList}\n\n` +
    dyadBlock +
    dynamicsBlock +
    preferLine +
    `Knowledge walls:\n${knowledgeWalls || '(none)'}\n\n` +
    `Latest player move: ${MODE_PREFIX[mode](input)}\n\n` +
    `Recent transcript:\n${transcript || '(episode just opened)'}\n\n` +
    `Plan castDelta and beats as JSON.`
  );
}
