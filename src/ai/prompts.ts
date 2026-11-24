import { looksText } from '../looks';
import { intimateAllowed } from './portrait';
import { activeMechanics, inventoryLine } from '../mechanics';
import { BEAT_FORMAT_RULES, beatsToTagged, validBeats } from './beatProtocol';
import { splitSceneReply, type SceneSpeaker } from './sceneReply';
import type {
  CalendarEvent, Character, ComposeMode, ContinuityFact, Episode, EpisodeGuest, Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
import { playerGoalBlock } from '../bonds';
import { isGeneratedShapeTag, PLOT_TARGET_CAP, storyStanceOf, worldCalendar } from '../worldOps';
import type { ChatMessage } from './client';
import { inferContextWindowTokens } from './contextBudget';
import { deliveryPhrase, parseDeliveryTone } from './deliveryTone';
import { stancePlaybook } from './storyStance';
import { offscreenLines } from './offscreenLife';
import { currentsWriterSection, isCurrent } from './currents';
import { placesAround, placeWhereLine, resolveScenePlace } from '../places';


/** Shared anti-generic-prose rules for narrator and speak agents. */
export const ANTI_SLOP_PROSE =
  `## Against generic prose\n` +
  `- Prefer concrete verbs and one named physical tic over mood adverbs (softly, gently, knowingly).\n` +
  `- Avoid stock filler: "couldn't help but", "a shiver ran down", "eyes sparkled/gleamed", ` +
  `"voice like velvet/silk", "smirked knowingly", "heart raced", "the air was thick with", ` +
  `"breathed a sigh of relief", "let out a breath they didn't know they were holding".\n` +
  `- Do not name the feeling when the body can show it. One specific detail beats a mood summary.\n` +
  `- Each speaker keeps their own cadence — never a shared polite chatbot register.`;

/** What makes people in the scene sound like people instead of a helpful assistant. */
export const HUMAN_DIALOGUE =
  `## How people talk\n` +
  `- First, respond to what the player just said or did. The person it was aimed at reacts to it directly: they answer, refuse, push back, or dodge on purpose, but it is plainly a reply to that line.\n` +
  `- Talk like a real person in this exact situation, not like a narrator. No speeches, no explaining the theme, no summing up the mood, no poetic monologue.\n` +
  `- Most lines are short. Fragments, trailing off, interrupting, and restarting a sentence are normal. A long speech only when this person would really hold the floor.\n` +
  `- Contractions and the words this person would actually use — their age, work, background, and mood. Nobody explains their own feelings aloud ("I feel conflicted") unless that is who they are.\n` +
  `- Everyone wants something right now. Let it show in what they say and how, but they still deal with what is in front of them.\n` +
  `- Do not echo or paraphrase the player's words back, do not agree with or validate everything, and do not end every reply on a question.\n` +
  `- Not everyone is warm or helpful. Strangers are guarded, tired people are curt, people who dislike the player show it, and people keep grudges from earlier in the story.\n` +
  `- Subtext is fine, but the words still answer the moment. What someone leaves unsaid, and what their hands do meanwhile, carries the feeling.`;


export type PromptPack = 'normal' | 'tight';

/** Per-beat prompt targeting + overflow pack. */
export interface PromptBuildOpts {
  focusIds?: string[];
  focusGuestIds?: string[];
  pack?: PromptPack;
  totalCap?: number;
  skipOmittedDigest?: boolean;
  /** Narrator keeps a richer prefix; speak/guest stay lean. */
  agent?: 'narrator' | 'character' | 'guest';
  historyTailChars?: number;
  historyTailMaxTurns?: number;
  /** Player line, beat brief, names, and place — ranks unpinned memory inside the cap. */
  memoryQuery?: string;
}


function joinPlaceNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Cast who belong to a place, unless the who's-here line already names them all. */
function placeResidentsLine(l: Location, characters?: Character[]): string {
  const names = (l.residentIds ?? [])
    .map((id) => characters?.find((person) => person.id === id)?.name.trim())
    .filter((name): name is string => !!name);
  if (names.length === 0) return '';
  if (names.every((name) => l.inhabitants.toLowerCase().includes(name.toLowerCase()))) return '';
  return `Belongs to: ${joinPlaceNames(names)}`;
}

/**
 * The one place sheet the writer gets: everything on the Places sheet, clipped
 * so a long sheet cannot crowd out the scene.
 */
export function whereYouAreBlock(
  place: Location,
  all: Location[],
  opts: { characters?: Character[]; sceneNote?: string; placeNote?: string } = {}
): string {
  const where = placeWhereLine(place, all);
  const now = [place.currentState.trim(), (opts.sceneNote ?? '').trim()].filter(Boolean).join(' ');
  const rules = place.rules.map((r) => r.trim()).filter(Boolean);
  const lines = [
    `## Where you are\n### ${place.name.trim() || 'Unnamed place'}${where ? ` (in ${where})` : ''}`,
    opts.placeNote?.trim() && `Exactly where: ${clipText(opts.placeNote.trim(), 160)}`,
    place.summary.trim() && `What it is: ${clipText(place.summary.trim(), 420)}`,
    place.atmosphere.trim() && `Feel (sensory detail to lean on): ${clipText(place.atmosphere.trim(), 320)}`,
    now && `Right now: ${clipText(now, 220)}`,
    place.inhabitants.trim() && `Who's usually here: ${clipText(place.inhabitants.trim(), 220)}`,
    placeResidentsLine(place, opts.characters),
    rules.length > 0 && `Rules here (hold to them):\n${rules.slice(0, 5).map((r) => `- ${clipText(r, 160)}`).join('\n')}`,
    place.hidden?.trim() && `Hidden (you know it; reveal only when the story earns it, never as exposition): ${clipText(place.hidden.trim(), 360)}`,
    place.customInstructions.trim() && `Author's notes for this place: ${clipText(place.customInstructions.trim(), 300)}`
  ];
  return lines.filter(Boolean).join('\n');
}

/** Saved places the scene can go to, one line each, nearest in the tree first. */
export function otherPlacesBlock(current: Location | undefined, all: Location[], limit = 8): string {
  const others = placesAround(current, all, limit);
  if (others.length === 0) return '';
  const line = (p: Location) => {
    const where = placeWhereLine(p, all);
    const what = clipText(p.summary.trim().split(/(?<=[.!?])\s/)[0] ?? '', 110);
    return `- ${p.name.trim()}${where ? ` (in ${where})` : ''}${what ? `: ${what}` : ''}`;
  };
  return `## Other places in this world (the scene can move to one of these)\n${others.map(line).join('\n')}`;
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

function proseDensityLine(ai: World['ai']): string {
  return ai.proseDensity < 34 ? 'Restrained, concrete prose. Few adverbs, no ornament for its own sake.'
    : ai.proseDensity < 67 ? 'Balanced literary prose. Texture where it earns its place.'
    : 'Rich, atmospheric prose. Lean into imagery and interiority.';
}

function pacingLine(ai: World['ai']): string {
  return ai.pacing < 34 ? 'Slow-burn pacing: linger in moments, let tension accumulate.'
    : ai.pacing < 67 ? 'Measured pacing: moments develop naturally, no rushing to payoffs.'
    : 'Propulsive pacing: keep events moving, cut the connective tissue.';
}

/** Cap for continuity bullets in narrator / speak frames. */
const CONTINUITY_FACT_CAP = 16;
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
    beatCapImmediate: 6, beatCapDigest: 2,
    recapDigestChars: 280, recapImmediateChars: 1800, runningCap: 1400
  },
  guest: {
    beatCapImmediate: 6, beatCapDigest: 2,
    recapDigestChars: 280, recapImmediateChars: 1800, runningCap: 1400
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

const MEMORY_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'her', 'his', 'she', 'him', 'they', 'them', 'their',
  'into', 'about', 'what', 'when', 'where', 'who', 'how', 'its', 'our', 'did', 'does'
]);

function memoryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !MEMORY_STOP.has(w));
}

/** Join the player line, brief, names, and place into one ranking query. */
export function memoryFocusQuery(parts: Array<string | null | undefined>): string {
  return parts.map((p) => (p ?? '').trim()).filter(Boolean).join('\n');
}

/** Light aliases so a fact filed as "harbour" still matches "harbor". */
const LORE_ALIASES: Record<string, string[]> = {
  harbour: ['harbor'],
  harbor: ['harbour'],
  colour: ['color'],
  color: ['colour'],
  grey: ['gray'],
  gray: ['grey']
};

function expandLoreTokens(tokens: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (t.length < 3) continue;
    out.add(t);
    if (t.length > 4 && t.endsWith('s')) out.add(t.slice(0, -1));
    else if (t.length >= 4) out.add(`${t}s`);
    for (const alt of LORE_ALIASES[t] ?? []) out.add(alt);
  }
  return out;
}

function loreKeys(item: { text: string; keys?: string[] }): string[] {
  const explicit = (item.keys ?? [])
    .map((k) => k.toLowerCase().trim())
    .filter((k) => k.length >= 2);
  const derived = memoryTokens(item.text).filter((w) => w.length >= 5);
  return [...new Set([...explicit, ...derived])];
}

function loreScore(item: { text: string; keys?: string[] }, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let n = 0;
  const seen = new Set<string>();
  for (const key of loreKeys(item)) {
    const forms = expandLoreTokens([key]);
    for (const form of forms) {
      if (!queryTokens.has(form) || seen.has(key)) continue;
      seen.add(key);
      n += key.length >= 5 || (item.keys ?? []).some((k) => k.toLowerCase().trim() === key) ? 2 : 1;
      break;
    }
  }
  return n;
}

function keysRelated(a: string, b: string): boolean {
  if (a.length < 5 || b.length < 5) return false;
  if (a === b) return true;
  return expandLoreTokens([a]).has(b);
}

function rankUnpinned<T extends { id: string; createdAt: number; text: string; keys?: string[] }>(
  items: T[],
  bucketOf: (t: T) => string,
  cap: number,
  preferBuckets: string[],
  query: string
): T[] {
  const tokens = expandLoreTokens(memoryTokens(query));
  if (tokens.size === 0) return pickAcrossBuckets(items, bucketOf, cap, preferBuckets);
  const scored = items.map((item) => ({ item, score: loreScore(item, tokens) }));
  scored.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  const hot: T[] = [];
  const rest: T[] = [];
  for (const row of scored) {
    if (row.score > 0) hot.push(row.item);
    else rest.push(row.item);
  }
  const picked = hot.slice(0, cap);
  if (picked.length >= cap) return picked;
  const seen = new Set(picked.map((item) => item.id));
  const pickedKeys = picked.flatMap((item) => loreKeys(item));
  const related: T[] = [];
  for (const item of rest) {
    if (picked.length + related.length >= cap) break;
    if (seen.has(item.id)) continue;
    const hit = loreKeys(item).some((key) => pickedKeys.some((pk) => keysRelated(key, pk)));
    if (!hit) continue;
    related.push(item);
    seen.add(item.id);
  }
  const soFar = [...picked, ...related];
  if (soFar.length >= cap) return soFar;
  const fill = pickAcrossBuckets(
    rest.filter((item) => !seen.has(item.id)),
    bucketOf,
    cap - soFar.length,
    preferBuckets
  );
  return [...soFar, ...fill];
}

/** Pinned facts fill the cap first, then relevance, then bucket-balanced rest. */
export function selectFactsPinnedFirst(
  continuity: ContinuityFact[],
  preferBuckets: string[] = [],
  cap: number,
  query = ''
): ContinuityFact[] {
  const pinned = continuity
    .filter((f) => f.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cap);
  const pinnedIds = new Set(pinned.map((f) => f.id));
  const restCap = Math.max(0, cap - pinned.length);
  const rest = restCap > 0
    ? rankUnpinned(
      continuity.filter((f) => !pinnedIds.has(f.id)),
      factBucket,
      restCap,
      preferBuckets,
      query
    )
    : [];
  if (!query.trim()) return [...pinned, ...rest].sort((a, b) => b.createdAt - a.createdAt);
  return [...pinned, ...rest];
}

