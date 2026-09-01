import { db, guardStorage, recordTombstones, uid } from '../db';
import { emptyCalendarEvent, evaluateCalendarEvents } from '../calendarEvents';
import { logAppError } from '../errors';
import { resolveModel, useSettings } from '../store/settings';
import { GAP_DAYS, GAP_LABELS } from '../ui/theme';
import type {
  CalendarEvent, CalendarEventKind, CalendarEventPromptPolicy, CalendarEventScale,
  Character, CharacterState, ComposeMode, Episode, EpisodeGuest, EpisodeWrap, EpisodeWrapBeat, Location, ModelRef,
  OpenThread, PlotTarget, Relationship, Season, SeasonWrap, SeasonWrapPlotArc, SeasonWrapRelationshipUpdate,
  Turn, TurnLength, TurnRole, World, WrapBeat, WrapCharacterOutcome
} from '../types';
import {
  CALENDAR_EVENT_CAP, defaultVisibilityForKind, isPlayerAgencyMode, worldCalendarEventPrefs
} from '../types';
import { normalizeRelationships } from '../relationships';
import {
  buildEpisodePlotTargets, buildNextSeasonPlotTargets, calendarPatch, emptyCharacter, emptyLocation,
  formatEpisodeDateRange, formatStoryDate, nextEpisode, pendingPlotTargets, worldCalendar
} from '../worldOps';
import { AIError, streamChat, isContextOverflowError, type ChatMessage, type StreamRequest } from './client';
import { promptCharBudget } from './contextBudget';
import { applyDeliveryTone, parseDeliveryTone } from './deliveryTone';
import { hasSpokenDialogue, normalizeSpeakText } from './dialogueFormat';
import {
  activeGuests,
  buildCharacterSpeakMessages,
  buildCharacterSystemPrompt,
  buildGuestSpeakMessages,
  buildGuestSystemPrompt,
  buildNarrationBeatMessages,
  buildNarratorSystemPrompt,
  characterSpeakTokens,
  compressOmittedTurns,
  directorSystemPrompt,
  directorUserPrompt,
  episodeContextPressure,
  episodeHistoryChars,
  focusFromBeat,
  HISTORY_CHAR_BUDGET,
  injectedSpeakBriefForCharacter,
  injectedSpeakBriefForGuest,
  packTurnsDetailed,
  resolveSpeakerName,
  type DirectorBeat,
  type PromptBuildOpts,
  narrationBeatTokens,
  planCapsForLength
} from './prompts';
import { rankReplySpeakers, speakerCandidates, type RankedSpeaker } from './roomDynamics';
import {
  isNearDuplicate,
  knowledgeFactLine,
  knowledgeStillNovel,
  LIVE_CANON_FACT_CAP,
  LIVE_CANON_THREAD_CAP,
  liveCanonHasWork,
  novelLines,
  normalizeLiveCanonExtract,
  selectStaleFactTexts,
  WRAP_NEW_FACT_CAP,
  WRAP_NEW_THREAD_CAP
} from './liveCanon';
import {
  clipMeanwhile,
  gapDays,
  matchLocationForPatch,
  meanwhileFact,
  mergeLocationPatch,
  nextAtmosphereNote,
  normalizePlacePatch,
  normalizePlacePatches,
  type PlacePatch
} from './worldMemory';

// ---------- Model resolution ----------

function requireModel(ref: ModelRef | null, label: string) {
  const resolved = resolveModel(ref);
  if (!resolved) {
    throw new AIError(`No ${label} model configured. Add a provider and pick a model in Settings.`);
  }
  return resolved;
}

export function proseModelFor(world: World | null) {
  const s = useSettings.getState();
  return requireModel(world?.proseModel ?? s.proseModel, 'writing');
}

export function utilityModelFor(world: World | null) {
  const s = useSettings.getState();
  // Fall back to the prose model when no utility model is set.
  return requireModel(world?.utilityModel ?? s.utilityModel ?? world?.proseModel ?? s.proseModel, 'utility');
}

// ---------- Prose generation ----------

const SPEAK_CONTINUE_NUDGE =
  'Your previous reply was cut off mid-line. Continue from exactly where you stopped — ' +
  'finish the unfinished *action* or "dialogue" only. Do not restart, repeat, or add new points. ' +
  'Keep it brief. Same *action* / "speech" format.';

const NARRATION_CONTINUE_NUDGE =
  'Your previous narration was cut off mid-sentence. Continue from exactly where you stopped — ' +
  'do not restart or repeat completed words. Stay in narrator voice; no character dialogue.';

const SPEAK_DIALOGUE_NUDGE =
  'Your reply had no spoken dialogue. Answer the player aloud with one short line in "double quotes". ' +
  'You may keep a brief *action*, but speech is required — do not expand into a monologue.';

/**
 * Stream a character/guest speak beat; if the provider stops for length, make one
 * continuation call and stitch before normalizing. When requireDialogue, retry once
 * if the cleaned text has no quoted speech.
 */
async function streamSpeakComplete(opts: {
  provider: StreamRequest['provider'];
  model: string;
  system: string;
  messages: ChatMessage[];
  length: TurnLength;
  signal?: AbortSignal;
  requireDialogue?: boolean;
  onProgress: (label: string) => void;
  onAccumulated: (text: string) => void;
}): Promise<string> {
  const maxTokens = characterSpeakTokens(opts.length);
  // Continuation only finishes a cut-off line — smaller budget so it cannot balloon.
  const continueTokens = Math.min(160, Math.max(80, Math.floor(maxTokens / 2)));
  let acc = '';
  const first = await streamChat({
    provider: opts.provider,
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    maxTokens,
    signal: opts.signal,
    onDelta: (d) => {
      acc += d;
      opts.onAccumulated(acc);
    }
  });
  if (first.truncated && acc.trim()) {
    opts.onProgress('finishing line…');
    await streamChat({
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      messages: [
        ...opts.messages,
        { role: 'assistant', content: acc },
        { role: 'user', content: SPEAK_CONTINUE_NUDGE }
      ],
      maxTokens: continueTokens,
      signal: opts.signal,
      onDelta: (d) => {
        acc += d;
        opts.onAccumulated(acc);
      }
    });
  }
  let cleaned = normalizeSpeakText(acc);
  if (opts.requireDialogue && cleaned && !hasSpokenDialogue(cleaned)) {
    opts.onProgress('adding dialogue…');
    acc = '';
    await streamChat({
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      messages: [
        ...opts.messages,
        { role: 'assistant', content: cleaned },
        { role: 'user', content: SPEAK_DIALOGUE_NUDGE }
      ],
      maxTokens: continueTokens,
      signal: opts.signal,
      onDelta: (d) => {
        acc += d;
        opts.onAccumulated(cleaned + (cleaned && acc ? ' ' : '') + acc);
      }
    });
    const retried = normalizeSpeakText(acc);
    if (retried && hasSpokenDialogue(retried)) cleaned = retried;
    else if (!hasSpokenDialogue(cleaned)) cleaned = '';
  }
  return cleaned;
}

/** Stream a narration beat; one continuation if truncated mid-sentence. */
async function streamNarrationComplete(opts: {
  provider: StreamRequest['provider'];
  model: string;
  system: string;
  messages: ChatMessage[];
  length: TurnLength;
  signal?: AbortSignal;
  onProgress: (label: string) => void;
  onAccumulated: (text: string) => void;
}): Promise<string> {
  const maxTokens = narrationBeatTokens(opts.length);
  let acc = '';
  const first = await streamChat({
    provider: opts.provider,
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    maxTokens,
    signal: opts.signal,
    onDelta: (d) => {
      acc += d;
      opts.onAccumulated(acc);
    }
  });
  if (first.truncated && acc.trim()) {
    opts.onProgress('finishing narration…');
    await streamChat({
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      messages: [
        ...opts.messages,
        { role: 'assistant', content: acc },
        { role: 'user', content: NARRATION_CONTINUE_NUDGE }
      ],
      maxTokens,
      signal: opts.signal,
      onDelta: (d) => {
        acc += d;
        opts.onAccumulated(acc);
      }
    });
  }
  return acc.trim();
}

