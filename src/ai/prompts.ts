import type {
  Character, ComposeMode, ContinuityFact, Episode, EpisodeGuest, Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
import { formatEpisodeDateRange, formatStoryDate, PLOT_TARGET_CAP, worldCalendar } from '../worldOps';
import type { ChatMessage } from './client';
import { SPEAK_FORMAT_RULES } from './dialogueFormat';

const LENGTH_SPEC: Record<TurnLength, { instruction: string; maxTokens: number }> = {
  beat: {
    instruction: 'Write ONE tight beat: 80–160 words. A single moment, exchange, or turn of pressure. Stop before it resolves.',
    maxTokens: 600
  },
  scene: {
    instruction: 'Write a scene-length passage: roughly 300–500 words. Let it breathe, but end on an unresolved note that invites the player to respond.',
    maxTokens: 1400
  },
  episode: {
    instruction: 'Write a long, episode-scale passage: roughly 700–1100 words. It may cross locations or hours, but keep the player at its centre and end mid-tension, not neatly.',
    maxTokens: 2600
  }
};

/** Shorter budgets when a narrator beat is one slice of a multi-agent turn. */
const NARRATION_BEAT_TOKENS: Record<TurnLength, number> = {
  beat: 400,
  scene: 700,
  episode: 1100
};

/**
 * Character/guest speak budgets — scaled by turn length so *action* + "dialogue"
 * does not hit max_tokens mid-sentence on longer scenes.
 */
const CHARACTER_SPEAK_TOKENS: Record<TurnLength, number> = {
  beat: 500,
  scene: 720,
  episode: 900
};

export function maxTokensFor(length: TurnLength): number {
  return LENGTH_SPEC[length].maxTokens;
}

export function narrationBeatTokens(length: TurnLength): number {
  return NARRATION_BEAT_TOKENS[length];
}

export function characterSpeakTokens(length: TurnLength = 'scene'): number {
  return CHARACTER_SPEAK_TOKENS[length];
}

function characterSheet(c: Character, all: Character[]): string {
  const rel = c.relationships
    .map((r) => {
      const target = all.find((x) => x.id === r.targetId);
      return target ? `- ${r.kind} of ${target.name}: ${r.note}` : null;
    })
    .filter(Boolean)
    .join('\n');
  // How others see this character — inbound edges (max 4) for narrator/full-sheet context.
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
    `### ${c.name}${c.isPlayer ? ' (THE PLAYER — never write their dialogue, decisions, or inner thoughts)' : ''}`,
    c.role && `Role: ${c.role}`,
    c.age && `Age/read: ${c.age}`,
    c.appearance && `Appearance: ${c.appearance}`,
    c.mannerisms && `Mannerisms (recurring physical habits and tics — weave them in naturally, never all at once): ${c.mannerisms}`,
    c.summary && `Who they are: ${c.summary}`,
    c.backstory && `Backstory (informs behaviour; reveal only in earned fragments, never as exposition): ${c.backstory}`,
    c.speechStyle && `Voice: ${c.speechStyle}`,
    c.exampleLines.length > 0 &&
      `Example lines (imitate the rhythm, never reuse verbatim):\n${c.exampleLines.map((l) => `  "${l}"`).join('\n')}`,
    c.traits && `Traits: ${c.traits}`,
    c.desires && `Desires: ${c.desires}`,
    c.fears && `Fears: ${c.fears}`,
    c.flaws && `Flaws: ${c.flaws}`,
    c.secrets && `Secrets they carry (may act on, never announce): ${c.secrets}`,
    c.mustNotKnow &&
      `MUST NOT KNOW YET (never let this character learn, reference, or act on this): ${c.mustNotKnow}`,
    rel && `Relationships:\n${rel}`,
    knownTo && `Known to others:\n${knownTo}`,
    c.anchors.length > 0 &&
      `BEHAVIOUR ANCHORS — non-negotiable, never break these under any circumstances:\n${c.anchors.map((a, i) => `  ${String(i + 1).padStart(2, '0')}. ${a}`).join('\n')}`,
    c.customInstructions && `Author's directives for this character (follow verbatim): ${c.customInstructions}`,
    (c.state.goal || c.state.emotion || c.state.location || c.state.condition) &&
      `Current state: ${[
        c.state.goal && `goal — ${c.state.goal}`,
        c.state.emotion && `emotional — ${c.state.emotion}`,
        c.state.location && `location — ${c.state.location}`,
        c.state.condition && `condition — ${c.state.condition}`
      ].filter(Boolean).join('; ')}`
  ];
  return lines.filter(Boolean).join('\n');
}