/** Same fact selection the director prompt uses. Pinned facts fill the cap first. */
export function selectDirectorFacts(
  continuity: ContinuityFact[],
  preferBuckets: string[] = [],
  query = ''
): ContinuityFact[] {
  return selectFactsPinnedFirst(continuity, preferBuckets, DIRECTOR_FACT_CAP, query);
}

/** Pinned open threads fill the cap first, then relevance, then bucket-balanced rest. */
export function selectThreadsPinnedFirst(
  threads: OpenThread[],
  preferBuckets: string[] = [],
  cap: number,
  query = ''
): OpenThread[] {
  const open = threads.filter((t) => t.status === 'open');
  const pinned = open
    .filter((t) => t.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cap);
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const restCap = Math.max(0, cap - pinned.length);
  const rest = restCap > 0
    ? rankUnpinned(
      open.filter((t) => !pinnedIds.has(t.id)),
      threadBucket,
      restCap,
      preferBuckets,
      query
    )
    : [];
  if (!query.trim()) return [...pinned, ...rest].sort((a, b) => b.createdAt - a.createdAt);
  return [...pinned, ...rest];
}

/** Same thread selection the director prompt uses. Pinned threads fill the cap first. */
export function selectDirectorThreads(
  threads: OpenThread[],
  preferBuckets: string[] = [],
  query = ''
): OpenThread[] {
  return selectThreadsPinnedFirst(threads, preferBuckets, DIRECTOR_THREAD_CAP, query);
}

/** Absolute day that counts as "now" in the active episode scene. */
export function episodeSceneDay(episode: Episode, cal: ReturnType<typeof worldCalendar>): number {
  if (episode.storyDayEnd && episode.storyDayEnd > 0) return episode.storyDayEnd;
  if (episode.storyDay && episode.storyDay > 0) return episode.storyDay;
  return cal.currentDay;
}


function cappedThreadLines(
  threads: OpenThread[],
  preferBuckets: string[] = [],
  cap = THREAD_CAP,
  query = ''
): string[] {
  return selectThreadsPinnedFirst(threads, preferBuckets, cap, query)
    .map((t) => `- ${t.text} (${t.openedLabel})`);
}

function cappedContinuityLines(
  continuity: ContinuityFact[],
  preferBuckets: string[] = [],
  cap = CONTINUITY_FACT_CAP,
  query = ''
): string[] {
  return selectFactsPinnedFirst(continuity, preferBuckets, cap, query)
    .map((f) => `- ${f.text}`);
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
    `## Already true in this room (established earlier in this chapter)\n` +
    `Stay consistent with these. Do not re-introduce them as if new, and do not quietly ` +
    `undo one without showing it change:\n` +
    details.map((d) => `- ${d}`).join('\n')
  );
}

function runningSummaryFor(episode: Episode, cap: number): string | null {
  const running = episode.runningSummary?.trim();
  if (!running) return null;
  return (
    `## Earlier in this chapter (running summary)\n` +
    `Glue only — what just happened after early turns dropped. Continuity facts and the room ledger outrank this if they conflict.\n` +
    clipText(running, cap)
  );
}


function continuityBlock(
  ctx: PromptContext,
  agent: Exclude<PromptAgent, 'director'>,
  tone: 'hard' | 'plausible',
  cap = FACT_CAPS[agent].facts,
  query = ''
): string | null {
  const prefer = preferEpisodeBuckets(ctx);
  const lines = cappedContinuityLines(ctx.continuity, prefer, cap, query);
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
  capOverride?: number,
  query = ''
): string | null {
  const prefer = preferEpisodeBuckets(ctx);
  const cap = capOverride ?? FACT_CAPS[agent].threads;
  const lines = agent === 'director'
    ? selectThreadsPinnedFirst(ctx.threads, prefer, cap, query).map((t) => `- ${t.text}`)
    : cappedThreadLines(ctx.threads, prefer, cap, query);
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
function situationPremise(ctx: PromptContext, opts?: { includeSeasonMeta?: boolean }): string {
  const { season } = ctx;
  const live = season.premise || 'unwritten; discover it in play.';
  if (opts?.includeSeasonMeta) {
    return (
      `## Opening\n${season.title ? `${season.title}. ` : ''}` +
      `What's live: ${live}` +
      `${season.timeGap ? ` It opens ${season.timeGap.toLowerCase()} after what came before.` : ''}`
    );
  }
  return `## Opening\nWhat's live: ${live}`;
}

function currentLocationBlock(ctx: PromptContext): string[] {
  const current = resolveScenePlace(ctx.episode, ctx.locations);
  const out: string[] = [];
  if (current) {
    out.push(whereYouAreBlock(current, ctx.locations, {
      characters: ctx.characters,
      sceneNote: ctx.episode.atmosphereNote,
      placeNote: ctx.episode.placeNote
    }));
  } else if (ctx.episode.location.trim()) {
    out.push(`## Where you are\n${clipText(ctx.episode.location.trim(), 200)}`);
  }
  const others = otherPlacesBlock(current, ctx.locations);
  if (others) out.push(others);
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
    const meanwhile = immediate ? offscreenLines(ep.wrap?.offscreen) : '';
    const title = ep.title ? ` — ${ep.title}` : '';
    const body = clipText(recap, immediate ? immediateCap : opts.recapDigestChars);
    const heading = immediate
      ? `### Chapter ${ep.number}${title} (the one before)`
      : `### Chapter ${ep.number}${title}`;
    return (
      `${heading}\n${body}` +
      (beats ? `\n\nWhat still matters:\n${beats}` : '') +
      (guestFx ? `\n\nWalk-on effects that still matter:\n${guestFx}` : '') +
      (meanwhile
        ? `\n\nMeanwhile, elsewhere (the player did not see this; let it surface only through what people say and do):\n${meanwhile}`
        : '')
    );
  });
  return `## Earlier chapters\n${blocks.join('\n\n')}`;
}