/** Retry once with a tight lore pack — never shortens the scene itself. */
async function withOverflowRetry<T>(
  run: (pack: PromptBuildOpts) => Promise<T>,
  onNotice?: (message: string) => void
): Promise<T> {
  try {
    return await run({ pack: 'normal' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    if (!isContextOverflowError(e)) throw e;
    onNotice?.('Prompt was too large for this model — sent a tighter pack of lore, not a shorter scene.');
    return run({ pack: 'tight', skipOmittedDigest: true });
  }
}

async function loadContext(world: World, season: Season, episode: Episode) {
  const [characters, locations, continuity, threads, turns, seasonEpisodes, calendarEvents] = await Promise.all([
    db.characters.where('worldId').equals(world.id).toArray(),
    db.locations.where('worldId').equals(world.id).toArray(),
    db.continuity.where('seasonId').equals(season.id).toArray(),
    db.threads.where('seasonId').equals(season.id).filter((t) => t.status === 'open').toArray(),
    db.turns.where('episodeId').equals(episode.id).sortBy('createdAt'),
    db.episodes.where('seasonId').equals(season.id).sortBy('number'),
    db.calendarEvents.where('seasonId').equals(season.id).toArray()
  ]);
  const endedPriors = seasonEpisodes.filter(
    (e) => e.number < episode.number && e.status === 'ended' && !!e.wrap?.recap?.trim()
  );
  /** Last up to 3 wrapped episodes — newest last (immediate prior is `.at(-1)`). */
  const priorEpisodes = endedPriors.slice(-3);
  const priorEpisode = priorEpisodes.at(-1) ?? null;
  return {
    world, season, episode, characters, locations, continuity, threads, turns,
    calendarEvents, priorEpisode, priorEpisodes
  };
}

export interface StreamMeta {
  role: TurnRole;
  characterId?: string;
  guestId?: string;
}

export interface WriteOptions {
  world: World;
  season: Season;
  episode: Episode;
  mode: ComposeMode;
  input: string;
  length: TurnLength;
  signal?: AbortSignal;
  /** Prefer this Cast NPC for the speak reply (Speak/Act). */
  preferCharacterId?: string;
  /** Prefer this walk-on for the speak reply (Speak/Act). */
  preferGuestId?: string;
  /** Skip director planning and run these leftover beats (Continue plan). */
  resumeBeats?: DirectorBeat[];
  /** Partial text of the beat currently streaming. */
  onDelta: (partial: string, meta: StreamMeta) => void;
  /** High-level stage labels for the UI spinner (planning / narrating / Name speaking). */
  onProgress?: (label: string) => void;
  /** Soft recoverable notices (e.g. director fallback) — not hard errors. */
  onNotice?: (message: string) => void;
}

const MAX_SPEAK_BEATS = 3;
const MAX_TOTAL_BEATS = 5;
const UTILITY_TIMEOUT_MS = 45_000;

function labelTurn(t: Turn, characters: Character[], guests: EpisodeGuest[] = []): string {
  if (t.role === 'user') return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
  if (t.role === 'character') {
    const name = t.guestId
      ? (guests.find((g) => g.id === t.guestId)?.name ?? 'Walk-on')
      : (characters.find((c) => c.id === t.characterId)?.name ?? 'NPC');
    return `[${name}]: ${t.text}`;
  }
  return `[narrator]: ${t.text}`;
}

/** Resolve a director speak target by id or case-insensitive name. */
function resolveCastSpeakerId(
  raw: string,
  inScene: Character[]
): string | null {
  const key = raw.trim();
  if (!key) return null;
  if (inScene.some((c) => c.id === key)) return key;
  const byName = inScene.find((c) => c.name.toLowerCase() === key.toLowerCase());
  return byName?.id ?? null;
}

function resolveGuestSpeakerId(
  raw: string,
  guests: EpisodeGuest[],
  introduceNameToId: Map<string, string>
): string | null {
  const key = raw.trim();
  if (!key) return null;
  if (guests.some((g) => g.id === key)) return key;
  const fromIntroduce = introduceNameToId.get(key.toLowerCase());
  if (fromIntroduce && guests.some((g) => g.id === fromIntroduce)) return fromIntroduce;
  const byName = guests.find((g) => g.name.toLowerCase() === key.toLowerCase());
  return byName?.id ?? null;
}

/** Where a fallback speaker stands in the room's turn-taking, phrased for their brief. */
function situationHint(ranked: RankedSpeaker): string {
  if (ranked.address === 'vocative' || ranked.address === 'directed') {
    return 'the player is speaking straight at you — do not hand it off';
  }
  if (!Number.isFinite(ranked.turnsSince)) {
    return 'you have not spoken yet — break your silence with something only you would say';
  }
  if (ranked.turnsSince >= 3) {
    return 'you have been listening for a while — come in with what has been building';
  }
  if (ranked.turnsSince === 0) {
    return 'you just spoke — push further or give ground, do not restate';
  }
  return '';
}

/**
 * Choose who answers when the director gives no speak beat.
 * A player pin wins outright; otherwise whoever the move is aimed at, then whoever
 * has been quiet longest — so the first cast card does not answer every turn.
 */
function pickReplySpeaker(
  inScene: Character[],
  guests: EpisodeGuest[],
  playerText: string,
  prefer?: { characterId?: string; guestId?: string },
  turns?: Turn[]
): DirectorBeat | null {
  if (prefer?.characterId) {
    const pinned = inScene.find((c) => c.id === prefer.characterId);
    if (pinned) {
      return {
        type: 'speak',
        characterId: pinned.id,
        brief: injectedSpeakBriefForCharacter(pinned, 'the player picked you to answer')
      };
    }
  }
  if (prefer?.guestId) {
    const pinned = guests.find((g) => g.id === prefer.guestId);
    if (pinned) {
      return {
        type: 'speak',
        guestId: pinned.id,
        brief: injectedSpeakBriefForGuest(pinned, 'the player picked you to answer')
      };
    }
  }

  const candidates = speakerCandidates(inScene, guests);
  const [best] = rankReplySpeakers({ candidates, playerText, turns });
  if (!best) return null;
  const hint = situationHint(best);
  if (best.kind === 'cast') {
    const c = inScene.find((x) => x.id === best.id);
    if (c) return { type: 'speak', characterId: c.id, brief: injectedSpeakBriefForCharacter(c, hint) };
  } else {
    const g = guests.find((x) => x.id === best.id);
    if (g) return { type: 'speak', guestId: g.id, brief: injectedSpeakBriefForGuest(g, hint) };
  }
  return null;
}

/** Fallback narration when the director fails — names the room, the move, and who is on stage. */
export function directorFallbackNarrationBrief(opts: {
  mode: ComposeMode;
  playerText: string;
  location: string;
  inScene: Character[];
}): string {
  const move = opts.playerText.trim().replace(/\s+/g, ' ').slice(0, 160);
  const loc = opts.location.trim() || 'the current room';
  const onStage = opts.inScene.slice(0, 2).map((c) => {
    const want = c.state?.goal?.trim();
    const feel = c.state?.emotion?.trim();
    const bits = [feel, want ? `wants ${want}` : ''].filter(Boolean).join(', ');
    return bits ? `${c.name} (${bits})` : c.name;
  });
  const bodies = onStage.length > 0 ? ` On stage: ${onStage.join('; ')}.` : '';
  const moveBit = move
    ? ` Continue from the player's ${opts.mode}: "${move}".`
    : ' Continue the scene.';
  return (
    `${moveBit} Location: ${loc}.${bodies} ` +
    'Show named bodies and one sensory job; leave space for the player.'
  ).trim();
}

function ensurePlayerReplySpeak(
  beats: DirectorBeat[],
  mode: ComposeMode,
  playerText: string,
  inScene: Character[],
  guests: EpisodeGuest[],
  caps: { maxSpeak: number; maxTotal: number } = { maxSpeak: MAX_SPEAK_BEATS, maxTotal: MAX_TOTAL_BEATS },
  prefer?: { characterId?: string; guestId?: string },
  turns?: Turn[]
): DirectorBeat[] {
  const needsReply = isPlayerAgencyMode(mode) && (inScene.length > 0 || guests.length > 0);
  if (!needsReply) return beats;

  const isPinnedSpeak = (b: DirectorBeat): boolean => {
    if (b.type !== 'speak') return false;
    if (prefer?.characterId && 'characterId' in b && b.characterId === prefer.characterId) return true;
    if (prefer?.guestId && 'guestId' in b && b.guestId === prefer.guestId) return true;
    return false;
  };

  // Hard pin: when the player picked a speaker, only that NPC/walk-on may speak.
  if (prefer?.characterId || prefer?.guestId) {
    const narration = beats.filter((b) => b.type === 'narration');
    let pinned = beats.find(isPinnedSpeak) ?? null;
    if (!pinned) {
      pinned = pickReplySpeaker(inScene, guests, playerText, prefer, turns);
    }
    const next: DirectorBeat[] = [];
    if (pinned) next.push(pinned);
    for (const b of narration) {
      if (next.length >= caps.maxTotal) break;
      next.push(b);
    }
    if (!next.some((b) => b.type === 'speak') && pinned) {
      return [pinned, ...narration].slice(0, caps.maxTotal);
    }
    return next.length > 0 ? next.slice(0, caps.maxTotal) : beats.slice(0, caps.maxTotal);
  }

  if (beats.some((b) => b.type === 'speak')) {
    return beats.slice(0, caps.maxTotal);
  }
  const injected = pickReplySpeaker(inScene, guests, playerText, prefer, turns);
  if (!injected) return beats;
  return [injected, ...beats].slice(0, caps.maxTotal);
}

/** Normalize raw director JSON into executable beats (exported for tests). */
export function normalizeBeats(
  raw: { beats?: Array<{ type?: string; brief?: string; characterId?: string; guestId?: string }> },
  inScene: Character[],
  guests: EpisodeGuest[],
  /** Map introduce-name → guest id for newly created walk-ons */
  introduceNameToId: Map<string, string>,
  mode: ComposeMode,
  playerText: string,
  length: TurnLength = 'scene',
  prefer?: { characterId?: string; guestId?: string },
  /** transcript so far — drives addressee detection and turn-taking fairness */
  turns?: Turn[]
): DirectorBeat[] {
  const caps = planCapsForLength(length);
  const allowedGuests = new Set(guests.map((g) => g.id));
  const beats: DirectorBeat[] = [];
  let speakCount = 0;
  for (const b of raw.beats ?? []) {
    if (beats.length >= caps.maxTotal) break;
    const brief = (b.brief ?? '').trim();
    if (!brief) continue;
    if (b.type === 'speak') {
      if (speakCount >= caps.maxSpeak) continue;
      const guestRaw = (b.guestId ?? '').trim();
      const castRaw = (b.characterId ?? '').trim();
      if (guestRaw) {
        const byId = resolveGuestSpeakerId(guestRaw, guests, introduceNameToId);
        if (!byId || !allowedGuests.has(byId)) continue;
        beats.push({ type: 'speak', guestId: byId, brief });
        speakCount++;
      } else if (castRaw) {
        const castId = resolveCastSpeakerId(castRaw, inScene);
        if (!castId) continue;
        beats.push({ type: 'speak', characterId: castId, brief });
        speakCount++;
      }
    } else if (b.type === 'narration') {
      beats.push({ type: 'narration', brief });
    }
  }
  if (beats.length === 0) {
    beats.push({
      type: 'narration',
      brief: 'Continue the scene with atmosphere and physical action; leave space for the player.'
    });
  }
  return ensurePlayerReplySpeak(beats, mode, playerText, inScene, guests, caps, prefer, turns);
}

/** Race a utility call against a timeout; merges with an optional outer AbortSignal. */
function withTimeoutSignal(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  const timer = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  };
}

/** Resolve a cast NPC by id or case-insensitive name (never the player). */
function resolveNpcId(raw: string, characters: Character[]): string | null {
  const key = raw.trim();
  if (!key) return null;
  const npcs = characters.filter((c) => !c.isPlayer);
  if (npcs.some((c) => c.id === key)) return key;
  const byName = npcs.find((c) => c.name.toLowerCase() === key.toLowerCase());
  return byName?.id ?? null;
}

/** Apply director enter/leave to episode cast; ids or exact names may enter/leave. */
function applyCastDelta(
  castIds: string[],
  characters: Character[],
  delta?: { enter?: string[]; leave?: string[] },
  protectId?: string
): string[] {
  const npcIds = new Set(characters.filter((c) => !c.isPlayer).map((c) => c.id));
  const playerId = characters.find((c) => c.isPlayer)?.id;
  const enter = (delta?.enter ?? [])
    .map((raw) => resolveNpcId(raw, characters))
    .filter((id): id is string => !!id && npcIds.has(id));
  const leave = new Set(
    (delta?.leave ?? [])
      .map((raw) => resolveNpcId(raw, characters))
      .filter((id): id is string => !!id && npcIds.has(id) && id !== protectId)
  );
  const known = (id: string) => id === playerId || npcIds.has(id);
  const next = [...new Set([...castIds.filter(known), ...enter])].filter((id) => !leave.has(id));
  if (playerId && castIds.includes(playerId) && !next.includes(playerId)) next.unshift(playerId);
  if (protectId && npcIds.has(protectId) && !next.includes(protectId)) next.push(protectId);
  return next;
}

const MAX_INTRODUCE_GUESTS = 2;

interface IntroduceSpec {
  name?: string;
  brief?: string;
  voice?: string;
}

/** Merge new walk-ons into episode guests; returns updated episode fields + name→id map. */
function applyGuestDelta(
  episode: Episode,
  introduce: IntroduceSpec[] | undefined,
  leaveIds: string[] | undefined,
  protectGuestId?: string
): {
  guests: EpisodeGuest[];
  activeGuestIds: string[];
  nameToId: Map<string, string>;
} {
  const guests = [...(episode.guests ?? [])];
  let active = episode.activeGuestIds
    ? [...episode.activeGuestIds]
    : guests.map((g) => g.id);
  const nameToId = new Map<string, string>();
  for (const g of guests) nameToId.set(g.name.toLowerCase(), g.id);

  let introduced = 0;
  for (const spec of introduce ?? []) {
    if (introduced >= MAX_INTRODUCE_GUESTS) break;
    const name = (spec.name ?? '').trim();
    const brief = (spec.brief ?? '').trim();
    if (!name || !brief) continue;
    const key = name.toLowerCase();
    const existing = guests.find((g) => g.name.toLowerCase() === key);
    if (existing) {
      nameToId.set(key, existing.id);
      if (!active.includes(existing.id)) active.push(existing.id);
      introduced++;
      continue;
    }
    const guest: EpisodeGuest = {
      id: uid(),
      name,
      brief,
      ...(spec.voice?.trim() ? { voice: spec.voice.trim() } : {})
    };
    guests.push(guest);
    active.push(guest.id);
    nameToId.set(key, guest.id);
    introduced++;
  }

  // Resolve leave by guest id or name (director often emits names).
  const leaveResolved = new Set<string>();
  for (const raw of leaveIds ?? []) {
    const id = resolveGuestSpeakerId(raw, guests, nameToId);
    if (id && id !== protectGuestId) leaveResolved.add(id);
  }
  active = active.filter((id) => !leaveResolved.has(id));
  if (protectGuestId && guests.some((g) => g.id === protectGuestId) && !active.includes(protectGuestId)) {
    active.push(protectGuestId);
  }

  return { guests, activeGuestIds: active, nameToId };
}

/** Thrown when the user aborts mid-write; completed beats are already persisted. */
export class WriteAbortedError extends Error {
  readonly name = 'AbortError';
  constructor(
    public beatsCompleted: number,
    public remainingBeats: DirectorBeat[] = []
  ) {
    super('Aborted');
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  beatsCompleted: number,
  remainingBeats: DirectorBeat[] = []
): void {
  if (signal?.aborted) throw new WriteAbortedError(beatsCompleted, remainingBeats);
}

function asWriteAbort(
  e: unknown,
  beatsCompleted: number,
  remainingBeats: DirectorBeat[] = []
): never {
  if (e instanceof WriteAbortedError) throw e;
  if ((e as Error)?.name === 'AbortError') {
    throw new WriteAbortedError(beatsCompleted, remainingBeats);
  }
  throw e;
}

async function savePendingPlan(
  episodeId: string,
  remaining: DirectorBeat[],
  length: TurnLength
): Promise<void> {
  if (remaining.length === 0) {
    await db.episodes.update(episodeId, { pendingPlan: null, updatedAt: Date.now() }).catch(() => undefined);
    return;
  }
  await db.episodes.update(episodeId, {
    pendingPlan: { beats: remaining, length, createdAt: Date.now() },
    updatedAt: Date.now()
  }).catch(() => undefined);
}

async function clearPendingPlan(episodeId: string): Promise<void> {
  await db.episodes.update(episodeId, { pendingPlan: null, updatedAt: Date.now() }).catch(() => undefined);
}

/**
 * Core writing loop: persist the user turn (unless continue), plan beats with
 * the director, then stream narrator (narration-only) and character agents.
 * Each completed beat is persisted immediately. Returns the last turn id.
 */
export async function writeTurn(opts: WriteOptions): Promise<string> {
  const { provider, model } = proseModelFor(opts.world);
  const ctx = await loadContext(opts.world, opts.season, opts.episode);
  let castIds = [...opts.episode.castIds];
  let inScene = ctx.characters.filter((c) => castIds.includes(c.id) && !c.isPlayer);
  let guests = [...(ctx.episode.guests ?? [])];
  let activeGuestIds = ctx.episode.activeGuestIds
    ? [...ctx.episode.activeGuestIds]
    : guests.map((g) => g.id);
  let beatsCompleted = 0;
  let userTurnId: string | null = null;
  // Pre-delta scene — restored if we abort/fail with zero beats after director mutated cast.
  const sceneSnapshot = {
    castIds: [...opts.episode.castIds],
    guests: [...(opts.episode.guests ?? [])] as EpisodeGuest[],
    /** undefined means field was omitted (all guests active) */
    activeGuestIds: opts.episode.activeGuestIds
      ? [...opts.episode.activeGuestIds]
      : undefined as string[] | undefined
  };
  let sceneMutated = false;

  const rollbackSceneIfNeeded = async () => {
    if (!sceneMutated) return;
    await db.episodes.where('id').equals(opts.episode.id).modify((ep) => {
      ep.castIds = sceneSnapshot.castIds;
      ep.guests = sceneSnapshot.guests;
      if (sceneSnapshot.activeGuestIds === undefined) delete ep.activeGuestIds;
      else ep.activeGuestIds = sceneSnapshot.activeGuestIds;
      ep.updatedAt = Date.now();
    }).catch(() => undefined);
    sceneMutated = false;
  };

  if (opts.mode !== 'continue' && opts.input.trim()) {
    const { tone, body } = parseDeliveryTone(opts.input.trim());
    const normalized = (opts.mode === 'speak' || opts.mode === 'play') ? normalizeSpeakText(body) : body;
    const userText = isPlayerAgencyMode(opts.mode)
      ? applyDeliveryTone(normalized, tone)
      : opts.input.trim();
    const userTurn: Turn = {
      id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
      role: 'user', mode: opts.mode, text: userText, createdAt: Date.now()
    };
    await guardStorage(() => db.turns.add(userTurn));
    userTurnId = userTurn.id;
    ctx.turns.push(userTurn);
  }

  const progress = opts.onProgress ?? (() => {});

  const playerText = opts.input.trim();
  const requireDialogue = isPlayerAgencyMode(opts.mode);

  // Director plans cast/guest changes + ordered narration / speak beats (utility model).
  // Resume path skips planning and runs leftover beats from a prior Stop/error.
  let beats: DirectorBeat[];
  let enterIds: string[] = [];
  if (opts.resumeBeats && opts.resumeBeats.length > 0) {
    progress('continuing plan…');
    beats = opts.resumeBeats;
    await clearPendingPlan(opts.episode.id);
  } else {
    try {
      progress('planning…');
      const speakersPresent = inScene.length > 0 || activeGuests(ctx.episode).length > 0;
      const prefer = {
        characterId: opts.preferCharacterId,
        guestId: opts.preferGuestId
      };
      const directorCap = promptCharBudget(utilityModelFor(opts.world).model, 1400);
      const planDirector = (pack: PromptBuildOpts['pack'] = 'normal') => utilityJson<{
        castDelta?: { enter?: string[]; leave?: string[]; introduce?: IntroduceSpec[] };
        beats: Array<{ type?: string; brief?: string; characterId?: string; guestId?: string }>;
      }>(
        opts.world,
        directorSystemPrompt(opts.mode, speakersPresent, opts.length),
        directorUserPrompt(ctx, opts.mode, playerText, {
          preferCharacterId: opts.preferCharacterId,
          preferGuestId: opts.preferGuestId,
          pack,
          totalCap: directorCap
        }),
        1400,
        opts.signal
      );
      let plan: Awaited<ReturnType<typeof planDirector>>;
      try {
        plan = await planDirector('normal');
      } catch (first) {
        if ((first as Error).name === 'AbortError') asWriteAbort(first, beatsCompleted);
        if (isContextOverflowError(first)) {
          opts.onNotice?.('Prompt was too large for this model — sent a tighter pack of lore, not a shorter scene.');
          plan = await planDirector('tight');
        } else {
          logAppError(first, 'director plan (retrying)');
          try {
            plan = await planDirector('normal');
          } catch (second) {
            if ((second as Error).name === 'AbortError') asWriteAbort(second, beatsCompleted);
            if (isContextOverflowError(second)) {
              opts.onNotice?.('Prompt was too large for this model — sent a tighter pack of lore, not a shorter scene.');
              plan = await planDirector('tight');
            } else {
              throw second;
            }
          }
        }
      }
      const nextCast = applyCastDelta(
        castIds, ctx.characters, plan.castDelta, opts.preferCharacterId
      );
      const guestDelta = applyGuestDelta(
        { ...ctx.episode, castIds, guests, activeGuestIds },
        plan.castDelta?.introduce,
        plan.castDelta?.leave,
        opts.preferGuestId
      );
      guests = guestDelta.guests;
      activeGuestIds = guestDelta.activeGuestIds;

      const episodePatch: Partial<Episode> = { updatedAt: Date.now() };
      let changed = false;
      if (nextCast.join('\0') !== castIds.join('\0')) {
        castIds = nextCast;
        episodePatch.castIds = nextCast;
        changed = true;
      }
      const prevGuestKey = JSON.stringify({
        g: ctx.episode.guests ?? [],
        a: ctx.episode.activeGuestIds ?? (ctx.episode.guests ?? []).map((g) => g.id)
      });
      const nextGuestKey = JSON.stringify({ g: guests, a: activeGuestIds });
      if (prevGuestKey !== nextGuestKey) {
        episodePatch.guests = guests;
        episodePatch.activeGuestIds = activeGuestIds;
        changed = true;
      }
      if (changed) {
        await db.episodes.update(opts.episode.id, episodePatch);
        sceneMutated = true;
        ctx.episode = { ...ctx.episode, ...episodePatch, castIds, guests, activeGuestIds };
        inScene = ctx.characters.filter((c) => castIds.includes(c.id) && !c.isPlayer);
      }
      beats = normalizeBeats(
        plan, inScene, activeGuests(ctx.episode), guestDelta.nameToId, opts.mode, playerText,
        opts.length, prefer, ctx.turns
      );
      enterIds = (plan.castDelta?.enter ?? [])
        .map((raw) => resolveNpcId(raw, ctx.characters))
        .filter((id): id is string => !!id);
      await clearPendingPlan(opts.episode.id);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        await rollbackSceneIfNeeded();
        if (userTurnId) {
          await db.turns.delete(userTurnId).catch(() => undefined);
          ctx.turns = ctx.turns.filter((t) => t.id !== userTurnId);
        }
        asWriteAbort(e, 0);
      }
      logAppError(e, 'director plan (fallback)');
      opts.onNotice?.(
        'Director planning failed — using a simple beat so the scene can continue. ' +
        'Check your utility model if this keeps happening.'
      );
      const fallback: DirectorBeat[] = [{
        type: 'narration',
        brief: directorFallbackNarrationBrief({
          mode: opts.mode,
          playerText,
          location: ctx.episode.location,
          inScene
        })
      }];
      beats = ensurePlayerReplySpeak(
        fallback, opts.mode, playerText, inScene, activeGuests(ctx.episode),
        planCapsForLength(opts.length),
        { characterId: opts.preferCharacterId, guestId: opts.preferGuestId }
      );
    }
  }

  const sceneGuests = () => activeGuests(ctx.episode);
  const speakOpts = { requireDialogue, episode: ctx.episode };
  const remainingFrom = (completed: number) => beats.slice(completed);

  let lastId = '';
  let speakTurnsSaved = 0;
  try {
    for (const beat of beats) {
      throwIfAborted(opts.signal, beatsCompleted, remainingFrom(beatsCompleted));

      if (beat.type === 'narration') {
        const meta: StreamMeta = { role: 'narrator' };
        progress('narrating…');
        opts.onDelta('', meta);
        const narrCap = promptCharBudget(model, narrationBeatTokens(opts.length));
        const narrText = await withOverflowRetry(async (pack) => {
          const focus = focusFromBeat(beat, ctx.characters, sceneGuests(), enterIds);
          const narrSystem = buildNarratorSystemPrompt(ctx, {
            ...pack,
            focusIds: focus.characterIds,
            focusGuestIds: focus.guestIds
          });
          return streamNarrationComplete({
            provider, model,
            system: narrSystem,
            messages: buildNarrationBeatMessages(
              ctx.turns, ctx.characters, beat.brief, opts.length, sceneGuests(), ctx.episode,
              narrSystem.length,
              { totalCap: narrCap, skipOmittedDigest: pack.skipOmittedDigest || pack.pack === 'tight' }
            ),
            length: opts.length,
            signal: opts.signal,
            onProgress: progress,
            onAccumulated: (acc) => opts.onDelta(acc, meta)
          });
        }, opts.onNotice);
        if (!narrText) {
          opts.onDelta('', meta);
          continue;
        }
        const narratorTurn: Turn = {
          id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
          role: 'narrator', mode: null, text: narrText, createdAt: Date.now()
        };
        await guardStorage(() => db.turns.add(narratorTurn));
        ctx.turns.push(narratorTurn);
        lastId = narratorTurn.id;
        beatsCompleted++;
        opts.onDelta('', meta);
        continue;
      }

      if ('guestId' in beat && beat.guestId) {
        const guest = (ctx.episode.guests ?? []).find((g) => g.id === beat.guestId);
        if (!guest) continue;
        const meta: StreamMeta = { role: 'character', guestId: guest.id };
        progress(`${guest.name} speaking…`);
        opts.onDelta('', meta);
        const speakCap = promptCharBudget(model, characterSpeakTokens(opts.length));
        const cleaned = await withOverflowRetry(async (pack) => {
          const focus = focusFromBeat(beat, ctx.characters, sceneGuests(), enterIds);
          const guestSystem = buildGuestSystemPrompt(ctx, guest, {
            ...pack,
            focusIds: focus.characterIds,
            focusGuestIds: focus.guestIds
          });
          return streamSpeakComplete({
            provider, model,
            system: guestSystem,
            messages: buildGuestSpeakMessages(
              ctx.turns, ctx.characters, guest, beat.brief, sceneGuests(),
              {
                ...speakOpts,
                systemChars: guestSystem.length,
                length: opts.length,
                totalCap: speakCap,
                skipOmittedDigest: pack.skipOmittedDigest || pack.pack === 'tight'
              }
            ),
            length: opts.length,
            signal: opts.signal,
            requireDialogue,
            onProgress: progress,
            onAccumulated: (acc) => opts.onDelta(acc, meta)
          });
        }, opts.onNotice);
        if (!cleaned) {
          opts.onDelta('', meta);
          continue;
        }
        const guestTurn: Turn = {
          id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
          role: 'character', mode: null, guestId: guest.id,
          text: cleaned, createdAt: Date.now()
        };
        await guardStorage(() => db.turns.add(guestTurn));
        ctx.turns.push(guestTurn);
        lastId = guestTurn.id;
        beatsCompleted++;
        speakTurnsSaved++;
        opts.onDelta('', meta);
        continue;
      }

      const speaking = ctx.characters.find((c) => c.id === ('characterId' in beat ? beat.characterId : ''));
      if (!speaking || speaking.isPlayer) continue;

      const meta: StreamMeta = { role: 'character', characterId: speaking.id };
      progress(`${speaking.name} speaking…`);
      opts.onDelta('', meta);
      const speakCap = promptCharBudget(model, characterSpeakTokens(opts.length));
      const cleaned = await withOverflowRetry(async (pack) => {
        const focus = focusFromBeat(beat, ctx.characters, sceneGuests(), enterIds);
        const charSystem = buildCharacterSystemPrompt(ctx, speaking, {
          ...pack,
          focusIds: focus.characterIds,
          focusGuestIds: focus.guestIds
        });
        return streamSpeakComplete({
          provider, model,
          system: charSystem,
          messages: buildCharacterSpeakMessages(
            ctx.turns, ctx.characters, speaking, beat.brief, sceneGuests(),
            {
              ...speakOpts,
              systemChars: charSystem.length,
              length: opts.length,
              totalCap: speakCap,
              skipOmittedDigest: pack.skipOmittedDigest || pack.pack === 'tight'
            }
          ),
          length: opts.length,
          signal: opts.signal,
          requireDialogue,
          onProgress: progress,
          onAccumulated: (acc) => opts.onDelta(acc, meta)
        });
      }, opts.onNotice);
      if (!cleaned) {
        opts.onDelta('', meta);
        continue;
      }
      const characterTurn: Turn = {
        id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
        role: 'character', mode: null, characterId: speaking.id,
        text: cleaned, createdAt: Date.now()
      };
      await guardStorage(() => db.turns.add(characterTurn));
      ctx.turns.push(characterTurn);
      lastId = characterTurn.id;
      beatsCompleted++;
      speakTurnsSaved++;
      opts.onDelta('', meta);
    }
  } catch (e) {
    const remaining = remainingFrom(beatsCompleted);
    try {
      asWriteAbort(e, beatsCompleted, remaining);
    } catch (abortErr) {
      // Orphan player line with no reply — remove so the composer can restore cleanly.
      if (beatsCompleted === 0) {
        await rollbackSceneIfNeeded();
        if (userTurnId) {
          await db.turns.delete(userTurnId).catch(() => undefined);
          ctx.turns = ctx.turns.filter((t) => t.id !== userTurnId);
        }
        await clearPendingPlan(opts.episode.id);
      } else if (remaining.length > 0) {
        await savePendingPlan(opts.episode.id, remaining, opts.length);
      }
      if (abortErr instanceof WriteAbortedError) throw abortErr;
      // Non-abort: attach beatsCompleted so UI can keep partial replies.
      if (abortErr && typeof abortErr === 'object') {
        (abortErr as { beatsCompleted?: number }).beatsCompleted = beatsCompleted;
        (abortErr as { remainingBeats?: DirectorBeat[] }).remainingBeats = remaining;
      }
      throw abortErr;
    }
  }

  if (beatsCompleted === 0) {
    await rollbackSceneIfNeeded();
    if (userTurnId) {
      await db.turns.delete(userTurnId).catch(() => undefined);
      ctx.turns = ctx.turns.filter((t) => t.id !== userTurnId);
    }
    await clearPendingPlan(opts.episode.id);
    throw new AIError(
      'The model produced no usable narration or dialogue. Try again, or choose a shorter reply size.'
    );
  }

  // Speak/Act must land at least one spoken reply — narration-only is not enough.
  if (requireDialogue && speakTurnsSaved === 0) {
    await clearPendingPlan(opts.episode.id);
    const err = new AIError(
      'No character replied aloud. Try again, pin who should answer, or add cast to the scene.'
    ) as AIError & { beatsCompleted?: number };
    err.beatsCompleted = beatsCompleted;
    throw err;
  }

  await clearPendingPlan(opts.episode.id);

  // Summary + light cast-state refresh are best-effort after beats are saved —
  // abort here must not look like a zero-beat stop.
  try {
    await maybeRefreshRunningSummary(opts.world, ctx, opts.signal, progress, opts.onNotice);
    await maybeRefreshLiveSceneState(
      opts.world, ctx, beatsCompleted, opts.signal, progress, opts.onNotice
    );
    await maybeFileLiveCanon(
      opts.world, ctx, beatsCompleted, opts.signal, progress, opts.onNotice
    );
  } catch (e) {
    if ((e as Error).name === 'AbortError' || e instanceof WriteAbortedError) {
      if (beatsCompleted > 0) {
        await db.worlds.update(opts.world.id, { updatedAt: Date.now() });
        return lastId;
      }
      asWriteAbort(e, beatsCompleted);
    }
    throw e;
  }
  await db.worlds.update(opts.world.id, { updatedAt: Date.now() });
  return lastId;
}

/**
 * Re-roll a single narrator or character beat in place — siblings stay.
 */
export async function regenerateBeat(opts: {
  world: World;
  season: Season;
  episode: Episode;
  turn: Turn;
  length: TurnLength;
  signal?: AbortSignal;
  onDelta: (partial: string, meta: StreamMeta) => void;
  onProgress?: (label: string) => void;
}): Promise<void> {
  if (opts.turn.role !== 'narrator' && opts.turn.role !== 'character') {
    throw new AIError('Only narrator or character turns can be re-rolled.');
  }
  const { provider, model } = proseModelFor(opts.world);
  const ctx = await loadContext(opts.world, opts.season, opts.episode);
  const progress = opts.onProgress ?? (() => {});
  const sceneGuests = () => activeGuests(ctx.episode);
  // History for the model excludes the turn being replaced.
  const historyTurns = ctx.turns.filter((t) => t.id !== opts.turn.id);

  if (opts.turn.role === 'narrator') {
    const meta: StreamMeta = { role: 'narrator' };
    progress('re-rolling narration…');
    opts.onDelta('', meta);
    const brief =
      'Rewrite this narration beat with fresh wording and the same dramatic function. ' +
      'Do not jump ahead of the scene. Prior wording for reference (do not copy):\n' +
      opts.turn.text.slice(0, 900);
    const narrCap = promptCharBudget(model, narrationBeatTokens(opts.length));
    const narrText = await withOverflowRetry(async (pack) => {
      const narrSystem = buildNarratorSystemPrompt(ctx, pack);
      return streamNarrationComplete({
        provider, model,
        system: narrSystem,
        messages: buildNarrationBeatMessages(
          historyTurns, ctx.characters, brief, opts.length, sceneGuests(), ctx.episode,
          narrSystem.length,
          { totalCap: narrCap, skipOmittedDigest: pack.skipOmittedDigest || pack.pack === 'tight' }
        ),
        length: opts.length,
        signal: opts.signal,
        onProgress: progress,
        onAccumulated: (acc) => opts.onDelta(acc, meta)
      });
    });
    if (!narrText) throw new AIError('Re-roll produced no narration. Try again.');
    await guardStorage(() => db.turns.update(opts.turn.id, { text: narrText, updatedAt: Date.now() }));
    await clearEpisodeRunningSummary(opts.episode.id);
    opts.onDelta('', meta);
    return;
  }

  const guest = opts.turn.guestId
    ? (ctx.episode.guests ?? []).find((g) => g.id === opts.turn.guestId)
    : undefined;
  const speaking = opts.turn.characterId
    ? ctx.characters.find((c) => c.id === opts.turn.characterId)
    : undefined;
  if (!guest && (!speaking || speaking.isPlayer)) {
    throw new AIError('Could not find the speaker for this turn.');
  }

  const brief =
    'Deliver the same intent with fresh wording. Prior line for reference (do not copy):\n' +
    opts.turn.text.slice(0, 700);
  const meta: StreamMeta = guest
    ? { role: 'character', guestId: guest.id }
    : { role: 'character', characterId: speaking!.id };
  progress(`${(guest?.name ?? speaking!.name)} re-rolling…`);
  opts.onDelta('', meta);

  const speakCap = promptCharBudget(model, characterSpeakTokens(opts.length));
  const focusIds = speaking ? [speaking.id] : [];
  const focusGuestIds = guest ? [guest.id] : [];
  const cleaned = await withOverflowRetry(async (pack) => {
    if (guest) {
      const guestSystem = buildGuestSystemPrompt(ctx, guest, { ...pack, focusIds, focusGuestIds });
      return streamSpeakComplete({
        provider, model,
        system: guestSystem,
        messages: buildGuestSpeakMessages(
          historyTurns, ctx.characters, guest, brief, sceneGuests(),
          {
            episode: ctx.episode,
            systemChars: guestSystem.length,
            length: opts.length,
            totalCap: speakCap,
            skipOmittedDigest: pack.skipOmittedDigest || pack.pack === 'tight'
          }
        ),
        length: opts.length,
        signal: opts.signal,
        requireDialogue: true,
        onProgress: progress,
        onAccumulated: (acc) => opts.onDelta(acc, meta)
      });
    }
    const charSystem = buildCharacterSystemPrompt(ctx, speaking!, { ...pack, focusIds, focusGuestIds });
    return streamSpeakComplete({
      provider, model,
      system: charSystem,
      messages: buildCharacterSpeakMessages(
        historyTurns, ctx.characters, speaking!, brief, sceneGuests(),
        {
          episode: ctx.episode,
          systemChars: charSystem.length,
          length: opts.length,
          totalCap: speakCap,
          skipOmittedDigest: pack.skipOmittedDigest || pack.pack === 'tight'
        }
      ),
      length: opts.length,
      signal: opts.signal,
      requireDialogue: true,
      onProgress: progress,
      onAccumulated: (acc) => opts.onDelta(acc, meta)
    });
  });

  if (!cleaned) throw new AIError('Re-roll produced no dialogue. Try again.');
  await guardStorage(() => db.turns.update(opts.turn.id, { text: cleaned, updatedAt: Date.now() }));
  await clearEpisodeRunningSummary(opts.episode.id);
  opts.onDelta('', meta);
}

/**
 * When the transcript approaches the history budget, refresh a compressed
 * running summary so early beats survive packing.
 */
async function maybeRefreshRunningSummary(
  world: World,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  signal: AbortSignal | undefined,
  progress: (label: string) => void,
  onNotice?: (message: string) => void
): Promise<void> {
  const chars = episodeHistoryChars(ctx.turns);
  const pressure = episodeContextPressure(chars);
  // Warm early so the summary is ready before packing starts dropping turns.
  if (pressure === 'ok') return;

  const lastAt = ctx.episode.runningSummaryAtChars ?? 0;
  const growthNeeded = pressure === 'warm'
    ? HISTORY_CHAR_BUDGET * 0.12
    : HISTORY_CHAR_BUDGET * 0.08;
  if (ctx.episode.runningSummary && chars < lastAt + growthNeeded) return;

  const { omitted } = packTurnsDetailed(ctx.turns);
  // Summarize on warm/warn/escalate even if nothing is omitted yet —
  // packing will start soon and the summary should already be ready.
  const sourceTurns = omitted.length > 0
    ? omitted
    : ctx.turns.slice(0, Math.max(4, Math.floor(ctx.turns.length * 0.45)));
  if (sourceTurns.length < 3) return;

  const guests = ctx.episode.guests ?? [];
  const digest = compressOmittedTurns(sourceTurns, ctx.characters, guests);
  if (!digest.trim()) return;

  try {
    progress('remembering earlier beats…');
    const { provider, model } = utilityModelFor(world);
    const { text } = await streamChat({
      provider,
      model,
      system:
        'You compress interactive-fiction episode transcripts into a running summary. ' +
        'Write 140–260 words in past tense: what happened, who was present, emotional shifts, open tensions, and any dated/calendar beats that mattered. ' +
        'No dialogue quotes. No preamble — return only the summary.',
      messages: [{
        role: 'user',
        content:
          `World: ${world.title}. Episode ${ctx.episode.number}.\n` +
          (ctx.episode.runningSummary
            ? `Prior running summary:\n${ctx.episode.runningSummary}\n\n`
            : '') +
          `New material to fold in:\n${digest.slice(0, 14000)}`
      }],
      maxTokens: 600,
      signal
    });
    const summary = text.trim();
    if (!summary) return;
    await db.episodes.update(ctx.episode.id, {
      runningSummary: summary,
      runningSummaryAtChars: chars,
      updatedAt: Date.now()
    });
    ctx.episode = {
      ...ctx.episode,
      runningSummary: summary,
      runningSummaryAtChars: chars
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Non-fatal — prompts still have omitted digests and prior wrap.
    logAppError(e, 'running summary');
    onNotice?.('Couldn’t refresh mid-episode memory — older beats may thin out until the next successful turn.');
  }
}

/**
 * Token overlap for wrap matching — prefers shared content words over raw substring
 * false-positives on short fragments.
 */
export function textMatchScore(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  // Need at least two shared content words — single-token hits are too noisy for wrap matching.
  if (inter < 2) return 0;
  return inter / Math.min(A.size, B.size);
}

function matchByExactContainsOrTokens<T extends { id: string }>(
  items: T[],
  lines: string[],
  textOf: (item: T) => string
): T[] {
  const matched: T[] = [];
  const used = new Set<string>();
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (!key) continue;
    let hit = items.find((t) => !used.has(t.id) && textOf(t).trim().toLowerCase() === key);
    if (!hit) {
      hit = items.find((t) => {
        if (used.has(t.id)) return false;
        const tKey = textOf(t).trim().toLowerCase();
        // Avoid matching very short needles into long texts.
        if (key.length < 8 && tKey.length > key.length * 2) return false;
        return tKey.includes(key) || key.includes(tKey);
      });
    }
    if (!hit) {
      let best: T | undefined;
      let bestScore = 0.62;
      for (const t of items) {
        if (used.has(t.id)) continue;
        const score = textMatchScore(key, textOf(t));
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      hit = best;
    }
    if (hit) {
      used.add(hit.id);
      matched.push(hit);
    }
  }
  return matched;
}

/**
 * Light mid-episode patch of in-scene cast state plus the scene's physical ledger.
 * Throttled so it does not run every Write — full relationship updates stay on wrap.
 * Runs after any saved beat, not just spoken ones: narration is what establishes
 * weather, damage, and props in the first place.
 */
async function maybeRefreshLiveSceneState(
  world: World,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  turnsSaved: number,
  signal: AbortSignal | undefined,
  progress: (label: string) => void,
  onNotice?: (message: string) => void
): Promise<void> {
  if (turnsSaved <= 0) return;
  const inScene = ctx.characters.filter(
    (c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer
  );

  const chars = episodeHistoryChars(ctx.turns);
  const pressure = episodeContextPressure(chars);
  const lastAt = ctx.episode.liveStateAtChars ?? 0;
  const growthNeeded = pressure === 'ok' || pressure === 'warm'
    ? HISTORY_CHAR_BUDGET * 0.14
    : HISTORY_CHAR_BUDGET * 0.1;
  // First patch once the scene has some meat; then throttle by transcript growth.
  if (lastAt === 0 && ctx.turns.length < 4) return;
  if (lastAt > 0 && chars < lastAt + growthNeeded) return;

  const recent = ctx.turns.slice(-14);
  const guests = ctx.episode.guests ?? [];
  const digest = recent
    .map((t) => {
      if (t.role === 'user') return `[player]: ${t.text.slice(0, 280)}`;
      if (t.role === 'character') {
        const name = resolveSpeakerName(t, ctx.characters, guests);
        return `[${name}]: ${t.text.slice(0, 320)}`;
      }
      return `[narrator]: ${t.text.slice(0, 320)}`;
    })
    .join('\n\n');
  if (!digest.trim()) return;

  const castLines = inScene
    .map((c) => {
      const s = c.state;
      return (
        `- ${c.name}: goal="${s.goal || ''}"; emotion="${s.emotion || ''}"; ` +
        `location="${s.location || ''}"; condition="${s.condition || ''}"`
      );
    })
    .join('\n');

  const priorLedger = (ctx.episode.sceneLedger ?? []).map((d) => `- ${d}`).join('\n');

  try {
    progress('reading the room…');
    const result = await utilityJson<{
      updates?: Array<{
        name?: string;
        goal?: string;
        emotion?: string;
        location?: string;
        condition?: string;
      }>;
      scene?: string[];
    }>(
      world,
      'You track live state in an interactive story. ' +
        'Return JSON only: {"updates":[{"name":"<exact cast name>","goal":"...","emotion":"...","location":"...","condition":"..."}],' +
        '"scene":["<physical detail now true in this room>"]}. ' +
        'updates: only characters whose state clearly shifted in the recent beats. ' +
        'Omit unchanged fields. Use "none" for a field that no longer applies — a mood that ' +
        'has passed, a goal that was met or abandoned, an injury that healed. ' +
        'Keep each field under 120 characters. No relationships.\n' +
        'scene: 3–6 short phrases naming physical facts the prose has established and that later ' +
        'paragraphs must stay consistent with — weather and light, damage, objects in play, ' +
        'doors open or shut, what someone is holding or wearing. ' +
        'Rewrite the whole list each time: carry forward what still holds, drop what has stopped ' +
        'being true, add what the latest beats established. Concrete nouns, no plot summary, no feelings.',
      `World: ${world.title}. Episode ${ctx.episode.number}.\n` +
        `Place: ${ctx.episode.location || '(unnamed)'}\n` +
        `In-scene cast (current state):\n${castLines || '(nobody on stage)'}\n\n` +
        `Already established in this scene:\n${priorLedger || '(nothing yet)'}\n\n` +
        `Recent beats:\n${digest.slice(0, 10000)}\n\n` +
        `Return updates JSON.`,
      900,
      signal,
      25_000
    );

    const applied = inScene.length > 0
      ? await applyLiveCharacterStateUpdates(world.id, inScene, result.updates ?? [])
      : 0;
    const sceneLedger = capSceneLedger(result.scene);
    await db.episodes.update(ctx.episode.id, {
      liveStateAtChars: chars,
      ...(sceneLedger ? { sceneLedger } : {}),
      updatedAt: Date.now()
    });
    ctx.episode = {
      ...ctx.episode,
      liveStateAtChars: chars,
      ...(sceneLedger ? { sceneLedger } : {})
    };
    if (applied > 0) {
      // Refresh local character sheets for any follow-on work in this write.
      const refreshed = await db.characters.where('worldId').equals(world.id).toArray();
      ctx.characters = refreshed;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    logAppError(e, 'live scene state');
    onNotice?.('Couldn’t refresh live cast state — sheets will catch up at episode wrap.');
  }
}

/**
 * File hard facts / threads / place / knowledge while the episode is still open.
 * Same throttle as live scene state. Errors must not block a successful write.
 */
async function maybeFileLiveCanon(
  world: World,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  turnsSaved: number,
  signal: AbortSignal | undefined,
  progress: (label: string) => void,
  onNotice?: (message: string) => void
): Promise<void> {
  if (turnsSaved <= 0) return;
  const chars = episodeHistoryChars(ctx.turns);
  const pressure = episodeContextPressure(chars);
  const lastAt = ctx.episode.liveCanonAtChars ?? 0;
  const growthNeeded = pressure === 'ok' || pressure === 'warm'
    ? HISTORY_CHAR_BUDGET * 0.14
    : HISTORY_CHAR_BUDGET * 0.1;
  if (lastAt === 0 && ctx.turns.length < 4) return;
  if (lastAt > 0 && chars < lastAt + growthNeeded) return;

  const recent = ctx.turns.slice(-14);
  const guests = ctx.episode.guests ?? [];
  const digest = recent
    .map((t) => {
      if (t.role === 'user') return `[player]: ${t.text.slice(0, 280)}`;
      if (t.role === 'character') {
        const name = resolveSpeakerName(t, ctx.characters, guests);
        return `[${name}]: ${t.text.slice(0, 320)}`;
      }
      return `[narrator]: ${t.text.slice(0, 320)}`;
    })
    .join('\n\n');
  if (!digest.trim()) return;

  const inScene = ctx.characters.filter(
    (c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer
  );
  const inSceneNames = new Set(inScene.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
  const existingFactTexts = ctx.continuity.map((f) => f.text);
  const existingThreadTexts = ctx.threads.map((t) => t.text);
  const episodeFactCount = ctx.continuity.filter((f) => f.episodeId === ctx.episode.id).length;
  const knownBlock = existingFactTexts.slice(-24).map((t) => `- ${t}`).join('\n');
  const threadBlock = existingThreadTexts.slice(0, 16).map((t) => `- ${t}`).join('\n');
  const ledger = (ctx.episode.sceneLedger ?? []).map((d) => `- ${d}`).join('\n');
  const placeLine = ctx.episode.location || '(unnamed)';
  const loc = ctx.episode.locationId
    ? ctx.locations.find((l) => l.id === ctx.episode.locationId)
    : ctx.locations.find((l) => l.name.toLowerCase() === placeLine.trim().toLowerCase());

  try {
    progress('filing what happened…');
    const result = await utilityJson<{
      facts?: string[];
      threads?: string[];
      place?: { name?: string; currentState?: string; atmosphere?: string };
      knowledge?: Array<{ name?: string; nowKnows?: string }>;
    }>(
      world,
      'You file hard canon for an interactive story WHILE the episode is still open. Return JSON only: ' +
        '{"facts":["..."],"threads":["..."],"place":{"name":"<scene place>","currentState":"...","atmosphere":"..."},' +
        '"knowledge":[{"name":"<exact in-scene name>","nowKnows":"..."}]}. ' +
        'Do not invent. Omit any key that has nothing new. ' +
        `facts: 2–${LIVE_CANON_FACT_CAP} durable facts that must stay true later (debts, promises, objects held, injuries, who saw what). ` +
        'Not weather, not mood, not a plot recap. Do not repeat Known facts. ' +
        `threads: 0–${LIVE_CANON_THREAD_CAP} NEW open tensions not already listed. ` +
        'place: lasting room condition and optional weather/light now true; omit if unchanged. ' +
        'knowledge: only in-scene named cast who clearly learned something; omit if none. ' +
        'Each line under 220 characters.',
      `World: ${world.title}. Episode ${ctx.episode.number}.\n` +
        `Place: ${placeLine}${loc?.currentState ? ` (now: ${loc.currentState})` : ''}\n` +
        `In-scene cast: ${inScene.map((c) => c.name).join(', ') || '(none)'}\n\n` +
        `Known facts (do not repeat):\n${knownBlock || '(none)'}\n\n` +
        `Open threads (do not repeat):\n${threadBlock || '(none)'}\n\n` +
        `Physical ledger (do not refile as facts):\n${ledger || '(none)'}\n\n` +
        `Recent beats:\n${digest.slice(0, 10000)}\n\n` +
        `Return live canon JSON.`,
      900,
      signal,
      25_000
    );

    const extract = normalizeLiveCanonExtract(result, {
      existingFacts: existingFactTexts,
      existingThreads: existingThreadTexts,
      inSceneNames,
      episodeFactCount
    });

    const now = Date.now();
    const newFacts = extract.facts.map((text) => ({
      id: uid(),
      worldId: world.id,
      seasonId: ctx.season.id,
      episodeId: ctx.episode.id,
      text,
      source: 'auto' as const,
      createdAt: now
    }));
    const knowledgeFacts = extract.knowledge.map((k) => {
      const c = inScene.find((x) => x.name.toLowerCase() === k.name.toLowerCase());
      const name = c?.name ?? k.name;
      return {
        id: uid(),
        worldId: world.id,
        seasonId: ctx.season.id,
        episodeId: ctx.episode.id,
        text: knowledgeFactLine(name, k.nowKnows),
        source: 'auto' as const,
        createdAt: now
      };
    });
    const newThreads = extract.threads.map((text) => ({
      id: uid(),
      worldId: world.id,
      seasonId: ctx.season.id,
      text,
      openedLabel: `opened S${ctx.season.number} · E${ctx.episode.number}`,
      status: 'open' as const,
      createdAt: now
    }));

    if (liveCanonHasWork(extract)) {
      if (newFacts.length > 0) await db.continuity.bulkAdd(newFacts);
      if (knowledgeFacts.length > 0) await db.continuity.bulkAdd(knowledgeFacts);
      if (newThreads.length > 0) await db.threads.bulkAdd(newThreads);
      if (extract.place?.currentState) {
        await applyPlacePatches(ctx.locations, [extract.place], ctx.episode.locationId);
      }
    }

    const epPatch: Partial<Episode> = { liveCanonAtChars: chars, updatedAt: now };
    if (extract.place?.atmosphere?.trim()) {
      epPatch.atmosphereNote = extract.place.atmosphere.trim();
    }
    await db.episodes.update(ctx.episode.id, epPatch);
    ctx.episode = { ...ctx.episode, ...epPatch };
    if (newFacts.length > 0 || knowledgeFacts.length > 0) {
      ctx.continuity = [...ctx.continuity, ...newFacts, ...knowledgeFacts];
    }
    if (newThreads.length > 0) {
      ctx.threads = [...ctx.threads, ...newThreads];
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    logAppError(e, 'live canon');
    onNotice?.('Couldn’t file live memory — writing still saved; wrap can catch up.');
  }
}

/** Longest scene ledger we will carry into a prompt. */
export const SCENE_LEDGER_CAP = 8;

/**
 * Clean a scene ledger from the tracker.
 * Returns null when the model gave nothing usable, so the prior ledger survives
 * rather than being wiped by a bad parse.
 */
export function capSceneLedger(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= SCENE_LEDGER_CAP) break;
  }
  return out.length > 0 ? out : null;
}

/** Values the state tracker may return to mean "this no longer applies". */
const STATE_CLEAR_WORDS = new Set(['none', 'clear', 'n/a', 'na', '-', '—', 'nothing', 'resolved']);

/**
 * Resolve one patched state field.
 * Omitted keeps the prior value; an explicit clear word empties it, so a mood or
 * injury does not follow a character for the rest of the episode.
 */
export function mergeStateField(patch: string | undefined, prior: string): string {
  if (patch === undefined) return prior;
  const next = patch.trim();
  if (!next) return prior;
  if (STATE_CLEAR_WORDS.has(next.toLowerCase().replace(/[.!]$/, ''))) return '';
  return next;
}

/** Merge live state patches onto cast cards (exported for tests). */
export async function applyLiveCharacterStateUpdates(
  worldId: string,
  cast: Character[],
  updates: Array<{
    name?: string;
    goal?: string;
    emotion?: string;
    location?: string;
    condition?: string;
  }>
): Promise<number> {
  let applied = 0;
  const now = Date.now();
  for (const u of updates) {
    const name = (u.name ?? '').trim().toLowerCase();
    if (!name) continue;
    const c = cast.find((x) => x.name.toLowerCase() === name);
    if (!c || c.isPlayer) continue;
    const state: CharacterState = {
      goal: mergeStateField(u.goal, c.state.goal),
      emotion: mergeStateField(u.emotion, c.state.emotion),
      location: mergeStateField(u.location, c.state.location),
      condition: mergeStateField(u.condition, c.state.condition)
    };
    if (
      state.goal === c.state.goal &&
      state.emotion === c.state.emotion &&
      state.location === c.state.location &&
      state.condition === c.state.condition
    ) {
      continue;
    }
    await db.characters.update(c.id, { state, updatedAt: now });
    c.state = state;
    applied++;
  }
  void worldId;
  return applied;
}

/** Write wrap place patches onto location cards. Scene location matches by id first. */
export async function applyPlacePatches(
  locations: Location[],
  patches: PlacePatch[],
  sceneLocationId?: string | null
): Promise<number> {
  let applied = 0;
  const now = Date.now();
  const used = new Set<string>();
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!patch.currentState?.trim()) continue;
    const loc = matchLocationForPatch(
      locations,
      patch,
      i === 0 ? sceneLocationId : undefined
    );
    if (!loc || used.has(loc.id)) continue;
    const next = mergeLocationPatch(loc, patch);
    if (next.currentState === loc.currentState) continue;
    await db.locations.update(loc.id, { currentState: next.currentState, updatedAt: now });
    loc.currentState = next.currentState;
    used.add(loc.id);
    applied++;
  }
  return applied;
}

/**
 * File a previously-on wrap when the user skips full review.
 * Recap always lands; a thin facts/threads/state pass runs after and fails open.
 */
export const SOFT_WRAP_FACT_CAP = 6;
export const SOFT_WRAP_THREAD_CAP = 4;

export interface SoftWrapExtract {
  facts: string[];
  threads: string[];
  characterUpdates: EpisodeWrapCharacterUpdate[];
  place: PlacePatch | null;
}

/** Cap extract rows and drop updates for people not in the scene. */
export function capSoftWrapExtract(
  raw: {
    facts?: string[];
    threads?: string[];
    characterUpdates?: Array<{
      name?: string;
      goal?: string;
      emotion?: string;
      location?: string;
      condition?: string;
    }>;
    place?: { name?: string; currentState?: string; atmosphere?: string };
  },
  inSceneNames: Set<string>
): SoftWrapExtract {
  const facts = (raw.facts ?? []).map((f) => f.trim()).filter(Boolean).slice(0, SOFT_WRAP_FACT_CAP);
  const threads = (raw.threads ?? []).map((t) => t.trim()).filter(Boolean).slice(0, SOFT_WRAP_THREAD_CAP);
  const characterUpdates: EpisodeWrapCharacterUpdate[] = [];
  for (const u of raw.characterUpdates ?? []) {
    const name = (u.name ?? '').trim();
    if (!name || !inSceneNames.has(name.toLowerCase())) continue;
    characterUpdates.push({
      name,
      goal: u.goal?.trim() || undefined,
      emotion: u.emotion?.trim() || undefined,
      location: u.location?.trim() || undefined,
      condition: u.condition?.trim() || undefined
    });
  }
  return { facts, threads, characterUpdates, place: normalizePlacePatch(raw.place) };
}

/** Drop facts/threads already on file so Skip wrap does not duplicate live canon. */
export function dedupeSoftWrapExtract(
  extract: SoftWrapExtract,
  existingFacts: string[],
  existingThreads: string[]
): SoftWrapExtract {
  return {
    ...extract,
    facts: novelLines(extract.facts, existingFacts, SOFT_WRAP_FACT_CAP),
    threads: novelLines(extract.threads, existingThreads, SOFT_WRAP_THREAD_CAP)
  };
}

export async function fileSoftWrapContinuity(
  world: World,
  season: Season,
  episode: Episode,
  extract: SoftWrapExtract
): Promise<void> {
  const existingFacts = (await db.continuity.where('seasonId').equals(season.id).toArray())
    .map((f) => f.text);
  const openThreads = await db.threads
    .where('seasonId')
    .equals(season.id)
    .filter((t) => t.status === 'open')
    .toArray();
  extract = dedupeSoftWrapExtract(extract, existingFacts, openThreads.map((t) => t.text));
  const now = Date.now();
  if (extract.facts.length > 0) {
    await db.continuity.bulkAdd(
      extract.facts.map((text) => ({
        id: uid(), worldId: world.id, seasonId: season.id, episodeId: episode.id,
        text, source: 'auto' as const, createdAt: now
      }))
    );
  }
  if (extract.threads.length > 0) {
    await db.threads.bulkAdd(
      extract.threads.map((text) => ({
        id: uid(), worldId: world.id, seasonId: season.id, text,
        openedLabel: `opened S${season.number} · E${episode.number}`,
        status: 'open' as const, createdAt: now
      }))
    );
  }
  if (extract.characterUpdates.length > 0) {
    const cast = await db.characters.where('worldId').equals(world.id).toArray();
    await applyLiveCharacterStateUpdates(world.id, cast, extract.characterUpdates);
  }
  if (extract.place?.currentState) {
    const locations = await db.locations.where('worldId').equals(world.id).toArray();
    await applyPlacePatches(locations, [extract.place], episode.locationId);
  }
}

/** True when Skip already wrote a recap — retry must not re-file continuity. */
export function softWrapAlreadyFiled(episode: Pick<Episode, 'wrap'>): boolean {
  return !!(episode.wrap?.recap?.trim());
}

/**
 * Minimal wrap + optional continuity for Skip.
 * Does not call nextEpisode — Story advances after this returns.
 * Full analyze path uses commitEpisodeWrap, which advances itself.
 * Idempotent: if wrap.recap is already filed, skips continuity re-file (safe retry after a failed advance).
 */
export async function commitSoftEpisodeWrap(
  world: World,
  season: Season,
  episode: Episode,
  opts?: { onNotice?: (message: string) => void }
): Promise<EpisodeWrap> {
  if (softWrapAlreadyFiled(episode) && episode.wrap) {
    return episode.wrap;
  }
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const guests = episode.guests ?? [];
  const existing = episode.runningSummary?.trim();
  let recap = existing ?? '';
  if (!recap) {
    const digest = compressOmittedTurns(
      turns.length > 12 ? turns.slice(0, -4) : turns,
      characters,
      guests
    );
    if (digest.trim()) {
      try {
        const { provider, model } = utilityModelFor(world);
        const { text } = await streamChat({
          provider,
          model,
          system:
            'Summarize an interactive-fiction episode for a previously-on card. ' +
            'Write 80–160 words in past tense. No dialogue quotes. No preamble.',
          messages: [{
            role: 'user',
            content:
              `World: ${world.title}. Season ${season.number}, episode ${episode.number}` +
              `${episode.title ? ` (${episode.title})` : ''}.\n\n${digest.slice(0, 12000)}`
          }],
          maxTokens: 400
        });
        recap = text.trim();
      } catch (e) {
        logAppError(e, 'soft wrap recap');
      }
    }
  }
  if (!recap) {
    const last = turns.slice(-3).map((t) => t.text.trim()).filter(Boolean);
    recap = last.length > 0
      ? `Episode ${episode.number} ended without a full wrap. Last beats: ${last.map((t) => t.slice(0, 120)).join(' / ')}`
      : `Episode ${episode.number} ended without a filed summary.`;
  }
  recap = recap.slice(0, 1200);

  const wrap: EpisodeWrap = {
    recap,
    beats: existing
      ? [{ text: 'Continued from mid-episode summary (full wrap skipped).', consequence: '' }]
      : [],
    guestEffects: []
  };
  await db.episodes.update(episode.id, {
    wrap,
    updatedAt: Date.now()
  });

  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const inSceneNames = new Set(inScene.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
  try {
    const digest = compressOmittedTurns(
      turns.length > 12 ? turns.slice(0, -4) : turns,
      characters,
      guests
    );
    const source = (digest.trim() || recap).slice(0, 14000);
    const result = await utilityJson<{
      facts?: string[];
      threads?: string[];
      characterUpdates?: Array<{
        name?: string;
        goal?: string;
        emotion?: string;
        location?: string;
        condition?: string;
      }>;
      place?: { name?: string; currentState?: string; atmosphere?: string };
    }>(
      world,
      'You are a continuity editor filing a skipped episode wrap. Respond with JSON only: ' +
      '{"facts":["..."],"threads":["..."],' +
      '"characterUpdates":[{"name":"<exact in-scene name>","goal":"","emotion":"","location":"","condition":""}],' +
      '"place":{"name":"<scene place>","currentState":"<how the room is left>"}}. ' +
      `At most ${SOFT_WRAP_FACT_CAP} durable facts and ${SOFT_WRAP_THREAD_CAP} unresolved threads. ` +
      'Facts must still be true next episode (revelations, injuries, promises, debts). ' +
      'characterUpdates: only named in-scene NPCs; omit empties. ' +
      'place.currentState: lasting physical condition of the scene as left; omit if nothing changed. ' +
      'Do not invent people, relationships, or calendar hits.',
      `World: ${world.title}. Season ${season.number}, episode ${episode.number}.\n` +
      `Place: ${episode.location || '(unnamed)'}\n` +
      `In-scene cast: ${inScene.map((c) => c.name).join(', ') || '(none)'}\n\n` +
      `Recap:\n${recap}\n\nEpisode material:\n${source}`,
      1400
    );
    const capped = capSoftWrapExtract(result, inSceneNames);
    await fileSoftWrapContinuity(world, season, episode, capped);
  } catch (e) {
    logAppError(e, 'soft wrap continuity');
    opts?.onNotice?.('Couldn’t file extra memory on skip — recap was kept.');
  }

  return wrap;
}

/** Snapshot turns that would be removed by deleteTurnsFrom (inclusive). */
export async function snapshotTurnsFrom(turnId: string, episodeId: string): Promise<Turn[]> {
  const turns = await db.turns.where('episodeId').equals(episodeId).sortBy('createdAt');
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return [];
  return turns.slice(idx);
}

/** Snapshot turns that would be removed by deleteTurnsAfter (exclusive of turnId). */
export async function snapshotTurnsAfter(turnId: string, episodeId: string): Promise<Turn[]> {
  const turns = await db.turns.where('episodeId').equals(episodeId).sortBy('createdAt');
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return [];
  return turns.slice(idx + 1);
}

/** Restore previously snapshotted turns (e.g. after a failed retry). */
export async function restoreTurns(turns: Turn[]): Promise<void> {
  if (turns.length === 0) return;
  await db.turns.bulkPut(turns);
}

/** Clear mid-episode digests when the transcript is rewritten (edit / delete / re-roll). */
export async function clearEpisodeRunningSummary(episodeId: string): Promise<void> {
  await db.episodes.update(episodeId, {
    runningSummary: null,
    runningSummaryAtChars: 0,
    liveStateAtChars: 0,
    liveCanonAtChars: 0,
    updatedAt: Date.now()
  });
}

/** Delete a turn and everything after it (used by regenerate / retry). */
export async function deleteTurnsFrom(turnId: string, episodeId: string): Promise<void> {
  const turns = await snapshotTurnsFrom(turnId, episodeId);
  if (turns.length === 0) return;
  await db.turns.bulkDelete(turns.map((t) => t.id));
  await clearEpisodeRunningSummary(episodeId);
}

/** Delete everything after a turn, keeping the turn itself. */
export async function deleteTurnsAfter(turnId: string, episodeId: string): Promise<void> {
  const turns = await snapshotTurnsAfter(turnId, episodeId);
  if (turns.length === 0) return;
  await db.turns.bulkDelete(turns.map((t) => t.id));
  await clearEpisodeRunningSummary(episodeId);
}

/**
 * After a failed retry: remove turns written during the attempt and put the
 * snapshot back. Does not record sync tombstones (caller handles that on success).
 */
export async function rollbackTurnSnapshot(
  episodeId: string,
  snapshot: Turn[],
  retryStartedAt: number
): Promise<void> {
  const snapIds = new Set(snapshot.map((t) => t.id));
  const current = await db.turns.where('episodeId').equals(episodeId).toArray();
  const extras = current.filter((t) => !snapIds.has(t.id) && t.createdAt >= retryStartedAt);
  if (extras.length > 0) await db.turns.bulkDelete(extras.map((t) => t.id));
  await restoreTurns(snapshot);
}

// ---------- Utility calls (JSON tasks on the utility model) ----------

function extractJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = Math.min(
    ...['{', '['].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0)
  );
  if (!Number.isFinite(start)) throw new AIError('The model did not return JSON.');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new AIError('The model returned malformed JSON.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new AIError('The model returned malformed JSON.');
  }
}

async function utilityJson<T>(
  world: World | null,
  system: string,
  user: string,
  maxTokens = 3000,
  signal?: AbortSignal,
  timeoutMs = UTILITY_TIMEOUT_MS
): Promise<T> {
  const { provider, model } = utilityModelFor(world);
  const { signal: timed, cancel } = withTimeoutSignal(signal, timeoutMs);
  try {
    const { text: raw } = await streamChat({
      provider, model, system,
      messages: [{ role: 'user', content: user }],
      maxTokens, temperature: 0.4, signal: timed
    });
    return extractJson<T>(raw);
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !signal?.aborted) {
      throw new AIError(`Utility model timed out after ${timeoutMs / 1000}s.`);
    }
    throw e;
  } finally {
    cancel();
  }
}

const WRAP_CHUNK_CHARS = 20000;
const WRAP_DIRECT_CHARS = 48000;
const WRAP_ANALYZE_TIMEOUT_MS = 90_000;

/**
 * Build a wrap-analysis corpus that preserves early + late episode detail.
 * Short episodes pass through; long ones are map-reduced with a raw tail kept.
 */
async function buildEpisodeWrapCorpus(
  world: World,
  episode: Episode,
  labeledText: string,
  signal?: AbortSignal
): Promise<string> {
  const running = episode.runningSummary?.trim();
  const prefix = running ? `Running summary already filed:\n${running}\n\n---\n\n` : '';

  if (labeledText.length <= WRAP_DIRECT_CHARS) {
    return prefix + labeledText;
  }

  const { provider, model } = utilityModelFor(world);
  const chunks: string[] = [];
  for (let i = 0; i < labeledText.length; i += WRAP_CHUNK_CHARS) {
    chunks.push(labeledText.slice(i, i + WRAP_CHUNK_CHARS));
  }

  const summaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { signal: timed, cancel } = withTimeoutSignal(signal, UTILITY_TIMEOUT_MS);
    try {
      const { text: summary } = await streamChat({
        provider,
        model,
        system:
          'You compress one slice of an interactive-fiction episode for continuity handoff. ' +
          '150–220 words. Keep every detail that must survive into the NEXT episode: ' +
          'proper names, decisions, revelations, promises/threats, injuries, debts, location changes, ' +
          'relationship shifts, who learned what, and unresolved tension. No preamble.',
        messages: [{
          role: 'user',
          content: `Episode ${episode.number}, slice ${i + 1}/${chunks.length}:\n\n${chunks[i]}`
        }],
        maxTokens: 700,
        temperature: 0.3,
        signal: timed
      });
      summaries.push(`(Slice ${i + 1}/${chunks.length})\n${summary.trim()}`);
    } catch (e) {
      if ((e as Error).name === 'AbortError' && !signal?.aborted) {
        throw new AIError(`Utility model timed out after ${UTILITY_TIMEOUT_MS / 1000}s.`);
      }
      throw e;
    } finally {
      cancel();
    }
  }

  const tail = labeledText.slice(-12000);
  return (
    prefix +
    `Episode map (compressed slices — preserve all of this):\n\n${summaries.join('\n\n---\n\n')}\n\n` +
    `---\n\nClosing transcript (raw, recent):\n${tail}`
  );
}