function briefSheet(c: Character): string {
  return `- ${c.name} (${c.role || 'off-scene'}): ${c.summary.slice(0, 160) || 'no notes'}${c.state.location ? ` Currently: ${c.state.location}.` : ''}`;
}

function locationSheet(l: Location): string {
  const lines = [
    `### ${l.name}`,
    l.tagline && `Tagline: ${l.tagline}`,
    l.summary && `Overview: ${l.summary}`,
    l.atmosphere && `Atmosphere (sensory detail to lean on): ${l.atmosphere}`,
    l.features && `Notable features: ${l.features}`,
    l.history && `History (reveal only in earned fragments, never as exposition): ${l.history}`,
    l.inhabitants && `Typically found here: ${l.inhabitants}`,
    l.rules.length > 0 &&
      `HARD RULES for this place — non-negotiable, never broken:\n${l.rules.map((r, i) => `  ${String(i + 1).padStart(2, '0')}. ${r}`).join('\n')}`,
    l.secrets && `Secrets hidden here (may surface, never announced): ${l.secrets}`,
    l.currentState && `Current state: ${l.currentState}`,
    l.customInstructions && `Author's directives for this location (follow verbatim): ${l.customInstructions}`
  ];
  return lines.filter(Boolean).join('\n');
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
export const DIRECTOR_FACT_CAP = 12;
export const DIRECTOR_THREAD_CAP = 8;
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
    recapDigestChars: 220, recapImmediateChars: 520, runningCap: 400
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

/** Same fact selection the director prompt uses. */
export function selectDirectorFacts(
  continuity: ContinuityFact[],
  preferBuckets: string[] = []
): ContinuityFact[] {
  return pickAcrossBuckets(continuity, factBucket, DIRECTOR_FACT_CAP, preferBuckets);
}

/** Same thread selection the director prompt uses. */
export function selectDirectorThreads(
  threads: OpenThread[],
  preferBuckets: string[] = []
): OpenThread[] {
  return pickAcrossBuckets(threads, threadBucket, DIRECTOR_THREAD_CAP, preferBuckets);
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
  return pickAcrossBuckets(threads, threadBucket, cap, preferBuckets)
    .map((t) => `- ${t.text} (${t.openedLabel})`);
}

function cappedContinuityLines(
  continuity: ContinuityFact[],
  preferBuckets: string[] = [],
  cap = CONTINUITY_FACT_CAP
): string[] {
  return pickAcrossBuckets(continuity, factBucket, cap, preferBuckets)
    .map((f) => `- ${f.text}`);
}

function worldBibleSection(world: World): string {
  return `## The world\n${clipText(world.bible || world.line, WORLD_BIBLE_CAP)}`;
}

function runningSummaryFor(episode: Episode, cap: number): string | null {
  const running = episode.runningSummary?.trim();
  if (!running) return null;
  return `## Earlier this episode (running summary)\n${clipText(running, cap)}`;
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
  agent: PromptAgent,
  tone: 'hard' | 'plausible'
): string | null {
  const prefer = preferEpisodeBuckets(ctx);
  const cap = FACT_CAPS[agent].facts;
  const lines = agent === 'director'
    ? selectDirectorFacts(ctx.continuity, prefer).map((f) => `- ${f.text}`)
    : cappedContinuityLines(ctx.continuity, prefer, cap);
  if (lines.length === 0) return null;
  const heading = tone === 'hard'
    ? '## Continuity — established facts, never contradict these'
    : '## Continuity — facts you may know if you could plausibly know them';
  return `${heading}\n${lines.join('\n')}`;
}

function threadsBlock(
  ctx: PromptContext,
  agent: PromptAgent,
  tone: 'narrator' | 'speak' | 'director'
): string | null {
  const prefer = preferEpisodeBuckets(ctx);
  const cap = FACT_CAPS[agent].threads;
  const lines = agent === 'director'
    ? selectDirectorThreads(ctx.threads, prefer).map((t) => `- ${t.text}`)
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
  opts?: { clipChars?: number; includeOthers?: boolean }
): string[] {
  const current = resolveCurrentLocations(ctx.episode, ctx.locations);
  const out: string[] = [];
  if (current.length > 0) {
    let sheet = current.map(locationSheet).join('\n\n');
    if (opts?.clipChars) sheet = clipText(sheet, opts.clipChars);
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
    (e) => e.number < ctx.episode.number && !!e.wrap?.recap?.trim()
  );
  if (fromList.length > 0) return fromList.slice(-PRIOR_EPISODE_DIGEST_COUNT);
  if (
    ctx.priorEpisode &&
    ctx.priorEpisode.number < ctx.episode.number &&
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

function seasonBibleSection(season: Season): string | null {
  if (!season.bible) return null;
  const beats = season.bible.carriedBeats
    .filter((b) => b.disposition !== 'drop')
    .slice(0, 8)
    .map((b) => `- [${b.disposition.toUpperCase()}] ${clipText(b.text, 200)} → ${clipText(b.consequence, 160)}`)
    .join('\n');
  return (
    `## Previously (season ${season.number - 1} recap)\n${clipText(season.bible.recap, SEASON_BIBLE_RECAP_CAP)}` +
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

function worldFrameSections(ctx: PromptContext): string[] {
  const { world, season, episode, characters } = ctx;
  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const player = characters.find((c) => c.isPlayer);
  const offScene = characters.filter((c) => !episode.castIds.includes(c.id) && !c.isPlayer);
  const sections: string[] = [];

  sections.push(worldBibleSection(world));

  const bible = seasonBibleSection(season);
  if (bible) sections.push(bible);

  sections.push(pressurePremise(ctx, { includeSeasonMeta: true }));

  const targets = plotTargetsSection(episode, season);
  if (targets) sections.push(targets);

  const priorEps = priorMemoryFor(ctx, 'narrator');
  if (priorEps) sections.push(priorEps);

  const running = runningSummaryFor(episode, PRIOR_CAPS.narrator.runningCap);
  if (running) sections.push(running);

  sections.push(calendarBlock(world, episode, 'full'));
  sections.push(episodeHeader(episode));

  const guests = activeGuests(episode);
  if (guests.length > 0) {
    sections.push(
      `## Walk-ons in this episode (not Cast cards — temporary)\n` +
      guests.map((g) => `- ${g.name}: ${g.brief}${g.voice ? ` Voice: ${g.voice}` : ''}`).join('\n')
    );
  }

  sections.push(...currentLocationBlock(ctx, { includeOthers: true }));

  // Prefer episode atmosphereNote; location atmosphere already lives on the location sheet.
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
    sections.push(`## The player\n${characterSheet(player, characters)}`);
  }

  if (inScene.length > 0) {
    sections.push(`## Characters in the scene\n${inScene.map((c) => characterSheet(c, characters)).join('\n\n')}`);
  }
  if (offScene.length > 0) {
    sections.push(`## Off-scene cast (may be referenced, may arrive if the story calls them)\n${offScene.map(briefSheet).join('\n')}`);
  }

  const cont = continuityBlock(ctx, 'narrator', 'hard');
  if (cont) sections.push(cont);
  const threads = threadsBlock(ctx, 'narrator', 'narrator');
  if (threads) sections.push(threads);

  return sections;
}

/**
 * Shared lean frame for character / guest speak agents (no plot-target checklist).
 * Role sheets go between this and continuity/threads (callers append those next).
 */
function leanAgentFrame(ctx: PromptContext, agent: 'character' | 'guest'): string[] {
  const sections: string[] = [];
  sections.push(worldBibleSection(ctx.world));
  const bible = seasonBibleSection(ctx.season);
  if (bible) sections.push(bible);
  sections.push(pressurePremise(ctx));
  const prior = priorMemoryFor(ctx, agent);
  if (prior) sections.push(prior);
  const running = runningSummaryFor(ctx.episode, PRIOR_CAPS[agent].runningCap);
  if (running) sections.push(running);
  sections.push(calendarBlock(ctx.world, ctx.episode, 'compact'));
  sections.push(...currentLocationBlock(ctx));
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
export function buildNarratorSystemPrompt(ctx: PromptContext): string {
  const { world } = ctx;
  const ai = world.ai;
  const sections: string[] = [];

  sections.push(
    `You are the narrator of "${world.title}", a longform interactive story written in collaboration with one player. ` +
    `You write narration only: setting, atmosphere, physical action, and what can be seen or felt. ` +
    `You never write spoken dialogue for any character. Named characters speak through their own voices in separate turns.`
  );

  sections.push(...worldFrameSections(ctx));

  sections.push(
    `## Character conduct (for what you show, not what they say)\n` +
    `- NPCs are proactive in body and situation. They pursue desires, remember slights, and can refuse or surprise through action.\n` +
    `- Never soften a character to be agreeable. Behaviour anchors are absolute.\n` +
    `- Characters only know what they could plausibly know. Honour every MUST NOT KNOW instruction silently.\n` +
    `- Trust moves slowly. Relationships shift in small, earned steps.`
  );

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
export function buildCharacterSystemPrompt(ctx: PromptContext, character: Character): string {
  const { world, characters } = ctx;
  const ai = world.ai;
  const others = characters.filter((c) => c.id !== character.id);
  const guests = activeGuests(ctx.episode);
  const sections: string[] = [];

  sections.push(
    `You ARE ${character.name} in the story "${world.title}". You speak and act only as yourself. ` +
    `You are not the narrator. You do not write other characters' dialogue or the player's lines. ` +
    `Reply in your own voice — looks/mannerisms plus what you say aloud.`
  );

  sections.push(...leanAgentFrame(ctx, 'character'));

  sections.push(`## You\n${characterSheet(character, characters)}`);

  if (others.length > 0) {
    sections.push(
      `## Others you may address or react to\n` +
      others.map((c) => briefSheet(c)).join('\n')
    );
  }
  if (guests.length > 0) {
    sections.push(
      `## Walk-ons present\n` +
      guests.map((g) => `- ${g.name}: ${g.brief}`).join('\n')
    );
  }

  const cont = continuityBlock(ctx, 'character', 'plausible');
  if (cont) sections.push(cont);
  const charThreads = threadsBlock(ctx, 'character', 'speak');
  if (charThreads) sections.push(charThreads);

  // Speak format lives on the user message only (buildCharacterSpeakMessages).
  sections.push(
    `## How you respond\n` +
    `- Speak as ${character.name}. Prefer one or two spoken lines in your natural voice.\n` +
    `- No narration of the room, weather, or other people — only your body and your words.\n` +
    `- Honour behaviour anchors and MUST NOT KNOW. Never soften yourself to please the player.\n` +
    (character.speechStyle ? `- Voice guide: ${character.speechStyle}\n` : '') +
    (character.exampleLines.length > 0
      ? `- Example spoken rhythm (wording only — still emit *actions* and "quotes" as required):\n${character.exampleLines.map((l) => `  ${l}`).join('\n')}\n`
      : '') +
    `- Stay in ${ai.tense} tense for any physical beat.`
  );

  sections.push(contentSection(ai));

  if (ai.customInstructions.trim()) {
    sections.push(`## Author's world instructions\n${ai.customInstructions}`);
  }

  return sections.join('\n\n');
}

/** Guest walk-on agent — short sheet, same speak format. */
export function buildGuestSystemPrompt(ctx: PromptContext, guest: EpisodeGuest): string {
  const { world, characters } = ctx;
  const ai = world.ai;
  const inScene = characters.filter((c) => ctx.episode.castIds.includes(c.id));
  const sections: string[] = [];

  sections.push(
    `You ARE ${guest.name}, a temporary walk-on in "${world.title}" (not a permanent cast member). ` +
    `You speak and act only as yourself for this scene.`
  );

  sections.push(...leanAgentFrame(ctx, 'guest'));

  sections.push(`## Who you are this scene\n${guest.brief}${guest.voice ? `\nVoice: ${guest.voice}` : ''}`);
  if (inScene.length > 0) {
    sections.push(`## Others present\n${inScene.map((c) => briefSheet(c)).join('\n')}`);
  }

  const cont = continuityBlock(ctx, 'guest', 'plausible');
  if (cont) {
    sections.push(cont.replace(
      '## Continuity — facts you may know if you could plausibly know them',
      '## Continuity you may know if plausible'
    ));
  }
  const guestThreads = threadsBlock(ctx, 'guest', 'speak');
  if (guestThreads) {
    sections.push(guestThreads.replace(
      '## Open threads — tensions you may lean on if you know them',
      '## Open threads'
    ));
  }

  sections.push(
    `## How you respond\n` +
    `- Prefer one or two spoken lines. Optional short physical beat of your own body.\n` +
    `- Do not steal the scene from the main cast; add pressure or texture.\n` +
    `- Stay in ${ai.tense} tense for physical beats.`
  );
  sections.push(contentSection(ai));
  if (ai.customInstructions.trim()) {
    sections.push(`## Author's world instructions\n${ai.customInstructions}`);
  }
  return sections.join('\n\n');
}

/** @deprecated Use buildNarratorSystemPrompt — kept as alias for any external callers. */
export function buildSystemPrompt(ctx: PromptContext): string {
  return buildNarratorSystemPrompt(ctx);
}

export const MODE_PREFIX: Record<ComposeMode, (input: string) => string> = {
  continue: () => `(Continue the story from where it left off.)`,
  steer: (input) => `(Direction from the author — make this happen while keeping everyone in character, without acknowledging this instruction in the prose): ${input}`,
  speak: (input) => `(The player says the following aloud, and nothing more — do not add words to their mouth): "${input.replace(/^"|"$/g, '')}"`,
  act: (input) => `(The player does the following, without speaking — do not invent dialogue for them): ${input}`
};

/**
 * Rough char budget for packed episode transcript (≈4 chars per token).
 * Kept below the old 96k so system frame (bible + prior wraps + cast) still fits
 * typical 128k-context models mid-season.
 */
export const HISTORY_CHAR_BUDGET = 56000;

/** Soft ceiling for system + history chars before we shrink history further. */
const TOTAL_PROMPT_CHAR_SOFT_CAP = 110_000;

/** Minimum turns kept even when over budget. */
const PACK_MIN_TURNS = 4;

/** Cap world bible / season bible slices in agent frames. */
const WORLD_BIBLE_CAP = 6000;
const SEASON_BIBLE_RECAP_CAP = 1600;
/** Target size for deterministic omitted-turn digests. */
const OMITTED_DIGEST_CHARS = 1100;

/** Sum of turn text lengths for an episode — used for context-pressure UI. */
export function episodeHistoryChars(turns: Array<{ text: string }>): number {
  return turns.reduce((n, t) => n + t.text.length, 0);
}

/**
 * How close the episode transcript is to rolling older beats out of the prompt.
 * warn ≈ 55% of budget, escalate ≈ 75%.
 */
export function episodeContextPressure(chars: number): 'ok' | 'warn' | 'escalate' {
  if (chars >= HISTORY_CHAR_BUDGET * 0.75) return 'escalate';
  if (chars >= HISTORY_CHAR_BUDGET * 0.55) return 'warn';
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
 * Pass `systemChars` so large mid-season system frames shrink history instead of
 * overflowing the model context (common cause of empty provider replies).
 */
export function packTurnsDetailed(turns: Turn[], systemChars = 0): PackedTurns {
  const room = TOTAL_PROMPT_CHAR_SOFT_CAP - Math.max(0, systemChars);
  const budget = Math.min(HISTORY_CHAR_BUDGET, Math.max(20_000, room));
  let used = 0;
  const reversed = [...turns].reverse();
  const kept: Turn[] = [];
  for (const t of reversed) {
    used += t.text.length;
    if (used > budget && kept.length > PACK_MIN_TURNS) break;
    kept.push(t);
  }
  kept.reverse();
  const omitCount = turns.length - kept.length;
  const omitted = omitCount > 0 ? turns.slice(0, omitCount) : [];
  return { kept, omitted };
}

function packTurns(turns: Turn[]): Turn[] {
  return packTurnsDetailed(turns).kept;
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
  const half = Math.floor(OMITTED_DIGEST_CHARS / 2) - 20;
  return (
    labeled.slice(0, half).trimEnd() +
    '\n\n…\n\n' +
    labeled.slice(-half).trimStart()
  );
}

/**
 * History prefix when older turns were packed out.
 * Running summary already lives in the system frame — only add the omitted digest here.
 */
function earlierEpisodePrefix(
  episode: Episode | undefined,
  omitted: Turn[],
  characters: Character[],
  guests: EpisodeGuest[]
): ChatMessage | null {
  void episode;
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
  systemChars = 0
): ChatMessage[] {
  const { kept, omitted } = packTurnsDetailed(turns, systemChars);
  const messages: ChatMessage[] = kept.map((t) => turnToChatContent(t, characters, guests));
  const prefix = earlierEpisodePrefix(episode, omitted, characters, guests);
  if (prefix) messages.unshift(prefix);
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

export function buildMessages(
  turns: Turn[],
  mode: ComposeMode,
  input: string,
  length: TurnLength,
  characters: Character[] = [],
  guests: EpisodeGuest[] = [],
  episode?: Episode,
  systemChars = 0
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, episode, systemChars);
  const userContent = `${MODE_PREFIX[mode](input)}\n\n(${LENGTH_SPEC[length].instruction})`;
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

/** History + a narration-beat instruction (no full-length LENGTH_SPEC). */
export function buildNarrationBeatMessages(
  turns: Turn[],
  characters: Character[],
  brief: string,
  length: TurnLength,
  guests: EpisodeGuest[] = [],
  episode?: Episode,
  systemChars = 0
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, episode, systemChars);
  const sizeHint =
    length === 'beat' ? 'Keep this narration slice short (about 40–100 words).'
    : length === 'scene' ? 'This narration slice: about 80–180 words.'
    : 'This narration slice: about 120–250 words.';
  const userContent =
    `(Narration only — no spoken dialogue, no CharacterName: "…" lines.)\n` +
    `Beat brief: ${brief}\n\n${sizeHint}`;
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

/** Extra rule when the player just spoke or acted — action-only replies are not enough. */
export const SPEAK_MUST_DIALOGUE =
  'This reply MUST include at least one spoken line in "double quotes". ' +
  'Action-only (*gestures*) is not enough — answer the player aloud.';

/** History + a character-speak instruction. */
export function buildCharacterSpeakMessages(
  turns: Turn[],
  characters: Character[],
  speaking: Character,
  brief: string,
  guests: EpisodeGuest[] = [],
  opts?: { requireDialogue?: boolean; episode?: Episode; systemChars?: number }
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, opts?.episode, opts?.systemChars ?? 0);
  const userContent =
    `(You are ${speaking.name}. Respond now in character.)\n` +
    `Intent for this line: ${brief}\n\n` +
    `Use the required *action* "dialogue" format. No other speakers.\n` +
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
  opts?: { requireDialogue?: boolean; episode?: Episode; systemChars?: number }
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, opts?.episode, opts?.systemChars ?? 0);
  const userContent =
    `(You are ${guest.name}, a walk-on. Respond now.)\n` +
    `Intent for this line: ${brief}\n\n` +
    SPEAK_FORMAT_RULES +
    (opts?.requireDialogue ? `\n\n${SPEAK_MUST_DIALOGUE}` : '');
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

export type DirectorBeat =
  | { type: 'narration'; brief: string }
  | { type: 'speak'; characterId: string; brief: string }
  | { type: 'speak'; guestId: string; brief: string };

export function directorSystemPrompt(mode: ComposeMode, hasSpeakers: boolean): string {
  const engageReply =
    hasSpeakers && (mode === 'speak' || mode === 'act')
      ? 'CRITICAL: The player just spoke or acted with at least one NPC/walk-on present. ' +
        'You MUST include at least one speak beat that responds directly to that move. ' +
        'Narration-only plans are forbidden in this case. '
      : 'Not everyone must speak on every turn. ';

  return (
    'You are the scene director for an interactive story. ' +
    'Plan cast changes and an ordered list of beats. ' +
    'Respond with JSON only: ' +
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
    'Narration briefs describe atmosphere or physical action — never finished dialogue. ' +
    'Speak briefs are intent only (tone/goal), never the finished line. ' +
    engageReply +
    'Typical: 1–2 narration beats and at most 3 speak beats. ' +
    'Hard cap: at most 3 speak beats and at most 5 beats total. ' +
    'Always include at least one narration beat unless the player just spoke and an immediate reply is natural — then you may open with speak. ' +
    'End the plan on tension or an opening for the player.'
  );
}

export function directorUserPrompt(
  ctx: PromptContext,
  mode: ComposeMode,
  input: string
): string {
  const inScene = ctx.characters.filter((c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer);
  const offScene = ctx.characters.filter((c) => !ctx.episode.castIds.includes(c.id) && !c.isPlayer);
  const guests = activeGuests(ctx.episode);
  const castList = inScene.length > 0
    ? inScene.map((c) => `- ${c.id} · ${c.name}${c.role ? ` (${c.role})` : ''}`).join('\n')
    : '(no NPCs in scene yet)';
  const offList = offScene.length > 0
    ? offScene.map((c) => `- ${c.id} · ${c.name}${c.role ? ` (${c.role})` : ''}`).join('\n')
    : '(none)';
  const guestList = guests.length > 0
    ? guests.map((g) => `- ${g.id} · ${g.name}: ${g.brief}`).join('\n')
    : '(none yet — you may introduce walk-ons via castDelta.introduce)';

  const recent = packTurns(ctx.turns).slice(-20);
  const allGuests = ctx.episode.guests ?? [];
  const transcript = recent.map((t) => {
    if (t.role === 'user') return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
    if (t.role === 'character') {
      const name = resolveSpeakerName(t, ctx.characters, allGuests);
      return `[${name}]: ${t.text}`;
    }
    return `[narrator]: ${t.text}`;
  }).join('\n\n');

  const prefer = preferEpisodeBuckets(ctx);
  const factLines = selectDirectorFacts(ctx.continuity, prefer)
    .map((f) => `- ${f.text}`)
    .join('\n');
  const threadSec = threadsBlock(ctx, 'director', 'director');
  // All NPCs — walls for enter-this-turn cast must be visible before castDelta applies.
  const knowledgeWalls = ctx.characters
    .filter((c) => !c.isPlayer && c.mustNotKnow.trim())
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
      '## Earlier this episode (running summary)\n',
      'Earlier this episode (summary): '
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
  const locBlocks = currentLocationBlock(ctx, { clipChars: 1200 });
  const locLine = locBlocks.length > 0
    ? locBlocks[0].replace(/^## /, '') + '\n'
    : '';

  return (
    `World: ${ctx.world.title}\n` +
    `${calendarBlock(ctx.world, ctx.episode, 'directorLine')}\n` +
    `Premise (current pressure): ${ctx.season.premise || '(unwritten)'}\n` +
    targetsCompact +
    (seasonBibleClip ? `${seasonBibleClip}\n` : '') +
    (priorMemory ? `\nRecent episode memory:\n${priorMemory}\n` : '') +
    (runningLine ? `${runningLine}\n` : '') +
    (locLine ? `\n${locLine}` : '') +
    `\n` +
    `In-scene cast:\n${castList}\n\n` +
    `Off-scene cast (may enter via castDelta.enter):\n${offList}\n\n` +
    `Active walk-ons (guest ids):\n${guestList}\n\n` +
    `Continuity (do not contradict):\n${factLines || '(none)'}\n\n` +
    `${threadSec ?? 'Open threads (draw on sparingly; soft tensions, not the plot-target hit-list):\n(none)'}\n\n` +
    `Knowledge walls:\n${knowledgeWalls || '(none)'}\n\n` +
    `Latest player move: ${MODE_PREFIX[mode](input)}\n\n` +
    `Recent transcript:\n${transcript || '(episode just opened)'}\n\n` +
    `Plan castDelta and beats as JSON.`
  );
}