function plotTargetsSection(episode: Episode, season: Season): string | null {
  // The author's targets. Currents are drafted by the AI and listed apart, below.
  const ep = (episode.plotTargets ?? [])
    .filter((t) => t.status === 'pending' && t.text.trim() && !isCurrent(t))
    .slice(0, PLOT_TARGET_CAP)
    .map((t) => `- ${clipText(t.text.trim(), 220)}`);
  const sea = (season.plotTargets ?? [])
    .filter((t) => t.status === 'pending' && t.text.trim() && !isCurrent(t))
    .slice(0, PLOT_TARGET_CAP)
    .map((t) => `- ${clipText(t.text.trim(), 220)}`);
  const currents = currentsWriterSection(episode.plotTargets);
  if (ep.length === 0 && sea.length === 0) return currents;
  const parts: string[] = [
    '## Plot targets — work toward these when natural; do not force every target in one turn; prefer story-driven progress over checklist completion' +
      (currents ? '. These are the author\'s and outrank anything merely in motion' : '')
  ];
  if (ep.length > 0) parts.push(`Episode:\n${ep.join('\n')}`);
  if (sea.length > 0) parts.push(`Season arc:\n${sea.join('\n')}`);
  if (currents) parts.push(currents);
  return parts.join('\n');
}


function contentSection(ai: World['ai']): string {
  return (
    `## Content\n${ai.mature
      ? 'This is a private adult world. Mature themes, violence, and explicit content are permitted where the story calls for them; write them with craft, not gratuitously.'
      : 'Keep content at a general-audience level. Imply rather than depict.'}${ai.contentNotes ? `\nWorld-specific boundaries: ${ai.contentNotes}` : ''}`
  );
}

export const MODE_PREFIX: Record<ComposeMode, (input: string) => string> = {
  continue: () => `(Continue the story from where it left off.)`,
  steer: (input) =>
    `(Author direction — this is the plot of this turn. Make every concrete event, outcome, entrance, exit, and spoken line happen as written. ` +
    `Personality, anchors, goals, knowledge walls, stance, and standing custom instructions yield. ` +
    `Do not soften, refuse, or swap in a different outcome. Do not mention this instruction in the prose. ` +
    `The world's content setting still applies): ${input}`,
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
    if (!/["“”*]/.test(body)) {
      return (
        `(The player's move${delivery} — treat what is aimed at someone as said aloud, the rest as action. ` +
        `Do not add to it, and do not invent dialogue for them): ${body}`
      );
    }
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

/** Verbatim tail shipped on each Write. Narrator and speaker share it. */
export const HISTORY_TAIL_CHAR_BUDGET = 16_000;
export const HISTORY_TAIL_MAX_TURNS = 16;
/** Same recent prose as the narrator, so a spoken line cannot miss the beat just written. */
export const SPEAK_HISTORY_TAIL_CHAR_BUDGET = HISTORY_TAIL_CHAR_BUDGET;
export const SPEAK_HISTORY_TAIL_MAX_TURNS = HISTORY_TAIL_MAX_TURNS;

export type HistoryTailAgent = 'narrator' | 'speak' | 'director';

export interface HistoryTail {
  charBudget: number;
  maxTurns: number;
}

/**
 * Verbatim tail by model window. Narrator and speaker share it, so the person
 * who talks has seen the prose that was just written. Unknown / 32k models
 * keep the conservative floor. An author window override replaces the guess.
 */
export function chooseHistoryTail(
  model: string,
  agent: HistoryTailAgent,
  windowTokens?: number | null
): HistoryTail {
  const window = windowTokens != null && windowTokens >= 2048
    ? windowTokens
    : inferContextWindowTokens(model);
  const large = window >= 128_000;
  const mid = window >= 64_000;
  if (agent === 'director') {
    if (large) return { charBudget: 16_000, maxTurns: 12 };
    if (mid) return { charBudget: 12_000, maxTurns: 10 };
    return { charBudget: 10_000, maxTurns: DIRECTOR_TRANSCRIPT_TURNS };
  }
  if (large) return { charBudget: 32_000, maxTurns: 32 };
  if (mid) return { charBudget: 24_000, maxTurns: 24 };
  return { charBudget: HISTORY_TAIL_CHAR_BUDGET, maxTurns: HISTORY_TAIL_MAX_TURNS };
}

/** Overflow retry keeps the latest exchange and drops the older chapter. */
export const OVERFLOW_HISTORY_TAIL: HistoryTail = { charBudget: 4_000, maxTurns: 4 };

export function historyTailFor(
  model: string,
  agent: HistoryTailAgent,
  pack?: PromptPack,
  windowTokens?: number | null
): HistoryTail {
  const tail = chooseHistoryTail(model, agent, windowTokens);
  if (pack !== 'tight') return tail;
  return {
    charBudget: Math.min(tail.charBudget, OVERFLOW_HISTORY_TAIL.charBudget),
    maxTurns: Math.min(tail.maxTurns, OVERFLOW_HISTORY_TAIL.maxTurns)
  };
}

/** Turns the narrator tail will drop — used to decide when to file a running summary. */
export function omittedTurnsForNarratorTail(
  turns: Turn[],
  model: string,
  windowTokens?: number | null
): Turn[] {
  const tail = chooseHistoryTail(model, 'narrator', windowTokens);
  return packTurnsDetailed(turns, 0, TOTAL_PROMPT_CHAR_SOFT_CAP, {
    charBudget: tail.charBudget,
    maxTurns: tail.maxTurns
  }).omitted;
}

/** Soft ceiling for system + history chars when no model budget is passed. */
export const TOTAL_PROMPT_CHAR_SOFT_CAP = 110_000;

/** Minimum turns kept even when over budget. */
const PACK_MIN_TURNS = 4;

/**
 * Omitted chapter text sent whole when it fits. Longer chapters are sampled
 * in even slices so the middle is not one 600-character window.
 */
const OMITTED_DIGEST_CHARS = 14_000;
const OMITTED_SLICE_COUNT = 7;

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

/** A "Write as" turn is that NPC's line, already said — not the player. */
function injectedNpcHistory(t: Turn, characters: Character[]): string | null {
  if (t.role !== 'user' || !t.asCharacterId) return null;
  const name = characters.find((c) => c.id === t.asCharacterId)?.name?.trim() || 'Someone';
  const { body } = parseDeliveryTone(t.text);
  return `[${name}]\n${body}`;
}

function shortPlayerHistory(t: Turn, characters: Character[] = []): string {
  const injected = injectedNpcHistory(t, characters);
  if (injected) return injected;
  const mode = t.mode ?? 'steer';
  const { body } = parseDeliveryTone(t.text);
  if (mode === 'speak') {
    const spoken = body.replace(/^"|"$/g, '');
    return `[player speak]: "${spoken}"`;
  }
  if (mode === 'continue') return '[player continue]';
  return `[player ${mode}]: ${body}`;
}

function latestUserTurnId(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].id;
  }
  return null;
}