/** Extract new continuity facts + open threads after an episode ends. */
/**
 * Legacy auto-extract — superseded by analyzeEpisode + commitEpisodeWrap.
 * Kept for older call sites / scripts; Story no longer uses this path.
 */
export async function extractContinuity(world: World, season: Season, episode: Episode): Promise<void> {
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  if (turns.length === 0) return;
  const existing = await db.continuity.where('seasonId').equals(season.id).toArray();
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const guests = episode.guests ?? [];
  const text = turns.map((t) => labelTurn(t, characters, guests)).join('\n\n');

  const result = await utilityJson<{ facts: string[]; threads: string[] }>(
    world,
    'You are a continuity editor for a longform story. You extract durable facts and unresolved threads. Respond with JSON only: {"facts": string[], "threads": string[]}. Facts are things that will still be true next episode (revelations, injuries, promises, debts, deaths, changed relationships). Threads are tensions raised but not resolved. 3-6 of each at most. Never repeat facts already known.',
    `Known facts:\n${existing.map((f) => `- ${f.text}`).join('\n') || '(none)'}\n\nEpisode ${episode.number} text:\n${text.slice(0, 24000)}`
  );

  const now = Date.now();
  await db.continuity.bulkAdd(
    result.facts.filter((f) => f.trim()).map((f) => ({
      id: uid(), worldId: world.id, seasonId: season.id, episodeId: episode.id,
      text: f.trim(), source: 'auto' as const, createdAt: now
    }))
  );
  await db.threads.bulkAdd(
    result.threads.filter((t) => t.trim()).map((t) => ({
      id: uid(), worldId: world.id, seasonId: season.id, text: t.trim(),
      openedLabel: `opened S${season.number} · E${episode.number}`, status: 'open' as const, createdAt: now
    }))
  );
}

/** Per-character handoff so next episode opens with current goals/feelings/place. */
export interface EpisodeWrapCharacterUpdate {
  /** Exact cast name */
  name: string;
  goal?: string;
  emotion?: string;
  location?: string;
  condition?: string;
}

export interface EpisodeWrapKnowledgeUpdate {
  name: string;
  /** Fact they now know — appended to continuity-facing sheet notes via mustNotKnow clear / fact */
  nowKnows?: string;
  /** Substring or clause to remove from mustNotKnow when they learned it */
  clearMustNotKnow?: string;
}

export interface EpisodeWrapRelationshipUpdate {
  from: string;
  to: string;
  kind?: string;
  note?: string;
}

export interface EpisodeWrapDraft {
  recap: string;
  beats: EpisodeWrapBeat[];
  facts: string[];
  threads: string[];
  guestEffects: string[];
  /** Open threads from earlier that this episode settled */
  resolvedThreads: string[];
  /** Known facts this episode made false — Keep in review to drop them from memory */
  staleFacts: string[];
  characterUpdates: EpisodeWrapCharacterUpdate[];
  knowledgeUpdates: EpisodeWrapKnowledgeUpdate[];
  relationshipUpdates: EpisodeWrapRelationshipUpdate[];
  /** Evolved living premise preview for next episode (editable) */
  premisePreview: string;
  /** Story day the episode opened (from tracker; editable in review) */
  storyDayStart: number;
  /** Story day the episode ended — may span multiple days */
  storyDayEnd: number;
  /** Suggested story day for the next episode to open on */
  nextStoryDay: number;
  /** Free-text when/how time passed (night fell, two days later, etc.) */
  dateNote: string;
  /** Pending plot targets this episode appears to have hit (near-exact to current list). */
  hitTargets: string[];
  /** Calendar events this episode played — id-backed for reliable commit. */
  hitCalendarEvents: Array<{ id: string; title: string; kind?: string; storyDay?: number }>;
  /** How the scene location is left; atmosphere is weather for the next opening. */
  place: PlacePatch | null;
  /** Other named library places that clearly changed this episode. */
  elsewhere: PlacePatch[];
  /** Off-screen life between this close and the next open — empty when same day. */
  meanwhile: string;
}

/** Season-like episode analysis for the wrap review UI. */
export async function analyzeEpisode(
  world: World,
  season: Season,
  episode: Episode,
  signal?: AbortSignal
): Promise<EpisodeWrapDraft> {
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const locations = await db.locations.where('worldId').equals(world.id).toArray();
  const existing = await db.continuity.where('seasonId').equals(season.id).toArray();
  const openThreads = await db.threads
    .where('seasonId')
    .equals(season.id)
    .filter((t) => t.status === 'open')
    .toArray();
  const guests = episode.guests ?? [];
  const text = turns.map((t) => labelTurn(t, characters, guests)).join('\n\n');
  const cal = worldCalendar(world);
  const dayStart = episode.storyDay && episode.storyDay > 0 ? episode.storyDay : cal.currentDay;
  const dayNow = cal.currentDay;

  const empty: EpisodeWrapDraft = {
    recap: 'The episode opened without lasting prose yet.',
    beats: [],
    facts: [],
    threads: [],
    guestEffects: [],
    resolvedThreads: [],
    staleFacts: [],
    characterUpdates: [],
    knowledgeUpdates: [],
    relationshipUpdates: [],
    premisePreview: season.premise || '',
    storyDayStart: dayStart,
    storyDayEnd: Math.max(dayStart, dayNow),
    nextStoryDay: Math.max(dayStart, dayNow) + cal.episodeAdvanceDays,
    dateNote: '',
    hitTargets: [],
    hitCalendarEvents: [],
    place: null,
    elsewhere: [],
    meanwhile: ''
  };
  if (!text.trim()) return empty;

  const corpus = await buildEpisodeWrapCorpus(world, episode, text, signal);

  const castBlock = characters
    .filter((c) => !c.isPlayer)
    .map((c) => {
      const stateBits = [
        c.state.goal && `goal=${c.state.goal}`,
        c.state.emotion && `emotion=${c.state.emotion}`,
        c.state.location && `location=${c.state.location}`,
        c.state.condition && `condition=${c.state.condition}`
      ].filter(Boolean).join('; ');
      const relBits = c.relationships
        .slice(0, 4)
        .map((r) => {
          const t = characters.find((x) => x.id === r.targetId)?.name;
          return t ? `${r.kind}→${t}` : null;
        })
        .filter(Boolean)
        .join(', ');
      return (
        `- ${c.name}${c.role ? ` (${c.role})` : ''}` +
        `${stateBits ? ` [${stateBits}]` : ''}` +
        `${c.mustNotKnow.trim() ? ` MUST NOT KNOW: ${c.mustNotKnow.trim()}` : ''}` +
        `${relBits ? ` rels: ${relBits}` : ''}`
      );
    })
    .join('\n');

  const guestBlock = guests.length > 0
    ? `Walk-ons this episode:\n${guests.map((g) => `- ${g.name}: ${g.brief}`).join('\n')}\n\n`
    : '';

  const knownFacts = [...existing]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40)
    .map((f) => `- ${f.text}`)
    .join('\n');

  const openThreadBlock = openThreads.length > 0
    ? openThreads.map((t) => `- ${t.text}`).join('\n')
    : '(none)';

  const pendingTargets = [
    ...pendingPlotTargets(episode.plotTargets).map((t) => ({ scope: 'episode' as const, text: t.text })),
    ...pendingPlotTargets(season.plotTargets).map((t) => ({ scope: 'season' as const, text: t.text }))
  ];
  const pendingTargetBlock = pendingTargets.length > 0
    ? pendingTargets.map((t) => `- [${t.scope}] ${t.text}`).join('\n')
    : '(none)';

  const calPrefs = worldCalendarEventPrefs(world);
  const dueCalendarEvents = calPrefs.enabled
    ? (await db.calendarEvents.where('seasonId').equals(season.id).toArray())
      .filter((e) => e.status === 'due' || e.status === 'scheduled')
      .filter((e) => {
        const start = Math.max(1, e.storyDay);
        const end = e.endDay != null && e.endDay >= start ? e.endDay : start;
        return start <= Math.max(dayStart, dayNow) && end >= dayStart;
      })
    : [];
  const dueCalendarBlock = dueCalendarEvents.length > 0
    ? dueCalendarEvents.map((e) => `- [${e.id}] ${e.title}: ${e.summary}`).join('\n')
    : '(none)';

  const dateBlock =
    `Calendar system: ${cal.system || '(day count only)'}\n` +
    `Weekdays: ${cal.weekdays.join(', ')} (story day 1 = ${cal.weekdays[cal.dayOneWeekday]})\n` +
    `Episode opened: ${formatStoryDate(cal, dayStart)}\n` +
    `World "today" now: ${formatStoryDate(cal, dayNow)}\n` +
    `Location: ${episode.location || '(unset)'}\n`;

  const sceneLoc = episode.locationId
    ? locations.find((l) => l.id === episode.locationId)
    : locations.find((l) => l.name.toLowerCase() === (episode.location ?? '').trim().toLowerCase());
  const placeLines = locations.slice(0, 24).map((l) => {
    const here = sceneLoc && l.id === sceneLoc.id ? ' · THIS SCENE' : '';
    const state = l.currentState.trim() ? ` now: ${l.currentState.trim()}` : '';
    return `- ${l.name}${here}${state}`;
  }).join('\n');
  const ledgerLines = (episode.sceneLedger ?? []).map((d) => `- ${d}`).join('\n');
  const placeBlock =
    `Known places (use exact names for place/elsewhere):\n${placeLines || '(none)'}\n` +
    (ledgerLines ? `\nAlready true in this room this episode:\n${ledgerLines}\n` : '');

  const result = await utilityJson<{
    recap?: string;
    beats?: { text?: string; consequence?: string }[];
    facts?: string[];
    staleFacts?: string[];
    threads?: string[];
    guestEffects?: string[];
    resolvedThreads?: string[];
    characterUpdates?: Array<{
      name?: string;
      goal?: string;
      emotion?: string;
      location?: string;
      condition?: string;
    }>;
    knowledgeUpdates?: Array<{
      name?: string;
      nowKnows?: string;
      clearMustNotKnow?: string;
    }>;
    relationshipUpdates?: Array<{
      from?: string;
      to?: string;
      kind?: string;
      note?: string;
    }>;
    storyDayEnd?: number;
    nextStoryDay?: number;
    dateNote?: string;
    hitTargets?: string[];
    hitCalendarEvents?: string[];
    place?: { name?: string; currentState?: string; atmosphere?: string };
    elsewhere?: Array<{ name?: string; currentState?: string; atmosphere?: string }>;
    meanwhile?: string;
  }>(
    world,
    'You are a continuity editor closing a chapter of interactive fiction. ' +
    'Durable facts and open threads were already filed during play — merge and prune; do not dump a second copy of Known facts. ' +
    'Your job is the previously-on recap, how time passed, the next opening, stale or resolved items, and only genuinely NEW or CONFLICTING facts/threads. ' +
    'Respond with JSON only:\n' +
    '{"recap":"<150-280 word previously-on paragraph — include WHEN (weekday/day) and WHERE if known, plus names, stakes, what hangs>",' +
    '"beats":[{"text":"<what happened, one concrete sentence with names>","consequence":"<what it leaves hanging for later>"}],' +
    '"facts":["<NEW durable facts not already in Known facts — omit if play already filed them>"],' +
    '"staleFacts":["<near-exact Known facts that are no longer true — omit if none>"],' +
    '"threads":["<NEW unresolved tensions not already in Open threads>"],' +
    '"resolvedThreads":["<exact or near-exact text of prior open threads this episode settled — omit if none>"],' +
    '"hitTargets":["<exact or near-exact text of pending plot targets this episode meaningfully advanced or fulfilled — omit if none>"],' +
    '"hitCalendarEvents":["<exact id from the Due calendar list, or near-exact title — omit if none>"],' +
    '"guestEffects":["<how walk-ons changed the story, if any>"],' +
    '"characterUpdates":[{"name":"<exact cast name>","goal":"<current goal or empty>","emotion":"<emotional state>","location":"<where they are>","condition":"<injuries/status>"}],' +
    '"knowledgeUpdates":[{"name":"<exact cast name>","nowKnows":"<what they learned>","clearMustNotKnow":"<clause from MUST NOT KNOW that is no longer secret to them>"}],' +
    '"relationshipUpdates":[{"from":"<cast name>","to":"<cast name>","kind":"<ally|rival|lover|debt|…>","note":"<one line what changed>"}],' +
    '"place":{"name":"<exact scene place name>","currentState":"<one sentence: how this room/street is left — damage, occupancy, objects moved>","atmosphere":"<optional weather/light/smell for the NEXT opening if still here>"},' +
    '"elsewhere":[{"name":"<exact other place name>","currentState":"<how that place changed because of this episode>"}],' +
    '"storyDayEnd":<integer story day when this episode ends — >= storyDayStart; same day if no time passed>,' +
    '"nextStoryDay":<integer story day the NEXT episode should open on — >= storyDayEnd>,' +
    '"dateNote":"<one short sentence: how time passed — dawn, overnight, two days later, same afternoon, etc.>",' +
    '"meanwhile":"<2–4 sentences of off-screen life during the gap before the next episode opens — empty string if same day>"}\n' +
    'Rules:\n' +
    '- Recap must be usable as "previously on": include proper names, calendar timing, place, decisive exchanges, open pressure.\n' +
    '- Beats: 3–7 events that matter later; never vague ("things escalated").\n' +
    '- Facts: 0–6 NEW durable facts; do NOT repeat Known facts; empty array if play already filed them; date when relevant.\n' +
    '- staleFacts: 0–8 Known facts this episode made false (a debt paid, an object no longer held, an injury healed). Near-exact wording. Omit if none.\n' +
    '- Threads: only NEW open tensions (0–6). Empty if already on file. Put settled prior threads in resolvedThreads.\n' +
    '- hitTargets: only from the Pending plot targets list; copy text near-exactly; omit if the target was not advanced.\n' +
    '- hitCalendarEvents: only from Due calendar events; prefer the bracketed id; title fallback allowed; omit if not addressed.\n' +
    '- characterUpdates: every non-player who appeared OR was named off-scene in a way that changed their situation; ' +
    'use "none" to clear a field that no longer applies (a mood that passed, an injury that healed).\n' +
    '- knowledgeUpdates: only when someone learned something that was blocked or newly revealed; clearMustNotKnow should match their wall when possible.\n' +
    '- relationshipUpdates: only real shifts (trust, debt, romance, enmity); use exact cast names.\n' +
    '- place.currentState: lasting physical condition of THIS SCENE as you leave it (not weather). place.atmosphere is weather/light for the next opening only.\n' +
    '- elsewhere: only places from Known places that clearly changed; exact names; omit if none.\n' +
    '- meanwhile: what off-screen people and places do during the gap to nextStoryDay. Empty if nextStoryDay === storyDayEnd. Invent nothing that contradicts facts; you MAY infer quiet life (travel, waiting, a wound closing) from time passing.\n' +
    '- storyDayEnd: infer from the prose + calendar (night falling → often same day; "next morning" → +1; multi-day travel → higher). ' +
    `Default to ${dayNow} if unclear. Never go below the episode start day.\n` +
    `- nextStoryDay: when the following episode should open. Same as storyDayEnd for immediate continuation; ` +
    `storyDayEnd+${cal.episodeAdvanceDays} is the world default when time simply moves on.\n` +
    '- Guest effects only for walk-ons, not Cast cards.\n' +
    '- Invent nothing that did not happen in the episode material — except meanwhile, which may cover the unshown gap.',
    `World: ${world.title} — ${world.line}\n` +
    `Season ${season.number} premise (current pressure): ${season.premise || '(unwritten)'}\n` +
    `Episode ${episode.number}${episode.title ? ` — ${episode.title}` : ''}` +
    `${episode.location ? ` @ ${episode.location}` : ''}\n` +
    `Date range so far: ${formatEpisodeDateRange(cal, dayStart, dayNow)}\n\n` +
    dateBlock + '\n' +
    placeBlock + '\n' +
    `Cast (names must match characterUpdates):\n${castBlock || '(none)'}\n\n` +
    guestBlock +
    `Known facts (do not repeat):\n${knownFacts || '(none)'}\n\n` +
    `Open threads already on file (resolve via resolvedThreads if settled):\n${openThreadBlock}\n\n` +
    `Pending plot targets (report hits via hitTargets):\n${pendingTargetBlock}\n\n` +
    `Due calendar events (report played via hitCalendarEvents):\n${dueCalendarBlock}\n\n` +
    `Episode material:\n${corpus.slice(0, 60000)}`,
    4000,
    signal,
    WRAP_ANALYZE_TIMEOUT_MS
  );

  const castNames = new Set(characters.filter((c) => !c.isPlayer).map((c) => c.name.toLowerCase()));
  const parsedEnd = typeof result.storyDayEnd === 'number' && Number.isFinite(result.storyDayEnd)
    ? Math.floor(result.storyDayEnd)
    : dayNow;
  const storyDayEnd = Math.max(dayStart, parsedEnd);
  const parsedNext = typeof result.nextStoryDay === 'number' && Number.isFinite(result.nextStoryDay)
    ? Math.floor(result.nextStoryDay)
    : storyDayEnd + cal.episodeAdvanceDays;
  const nextStoryDay = Math.max(storyDayEnd, parsedNext);

  const knownFactTexts = existing.map((f) => f.text);
  const openThreadTexts = openThreads.map((t) => t.text);
  const draftCore: EpisodeWrapDraft = {
    recap: (result.recap ?? '').trim() || 'The episode closed without a clear recap.',
    beats: (result.beats ?? [])
      .map((b) => ({ text: (b.text ?? '').trim(), consequence: (b.consequence ?? '').trim() }))
      .filter((b) => b.text)
      .slice(0, 9),
    facts: novelLines(result.facts ?? [], knownFactTexts, WRAP_NEW_FACT_CAP),
    threads: novelLines(result.threads ?? [], openThreadTexts, WRAP_NEW_THREAD_CAP),
    guestEffects: (result.guestEffects ?? []).map((g) => g.trim()).filter(Boolean).slice(0, 8),
    resolvedThreads: (result.resolvedThreads ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 10),
    staleFacts: selectStaleFactTexts(result.staleFacts ?? [], knownFactTexts, 8),
    characterUpdates: (result.characterUpdates ?? [])
      .map((u) => ({
        name: (u.name ?? '').trim(),
        goal: (u.goal ?? '').trim() || undefined,
        emotion: (u.emotion ?? '').trim() || undefined,
        location: (u.location ?? '').trim() || undefined,
        condition: (u.condition ?? '').trim() || undefined
      }))
      .filter((u) => u.name && castNames.has(u.name.toLowerCase()))
      .filter((u) => u.goal || u.emotion || u.location || u.condition)
      .slice(0, 16),
    knowledgeUpdates: (result.knowledgeUpdates ?? [])
      .map((u) => ({
        name: (u.name ?? '').trim(),
        nowKnows: (u.nowKnows ?? '').trim() || undefined,
        clearMustNotKnow: (u.clearMustNotKnow ?? '').trim() || undefined
      }))
      .filter((u) => u.name && castNames.has(u.name.toLowerCase()))
      .filter((u) => u.nowKnows || u.clearMustNotKnow)
      .filter((u) =>
        !!u.clearMustNotKnow || knowledgeStillNovel(u.name, u.nowKnows, knownFactTexts)
      )
      .slice(0, 12),
    relationshipUpdates: (result.relationshipUpdates ?? [])
      .map((u) => ({
        from: (u.from ?? '').trim(),
        to: (u.to ?? '').trim(),
        kind: (u.kind ?? '').trim() || undefined,
        note: (u.note ?? '').trim() || undefined
      }))
      .filter((u) =>
        u.from && u.to &&
        castNames.has(u.from.toLowerCase()) &&
        (castNames.has(u.to.toLowerCase()) || characters.some((c) => c.isPlayer && c.name.toLowerCase() === u.to.toLowerCase()))
      )
      .slice(0, 12),
    premisePreview: season.premise || '',
    storyDayStart: dayStart,
    storyDayEnd,
    nextStoryDay,
    dateNote: (result.dateNote ?? '').trim(),
    hitTargets: (result.hitTargets ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 10),
    hitCalendarEvents: matchCalendarEventsByTitle(
      dueCalendarEvents,
      (result.hitCalendarEvents ?? []).map((t) => {
        const s = t.trim();
        // Accept raw ids returned by the model.
        if (dueCalendarEvents.some((e) => e.id === s)) return { id: s, title: '' };
        return s;
      })
    ).map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      storyDay: e.storyDay
    })).slice(0, 10),
    place: normalizePlacePatch(
      result.place
        ? {
          ...result.place,
          name: (result.place.name || sceneLoc?.name || episode.location || '').trim()
        }
        : null
    ),
    elsewhere: normalizePlacePatches(result.elsewhere, 4)
      .filter((p) => {
        const sceneName = (sceneLoc?.name ?? episode.location).trim().toLowerCase();
        return !sceneName || p.name.trim().toLowerCase() !== sceneName;
      }),
    meanwhile: clipMeanwhile(result.meanwhile)
  };

  try {
    draftCore.premisePreview = await evolveSeasonPremise(world, season, {
      recap: draftCore.recap,
      beats: draftCore.beats,
      facts: draftCore.facts,
      threads: draftCore.threads,
      guestEffects: draftCore.guestEffects
    });
  } catch (e) {
    logAppError(e, 'premise preview');
    draftCore.premisePreview = season.premise || '';
  }

  return draftCore;
}