/** Older prose turns, shown to the scene writer in the same @tag form it writes. */
function taggedFromProse(text: string, characters: Character[], guests: EpisodeGuest[]): string {
  const speakers: SceneSpeaker[] = [
    ...characters.filter((c) => !c.isPlayer && c.name.trim()).map((c) => ({
      id: c.id,
      name: c.name.trim(),
      kind: 'cast' as const,
      ...(c.aliases?.length ? { aliases: c.aliases } : {})
    })),
    ...guests.filter((g) => g.name.trim()).map((g) => ({ id: g.id, name: g.name.trim(), kind: 'guest' as const }))
  ];
  const pieces = splitSceneReply(text, speakers);
  if (!pieces.some((piece) => piece.role === 'character')) return `@narration\n${text.trim()}`;
  return beatsToTagged(pieces.map((piece) => ({
    role: piece.role,
    text: piece.text,
    ...(piece.speakerId ? { speakerId: piece.speakerId, name: speakers.find((s) => s.id === piece.speakerId)?.name } : {})
  })));
}

function turnToChatContent(
  t: Turn,
  characters: Character[],
  guests: EpisodeGuest[] = [],
  fullPlayerPrefix = false,
  voice: HistoryVoice = { kind: 'narrator' }
): { role: 'user' | 'assistant'; content: string } {
  if (t.role === 'user') {
    const injected = injectedNpcHistory(t, characters);
    if (injected) {
      const mine = voice.kind === 'speaker' && t.asCharacterId === voice.speakerId;
      return { role: mine ? 'assistant' : 'user', content: injected };
    }
    return {
      role: 'user',
      content: t.mode
        ? (fullPlayerPrefix ? MODE_PREFIX[t.mode](t.text) : shortPlayerHistory(t, characters))
        : t.text
    };
  }
  if (t.role === 'character') {
    const name = resolveSpeakerName(t, characters, guests);
    const id = t.guestId ?? t.characterId ?? '';
    if (voice.kind === 'narrator') return { role: 'user', content: `@${name}\n${t.text}` };
    const mine = voice.kind === 'speaker' && id === voice.speakerId;
    // Only this speaker's own lines are assistant. Everyone else is context.
    return { role: mine ? 'assistant' : 'user', content: `[${name}]\n${t.text}` };
  }
  if (voice.kind === 'narrator') {
    const beats = validBeats(t);
    return { role: 'assistant', content: beats ? beatsToTagged(beats) : taggedFromProse(t.text, characters, guests) };
  }
  return { role: 'user', content: `[Narrator]\n${t.text}` };
}

function labelTurnCompact(
  t: Turn,
  characters: Character[],
  guests: EpisodeGuest[] = []
): string {
  if (t.role === 'user') {
    const injected = injectedNpcHistory(t, characters);
    if (injected) {
      const name = characters.find((c) => c.id === t.asCharacterId)?.name?.trim() || 'Someone';
      const { body } = parseDeliveryTone(t.text);
      return `[${name}]: ${body}`;
    }
    return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
  }
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
  totalCap = TOTAL_PROMPT_CHAR_SOFT_CAP,
  tail?: { charBudget?: number; maxTurns?: number }
): PackedTurns {
  const tailChars = tail?.charBudget ?? HISTORY_TAIL_CHAR_BUDGET;
  const tailTurns = tail?.maxTurns ?? HISTORY_TAIL_MAX_TURNS;
  const room = totalCap - Math.max(0, systemChars);
  const budget = Math.min(tailChars, Math.max(0, room));
  const minKeep = room <= 0 ? 1 : PACK_MIN_TURNS;
  let used = 0;
  const reversed = [...turns].reverse();
  const keptRev: Turn[] = [];
  for (const t of reversed) {
    used += t.text.length;
    if (used > budget && keptRev.length >= minKeep) break;
    keptRev.push(t);
  }
  keptRev.reverse();
  const kept = keptRev.length > tailTurns
    ? keptRev.slice(-tailTurns)
    : keptRev;
  const omitCount = turns.length - kept.length;
  const omitted = omitCount > 0 ? turns.slice(0, omitCount) : [];
  return { kept, omitted };
}

/**
 * Deterministic digest of turns dropped by packing.
 * A chapter that fits is sent whole. A longer one is sampled in even slices
 * from the open through the middle to the cutover.
 */
export function compressOmittedTurns(
  omitted: Turn[],
  characters: Character[],
  guests: EpisodeGuest[] = []
): string {
  if (omitted.length === 0) return '';
  const labeled = omitted.map((t) => labelTurnCompact(t, characters, guests)).join('\n\n');
  if (labeled.length <= OMITTED_DIGEST_CHARS) return labeled;
  const slice = Math.max(240, Math.floor(OMITTED_DIGEST_CHARS / OMITTED_SLICE_COUNT) - 16);
  const parts: string[] = [];
  for (let i = 0; i < OMITTED_SLICE_COUNT; i++) {
    const start = Math.floor((labeled.length - slice) * (i / (OMITTED_SLICE_COUNT - 1)));
    const bit = labeled.slice(Math.max(0, start), Math.max(0, start) + slice).trim();
    if (bit) parts.push(bit);
  }
  return parts.join('\n\n…\n\n');
}

/** Turns whose text begins after `markChars` of transcript. Empty when the mark is current. */
export function turnsSinceCharMark<T extends { text: string }>(turns: T[], markChars: number): T[] {
  if (markChars <= 0) return turns;
  let used = 0;
  for (let i = 0; i < turns.length; i++) {
    if (used >= markChars) return turns.slice(i);
    used += turns[i].text.length;
  }
  return [];
}

/**
 * Concrete lines that fell off the verbatim tail.
 * A running summary does not replace them — the summary can flatten a beat the next line still needs.
 */
function earlierEpisodePrefix(
  episode: Episode | undefined,
  omitted: Turn[],
  characters: Character[],
  guests: EpisodeGuest[]
): ChatMessage | null {
  const digest = compressOmittedTurns(omitted, characters, guests);
  if (!digest) return null;
  const note = episode?.runningSummary?.trim()
    ? '(Concrete lines from earlier in this chapter. The running summary may have flattened these. Recent turns follow.)'
    : '(Earlier in this chapter — compressed; recent turns follow.)';
  return {
    role: 'user',
    content: `${note}\n\nCompressed earlier beats:\n${digest}`
  };
}

type HistoryVoice =
  | { kind: 'narrator' }
  | { kind: 'speaker'; speakerId: string };

function historyMessages(
  turns: Turn[],
  characters: Character[],
  guests: EpisodeGuest[] = [],
  episode?: Episode,
  systemChars = 0,
  pack?: Pick<PromptBuildOpts, 'totalCap' | 'skipOmittedDigest' | 'historyTailChars' | 'historyTailMaxTurns'>,
  voice: HistoryVoice = { kind: 'narrator' }
): ChatMessage[] {
  const { kept, omitted } = packTurnsDetailed(
    turns, systemChars, pack?.totalCap ?? TOTAL_PROMPT_CHAR_SOFT_CAP,
    { charBudget: pack?.historyTailChars, maxTurns: pack?.historyTailMaxTurns }
  );
  const latestUser = latestUserTurnId(turns);
  const messages: ChatMessage[] = kept.map((t) =>
    turnToChatContent(t, characters, guests, t.role === 'user' && t.id === latestUser, voice)
  );
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

/** Context for the writer. Not an order to print the date on this turn. */
export function sceneDateContextLine(sceneDate: string): string {
  const date = sceneDate.trim();
  if (!date) return '';
  return `The scene is on ${date}. This is context for the writer, not an order to print the date on this turn.`;
}

/** One reply for the whole beat: narration and the lines of the people who may speak. */
const SCENE_REPLY_TOKENS: Record<TurnLength, number> = {
  beat: 900,
  scene: 1200,
  episode: 2000
};

export function sceneReplyTokens(length: TurnLength): number {
  return SCENE_REPLY_TOKENS[length];
}

export function sceneLengthHint(length: TurnLength): string {
  if (length === 'beat') return 'Short reply: about 40–100 words in all.';
  if (length === 'scene') return 'Reply length: about 60–180 words in all.';
  return 'Long reply: about 250–500 words in all.';
}

export interface SceneVoice {
  id: string;
  name: string;
  kind: 'cast' | 'guest';
  role?: string;
  voice?: string;
  want?: string;
  /** Live feeling. Empty and clear-words are omitted. */
  emotion?: string;
  /** Live physical or social condition. */
  condition?: string;
  /** Ties to other people in this room, already resolved to names. */
  ties?: string;
  example?: string;
  mustNotKnow?: string;
  anchor?: string;
  brief?: string;
  /** Moments they lived through that bear on this one, oldest first. */
  memories?: string[];
  /** How they look right now: overall, face, hair, body, clothes, wearing now. */
  looks?: string;
  /** Traits, flaws, fears, and habits, in a line. */
  personality?: string;
  /** The author's standing instructions for this person. */
  notes?: string;
}

/** The short tag a card offers: the first name when nobody else here shares it. */
function cardTags(voices: SceneVoice[]): Map<string, string> {
  const firsts = new Map<string, number>();
  for (const voice of voices) {
    const first = voice.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const voice of voices) {
    const first = voice.name.trim().split(/\s+/)[0] ?? '';
    if (first.length >= 2 && firsts.get(first.toLowerCase()) === 1 && !/^the$/i.test(first)) out.set(voice.id, first);
  }
  return out;
}

/** Full cards for the people who should answer, then the rest of a small room. */
const FULL_SCENE_CARDS = 6;

export interface SceneReplyInput {
  ctx: PromptContext;
  mode: ComposeMode;
  playerText: string;
  length: TurnLength;
  /** Everyone who gets a card. Answerers first when the caller ordered them. */
  speakers: SceneVoice[];
  /** Who should answer. Everyone else here may still speak. */
  answerers?: Array<{ name: string }>;
  /** Everyone physically here. */
  present: Array<{ name: string; role?: string }>;
  pack?: PromptPack;
  historyTailChars?: number;
  historyTailMaxTurns?: number;
  totalCap?: number;
  /** Write-as: narration of a move that already happened, with no new quoted speaker. */
  narrationOnly?: boolean;
  /** The person this line is said to, by name. */
  saidTo?: string;
  /** Re-roll of one existing line, or of a whole scene when the name is the narrator. */
  rewrite?: { speakerName: string; prior: string };
  /** The settled outcome of a risky player move. The reply must honour it. */
  checkDirective?: string;
  /** "Let time pass": the instruction for a turn the world takes on its own. */
  worldMove?: string;
}

/** A character's look for the story, intimate details only for an adult in an adult world. */
export function characterLooksLine(world: World, c: Character): string {
  return looksText(c, { adult: intimateAllowed(world, c), wearing: true });
}

function sceneSpeakerCard(voice: SceneVoice, tag?: string): string {
  const example = voice.example?.trim().replace(/^["“”]+|["“”]+$/g, '').trim();
  const lines = [
    tag && tag !== voice.name ? `### ${voice.name} (tag: @${tag})` : `### ${voice.name}`,
    voice.role && `Role: ${voice.role}`,
    voice.brief && `Who they are here: ${clipText(voice.brief, voice.kind === 'cast' ? 320 : 180)}`,
    voice.personality && `Personality: ${clipText(voice.personality, 300)}`,
    voice.looks && `Looks (keep consistent; mention only what the moment notices): ${clipText(voice.looks, 420)}`,
    voice.voice && `Voice: ${clipText(voice.voice, 240)}`,
    voice.want && `Wants: ${clipText(voice.want, 160)}`,
    voice.emotion && `Now: ${clipText(voice.emotion, 120)}`,
    voice.condition && `Condition: ${clipText(voice.condition, 120)}`,
    voice.ties && `With the people here: ${clipText(voice.ties, 720)}`,
    example && `Example line (rhythm only, do not reuse it): "${clipText(example, 160)}"`,
    voice.anchor && `Anchor: ${clipText(voice.anchor, 160)}`,
    voice.memories?.length
      ? `Remembers (let it colour what they do; do not recite it):\n${voice.memories.map((m) => `- ${clipText(m, 220)}`).join('\n')}`
      : '',
    voice.mustNotKnow && `Must not know or say: ${clipText(voice.mustNotKnow, 240)}`,
    voice.notes && `Author notes for this person: ${clipText(voice.notes, 300)}`
  ];
  return lines.filter(Boolean).join('\n');
}

function answerLine(names: string[], reacting = true): string {
  if (names.length === 0) {
    return 'Nobody is here to speak. Write the consequence in narration. No quoted dialogue.';
  }
  if (!reacting) {
    return [
      `${names.join(', ')} ${names.length === 1 ? 'carries' : 'carry'} this beat out loud, in their own voice.`,
      'Spoken lines lead; narration only frames them.',
      'Anyone else already here may cut in when the moment needs them.'
    ].join(' ');
  }
  const lead = names.length === 1
    ? `${names[0]} responds directly to the player's line, out loud, in their own voice.`
    : names.length === 2
      ? `${names[0]} and ${names[1]} respond directly to the player's line, out loud, in their own voices.`
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]} respond directly to the player's line, out loud, in their own voices.`;
  const first = names[0];
  return [
    lead,
    `Lead with ${first}'s spoken response in their @ beat. Narration only for what the moment needs: a gesture, a sound, what changes. Keep narration to a third of the reply or less. Stop when it is the player's turn.`,
    'Anyone else already here may cut in when the moment needs them.'
  ].join(' ');
}