export interface CommitEpisodeWrapInput {
  recap: string;
  beats: EpisodeWrapBeat[];
  facts: string[];
  threads: string[];
  guestEffects: string[];
  resolvedThreads?: string[];
  /** Known facts to drop from continuity (no longer true). */
  staleFacts?: string[];
  characterUpdates?: EpisodeWrapCharacterUpdate[];
  knowledgeUpdates?: EpisodeWrapKnowledgeUpdate[];
  relationshipUpdates?: EpisodeWrapRelationshipUpdate[];
  premisePreview?: string;
  storyDayStart?: number;
  storyDayEnd?: number;
  /** Story day the next episode should open on */
  nextStoryDay?: number;
  dateNote?: string;
  /** Kept beat texts aimed at the next episode as plot targets. */
  aimedBeatTexts?: string[];
  /** Pending plot target texts the author confirmed as hit this episode. */
  hitTargets?: string[];
  /** Calendar event ids (preferred) or titles the author confirmed as played. */
  hitCalendarEvents?: Array<{ id?: string; title?: string } | string>;
  /** Lasting condition of the scene location; atmosphere rides to the next episode. */
  place?: PlacePatch | null;
  elsewhere?: PlacePatch[];
  meanwhile?: string;
}

/**
 * Evolve the season premise into living plot pressure from an episode wrap.
 * Present tense, 2–4 sentences; no spoilers beyond established events.
 */
export async function evolveSeasonPremise(
  world: World,
  season: Season,
  wrap: CommitEpisodeWrapInput
): Promise<string> {
  const beats = wrap.beats
    .filter((b) => b.text.trim())
    .map((b) => `- ${b.text.trim()}${b.consequence?.trim() ? ` → ${b.consequence.trim()}` : ''}`)
    .join('\n');
  const facts = wrap.facts.map((f) => f.trim()).filter(Boolean);
  const threads = wrap.threads.map((t) => t.trim()).filter(Boolean);

  const { provider, model } = utilityModelFor(world);
  const { text: premise } = await streamChat({
    provider,
    model,
    system:
      'You update season premises for longform interactive fiction after an episode ends. ' +
      'Rewrite the premise as living current pressure: where the plot is NOW, what hangs over the next episode. ' +
      'One paragraph, 2–4 sentences, present tense, concrete and pressurized. ' +
      'Carry forward unresolved stakes; do not invent events beyond the wrap. ' +
      'No preamble — return only the premise.',
    messages: [{
      role: 'user',
      content:
        `World: ${world.title}. Season ${season.number}.\n` +
        `Current premise:\n${season.premise || '(blank)'}\n\n` +
        `Episode recap:\n${wrap.recap.trim()}\n\n` +
        (beats ? `Beats:\n${beats}\n\n` : '') +
        (facts.length ? `New facts:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` : '') +
        (threads.length ? `Open threads:\n${threads.map((t) => `- ${t}`).join('\n')}\n\n` : '') +
        (wrap.guestEffects.length
          ? `Guest effects:\n${wrap.guestEffects.map((g) => `- ${g}`).join('\n')}\n`
          : '')
    }],
    maxTokens: 400
  });
  const next = premise.trim();
  return next || season.premise;
}

/** Match wrap "resolved" lines to open threads (exact, contains, then token overlap). */
function matchOpenThreads(
  open: OpenThread[],
  resolvedLines: string[]
): OpenThread[] {
  return matchByExactContainsOrTokens(open, resolvedLines, (t) => t.text);
}

/** Match wrap hit-target lines to pending plot targets (exact, contains, then token overlap). */
export function matchPlotTargets(
  targets: PlotTarget[],
  hitLines: string[]
): PlotTarget[] {
  const pending = targets.filter((t) => t.status === 'pending');
  return matchByExactContainsOrTokens(pending, hitLines, (t) => t.text);
}

/** Match wrap hits to calendar events by id first, then title. */
export function matchCalendarEventsByTitle(
  events: CalendarEvent[],
  hitLines: Array<{ id?: string; title?: string } | string>
): CalendarEvent[] {
  const matched: CalendarEvent[] = [];
  const used = new Set<string>();
  for (const raw of hitLines) {
    const id = typeof raw === 'string' ? '' : (raw.id ?? '').trim();
    const title = typeof raw === 'string' ? raw.trim() : (raw.title ?? '').trim();
    if (id) {
      const byId = events.find((e) => !used.has(e.id) && e.id === id);
      if (byId) {
        used.add(byId.id);
        matched.push(byId);
        continue;
      }
    }
    const key = title.toLowerCase();
    if (!key) continue;
    let hit = events.find((e) => !used.has(e.id) && e.title.trim().toLowerCase() === key);
    if (!hit) {
      hit = events.find((e) => {
        if (used.has(e.id)) return false;
        const tKey = e.title.trim().toLowerCase();
        if (key.length < 8 && tKey.length > key.length * 2) return false;
        return tKey.includes(key) || key.includes(tKey);
      });
    }
    if (!hit) {
      let best: CalendarEvent | undefined;
      let bestScore = 0.62;
      for (const e of events) {
        if (used.has(e.id)) continue;
        const score = textMatchScore(key, e.title);
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
      hit = best;
    }
    if (hit) {
      used.add(hit.id);
      matched.push(hit);
    }
  }
  return matched;
}

function markTargetsHit(list: PlotTarget[] | undefined, hitIds: Set<string>): PlotTarget[] | undefined {
  if (!list?.length || hitIds.size === 0) return list;
  return list.map((t) => (hitIds.has(t.id) ? { ...t, status: 'hit' as const } : t));
}

/**
 * Persist wrap onto the ended episode, file continuity/threads, evolve premise,
 * update cast state, open the next episode.
 */
export async function commitEpisodeWrap(
  world: World,
  season: Season,
  episode: Episode,
  input: CommitEpisodeWrapInput
): Promise<Episode> {
  const wrap: EpisodeWrap = {
    recap: input.recap.trim(),
    beats: input.beats.filter((b) => b.text.trim()),
    guestEffects: input.guestEffects.map((g) => g.trim()).filter(Boolean)
  };

  const cal = worldCalendar(world);
  const dayStart = Math.max(1, input.storyDayStart ?? episode.storyDay ?? cal.currentDay);
  const dayEnd = Math.max(dayStart, input.storyDayEnd ?? cal.currentDay);
  const dateNote = (input.dateNote ?? '').trim();
  const dateFact =
    `Episode ${episode.number}` +
    `${episode.title ? ` (${episode.title})` : ''}` +
    `${episode.location ? ` @ ${episode.location}` : ''}` +
    ` — ${formatEpisodeDateRange(cal, dayStart, dayEnd)}` +
    (dateNote ? `. ${dateNote}` : '.');

  const hitLines = (input.hitTargets ?? []).map((t) => t.trim()).filter(Boolean);
  const epHits = matchPlotTargets(episode.plotTargets ?? [], hitLines);
  const seasonHits = matchPlotTargets(season.plotTargets ?? [], hitLines);
  const epHitIds = new Set(epHits.map((t) => t.id));
  const seasonHitIds = new Set(seasonHits.map((t) => t.id));
  const episodeTargetsNext = markTargetsHit(episode.plotTargets, epHitIds);
  const seasonTargetsNext = markTargetsHit(season.plotTargets, seasonHitIds);

  await db.episodes.update(episode.id, {
    wrap,
    storyDay: dayStart,
    storyDayEnd: dayEnd,
    dateNote: dateNote || null,
    ...(episodeTargetsNext ? { plotTargets: episodeTargetsNext } : {}),
    updatedAt: Date.now()
  });
  if (seasonTargetsNext) {
    await db.seasons.update(season.id, { plotTargets: seasonTargetsNext, updatedAt: Date.now() });
  }

  // Sync world "today" to the episode end before nextEpisode advances.
  if (cal.currentDay !== dayEnd) {
    const live = await db.worlds.get(world.id);
    if (live) {
      await db.worlds.update(world.id, {
        calendar: calendarPatch(live, { currentDay: dayEnd }),
        updatedAt: Date.now()
      });
    }
  }

  const now = Date.now();
  const existingRows = await db.continuity.where('seasonId').equals(season.id).toArray();
  const prunedIds = new Set<string>();
  for (const line of (input.staleFacts ?? []).map((t) => t.trim()).filter(Boolean)) {
    const hit = existingRows.find((f) =>
      !prunedIds.has(f.id)
      && !f.pinned
      && (
        f.text.trim().toLowerCase() === line.toLowerCase()
        || isNearDuplicate(line, [f.text])
        || isNearDuplicate(f.text, [line])
      )
    );
    if (!hit) continue;
    prunedIds.add(hit.id);
    await db.continuity.delete(hit.id);
  }
  const remainingFactTexts = existingRows
    .filter((f) => !prunedIds.has(f.id))
    .map((f) => f.text);

  // Guest effects stay on episode.wrap for prior-episode prompts — do not also file into continuity.
  const factLines = [
    dateFact,
    ...novelLines(input.facts, [...remainingFactTexts, dateFact], WRAP_NEW_FACT_CAP)
  ];
  if (factLines.length > 0) {
    await db.continuity.bulkAdd(
      factLines.map((text) => ({
        id: uid(), worldId: world.id, seasonId: season.id, episodeId: episode.id,
        text, source: 'auto' as const, createdAt: now
      }))
    );
    remainingFactTexts.push(...factLines);
  }

  const openForDedupe = await db.threads
    .where('seasonId')
    .equals(season.id)
    .filter((t) => t.status === 'open')
    .toArray();
  const threadLines = novelLines(
    input.threads,
    openForDedupe.map((t) => t.text),
    WRAP_NEW_THREAD_CAP
  );
  if (threadLines.length > 0) {
    await db.threads.bulkAdd(
      threadLines.map((text) => ({
        id: uid(), worldId: world.id, seasonId: season.id, text,
        openedLabel: `opened S${season.number} · E${episode.number}`,
        status: 'open' as const, createdAt: now
      }))
    );
  }

  const resolvedLines = (input.resolvedThreads ?? []).map((t) => t.trim()).filter(Boolean);
  if (resolvedLines.length > 0) {
    const open = await db.threads
      .where('seasonId')
      .equals(season.id)
      .filter((t) => t.status === 'open')
      .toArray();
    const hits = matchOpenThreads(open, resolvedLines);
    for (const t of hits) {
      await db.threads.update(t.id, { status: 'resolved', updatedAt: now });
    }
  }

  const cast = await db.characters.where('worldId').equals(world.id).toArray();
  const byName = (name: string) =>
    cast.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());

  const updates = input.characterUpdates ?? [];
  for (const u of updates) {
    const c = byName(u.name);
    if (!c || c.isPlayer) continue;
    const state = {
      goal: mergeStateField(u.goal, c.state.goal),
      emotion: mergeStateField(u.emotion, c.state.emotion),
      location: mergeStateField(u.location, c.state.location),
      condition: mergeStateField(u.condition, c.state.condition)
    };
    if (
      state.goal === c.state.goal &&
      state.emotion === c.state.emotion &&
      state.location === c.state.location &&
      state.condition === c.state.condition
    ) {
      continue;
    }
    await db.characters.update(c.id, { state, updatedAt: now });
    c.state = state;
  }

  for (const k of input.knowledgeUpdates ?? []) {
    const c = byName(k.name);
    if (!c || c.isPlayer) continue;
    let mustNotKnow = c.mustNotKnow;
    const clear = k.clearMustNotKnow?.trim();
    if (clear && mustNotKnow) {
      const parts = mustNotKnow
        .split(/[.;\n]+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => {
          const pl = p.toLowerCase();
          const cl = clear.toLowerCase();
          return !(pl.includes(cl) || cl.includes(pl));
        });
      mustNotKnow = parts.join('; ');
    }
    if (k.nowKnows?.trim()) {
      const line = `${c.name} now knows: ${k.nowKnows.trim()}`;
      if (knowledgeStillNovel(c.name, k.nowKnows, remainingFactTexts)) {
        await db.continuity.add({
          id: uid(),
          worldId: world.id,
          seasonId: season.id,
          episodeId: episode.id,
          text: line,
          source: 'auto',
          createdAt: now
        });
        remainingFactTexts.push(line);
      }
    }
    if (mustNotKnow !== c.mustNotKnow) {
      await db.characters.update(c.id, { mustNotKnow, updatedAt: now });
      c.mustNotKnow = mustNotKnow;
    }
  }

  for (const r of input.relationshipUpdates ?? []) {
    const from = byName(r.from);
    const to = byName(r.to);
    if (!from || !to || from.id === to.id) continue;
    const nextRels = normalizeRelationships(
      [
        ...from.relationships.filter((edge) => edge.targetId !== to.id),
        {
          targetId: to.id,
          kind: (r.kind ?? '').trim() || 'linked',
          note: (r.note ?? '').trim()
        }
      ],
      cast.map((c) => c.id),
      from.id
    );
    await db.characters.update(from.id, { relationships: nextRels, updatedAt: now });
    from.relationships = nextRels;
  }

  const premiseNext = (input.premisePreview ?? '').trim();
  if (premiseNext) {
    await db.seasons.update(season.id, { premise: premiseNext, updatedAt: Date.now() });
  } else {
    try {
      const evolved = await evolveSeasonPremise(world, season, {
        ...input,
        recap: wrap.recap,
        beats: wrap.beats,
        guestEffects: wrap.guestEffects
      });
      if (evolved.trim()) {
        await db.seasons.update(season.id, { premise: evolved.trim(), updatedAt: Date.now() });
      }
    } catch (e) {
      // Non-fatal — wrap and next episode still proceed with the prior premise.
      logAppError(e, 'premise evolution');
    }
  }

  const nextDay = Math.max(
    dayEnd,
    input.nextStoryDay != null && Number.isFinite(input.nextStoryDay)
      ? Math.floor(input.nextStoryDay)
      : dayEnd + cal.episodeAdvanceDays
  );
  const gap = gapDays(dayEnd, nextDay);

  const places = await db.locations.where('worldId').equals(world.id).toArray();
  if (input.place) {
    await applyPlacePatches(places, [input.place], episode.locationId);
  }
  if ((input.elsewhere ?? []).length > 0) {
    await applyPlacePatches(places, input.elsewhere ?? [], undefined);
  }

  const meanwhileLine = meanwhileFact({
    episodeNumber: episode.number,
    gap,
    text: input.meanwhile ?? ''
  });
  if (meanwhileLine) {
    await db.continuity.add({
      id: uid(),
      worldId: world.id,
      seasonId: season.id,
      episodeId: episode.id,
      text: meanwhileLine,
      source: 'auto',
      createdAt: Date.now()
    });
  }

  const nextAtmosphere = nextAtmosphereNote({
    carried: episode.atmosphereNote,
    override: input.place?.atmosphere,
    gap
  });

  // Mark author-confirmed calendar events as played BEFORE wrap miss evaluation.
  const playedIds = new Set<string>();
  if (worldCalendarEventPrefs(world).enabled) {
    const hitCal = input.hitCalendarEvents ?? [];
    if (hitCal.length > 0) {
      const seasonEvents = await db.calendarEvents.where('seasonId').equals(season.id).toArray();
      const matched = matchCalendarEventsByTitle(
        seasonEvents.filter((e) =>
          e.status === 'due' || e.status === 'scheduled' || e.status === 'missed'
        ),
        hitCal
      );
      const nowCal = Date.now();
      for (const ev of matched) {
        playedIds.add(ev.id);
        await db.calendarEvents.update(ev.id, { status: 'played', updatedAt: nowCal });
        const factText = `Calendar: ${ev.title.trim()}${ev.summary.trim() ? ` — ${ev.summary.trim()}` : ''}`;
        await db.continuity.add({
          id: uid(),
          worldId: world.id,
          seasonId: season.id,
          episodeId: episode.id,
          text: factText.slice(0, 400),
          source: 'auto',
          createdAt: nowCal
        });
      }
    }
  }

  // Activate / miss remaining calendar events across this episode's date span.
  await evaluateCalendarEvents({
    worldId: world.id,
    seasonId: season.id,
    fromDay: dayStart,
    toDay: dayEnd,
    mode: 'wrap',
    world,
    excludeIds: playedIds
  });

  const aimedTexts = (input.aimedBeatTexts ?? []).map((t) => t.trim()).filter(Boolean);
  // Carry unfinished pending from the ending episode (after hit marks applied).
  const carriedPending = pendingPlotTargets(episodeTargetsNext ?? episode.plotTargets);
  const nextPlotTargets = buildEpisodePlotTargets({
    aimedTexts,
    carried: carriedPending
  });
  const next = await nextEpisode(
    {
      ...episode,
      wrap,
      storyDay: dayStart,
      storyDayEnd: dayEnd,
      dateNote: dateNote || null,
      plotTargets: episodeTargetsNext ?? episode.plotTargets
    },
    {
      storyDayEnd: dayEnd,
      nextStoryDay: nextDay,
      dateNote: dateNote || null,
      plotTargets: nextPlotTargets,
      atmosphereNote: nextAtmosphere ?? null
    }
  );
  await db.worlds.update(world.id, { updatedAt: Date.now() });
  return next;
}

/** Step 1 of the sequel pipeline: read the season, propose beats + character outcomes. */
export async function analyzeSeason(world: World, season: Season): Promise<SeasonWrap> {
  const episodes = await db.episodes.where('seasonId').equals(season.id).sortBy('number');
  const characters = await db.characters.where('worldId').equals(world.id).toArray();

  // Map-reduce: summarize each episode, then analyze the summaries.
  const episodeSummaries: string[] = [];
  for (const ep of episodes) {
    const turns = await db.turns.where('episodeId').equals(ep.id).sortBy('createdAt');
    if (turns.length === 0) continue;
    const guests = ep.guests ?? [];
    const text = turns.map((t) => labelTurn(t, characters, guests)).join('\n\n');
    if (text.length < 6000) {
      episodeSummaries.push(`Episode ${ep.number}${ep.title ? ` (${ep.title})` : ''}:\n${text}`);
    } else {
      const { provider, model } = utilityModelFor(world);
      const { text: summary } = await streamChat({
        provider, model,
        system: 'Summarize this story episode in 150-250 words, keeping every event that could matter later: decisions, revelations, injuries, promises, relationship shifts.',
        messages: [{ role: 'user', content: text.slice(0, 48000) }],
        maxTokens: 800, temperature: 0.3
      });
      episodeSummaries.push(`Episode ${ep.number}${ep.title ? ` (${ep.title})` : ''} (summary):\n${summary}`);
    }
  }

  const result = await utilityJson<{
    beats: { where: string; text: string; consequence: string }[];
    characters: { name: string; outcome: string }[];
  }>(
    world,
    `You are a story editor reviewing a finished season. Respond with JSON only:\n{"beats": [{"where": "S${season.number} · E<n> · <place>", "text": "<what happened, one sentence>", "consequence": "<what it left behind, one sentence>"}], "characters": [{"name": "<character name>", "outcome": "<where the season leaves them, 1-2 sentences>"}]}\nExtract 4-7 beats — the events that will shape what comes next. Cover every named character in "characters".`,
    `World: ${world.title}. Season ${season.number} premise: ${season.premise}\n\nCast: ${characters.map((c) => c.name).join(', ')}\n\n${episodeSummaries.join('\n\n---\n\n').slice(0, 60000)}`,
    4000
  );

  const now = Date.now();
  const wrap: SeasonWrap = {
    id: uid(), seasonId: season.id, worldId: world.id,
    beats: result.beats.map((b) => ({ ...b, disposition: 'keep' as const })),
    characters: characters.map((c) => ({
      characterId: c.id,
      name: c.name,
      outcome: result.characters.find((r) => r.name.toLowerCase() === c.name.toLowerCase())?.outcome ?? '',
      evolution: '',
      returning: true
    })),
    gap: 1, premise: '', status: 'draft', createdAt: now, updatedAt: now
  };
  // One draft wrap per season: replace any previous draft.
  const old = await db.wraps.where('seasonId').equals(season.id).filter((w) => w.status === 'draft').toArray();
  if (old.length > 0) {
    await recordTombstones(old.map((w) => ({
      table: 'wraps' as const, id: w.id, worldId: w.worldId, seasonId: w.seasonId, payload: w
    })));
    await db.wraps.bulkDelete(old.map((w) => w.id));
  }
  await db.wraps.add(wrap);
  return wrap;
}

/** Step 3: propose cast / relationship / plot evolution across the time gap. */
export async function evolveCharacters(world: World, wrap: SeasonWrap, gapLabel: string): Promise<SeasonWrap> {
  const returning = wrap.characters.filter((c) => c.returning);
  if (returning.length === 0) return wrap;

  const cast = await db.characters.where('worldId').equals(world.id).toArray();
  const byId = new Map(cast.map((c) => [c.id, c]));
  const season = await db.seasons.get(wrap.seasonId);

  const sheetBrief = (c: Character) => {
    const rels = c.relationships
      .map((r) => {
        const t = cast.find((x) => x.id === r.targetId);
        return t ? `${r.kind} of ${t.name}${r.note ? ` (${r.note})` : ''}` : null;
      })
      .filter(Boolean)
      .slice(0, 6)
      .join('; ');
    return [
      `Name: ${c.name}${c.isPlayer ? ' (PLAYER)' : ''}`,
      c.role && `Role: ${c.role}`,
      c.summary && `Summary: ${c.summary.slice(0, 280)}`,
      c.traits && `Traits: ${c.traits.slice(0, 160)}`,
      c.desires && `Desires: ${c.desires.slice(0, 160)}`,
      c.fears && `Fears: ${c.fears.slice(0, 160)}`,
      c.flaws && `Flaws: ${c.flaws.slice(0, 120)}`,
      c.mustNotKnow && `Must not know: ${c.mustNotKnow.slice(0, 200)}`,
      rels && `Relationships: ${rels}`,
      (c.state.goal || c.state.emotion || c.state.location || c.state.condition) &&
        `Live state: goal=${c.state.goal || '—'}; emotion=${c.state.emotion || '—'}; location=${c.state.location || '—'}; condition=${c.state.condition || '—'}`
    ].filter(Boolean).join('\n');
  };

  const pendingSeason = pendingPlotTargets(season?.plotTargets)
    .map((t) => `- ${t.text}`)
    .join('\n');

  type EvolveResult = {
    characters?: Array<{
      name: string;
      evolution?: string;
      statePatch?: Partial<CharacterState>;
      sheetPatch?: WrapCharacterOutcome['sheetPatch'];
      knowledge?: WrapCharacterOutcome['knowledge'];
    }>;
    relationshipUpdates?: Array<{ from: string; to: string; kind?: string; note?: string }>;
    plotArc?: Array<{ text: string }>;
  };

  const result = await utilityJson<EvolveResult>(
    world,
    'You are a senior story editor handing a cast from one finished season into the next. ' +
    'Propose only earned changes across the time gap. Respond with JSON only:\n' +
    '{"characters":[{' +
    '"name":string,' +
    '"evolution":"<1-2 sentences of what changed off-screen>",' +
    '"statePatch":{"goal"?:string,"emotion"?:string,"location"?:string,"condition"?:string},' +
    '"sheetPatch":{"role"?:string,"summary"?:string,"traits"?:string,"desires"?:string,"fears"?:string,"flaws"?:string},' +
    '"knowledge":{"nowKnows"?:string,"clearMustNotKnow"?:string}' +
    '}],' +
    '"relationshipUpdates":[{"from":"<exact name>","to":"<exact name>","kind":string,"note":string}],' +
    '"plotArc":[{"text":"<season-arc pressure for next season>"}]}' +
    '\nRules:\n' +
    '- Prefer omission over noise — omit unchanged fields entirely.\n' +
    '- Never rewrite speechStyle, example lines, anchors, or customInstructions.\n' +
    '- sheetPatch: only for non-player NPCs; concrete earned shifts (1-2 sentences max per field).\n' +
    '- PLAYER characters: evolution + light statePatch only — no sheetPatch.\n' +
    '- statePatch: how they OPEN the next season, not a recap dump.\n' +
    '- relationshipUpdates: only edges that shifted; use exact cast names.\n' +
    '- plotArc: 2-5 distinct arc pressures for season N+1; do not duplicate Raise beats already listed.\n' +
    '- knowledge.clearMustNotKnow: substring of their wall they can now safely lose; nowKnows: what they learned.',
    `World: ${world.title}\nTime gap before next season: ${gapLabel}\n\n` +
    `Beats carried forward:\n${wrap.beats.filter((b) => b.disposition !== 'drop').map((b) => `- [${b.disposition}] ${b.text} → ${b.consequence}`).join('\n') || '(none)'}\n\n` +
    `Raise beats (already become season plot targets — do not restate in plotArc):\n${wrap.beats.filter((b) => b.disposition === 'raise').map((b) => `- ${b.text} → ${b.consequence}`).join('\n') || '(none raised)'}\n\n` +
    `Pending season plot targets still open:\n${pendingSeason || '(none)'}\n\n` +
    `Returning cast sheets:\n${returning.map((w) => {
      const c = byId.get(w.characterId);
      const head = `- ${w.name}: season outcome — ${w.outcome || 'unknown'}`;
      return c ? `${head}\n${sheetBrief(c)}` : head;
    }).join('\n\n')}`,
    4500
  );

  const charResults = result.characters ?? [];
  const relUpdates: SeasonWrapRelationshipUpdate[] = (result.relationshipUpdates ?? [])
    .map((r) => ({
      from: (r.from ?? '').trim(),
      to: (r.to ?? '').trim(),
      kind: (r.kind ?? '').trim() || undefined,
      note: (r.note ?? '').trim() || undefined,
      keep: true
    }))
    .filter((r) => r.from && r.to && r.from.toLowerCase() !== r.to.toLowerCase());

  const plotArc: SeasonWrapPlotArc[] = (result.plotArc ?? [])
    .map((p) => ({ text: (p.text ?? '').trim(), keep: true }))
    .filter((p) => p.text);

  const cleanState = (raw?: Partial<CharacterState>): Partial<CharacterState> | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const next: Partial<CharacterState> = {};
    for (const key of ['goal', 'emotion', 'location', 'condition'] as const) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim()) next[key] = v.trim();
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  const cleanSheet = (
    raw?: WrapCharacterOutcome['sheetPatch'],
    isPlayer?: boolean
  ): WrapCharacterOutcome['sheetPatch'] | undefined => {
    if (isPlayer || !raw || typeof raw !== 'object') return undefined;
    const next: NonNullable<WrapCharacterOutcome['sheetPatch']> = {};
    for (const key of ['role', 'summary', 'traits', 'desires', 'fears', 'flaws'] as const) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim()) next[key] = v.trim();
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  const cleanKnowledge = (
    raw?: WrapCharacterOutcome['knowledge']
  ): WrapCharacterOutcome['knowledge'] | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const nowKnows = raw.nowKnows?.trim() || undefined;
    const clearMustNotKnow = raw.clearMustNotKnow?.trim() || undefined;
    if (!nowKnows && !clearMustNotKnow) return undefined;
    return { nowKnows, clearMustNotKnow };
  };

  const updated: SeasonWrap = {
    ...wrap,
    characters: wrap.characters.map((c) => {
      if (!c.returning) return c;
      const hit = charResults.find((r) => r.name.toLowerCase() === c.name.toLowerCase());
      if (!hit) return c;
      const sheet = byId.get(c.characterId);
      const sheetPatch = cleanSheet(hit.sheetPatch, sheet?.isPlayer);
      const statePatch = cleanState(hit.statePatch);
      const knowledge = cleanKnowledge(hit.knowledge);
      return {
        ...c,
        evolution: hit.evolution?.trim() || c.evolution,
        sheetPatch,
        statePatch,
        knowledge,
        keepSheet: sheetPatch ? true : undefined,
        keepState: statePatch ? true : undefined,
        keepKnowledge: knowledge ? true : undefined
      };
    }),
    relationshipUpdates: relUpdates,
    plotArc,
    updatedAt: Date.now()
  };
  await db.wraps.put(updated);
  return updated;
}

/** Merge season-open state from wrap outcome (exported for tests). */
export function mergeSeasonOpenState(
  prior: CharacterState,
  outcome: Pick<WrapCharacterOutcome, 'evolution' | 'outcome' | 'statePatch' | 'keepState'>
): CharacterState {
  if (outcome.keepState === false) {
    return { ...prior };
  }
  const patch = outcome.statePatch;
  const conditionFallback = (outcome.evolution || outcome.outcome || prior.condition).trim();
  // Only replace goal/emotion when statePatch explicitly provides them.
  // Without a statePatch, keep prior goal/emotion and only refresh condition from evolution.
  if (!patch) {
    return {
      goal: prior.goal,
      emotion: prior.emotion,
      location: prior.location,
      condition: conditionFallback || prior.condition
    };
  }
  return {
    goal: patch.goal !== undefined ? patch.goal.trim() : prior.goal,
    emotion: patch.emotion !== undefined ? patch.emotion.trim() : prior.emotion,
    location: patch.location !== undefined ? patch.location.trim() : prior.location,
    condition: patch.condition !== undefined
      ? patch.condition.trim()
      : (conditionFallback || prior.condition)
  };
}