/** The last instruction: who should answer, how long, then the player's line. */
export function sceneTurnCue(opts: {
  mode: ComposeMode;
  playerText: string;
  length: TurnLength;
  speakers: Array<{ name: string }>;
  answerers?: Array<{ name: string }>;
  narrationOnly?: boolean;
  saidTo?: string;
  rewrite?: { speakerName: string; prior: string };
  checkDirective?: string;
  worldMove?: string;
}): string {
  const names = (opts.answerers ?? opts.speakers).map((s) => s.name.trim()).filter(Boolean);
  const saidTo = opts.saidTo?.trim() ?? '';
  const who = opts.rewrite
    ? opts.narrationOnly
      ? 'Nobody new speaks. Write narration only. No quoted dialogue.'
      : opts.rewrite.speakerName === 'the narrator'
        ? 'Rewrite this as one continuous scene. Anyone already here may speak or act when the moment needs them. Do not write the player\'s next line, and do not bring in anyone who is not here.'
        : `Stay with ${opts.rewrite.speakerName}. Do not hand the line to anyone else.`
    : opts.narrationOnly
      ? 'Nobody new speaks. Write narration only. No quoted dialogue.'
      : answerLine(names, !(opts.mode === 'continue' && !opts.playerText.trim()));
  const said = !opts.narrationOnly && saidTo ? `This is said to ${saidTo}.` : '';
  const move = opts.rewrite
    ? ''
    : opts.narrationOnly && opts.playerText.trim()
    ? `${[
        'This already happened, as them, not as the player.',
        saidTo ? `It is said to ${saidTo}.` : '',
        saidTo
          ? `Describe it. Do not quote a new speaker, do not write ${saidTo}'s reply, and do not hand the line to anyone else.`
          : 'Describe it. Do not quote a new speaker and do not hand the line to anyone else.'
      ].filter(Boolean).join(' ')}\n${opts.playerText.trim()}`
    : opts.mode === 'continue' && !opts.playerText.trim()
      ? opts.worldMove?.trim() || 'No new player line. Continue the scene from the last beat. Do not recap. Do not wait for the player.'
      : MODE_PREFIX[opts.mode](opts.playerText);
  const rewrite = !opts.rewrite
    ? ''
    : opts.rewrite.speakerName === 'the narrator'
      ? `Rewrite the previous scene in fresh wording. Keep the same events and who spoke. Do not copy it.\nPrevious scene:\n${opts.rewrite.prior.trim()}`
      : `Rewrite only ${opts.rewrite.speakerName}'s previous line with fresh wording and the same job. Do not copy it.\nPrevious line:\n${opts.rewrite.prior.trim()}`;
  const outcome = opts.checkDirective?.trim() ?? '';
  return [said, who, sceneLengthHint(opts.length), rewrite, move, outcome].filter(Boolean).join('\n\n');
}

/**
 * Standing rules, who is here, keyword memory, the recent transcript,
 * and this turn's instruction last.
 */
export function buildSceneReply(opts: SceneReplyInput): { system: string; messages: ChatMessage[] } {
  const { ctx } = opts;
  const ai = ctx.world.ai;
  const tight = opts.pack === 'tight';
  const query = memoryFocusQuery([
    opts.playerText,
    opts.speakers.map((s) => s.name).join(' '),
    opts.present.map((p) => p.name).join(' '),
    ctx.episode.location
  ]);
  const sections: string[] = [];
  const rules = ai.narratorRules.filter((r) => r.trim());
  sections.push(
    [
      `You run the scene in "${ctx.world.title}". The player has just spoken or acted; the people here react to it, in ${ai.pov} person, ${ai.tense} tense.`,
      'The people here talk. Their spoken lines carry the scene; narration only frames them.',
      BEAT_FORMAT_RULES,
      'Never write the player\'s dialogue, decisions, or inner thoughts. Do not repeat their line.',
      'Do not recap the transcript. Do not bring in anyone who is not already here.',
      proseDensityLine(ai),
      pacingLine(ai),
      rules.length > 0 ? rules.map((r) => `- ${r}`).join('\n') : ''
    ].filter(Boolean).join('\n')
  );
  sections.push(stancePlaybook(storyStanceOf(ctx.world)));
  sections.push(ANTI_SLOP_PROSE);
  if (!opts.narrationOnly) sections.push(HUMAN_DIALOGUE);
  sections.push(contentSection(ai));
  if (ai.customInstructions.trim() && !isGeneratedShapeTag(ai.customInstructions.trim())) {
    sections.push(`## Author's instructions (follow verbatim)\n${ai.customInstructions.trim()}`);
  }
  sections.push(situationPremise(ctx));
  const prior = formatPriorEpisodesSection(ctx, {
    beatCapImmediate: tight ? 2 : 3,
    beatCapDigest: 1,
    recapDigestChars: 160,
    recapImmediateChars: tight ? 400 : 700
  });
  if (prior) sections.push(prior);
  const targets = plotTargetsSection(ctx.episode, ctx.season);
  if (targets) sections.push(targets);
  const threads = threadsBlock(ctx, 'narrator', 'narrator', tight ? 4 : 8, query);
  if (threads) sections.push(threads);
  const ledger = sceneLedgerSection(ctx.episode, tight ? 4 : 8);
  if (ledger) sections.push(ledger);
  const running = runningSummaryFor(ctx.episode, tight ? 700 : PRIOR_CAPS.narrator.runningCap);
  if (running) sections.push(running);
  const answererNames = new Set((opts.answerers ?? []).map((a) => a.name.trim().toLowerCase()));
  const ordered = [...opts.speakers].sort((a, b) => {
    const ar = answererNames.has(a.name.trim().toLowerCase()) ? 0 : 1;
    const br = answererNames.has(b.name.trim().toLowerCase()) ? 0 : 1;
    return ar - br;
  });
  const player = ctx.characters.find((c) => c.isPlayer);
  const playerName = player?.name.trim() ?? '';
  const playerKey = playerName.toLowerCase();
  const cardVoices = ordered.slice(0, FULL_SCENE_CARDS).map((voice) => {
    if (voice.looks || voice.kind !== 'cast') return voice;
    const c = ctx.characters.find((x) => x.id === voice.id);
    const looks = c ? characterLooksLine(ctx.world, c) : '';
    return looks ? { ...voice, looks } : voice;
  });
  const tags = cardTags(cardVoices);
  const cards = cardVoices.map((voice) => sceneSpeakerCard(voice, tags.get(voice.id))).filter(Boolean);
  const listed = new Set(cardVoices.map((s) => s.name.trim().toLowerCase()));
  const also: Array<{ name: string; role?: string }> = [];
  const seen = new Set<string>();
  const pushAlso = (name: string, role?: string) => {
    const key = name.trim().toLowerCase();
    if (!key || key === playerKey || listed.has(key) || seen.has(key)) return;
    seen.add(key);
    also.push({ name: name.trim(), role });
  };
  for (const voice of ordered.slice(FULL_SCENE_CARDS)) pushAlso(voice.name, voice.role ?? voice.brief);
  for (const person of opts.present) pushAlso(person.name, person.role);
  const alsoShown = also
    .map((p) => p.role?.trim() ? `${p.name} (${p.role.trim()})` : p.name)
    .join(', ');
  const inviteOthers = !opts.narrationOnly && (!opts.rewrite || opts.rewrite.speakerName === 'the narrator');
  const playerLooks = player ? characterLooksLine(ctx.world, player) : '';
  const playerLine = [
    playerName ? `The player is ${playerName}.` : 'The player is here.',
    playerLooks ? `How ${playerName || 'the player'} looks (keep consistent): ${clipText(playerLooks, 420)}` : ''
  ].filter(Boolean).join('\n');
  const goalBlock = playerGoalBlock(player?.goals);
  const carried = activeMechanics(ctx.world) ? inventoryLine(player?.inventory) : '';
  const carriesLine = carried
    ? `${playerName || 'The player'} carries: ${carried}. They have nothing else unless the story gives it to them.`
    : '';
  const here = [
    '## Here',
    playerLine,
    goalBlock,
    carriesLine,
    cards.length > 0 ? cards.join('\n\n') : 'Nobody has a speaking part on this turn.',
    alsoShown
      ? inviteOthers
        ? `Also here, and they may speak if the moment needs them: ${alsoShown}.`
        : `Also here: ${alsoShown}.`
      : ''
  ].filter(Boolean).join('\n\n');
  sections.push(here);
  const facts = continuityBlock(ctx, 'narrator', 'hard', tight ? 6 : 12, query);
  if (facts) sections.push(facts);
  sections.push(...currentLocationBlock(ctx));

  const system = sections.join('\n\n');
  // The cue below carries this turn's move. Leaving it in the history too sends it twice.
  const lastTurn = ctx.turns[ctx.turns.length - 1];
  const cueCarriesMove = !opts.rewrite && !!opts.playerText.trim() && lastTurn?.role === 'user';
  const history = historyMessages(
    cueCarriesMove ? ctx.turns.slice(0, -1) : ctx.turns,
    ctx.characters,
    ctx.episode.guests ?? [],
    ctx.episode,
    system.length,
    {
      totalCap: opts.totalCap,
      historyTailChars: opts.historyTailChars,
      historyTailMaxTurns: opts.historyTailMaxTurns
    }
  );
  const cue = sceneTurnCue(opts);
  return { system, messages: mergeMessages([...history, { role: 'user', content: cue }]) };
}