/** Merge earned sheet fields; never touches voice/anchors (exported for tests). */
export function mergeSeasonSheetPatch(
  character: Character,
  outcome: Pick<WrapCharacterOutcome, 'sheetPatch' | 'keepSheet'>
): Partial<Character> | null {
  if (character.isPlayer || outcome.keepSheet === false || !outcome.sheetPatch) return null;
  const patch: Partial<Character> = {};
  const src = outcome.sheetPatch;
  for (const key of ['role', 'summary', 'traits', 'desires', 'fears', 'flaws'] as const) {
    const v = src[key]?.trim();
    if (v) patch[key] = v;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Strip matching clauses from mustNotKnow (exported for tests). */
export function clearMustNotKnowClauses(mustNotKnow: string, clear?: string): string {
  const needle = (clear ?? '').trim();
  if (!needle || !mustNotKnow.trim()) return mustNotKnow;
  const parts = mustNotKnow
    .split(/[.;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const pl = p.toLowerCase();
      const cl = needle.toLowerCase();
      return !(pl.includes(cl) || cl.includes(pl));
    });
  return parts.join('; ');
}

/** Apply relationship name-pairs onto an in-memory cast list (exported for tests). */
export function applySeasonRelationshipUpdates(
  cast: Character[],
  updates: SeasonWrapRelationshipUpdate[] | undefined
): Character[] {
  if (!updates?.length) return cast;
  const next = cast.map((c) => ({ ...c, relationships: [...c.relationships] }));
  const byName = (name: string) =>
    next.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  const ids = next.map((c) => c.id);
  for (const r of updates) {
    if (r.keep === false) continue;
    const from = byName(r.from);
    const to = byName(r.to);
    if (!from || !to || from.id === to.id) continue;
    from.relationships = normalizeRelationships(
      [
        ...from.relationships.filter((edge) => edge.targetId !== to.id),
        {
          targetId: to.id,
          kind: (r.kind ?? '').trim() || 'linked',
          note: (r.note ?? '').trim()
        }
      ],
      ids,
      from.id
    );
  }
  return next;
}

/** Draft (or redraft) the next-season premise from the wrap sheet. */
export async function draftPremise(world: World, season: Season, wrap: SeasonWrap, gapLabel: string): Promise<string> {
  const { provider, model } = utilityModelFor(world);
  const keptArc = (wrap.plotArc ?? []).filter((p) => p.keep !== false && p.text.trim());
  const keptRels = (wrap.relationshipUpdates ?? []).filter((r) => r.keep !== false);
  const { text: premise } = await streamChat({
    provider, model,
    system: 'You write season premises for longform interactive fiction. One paragraph, 2-4 sentences, present tense, concrete and pressurized. Open on the raised beats. No preamble — return only the premise.',
    messages: [{
      role: 'user',
      content:
        `World: ${world.title} — ${world.line}\nSeason ${season.number} just ended. Season ${season.number + 1} opens ${gapLabel.toLowerCase()} later.\n\n` +
        `Beats:\n${wrap.beats.filter((b) => b.disposition !== 'drop').map((b) => `- [${b.disposition}] ${b.text} → ${b.consequence}`).join('\n') || '(none carried)'}\n\n` +
        `Returning cast:\n${wrap.characters.filter((c) => c.returning).map((c) => `- ${c.name}: ${c.evolution || c.outcome}`).join('\n')}` +
        (keptRels.length
          ? `\n\nRelationship shifts:\n${keptRels.map((r) => `- ${r.from} → ${r.to}: ${r.kind || 'linked'}${r.note ? ` — ${r.note}` : ''}`).join('\n')}`
          : '') +
        (keptArc.length
          ? `\n\nExtra plot pressures:\n${keptArc.map((p) => `- ${p.text}`).join('\n')}`
          : '')
    }],
    maxTokens: 500, temperature: 0.9
  });
  return premise.trim();
}

/** Resolve season-open place from the prior season's last episode (pure — easy to test). */
export function seasonOpenPlaceFromLastEpisode(
  lastEp: { location: string; locationId?: string | null } | undefined,
  resolveLocation: (id: string) => { id: string; name: string } | undefined
): { location: string; locationId: string | null } {
  if (!lastEp) return { location: '', locationId: null };
  if (lastEp.locationId) {
    const loc = resolveLocation(lastEp.locationId);
    if (loc) {
      return { locationId: loc.id, location: loc.name || lastEp.location || '' };
    }
  }
  if (lastEp.location.trim()) {
    return { location: lastEp.location.trim(), locationId: null };
  }
  return { location: '', locationId: null };
}

/** Steps 4-5: build the season bible, create season N+1, evolve character sheets/state. */
export async function beginNextSeason(world: World, season: Season, wrap: SeasonWrap, gapLabel: string): Promise<Season> {
  const { provider, model } = utilityModelFor(world);

  const kept = wrap.beats.filter((b) => b.disposition !== 'drop');
  const { text: recap } = await streamChat({
    provider, model,
    system: 'You write "previously on" recaps for longform stories. Write one recap paragraph (120-220 words) weighted by disposition: RAISE beats vivid and present, KEEP beats brief, SOFTEN beats a single distant clause. Do not mention dropped events at all. Return only the recap.',
    messages: [{
      role: 'user',
      content: `World: ${world.title}\n\nBeats:\n${kept.map((b) => `- [${b.disposition}] ${b.text} → ${b.consequence}`).join('\n') || '(nothing carried)'}`
    }],
    maxTokens: 700, temperature: 0.6
  });

  const offscreenLines: string[] = wrap.characters
    .filter((c) => c.returning && c.evolution)
    .map((c) => `- ${c.name}: ${c.evolution}`);
  for (const c of wrap.characters) {
    if (!c.returning || c.keepSheet === false || !c.sheetPatch) continue;
    const bits = (['role', 'summary', 'desires', 'fears'] as const)
      .map((k) => c.sheetPatch?.[k]?.trim())
      .filter(Boolean);
    if (bits.length > 0) {
      offscreenLines.push(`- ${c.name} (sheet): ${bits[0]}`);
    }
  }
  const offscreen = offscreenLines.join('\n');

  const raised = wrap.beats.filter((b) => b.disposition === 'raise');
  const plotTargets = buildNextSeasonPlotTargets({
    raiseBeats: raised,
    plotArc: wrap.plotArc,
    carried: season.plotTargets
  });

  const next: Season = {
    id: uid(), worldId: world.id, number: season.number + 1,
    title: '', premise: wrap.premise, timeGap: gapLabel,
    bible: {
      recap: recap.trim(),
      carriedBeats: kept.map(({ where: _where, ...b }): { text: string; consequence: string; disposition: WrapBeat['disposition'] } => b),
      offscreenChanges: offscreen
    },
    plotTargets: plotTargets.length > 0 ? plotTargets : undefined,
    status: 'active', createdAt: Date.now(), updatedAt: Date.now()
  };

  const calForSeason = worldCalendar(world);
  const gapIdx = GAP_LABELS.indexOf(gapLabel);
  const seasonOpenDay = calForSeason.currentDay + (gapIdx >= 0 ? GAP_DAYS[gapIdx] : 0);

  const allCharacters = await db.characters.where('worldId').equals(world.id).toArray();
  const playerId = allCharacters.find((c) => c.isPlayer)?.id;
  const returningIds = wrap.characters.filter((c) => c.returning).map((c) => c.characterId);
  const castIds = playerId
    ? [playerId, ...returningIds.filter((id) => id !== playerId)]
    : returningIds;

  // Carry place into season-open E1 when the last episode still had a valid location.
  const priorEps = await db.episodes.where('seasonId').equals(season.id).toArray();
  const lastEp = [...priorEps].sort((a, b) => b.number - a.number)[0];
  const worldPlaces = await db.locations.where('worldId').equals(world.id).toArray();
  const placeById = new Map(worldPlaces.map((l) => [l.id, { id: l.id, name: l.name }]));
  const { location: openLocation, locationId: openLocationId } = seasonOpenPlaceFromLastEpisode(
    lastEp,
    (id) => placeById.get(id)
  );

  const firstEpisode: Episode = {
    id: uid(), seasonId: next.id, worldId: world.id, number: 1,
    title: '', location: openLocation, locationId: openLocationId,
    castIds,
    storyDay: Math.max(1, seasonOpenDay),
    storyDayEnd: null,
    dateNote: null,
    status: 'active', createdAt: Date.now(), updatedAt: Date.now()
  };

  await db.transaction(
    'rw',
    [db.seasons, db.episodes, db.worlds, db.wraps, db.characters, db.threads, db.continuity],
    async () => {
      await db.seasons.update(season.id, { status: 'wrapped', updatedAt: Date.now() });
      await db.seasons.add(next);
      await db.episodes.add(firstEpisode);
      const liveWorld = await db.worlds.get(world.id);
      await db.worlds.update(world.id, {
        activeSeasonId: next.id,
        calendar: calendarPatch(liveWorld ?? world, { currentDay: Math.max(1, seasonOpenDay) }),
        updatedAt: Date.now()
      });
      await db.wraps.update(wrap.id, { status: 'committed', updatedAt: Date.now() });

      const now = Date.now();
      const castLive = await db.characters.where('worldId').equals(world.id).toArray();
      const byId = new Map(castLive.map((c) => [c.id, c]));

      // Character state + sheet + knowledge for returning / departed.
      for (const outcome of wrap.characters) {
        const c = byId.get(outcome.characterId);
        if (!c) continue;
        // Player always returns; never stamp them as departed.
        const returning = c.isPlayer ? true : outcome.returning;
        if (!returning) {
          await db.characters.update(c.id, {
            state: { ...c.state, location: 'departed — not in this season' },
            updatedAt: now
          });
          continue;
        }

        const state = mergeSeasonOpenState(c.state, outcome);
        const sheet = mergeSeasonSheetPatch(c, outcome);
        let mustNotKnow = c.mustNotKnow;
        if (outcome.keepKnowledge !== false && outcome.knowledge) {
          mustNotKnow = clearMustNotKnowClauses(mustNotKnow, outcome.knowledge.clearMustNotKnow);
          if (outcome.knowledge.nowKnows?.trim()) {
            await db.continuity.add({
              id: uid(),
              worldId: world.id,
              seasonId: next.id,
              episodeId: firstEpisode.id,
              text: `${c.name} now knows: ${outcome.knowledge.nowKnows.trim()}`,
              source: 'auto',
              createdAt: now
            });
          }
        }
        const patch: Partial<Character> = {
          state,
          updatedAt: now,
          ...(sheet ?? {}),
          ...(mustNotKnow !== c.mustNotKnow ? { mustNotKnow } : {})
        };
        await db.characters.update(c.id, patch);
        // Keep in-memory list fresh for relationship apply.
        Object.assign(c, patch);
      }

      // Relationships after sheet updates so name resolution uses current cast.
      const relTouched = applySeasonRelationshipUpdates(
        [...byId.values()],
        wrap.relationshipUpdates
      );
      for (const c of relTouched) {
        const prior = byId.get(c.id);
        if (!prior) continue;
        const same =
          prior.relationships.length === c.relationships.length &&
          prior.relationships.every((r, i) =>
            r.targetId === c.relationships[i]?.targetId &&
            r.kind === c.relationships[i]?.kind &&
            r.note === c.relationships[i]?.note
          );
        if (!same) {
          await db.characters.update(c.id, { relationships: c.relationships, updatedAt: now });
        }
      }

      // Carry durable facts into the new season (prompts load by seasonId).
      const priorFacts = await db.continuity.where('seasonId').equals(season.id).toArray();
      const carriedFacts = [...priorFacts]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 24);
      const beatFacts = kept
        .filter((b) => b.disposition === 'raise' || b.disposition === 'keep')
        .slice(0, 8)
        .map((b) => ({
          id: uid(),
          worldId: world.id,
          seasonId: next.id,
          text: `${b.text.trim()}${b.consequence?.trim() ? ` → ${b.consequence.trim()}` : ''}`,
          source: 'auto' as const,
          createdAt: now
        }))
        .filter((f) => f.text.trim());
      const migrated = carriedFacts.map((f) => ({
        id: uid(),
        worldId: world.id,
        seasonId: next.id,
        episodeId: f.episodeId,
        text: f.text,
        source: f.source,
        createdAt: now
      }));
      // Prefer beat seeds first, then prior facts; dedupe by normalized text.
      const seen = new Set<string>();
      const toAdd = [...beatFacts, ...migrated].filter((f) => {
        const key = f.text.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 32);
      if (toAdd.length > 0) await db.continuity.bulkAdd(toAdd);

      // Dropped beats close matching threads; surviving open threads from this season move forward.
      const threads = await db.threads
        .where('seasonId')
        .equals(season.id)
        .filter((t) => t.status === 'open')
        .toArray();
      const dropLines = wrap.beats
        .filter((b) => b.disposition === 'drop')
        .flatMap((b) => [b.text, b.consequence].map((s) => (s ?? '').trim()).filter(Boolean));
      const droppedHits = matchOpenThreads(threads, dropLines);
      const droppedIds = new Set(droppedHits.map((t) => t.id));
      for (const t of droppedHits) {
        await db.threads.update(t.id, { status: 'resolved', updatedAt: now });
      }
      for (const t of threads) {
        if (droppedIds.has(t.id)) continue;
        await db.threads.update(t.id, { seasonId: next.id });
      }
    }
  );

  // Close out overdue calendar texture on the wrapped season across the time gap.
  await evaluateCalendarEvents({
    worldId: world.id,
    seasonId: season.id,
    fromDay: calForSeason.currentDay,
    toDay: Math.max(1, seasonOpenDay),
    mode: 'wrap',
    world
  });

  // Optional AI seed for the new season's calendar texture.
  const nextPrefs = worldCalendarEventPrefs(world);
  if (nextPrefs.enabled && nextPrefs.aiSeedOnSeasonStart) {
    try {
      await seedSeasonCalendarEvents(world, next, { autoCommit: true });
    } catch (e) {
      logAppError(e, 'calendar seed on season start');
    }
  }

  return next;
}

export interface SeedCalendarEventDraft {
  title: string;
  summary: string;
  kind: CalendarEventKind;
  scale: CalendarEventScale;
  storyDay: number;
  endDay?: number;
  promptPolicy: CalendarEventPromptPolicy;
  characterIds?: string[];
}

/**
 * Propose dated season calendar texture via the utility model.
 * When autoCommit is true, writes scheduled events (capped) into Dexie.
 */
export async function seedSeasonCalendarEvents(
  world: World,
  season: Season,
  opts?: { autoCommit?: boolean; signal?: AbortSignal; horizonDays?: number }
): Promise<SeedCalendarEventDraft[]> {
  const cal = worldCalendar(world);
  const openDay = Math.max(1, cal.currentDay);
  const horizon = Math.max(30, Math.min(180, opts?.horizonDays ?? 90));
  const endDay = openDay + horizon;
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const existing = await db.calendarEvents.where('seasonId').equals(season.id).toArray();
  const activeCount = existing.filter((e) => e.status === 'scheduled' || e.status === 'due').length;
  const room = Math.max(0, CALENDAR_EVENT_CAP - activeCount);
  if (room === 0) return [];

  const castLines = characters
    .filter((c) => !c.isPlayer)
    .slice(0, 12)
    .map((c) => {
      const rel = c.relationships.slice(0, 3).map((r) => {
        const t = characters.find((x) => x.id === r.targetId)?.name;
        return t ? `${r.kind}→${t}` : null;
      }).filter(Boolean).join(', ');
      return `- ${c.name}${c.role ? ` (${c.role})` : ''}${rel ? ` · ${rel}` : ''}`;
    })
    .join('\n');

  const targets = pendingPlotTargets(season.plotTargets).map((t) => `- ${t.text}`).join('\n');
  const months = cal.months.join(', ');

  const result = await utilityJson<{
    events?: Array<{
      title?: string;
      summary?: string;
      kind?: string;
      scale?: string;
      storyDay?: number;
      endDay?: number;
      promptPolicy?: string;
      characterNames?: string[];
    }>;
  }>(
    world,
    'You seed a season calendar of dated texture for longform interactive fiction. ' +
    'Respond with JSON only: {"events":[{"title":"...","summary":"...","kind":"holiday|festival|ceremony|gathering|sport|disaster|personal|mundane|custom",' +
    '"scale":"small|medium|large","storyDay":<int>,"endDay":<optional int>,"promptPolicy":"soft|hard","characterNames":["optional cast names"]}]}\n' +
    'Rules:\n' +
    '- Prefer mostly small/medium mundane, gathering, holiday, festival, ceremony, sport — keep the world feeling lived-in.\n' +
    '- At most 1–2 personal or disaster events; never tragedy spam.\n' +
    '- Spread storyDay across the given range; use the world month names when writing summaries.\n' +
    '- Soft is default; hard only for events that should pressure the director while due.\n' +
    `- Propose at most ${Math.min(room, 10)} events.`,
    `World: ${world.title} — ${world.line}\n` +
    `Bible excerpt: ${(world.bible || '').slice(0, 1200)}\n` +
    `Season ${season.number} premise: ${season.premise || '(unwritten)'}\n` +
    `Calendar: ${cal.system || '(unnamed)'} · months: ${months}\n` +
    `Open day ${openDay} (${formatStoryDate(cal, openDay)}) through day ${endDay}.\n` +
    `Cast:\n${castLines || '(none)'}\n` +
    `Season plot targets:\n${targets || '(none)'}\n` +
    `Existing event titles to avoid duplicating:\n${existing.map((e) => `- ${e.title}`).join('\n') || '(none)'}`,
    2800,
    opts?.signal
  );

  const kinds = new Set([
    'holiday', 'festival', 'ceremony', 'gathering', 'sport', 'disaster', 'personal', 'mundane', 'custom'
  ]);
  const drafts: SeedCalendarEventDraft[] = (result.events ?? [])
    .map((e) => {
      const kind = kinds.has((e.kind ?? '').toLowerCase())
        ? (e.kind!.toLowerCase() as CalendarEventKind)
        : 'mundane';
      const scale = e.scale === 'large' || e.scale === 'medium' ? e.scale : 'small';
      const day = Math.max(openDay, Math.min(endDay, Math.floor(Number(e.storyDay) || openDay)));
      const end = e.endDay != null && Number.isFinite(e.endDay)
        ? Math.max(day, Math.min(endDay, Math.floor(e.endDay)))
        : undefined;
      const names = (e.characterNames ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
      const characterIds = characters
        .filter((c) => names.includes(c.name.trim().toLowerCase()))
        .map((c) => c.id)
        .slice(0, 4);
      return {
        title: (e.title ?? '').trim(),
        summary: (e.summary ?? '').trim(),
        kind,
        scale: scale as CalendarEventScale,
        storyDay: day,
        endDay: end,
        promptPolicy: e.promptPolicy === 'hard' ? 'hard' as const : 'soft' as const,
        characterIds: characterIds.length ? characterIds : undefined
      };
    })
    .filter((e) => e.title && e.summary)
    .slice(0, room);

  if (opts?.autoCommit && drafts.length > 0) {
    const now = Date.now();
    await db.calendarEvents.bulkAdd(
      drafts.map((d) => emptyCalendarEvent(world.id, season.id, {
        ...d,
        visibility: defaultVisibilityForKind(d.kind),
        source: 'ai-seed',
        createdAt: now,
        updatedAt: now
      }, { currentDay: openDay }))
    );
  }

  return drafts;
}

/** AI-assisted character draft from a one-line description. */
export async function draftCharacter(world: World | null, description: string): Promise<Partial<Character>> {
  const result = await utilityJson<{
    name: string; role: string; age: string; appearance: string; mannerisms: string;
    backstory: string; summary: string;
    speechStyle: string; exampleLines: string[]; traits: string; desires: string;
    fears: string; flaws: string; secrets: string; mustNotKnow?: string; anchors: string[];
    state?: { goal?: string; emotion?: string; location?: string; condition?: string };
  }>(
    world,
    'You design deep NPC character sheets for longform interactive fiction. Respond with JSON only:\n' +
    '{"name": string, "role": "<role · relationship to protagonist>", "age": string, "appearance": string, ' +
    '"mannerisms": "<2-3 recurring physical habits or tics, concrete and observable>", ' +
    '"backstory": "<the history that shaped them, 2-3 sentences>", "summary": "<who they are, 2-4 sentences of prose>", ' +
    '"speechStyle": "<how they talk, 1-2 sentences>", "exampleLines": [<2-3 sample spoken lines>], ' +
    '"traits": string, "desires": string, "fears": string, "flaws": string, "secrets": "<something they hide>", ' +
    '"mustNotKnow": "<facts they must not know yet, or empty>", ' +
    '"anchors": [<3-4 hard behavioural rules they never break, e.g. "Never lies in writing">], ' +
    '"state":{"goal":"<what they want right now>","emotion":"<mood>","location":"<where they are>","condition":"<physical/social condition>"}}\n' +
    'Make them specific, contradictory in believable ways, never generic.',
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}Character to create: ${description}`
  );
  const state: CharacterState | undefined = result.state
    ? {
        goal: (result.state.goal ?? '').trim(),
        emotion: (result.state.emotion ?? '').trim(),
        location: (result.state.location ?? '').trim(),
        condition: (result.state.condition ?? '').trim()
      }
    : undefined;
  const { state: _s, ...rest } = result;
  return {
    ...rest,
    mustNotKnow: (result.mustNotKnow ?? '').trim(),
    ...(state ? { state } : {})
  };
}

/** AI-assisted location draft from a one-line description. */
export async function draftLocation(world: World | null, description: string): Promise<Partial<Location>> {
  const result = await utilityJson<{
    name: string; tagline: string; summary: string; atmosphere: string; features: string;
    history: string; inhabitants: string; rules: string[]; secrets: string; currentState: string;
  }>(
    world,
    'You design deep location sheets for longform interactive fiction. Respond with JSON only:\n{"name": string, "tagline": "<short tagline, e.g. \'harbour district · public square\'>", "summary": "<what the place is, first impression, 2-4 sentences of prose>", "atmosphere": "<sensory detail — sight, sound, smell, feel — the narrator leans on>", "features": "<notable landmarks, rooms, or geography within it>", "history": "<how it came to be / what happened here, 2-3 sentences>", "inhabitants": "<who or what is typically found here>", "rules": [<2-4 hazards, laws, or hard rules specific to this place that are never broken>], "secrets": "<something hidden here, not common knowledge>", "currentState": "<its condition right now, one sentence>"}\nMake it specific and concrete, with at least one pressure or danger, never generic.',
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}Location to create: ${description}`
  );
  return result;
}

// ---------- AI-assisted flesh-out (enrich existing cards, never remove detail) ----------

const NON_DESTRUCTIVE_RULE =
  'Fields that are empty: generate them fresh from the name/role and the world context provided. ' +
  'Fields that already contain text: you may correct grammar and spelling and reformat for clarity, and you may add ' +
  'supporting detail — but you must never delete, shorten, or contradict any detail already present. Every fact the ' +
  'author already wrote must still be present in your output, verbatim or better-phrased.';

const RELATIONSHIP_POV_RULES =
  'Write each relationship FROM the Subject TO the target, in third person about the Subject ' +
  '(e.g. "Mara still owes Ivo for the forge debt"). Never address the Subject as "you". ' +
  'Never treat the Subject as the player/reader unless Subject.isPlayer is true. ' +
  'When the target is the player protagonist (isPlayer true, often named "you"), refer to them as ' +
  '"the protagonist" or by their role — not as if the Subject were the reader. ' +
  'Prefer 2-5 concrete links. When other NPCs are on the roster, include peer NPC links, not only Subject↔protagonist.';

function worldFleshPreamble(world: World | null): string {
  if (!world) return '';
  return (
    `World: ${world.title}\n` +
    `World logline (addresses the player protagonist in second person; does NOT describe the Subject): ${world.line}\n` +
    `World bible: ${world.bible.slice(0, 1200)}\n\n`
  );
}

function castRosterEntry(c: Character, summaryLen = 200) {
  return {
    name: c.name,
    role: c.role,
    isPlayer: !!c.isPlayer,
    label: c.isPlayer
      ? 'player protagonist (second person in story — do not confuse with Subject)'
      : 'npc',
    summary: c.summary.slice(0, summaryLen),
    traits: c.traits.slice(0, 120)
  };
}

/** Union two line lists without ever dropping an existing line (case-insensitive de-dupe). */
function mergeLines(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  return [...existing, ...incoming.filter((s) => s.trim() && !seen.has(s.trim().toLowerCase()))];
}

/** Defensive fallback: never let a blank AI response wipe out existing text. */
function keepIfBlank(existing: string, incoming: string | undefined): string {
  return incoming && incoming.trim() ? incoming : existing;
}

function resolveRelationshipsByName(
  proposed: Array<{ targetName?: string; kind?: string; note?: string }>,
  others: Character[]
): Relationship[] {
  const byName = new Map(others.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const out: Relationship[] = [];
  const seen = new Set<string>();
  for (const p of proposed) {
    const key = (p.targetName ?? '').trim().toLowerCase();
    if (!key) continue;
    const targetId = byName.get(key);
    if (!targetId || seen.has(targetId)) continue;
    const kind = (p.kind ?? '').trim() || 'linked';
    const note = (p.note ?? '').trim();
    seen.add(targetId);
    out.push({ targetId, kind, note });
  }
  return out;
}

/** Merge proposed relationships without deleting author links; enrich blank kind/note. */
export function mergeRelationships(
  existing: Relationship[],
  incoming: Relationship[]
): Relationship[] {
  const map = new Map(existing.map((r) => [r.targetId, { ...r }]));
  for (const r of incoming) {
    const cur = map.get(r.targetId);
    if (!cur) {
      map.set(r.targetId, { ...r });
      continue;
    }
    map.set(r.targetId, {
      targetId: r.targetId,
      kind: cur.kind.trim() ? cur.kind : r.kind,
      note: cur.note.trim() ? (r.note.trim() && r.note.length > cur.note.length ? r.note : cur.note) : r.note
    });
  }
  return [...map.values()];
}

/** AI-assisted flesh-out of an existing character sheet: fills blanks, enriches filled fields, never removes detail. */
export async function fleshOutCharacter(
  world: World | null,
  character: Character,
  cast: Character[] = []
): Promise<Partial<Character>> {
  const others = cast.filter((c) => c.id !== character.id && c.name.trim());
  const subjectFrame = character.isPlayer
    ? 'SUBJECT is the player protagonist sheet (second person in play). Fill their card; relationships still use third-person notes about them as the protagonist.'
    : 'SUBJECT is this NPC — not the player. Do not rewrite them as the reader or address them as "you".';
  const current = {
    isPlayer: !!character.isPlayer,
    name: character.name, role: character.role, age: character.age, appearance: character.appearance,
    mannerisms: character.mannerisms, backstory: character.backstory, summary: character.summary,
    speechStyle: character.speechStyle, exampleLines: character.exampleLines, traits: character.traits,
    desires: character.desires, fears: character.fears, flaws: character.flaws, secrets: character.secrets,
    mustNotKnow: character.mustNotKnow,
    anchors: character.anchors,
    state: character.state,
    relationships: character.relationships.map((r) => {
      const target = others.find((c) => c.id === r.targetId);
      return { targetName: target?.name ?? '', kind: r.kind, note: r.note };
    })
  };
  const roster = others.map((c) => castRosterEntry(c, 160));

  const result = await utilityJson<{
    name: string; role: string; age: string; appearance: string; mannerisms: string;
    backstory: string; summary: string;
    speechStyle: string; exampleLines: string[]; traits: string; desires: string;
    fears: string; flaws: string; secrets: string; mustNotKnow?: string; anchors: string[];
    state?: { goal?: string; emotion?: string; location?: string; condition?: string };
    relationships?: { targetName?: string; kind?: string; note?: string }[];
  }>(
    world,
    `You flesh out character sheets for longform interactive fiction. ${subjectFrame} ${NON_DESTRUCTIVE_RULE}\n` +
    `Respond with JSON only: {"name": string, "role": string, "age": string, "appearance": string, "mannerisms": string, ` +
    `"backstory": string, "summary": string, "speechStyle": string, "exampleLines": string[], "traits": string, ` +
    `"desires": string, "fears": string, "flaws": string, "secrets": string, "mustNotKnow": string, "anchors": string[], ` +
    `"state":{"goal":string,"emotion":string,"location":string,"condition":string}, ` +
    `"relationships":[{"targetName":"<exact name from Other cast>","kind":"ally|rival|lover|debt|family|…","note":"<one-line history>"}]}\n` +
    `Only link to names listed in Other cast. Prefer unlinked cast first. If Other cast is empty, return relationships: []. ` +
    `state is live opening condition (goal/emotion/where/condition), separate from enduring voice fields. ${RELATIONSHIP_POV_RULES}`,
    worldFleshPreamble(world) +
    `Other cast (relationship targets):\n${JSON.stringify(roster, null, 2)}\n\n` +
    `SUBJECT sheet (JSON, blank strings/arrays mean unset):\n${JSON.stringify(current, null, 2)}`
  );

  const castIds = cast.map((c) => c.id);
  const relIncoming = others.length > 0
    ? resolveRelationshipsByName(result.relationships ?? [], others)
    : [];

  const stateIncoming = result.state ?? {};
  const state: CharacterState = {
    goal: keepIfBlank(character.state.goal, stateIncoming.goal),
    emotion: keepIfBlank(character.state.emotion, stateIncoming.emotion),
    location: keepIfBlank(character.state.location, stateIncoming.location),
    condition: keepIfBlank(character.state.condition, stateIncoming.condition)
  };

  return {
    name: keepIfBlank(character.name, result.name),
    role: keepIfBlank(character.role, result.role),
    age: keepIfBlank(character.age, result.age),
    appearance: keepIfBlank(character.appearance, result.appearance),
    mannerisms: keepIfBlank(character.mannerisms, result.mannerisms),
    backstory: keepIfBlank(character.backstory, result.backstory),
    summary: keepIfBlank(character.summary, result.summary),
    speechStyle: keepIfBlank(character.speechStyle, result.speechStyle),
    exampleLines: mergeLines(character.exampleLines, result.exampleLines ?? []),
    traits: keepIfBlank(character.traits, result.traits),
    desires: keepIfBlank(character.desires, result.desires),
    fears: keepIfBlank(character.fears, result.fears),
    flaws: keepIfBlank(character.flaws, result.flaws),
    secrets: keepIfBlank(character.secrets, result.secrets),
    mustNotKnow: keepIfBlank(character.mustNotKnow, result.mustNotKnow),
    anchors: mergeLines(character.anchors, result.anchors ?? []),
    state,
    relationships: normalizeRelationships(
      mergeRelationships(character.relationships, relIncoming),
      castIds,
      character.id
    )
  };
}

/** Focused AI pass: propose/enrich typed links to other cast members. */
export async function fleshOutRelationships(
  world: World | null,
  character: Character,
  cast: Character[]
): Promise<Relationship[]> {
  const others = cast.filter((c) => c.id !== character.id && c.name.trim());
  if (others.length === 0) return character.relationships;

  const roster = others.map((c) => castRosterEntry(c, 200));
  const existing = character.relationships.map((r) => {
    const target = others.find((c) => c.id === r.targetId);
    return { targetName: target?.name ?? '', kind: r.kind, note: r.note };
  });
  const subject = {
    isPlayer: !!character.isPlayer,
    name: character.name,
    role: character.role,
    age: character.age,
    appearance: character.appearance.slice(0, 280),
    mannerisms: character.mannerisms.slice(0, 200),
    summary: character.summary.slice(0, 500),
    backstory: character.backstory.slice(0, 600),
    traits: character.traits.slice(0, 280),
    desires: character.desires.slice(0, 280),
    fears: character.fears.slice(0, 280),
    flaws: character.flaws.slice(0, 280),
    secrets: character.secrets.slice(0, 280),
    anchors: character.anchors.slice(0, 8),
    speechStyle: character.speechStyle.slice(0, 200),
    existingRelationships: existing
  };

  const result = await utilityJson<{
    relationships: { targetName?: string; kind?: string; note?: string }[];
  }>(
    world,
    `You design relationship links between cast members for longform interactive fiction. ${NON_DESTRUCTIVE_RULE}\n` +
    `Respond with JSON only: {"relationships":[{"targetName":"<exact name from roster>","kind":"ally|rival|lover|debt|family|mentor|…","note":"<concrete one-line history or tension>"}]}\n` +
    `${RELATIONSHIP_POV_RULES} Prefer roster members the Subject is not yet linked to. Never invent cast names not in the roster.`,
    worldFleshPreamble(world) +
    `SUBJECT (the character whose outbound relationships you are writing — not the player unless isPlayer is true):\n` +
    `${JSON.stringify(subject, null, 2)}\n\n` +
    `Other cast roster:\n${JSON.stringify(roster, null, 2)}`
  );

  const castIds = cast.map((c) => c.id);
  const incoming = resolveRelationshipsByName(result.relationships ?? [], others);
  return normalizeRelationships(
    mergeRelationships(character.relationships, incoming),
    castIds,
    character.id
  );
}

/** AI-assisted flesh-out of an existing location sheet: fills blanks, enriches filled fields, never removes detail. */
export async function fleshOutLocation(world: World | null, location: Location): Promise<Partial<Location>> {
  const current = {
    name: location.name, tagline: location.tagline, summary: location.summary, atmosphere: location.atmosphere,
    features: location.features, history: location.history, inhabitants: location.inhabitants,
    rules: location.rules, secrets: location.secrets, currentState: location.currentState
  };
  const result = await utilityJson<{
    name: string; tagline: string; summary: string; atmosphere: string; features: string;
    history: string; inhabitants: string; rules: string[]; secrets: string; currentState: string;
  }>(
    world,
    `You flesh out location sheets for longform interactive fiction. ${NON_DESTRUCTIVE_RULE}\nRespond with JSON only, same shape as the input: {"name": string, "tagline": string, "summary": string, "atmosphere": string, "features": string, "history": string, "inhabitants": string, "rules": string[], "secrets": string, "currentState": string}`,
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}Current location sheet (JSON, blank strings/arrays mean unset):\n${JSON.stringify(current, null, 2)}`
  );
  return {
    name: keepIfBlank(location.name, result.name),
    tagline: keepIfBlank(location.tagline, result.tagline),
    summary: keepIfBlank(location.summary, result.summary),
    atmosphere: keepIfBlank(location.atmosphere, result.atmosphere),
    features: keepIfBlank(location.features, result.features),
    history: keepIfBlank(location.history, result.history),
    inhabitants: keepIfBlank(location.inhabitants, result.inhabitants),
    rules: mergeLines(location.rules, result.rules ?? []),
    secrets: keepIfBlank(location.secrets, result.secrets),
    currentState: keepIfBlank(location.currentState, result.currentState)
  };
}

/** AI-assisted flesh-out of the world's title/logline/bible. */
export async function fleshOutWorldLore(world: World): Promise<{
  title: string; line: string; bible: string; calendarSystem?: string;
}> {
  const result = await utilityJson<{
    title: string; line: string; bible: string; calendarSystem?: string;
  }>(
    world,
    `You flesh out the lore of a story world for longform interactive fiction. ${NON_DESTRUCTIVE_RULE}\n` +
    `Respond with JSON only: {"title": string, "line": "<one-sentence logline in second person>", ` +
    `"bible": "<setting, atmosphere, rules of the world, pressures at work — prose the narrator will follow>", ` +
    `"calendarSystem": "<optional short flavor for how time is named here, e.g. 'harbor reckoning' — omit or empty if Earth-like>"}`,
    `Current world sheet (JSON, blank strings mean unset):\n${JSON.stringify({
      title: world.title, line: world.line, bible: world.bible,
      calendarSystem: world.calendar?.system ?? ''
    }, null, 2)}`
  );
  return {
    title: keepIfBlank(world.title, result.title),
    line: keepIfBlank(world.line, result.line),
    bible: keepIfBlank(world.bible, result.bible),
    calendarSystem: (result.calendarSystem ?? '').trim() || undefined
  };
}

/** AI-assisted flesh-out of the season premise (the plot). */
export async function fleshOutPremise(world: World, season: Season): Promise<string> {
  const { provider, model } = utilityModelFor(world);
  const { text: premise } = await streamChat({
    provider, model,
    system: `You flesh out season premises for longform interactive fiction. ${NON_DESTRUCTIVE_RULE} If the premise is blank, write one from the world context. One paragraph, 2-5 sentences, present tense, concrete and pressurized. Return only the premise.`,
    messages: [{
      role: 'user',
      content: `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\nSeason ${season.number} current premise (may be blank):\n${season.premise || '(blank)'}`
    }],
    maxTokens: 500, temperature: 0.7
  });
  return keepIfBlank(season.premise, premise.trim());
}

/** AI-assisted flesh-out of the narrator's hard rules. */
export async function fleshOutNarratorRules(world: World): Promise<string[]> {
  const result = await utilityJson<{ rules: string[] }>(
    world,
    `You propose hard narrator rules for longform interactive fiction — non-negotiable behavioural constraints the narrator must never break. ${NON_DESTRUCTIVE_RULE} Respond with JSON only: {"rules": string[]}. Include every existing rule (reworded for clarity if needed) plus 2-5 new ones suited to this world.`,
    `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\nExisting narrator rules (may be empty):\n${world.ai.narratorRules.join('\n') || '(none)'}`
  );
  return mergeLines(world.ai.narratorRules, result.rules ?? []);
}

export interface WorldInterviewQuestion {
  id: string;
  question: string;
  hint?: string;
}

/** Ask 4–5 clarifying questions from a raw RP idea before world generation. */
export async function interviewWorldIdea(
  idea: string,
  shape: string
): Promise<WorldInterviewQuestion[]> {
  const result = await utilityJson<{
    questions?: Array<{ id?: string; question?: string; hint?: string }>;
  }>(
    null,
    'You help authors lock a roleplay premise before world generation. Respond with JSON only:\n' +
    '{"questions":[{"id":"<short_slug>","question":"<one concrete question>","hint":"<optional short example answer>"}]}\n' +
    'Ask exactly 4 or 5 questions covering: who the player is / what they want, the opening pressure, ' +
    'who shares the opening scene, where it opens, and hard boundaries (tone, content, or plot lines that must never break). ' +
    'Do not invent the world yet — only ask. Questions must be specific to THIS idea, never generic.',
    `Story shape the player wants: ${shape}\n\nPlayer's idea:\n${idea.trim()}`
  );
  return (result.questions ?? [])
    .map((q, i) => ({
      id: (q.id ?? `q${i}`).trim() || `q${i}`,
      question: (q.question ?? '').trim(),
      hint: (q.hint ?? '').trim() || undefined
    }))
    .filter((q) => q.question)
    .slice(0, 5);
}

export interface WorldBriefFromInterview {
  title: string;
  line: string;
  bible: string;
  premise: string;
  contentNotes: string;
  narratorRules: string[];
  mature: boolean;
  customInstructions: string;
}

/** Turn idea + interview answers into a seed-quality brief for create/flesh. */
export async function composeWorldBriefFromInterview(
  idea: string,
  shape: string,
  answers: Array<{ question: string; answer: string }>
): Promise<WorldBriefFromInterview> {
  const answered = answers
    .map((a) => ({ question: a.question.trim(), answer: a.answer.trim() }))
    .filter((a) => a.question);
  const result = await utilityJson<{
    title?: string;
    line?: string;
    bible?: string;
    premise?: string;
    contentNotes?: string;
    narratorRules?: string[];
    mature?: boolean;
    customInstructions?: string;
  }>(
    null,
    'You turn a roleplay idea and clarifying answers into a world brief for longform interactive fiction. Respond with JSON only:\n' +
    '{"title":"<1-4 evocative words>","line":"<one-sentence logline in second person>",' +
    '"bible":"<150-350 words: setting, atmosphere, rules, pressures — narrator will follow this>",' +
    '"premise":"<season 1 opening pressure, 2-5 sentences, present tense>",' +
    '"contentNotes":"<hard content boundaries from the answers, or empty>",' +
    '"narratorRules":["<2-5 hard narrator constraints>"],' +
    '"mature":boolean,' +
    '"customInstructions":"<themes, imagery, and author intent to keep verbatim in prompts>"}\n' +
    'Be concrete and pressurized. Honor every answered constraint. Unanswered questions: invent carefully from the idea without contradicting it.',
    `Story shape: ${shape}\n\nOriginal idea:\n${idea.trim()}\n\n` +
    `Interview:\n${answered.map((a) => `Q: ${a.question}\nA: ${a.answer || '(skipped)'}`).join('\n\n')}`
  );

  const bible = (result.bible ?? '').trim() || idea.trim();
  const line = (result.line ?? '').trim() || bible.slice(0, 140);
  return {
    title: (result.title ?? '').trim() || 'Untitled world',
    line,
    bible,
    premise: (result.premise ?? '').trim(),
    contentNotes: (result.contentNotes ?? '').trim(),
    narratorRules: (result.narratorRules ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 8),
    mature: result.mature !== false,
    customInstructions: (result.customInstructions ?? '').trim() || `Shape: ${shape}`
  };
}

export interface WorldRosterProposal {
  characters: { description: string }[];
  locations: { description: string }[];
  openingLocationIndex: number;
}

/** Propose opening cast + place one-liners for a world (does not persist). */
export async function proposeWorldRoster(
  world: World,
  shape: string,
  counts: { characters: number; locations: number }
): Promise<WorldRosterProposal> {
  const nChars = Math.max(0, Math.min(6, counts.characters));
  const nPlaces = Math.max(0, Math.min(5, counts.locations));
  if (nChars === 0 && nPlaces === 0) {
    return { characters: [], locations: [], openingLocationIndex: 0 };
  }
  const result = await utilityJson<WorldRosterProposal>(
    world,
    `You propose an opening cast and places for a longform interactive story world. Respond with JSON only:\n` +
    `{"characters":[{"description":"<one specific sentence: who they are and their pressure on the protagonist>"}],` +
    `"locations":[{"description":"<one specific sentence: what the place is and why it matters>"}],` +
    `"openingLocationIndex":<0-based index into locations for where episode 1 opens>}\n` +
    `Return exactly ${nChars} character description(s) and ${nPlaces} location description(s). ` +
    `Use empty arrays when the count is 0. No player/protagonist. ` +
    `Every description must be concrete and rooted in THIS world's weather, rules, and pressures — never generic fantasy filler.`,
    `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1600)}\n` +
    `Story shape the player wants: ${shape}\n\nPropose the roster.`
  );
  const characters = (result.characters ?? []).filter((c) => c.description?.trim()).slice(0, nChars);
  const locations = (result.locations ?? []).filter((l) => l.description?.trim()).slice(0, nPlaces);
  const openingLocationIndex = locations.length === 0
    ? 0
    : Number.isFinite(result.openingLocationIndex)
      ? Math.max(0, Math.min(locations.length - 1, Math.floor(result.openingLocationIndex)))
      : 0;
  return { characters, locations, openingLocationIndex };
}

export interface FleshOutEverythingOpts {
  /** e.g. "One long story… — Seasons, episodes…" */
  shape: string;
  targetCharacters: number;
  targetLocations: number;
  onProgress?: (label: string) => void;
  /** When true, invent a short cold-open narrator turn if the episode has none. */
  seedColdOpen?: boolean;
}

/** Link opening place; set episode title from place name when title is blank. */
async function linkEpisodeOpening(episode: Episode, open: Location): Promise<Episode> {
  const patch: Partial<Episode> = {
    location: open.name,
    locationId: open.id
  };
  if (!(episode.title ?? '').trim() && open.name.trim()) {
    patch.title = open.name.trim();
  }
  await db.episodes.update(episode.id, patch);
  return { ...episode, ...patch };
}

export interface FleshOutEverythingResult {
  characterIds: string[];
  locationIds: string[];
  continuityIds: string[];
  threadIds: string[];
}

/**
 * Seed 2–4 opening continuity facts + open threads from bible/premise/cast.
 * Skips if the season already has continuity.
 */
export async function seedOpeningMemory(
  world: World,
  season: Season,
  episode: Episode,
  cast: Character[]
): Promise<{ continuityIds: string[]; threadIds: string[] }> {
  const existingFacts = await db.continuity.where('seasonId').equals(season.id).count();
  if (existingFacts > 0) return { continuityIds: [], threadIds: [] };

  const castBrief = cast
    .filter((c) => c.name.trim())
    .map((c) => ({
      name: c.name,
      role: c.role,
      isPlayer: !!c.isPlayer,
      summary: c.summary.slice(0, 160),
      goal: c.state.goal.slice(0, 80)
    }));

  const result = await utilityJson<{ facts: string[]; threads: string[] }>(
    world,
    'You seed opening continuity for episode 1 of a longform interactive story. Respond with JSON only:\n' +
    '{"facts":[<2-4 durable facts already true as the story opens>],' +
    '"threads":[<2-4 unresolved tensions already live as the story opens>]}\n' +
    'Facts are things that will still be true next episode (debts, alliances, injuries, public rules). ' +
    'Threads are pressures already in motion, not resolved. Be concrete and rooted in THIS world — no generic filler.',
    `World: ${world.title} — ${world.line}\nBible:\n${world.bible.slice(0, 1600)}\n\n` +
    `Season ${season.number} premise:\n${season.premise || '(blank)'}\n\n` +
    `Opening location: ${episode.location || '(unset)'}\n` +
    `Cast:\n${JSON.stringify(castBrief, null, 2)}`
  );

  const now = Date.now();
  const facts = (result.facts ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 4);
  const threads = (result.threads ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 4);
  const continuityIds: string[] = [];
  const threadIds: string[] = [];

  if (facts.length > 0) {
    const rows = facts.map((text) => {
      const id = uid();
      continuityIds.push(id);
      return {
        id, worldId: world.id, seasonId: season.id, episodeId: episode.id,
        text, source: 'auto' as const, pinned: false, createdAt: now, updatedAt: now
      };
    });
    await db.continuity.bulkAdd(rows);
  }
  if (threads.length > 0) {
    const rows = threads.map((text) => {
      const id = uid();
      threadIds.push(id);
      return {
        id, worldId: world.id, seasonId: season.id, text,
        openedLabel: `opened S${season.number} · E${episode.number}`,
        status: 'open' as const, pinned: false, createdAt: now, updatedAt: now
      };
    });
    await db.threads.bulkAdd(rows);
  }
  return { continuityIds, threadIds };
}

/** Optional cold-open narrator turn (~80–150 words) when episode has zero turns. */
export async function draftColdOpenNarration(
  world: World,
  season: Season,
  episode: Episode
): Promise<string | null> {
  const turnCount = await db.turns.where('episodeId').equals(episode.id).count();
  if (turnCount > 0) return null;

  const { provider, model } = proseModelFor(world);
  const { text } = await streamChat({
    provider, model,
    system:
      `You write the opening narrator beat for longform interactive fiction. ` +
      `POV: ${world.ai.pov}. Tense: ${world.ai.tense}. ` +
      `80–150 words. Second-person when POV is second. No dialogue. Establish place and pressure; do not resolve anything. Return only the prose.`,
    messages: [{
      role: 'user',
      content:
        `World: ${world.title} — ${world.line}\nBible:\n${world.bible.slice(0, 1200)}\n\n` +
        `Premise:\n${season.premise}\n\n` +
        `Opening location: ${episode.location || '(unnamed)'}\n` +
        `Write the cold open.`
    }],
    maxTokens: 400, temperature: 0.75
  });
  const body = text.trim();
  if (!body) return null;
  await db.turns.add({
    id: uid(),
    worldId: world.id,
    episodeId: episode.id,
    role: 'narrator',
    mode: null,
    text: body,
    createdAt: Date.now()
  });
  return body;
}

/**
 * Flesh lore/premise/rules, invent opening cast & places to roster targets,
 * relationship-pass NPCs, seed opening memory, optionally cold-open.
 */
export async function fleshOutWorldEverything(
  world: World,
  season: Season,
  episode: Episode,
  opts: FleshOutEverythingOpts
): Promise<FleshOutEverythingResult> {
  const progress = opts.onProgress ?? (() => {});
  let liveEpisode = episode;

  progress('Fleshing lore…');
  const lore = await fleshOutWorldLore(world);
  const calPatch =
    lore.calendarSystem && !(world.calendar?.system ?? '').trim()
      ? calendarPatch(world, { system: lore.calendarSystem })
      : undefined;
  await db.worlds.update(world.id, {
    title: lore.title,
    line: lore.line,
    bible: lore.bible,
    ...(calPatch ? { calendar: calPatch } : {}),
    updatedAt: Date.now()
  });
  let live: World = {
    ...world,
    title: lore.title,
    line: lore.line,
    bible: lore.bible,
    ...(calPatch ? { calendar: calPatch } : {})
  };

  progress('Fleshing premise…');
  const premise = await fleshOutPremise(live, season);
  await db.seasons.update(season.id, { premise });
  const liveSeason: Season = { ...season, premise };

  progress('Fleshing narrator rules…');
  const rules = await fleshOutNarratorRules(live);
  await db.worlds.update(live.id, {
    ai: { ...live.ai, narratorRules: rules },
    updatedAt: Date.now()
  });
  live = { ...live, ai: { ...live.ai, narratorRules: rules } };

  let allChars = await db.characters.where('worldId').equals(live.id).toArray();
  const player = allChars.find((c) => c.isPlayer);
  if (player && (!player.summary.trim() || !player.state.goal.trim())) {
    progress('Fleshing you…');
    const sheet = await fleshOutCharacter(live, player, allChars);
    await db.characters.update(player.id, { ...sheet, isPlayer: true, updatedAt: Date.now() });
    allChars = await db.characters.where('worldId').equals(live.id).toArray();
  }

  let npcs = allChars.filter((c) => !c.isPlayer);
  let existingPlaces = await db.locations.where('worldId').equals(live.id).toArray();
  const charSlots = Math.max(0, opts.targetCharacters - npcs.length);
  const placeSlots = Math.max(0, opts.targetLocations - existingPlaces.length);

  const createdCharacterIds: string[] = [];
  const createdLocationIds: string[] = [];

  if (charSlots > 0 || placeSlots > 0) {
    progress('Planning cast & places…');
    const roster = await proposeWorldRoster(live, opts.shape, {
      characters: charSlots,
      locations: placeSlots
    });

    const charDescs = roster.characters.slice(0, charSlots);
    const placeDescs = roster.locations.slice(0, placeSlots);

    for (const { description } of charDescs) {
      const hint = description.trim().slice(0, 48);
      progress(hint ? `Writing ${hint}…` : 'Writing cast…');
      const draft = await draftCharacter(live, description);
      const c = emptyCharacter(live.id, { ...draft, isPlayer: false, updatedAt: Date.now() });
      if (!c.name.trim()) c.name = description.slice(0, 40);
      await db.characters.add(c);
      createdCharacterIds.push(c.id);
    }

    for (const { description } of placeDescs) {
      const hint = description.trim().slice(0, 48);
      progress(hint ? `Placing ${hint}…` : 'Placing the world…');
      const draft = await draftLocation(live, description);
      const l = emptyLocation(live.id, { ...draft, updatedAt: Date.now() });
      if (!l.name.trim()) l.name = description.slice(0, 40);
      // Leave rules empty if the draft missed them — write-ready gate requires a real rule.
      await db.locations.add(l);
      createdLocationIds.push(l.id);
    }

    if (createdCharacterIds.length > 0) {
      const castIds = [...new Set([...liveEpisode.castIds, ...createdCharacterIds])];
      await db.episodes.update(liveEpisode.id, { castIds });
      liveEpisode = { ...liveEpisode, castIds };
    }

    if (createdLocationIds.length > 0 && !liveEpisode.locationId && !liveEpisode.location.trim()) {
      const idx = Math.max(0, Math.min(createdLocationIds.length - 1, roster.openingLocationIndex));
      const openId = createdLocationIds[idx] ?? createdLocationIds[0];
      const open = await db.locations.get(openId);
      if (open) {
        liveEpisode = await linkEpisodeOpening(liveEpisode, open);
      }
    }
  }

  // Ensure episode has an opening location if places exist but none linked.
  existingPlaces = await db.locations.where('worldId').equals(live.id).toArray();
  if (!liveEpisode.locationId && existingPlaces.length > 0) {
    liveEpisode = await linkEpisodeOpening(liveEpisode, existingPlaces[0]);
  } else if (liveEpisode.locationId && !(liveEpisode.title ?? '').trim()) {
    const open = existingPlaces.find((l) => l.id === liveEpisode.locationId)
      ?? await db.locations.get(liveEpisode.locationId);
    if (open?.name.trim()) {
      await db.episodes.update(liveEpisode.id, { title: open.name.trim() });
      liveEpisode = { ...liveEpisode, title: open.name.trim() };
    }
  }

  allChars = await db.characters.where('worldId').equals(live.id).toArray();
  npcs = allChars.filter((c) => !c.isPlayer);

  if (npcs.length > 0) {
    progress('Linking relationships…');
    for (const npc of npcs) {
      const relationships = await fleshOutRelationships(live, npc, allChars);
      await db.characters.update(npc.id, { relationships, updatedAt: Date.now() });
    }
    allChars = await db.characters.where('worldId').equals(live.id).toArray();
  }

  progress('Seeding opening memory…');
  const memory = await seedOpeningMemory(live, liveSeason, liveEpisode, allChars);

  if (opts.seedColdOpen) {
    progress('Drafting cold open…');
    try {
      await draftColdOpenNarration(live, liveSeason, liveEpisode);
    } catch {
      // Cold open is optional — don't fail the whole flesh pass.
    }
  }

  await db.worlds.update(live.id, { updatedAt: Date.now() });
  return {
    characterIds: createdCharacterIds,
    locationIds: createdLocationIds,
    continuityIds: memory.continuityIds,
    threadIds: memory.threadIds
  };
}
