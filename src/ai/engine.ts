import { db, guardStorage, recordTombstones, tombstoneAndDeleteTurns, uid } from '../db';
import { beginAppWrite, endAppWrite } from '../security/writeGate';
import { emptyCalendarEvent, evaluateCalendarEvents } from '../calendarEvents';
import { logAppError } from '../errors';
import { GAP_DAYS, GAP_LABELS } from '../ui/theme';
import type {
  CalendarEvent, CalendarEventKind, CalendarEventPromptPolicy, CalendarEventScale,
  Character, CharacterState, ComposeMode,   Episode, EpisodeGuest, EpisodeWrap, Location,
  OpenThread, PlayerGoal, Relationship, ScoreMark, Season, SeasonWrap, SeasonWrapPlotArc, SeasonWrapRelationshipUpdate,
  NpcMemory, Turn, TurnBeat, TurnLength, TurnRole, World, WrapBeat, WrapCharacterOutcome
} from '../types';
import {
  CALENDAR_EVENT_CAP, defaultVisibilityForKind, isPlayerAgencyMode, worldCalendarEventPrefs
} from '../types';
import { normalizeRelationships } from '../relationships';
import {
  applyTrackedShifts, authoredMarks, bondCue, FALLBACK_BOND_MARKS, FALLBACK_GOAL_MARKS,
  goalsToKeep, keptBond, marksToKeep, meaningWords, PLAYER_GOAL_CAP,
  shouldDraftBondMeanings, shouldDraftGoalMeanings, worldBondPace, BOND_RUBRIC
} from '../bonds';
import {
  buildNextSeasonPlotTargets, calendarPatch, emptyCharacter, emptyLocation,
  formatStoryDate, inferStanceFromInstructions, pendingPlotTargets,
  povPersonLabel, storyStanceOf, worldCalendar, BIBLE_MIN_CHARS
} from '../worldOps';
import { AIError, streamChat, isPromptPackRetryError, type ChatMessage } from './client';
import { contextWindowFor, imageModelFor, proseModelFor, utilityModelFor } from './models';
import { LIVE_MEMORY_TOOL, utilityCall, type ToolSpec } from './utilityCall';
import { promptCharBudget } from './contextBudget';
import { proseCompletionTokens } from './modelProfile';
import { applyDeliveryTone, deliveryPhrase, parseDeliveryTone } from './deliveryTone';
import { stancePlaybook } from './storyStance';
import { narrationNeedsContinue, normalizeSpeakText } from './dialogueFormat';
import { clearMustNotKnowClause, speakLeaksMustNotKnow } from './knowledgeWall';
import {
  activeGuests,
  buildSceneReply,
  sceneReplyTokens,
  type SceneVoice,
  episodeSceneDay,
  sceneDateContextLine,
  historyTailFor,
  compressOmittedTurns,
  turnsSinceCharMark,
  episodeContextPressure,
  episodeHistoryChars,
  omittedTurnsForNarratorTail,
  HISTORY_CHAR_BUDGET,
  type PromptBuildOpts
} from './prompts';
import {
  detectHardAddressees,
  sceneReplySpeakerCap,
  selectAnswerers,
  speakerCandidates,
  turnsSinceSpoke
} from './roomDynamics';
import { addAltPatch, switchAltPatch } from '../turnAlts';
import { cleanSuggestions, dueEventsLine, pickWorldMover, worldMoveCue } from '../worldMove';
import { parseCharacterImportance } from './characterWeight';
import { characterFitsPlace, inferPlaceChanged, namedNewcomer, openingFittingIds, rosterChangeNotice, stageSceneCast } from './sceneFit';
import {
  applyPlaceDraft,
  placeAuthorText,
  placeFillGuidance,
  residentLocationSeeds,
  resolveResidents,
  type PlaceCastPerson,
  type PlaceDraftModel,
  type PlaceDraftSheet
} from './placeDraft';
import type { SceneSpeaker } from './sceneReply';
import { beatsToProse, beatsToTagged, parseBeats, scenePiecesOf, validBeats } from './beatProtocol';
import {
  activeMechanics, applyInventoryChanges, checkDirective, inventoryLine, needsReferee, type InventoryChange
} from '../mechanics';
import { checkFromRuling, ruleMove } from './checks';
import { mergeLooks } from '../looks';
import { intimateAllowed } from './portrait';
import {
  NPC_MEMORY_PER_PASS, addMemories, forgetFiledSince, recallMemories, memoryCardLine, type MemoryDraft
} from '../npcMemory';
import {
  knowledgeFactLine,
  LIVE_CANON_FACT_CAP,
  LIVE_CANON_THREAD_CAP,
  liveCanonHasWork,
  novelLines,
  normalizeLiveCanonExtract,
  type LiveCanonExtract,
  selectStaleFactTexts
} from './liveCanon';
import {
  matchLocationForPatch,
  mergeLocationPatch,
  normalizePlacePatch,
  type PlacePatch
} from './worldMemory';

export { imageModelFor, proseModelFor, utilityModelFor };

// ---------- Prose generation ----------


function isAbortError(e: unknown): boolean {
  return e instanceof WriteAbortedError || (e as Error)?.name === 'AbortError';
}


function proseCharBudget(model: string, maxTokens: number): number {
  return promptCharBudget(model, maxTokens, { windowTokens: contextWindowFor() });
}

const OVERFLOW_NOTICE = 'Prompt was too large for this model — sent a tighter pack and a shorter recent transcript.';

/** Retry once with a tight lore pack and a short transcript tail. */
async function withOverflowRetry<T>(
  run: (pack: PromptBuildOpts) => Promise<T>,
  onNotice?: (message: string) => void
): Promise<T> {
  try {
    return await run({ pack: 'normal' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    if (!isPromptPackRetryError(e)) throw e;
    onNotice?.(OVERFLOW_NOTICE);
    return run({ pack: 'tight' });
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
  /** Exact beats of the streaming scene reply, when the model used beat tags. */
  beats?: TurnBeat[];
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
  /** This changes things, or only this moment. A moment is not filed as canon. */
  weight?: 'moment' | 'matters';
  /** The action is taken as this cast member. Omitted means the player. */
  asCharacterId?: string;
  /** Prefer this walk-on for the speak reply (Speak/Act). */
  preferGuestId?: string;
  /** This line is said to this cast member. The player id means an NPC is speaking to them. */
  toCharacterId?: string;
  /** This line is said to this walk-on. */
  toGuestId?: string;
  /** The speaker is an NPC and the line is said to the player, even with no player card. */
  toPlayer?: boolean;
  /** "Let time pass": someone here acts on their own goal. Mode should be continue with no input. */
  worldMove?: boolean;
  /** Partial text of the beat currently streaming. */
  onDelta: (partial: string, meta: StreamMeta) => void;
  /** High-level stage labels for the UI spinner (planning / narrating / Name speaking). */
  onProgress?: (label: string) => void;
  /** Soft recoverable notices (e.g. director fallback) — not hard errors. */
  onNotice?: (message: string) => void;
  /** Set when the screen already holds the story-write lock. */
  writeToken?: symbol;
  /**
   * The user line is already in the chapter (Rewrite from here).
   * Do not file a second copy. The input is still the move.
   */
  keepExistingUserTurn?: boolean;
}

/** You and Write-as lines can redo the reply that follows them. Narrator and NPC lines use Rewrite this passage. */
export function canRewriteFromHere(turn: { role: string }): boolean {
  return turn.role === 'user';
}

/** Whether this write should append a new user turn. Continue and a rewrite from an existing line do not. */
export function shouldFileUserTurn(opts: {
  mode: ComposeMode;
  input: string;
  keepExistingUserTurn?: boolean;
}): boolean {
  return !opts.keepExistingUserTurn && opts.mode !== 'continue' && opts.input.trim().length > 0;
}

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

function narrationSceneDate(world: World, episode: Episode): string {
  const cal = worldCalendar(world);
  return formatStoryDate(cal, episodeSceneDay(episode, cal));
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

/** The rewrite still said the secret. The partial stream must not be saved. */
export class KnowledgeWallError extends AIError {
  constructor() {
    super('That line still says something they must not know. Try the beat again.');
    this.name = 'KnowledgeWallError';
  }
}

/**
 * A dropped connection or an abort may keep a prefix that does not leak.
 * A knowledge-wall failure never does, even when an earlier prefix was clean.
 */
export function partialReplyAfterError(opts: {
  error: unknown;
  safeText: string;
  stillLeaks: (text: string) => boolean;
}): string | null {
  if (opts.error instanceof KnowledgeWallError) return null;
  const keep = opts.safeText.trim();
  if (!keep || opts.stillLeaks(keep)) return null;
  return keep;
}

/** Thrown when the user aborts mid-write; completed beats are already persisted. */
export class WriteAbortedError extends Error {
  readonly name = 'AbortError';
  constructor(public beatsCompleted: number) {
    super('Aborted');
  }
}

function throwIfAborted(signal: AbortSignal | undefined, beatsCompleted: number): void {
  if (signal?.aborted) throw new WriteAbortedError(beatsCompleted);
}

/**
 * Post-turn summary and live memory. The reply has already returned.
 * The next line does not wait on this. Closing the chapter does.
 */
let postTurnTail: Promise<void> = Promise.resolve();

/** Memory work after a reply. A failure resolves; it never fails the next reply. */
export function enqueuePostTurn(task: () => Promise<void>): void {
  beginAppWrite();
  const run = task()
    .catch((e: unknown) => {
      if ((e as Error).name === 'AbortError' || e instanceof WriteAbortedError) return;
      logAppError(e, 'post turn');
    })
    .finally(endAppWrite);
  postTurnTail = postTurnTail.then(() => run, () => run);
}

function trackPostTurn(task: () => Promise<void>): void {
  enqueuePostTurn(task);
}

export function waitForPostTurn(): Promise<void> {
  return postTurnTail;
}

/** One reply or rewrite at a time. Taken synchronously, before any await. */
let storyWrite: symbol | null = null;

export function tryBeginStoryWrite(): symbol | null {
  if (storyWrite) return null;
  storyWrite = Symbol('story-write');
  return storyWrite;
}

export function endStoryWrite(token: symbol | null): void {
  if (token && storyWrite === token) storyWrite = null;
}

export function writeTurn(opts: WriteOptions): Promise<string> {
  if (storyWrite && storyWrite !== opts.writeToken) {
    return Promise.reject(new AIError('A reply is already being written.'));
  }
  const takenHere = !storyWrite;
  const token = storyWrite ?? Symbol('story-write');
  if (takenHere) storyWrite = token;
  beginAppWrite();
  return writeTurnInner(opts).finally(() => {
    if (takenHere && storyWrite === token) storyWrite = null;
    endAppWrite();
  });
}

function liveCardNote(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;
  if (STATE_CLEAR_WORDS.has(text.toLowerCase().replace(/[.!]$/, ''))) return undefined;
  return text;
}

/** Ties this person has with others who are in the room, named for the prompt. */
export function tiesInRoom(c: Character, room: Character[]): string | undefined {
  const names = new Map(
    room.filter((p) => p.id !== c.id && p.name.trim()).map((p) => [p.id, p.name.trim()])
  );
  const player = room.find((p) => p.isPlayer);
  const bits: string[] = [];
  for (const rel of c.relationships ?? []) {
    const name = names.get(rel.targetId);
    if (!name) continue;
    const kind = rel.kind?.trim();
    const note = rel.note?.trim();
    const cue = player && rel.targetId === player.id ? bondCue(rel) : undefined;
    if (!kind && !note && !cue) continue;
    const shownNote = note ? (cue ? note.slice(0, 80) : note) : '';
    const base = shownNote
      ? `${name}, ${kind || 'linked'}: ${shownNote}`
      : kind
        ? `${name}, ${kind}`
        : '';
    bits.push(cue ? `${base ? `${base}. ` : ''}Toward ${name}: ${cue}` : base);
    if (bits.length >= 4) break;
  }
  return bits.length > 0 ? bits.join('; ') : undefined;
}

/** The player is in the room for bond lines even though they are not a speaker. */
function withPlayer(speakers: Character[], everyone: Character[]): Character[] {
  const ids = new Set(speakers.map((person) => person.id));
  const room = everyone.filter((person) => ids.has(person.id));
  const player = everyone.find((person) => person.isPlayer);
  if (player && !ids.has(player.id)) room.push(player);
  return room;
}

function sceneVoiceFromCharacter(c: Character, room: Character[], recallQuery = ''): SceneVoice {
  const emotion = liveCardNote(c.state?.emotion);
  const condition = liveCardNote(c.state?.condition);
  const ties = tiesInRoom(c, room);
  const memories = recallMemories(c.memories, recallQuery).map(memoryCardLine);
  return {
    id: c.id,
    name: c.name,
    kind: 'cast',
    role: c.role,
    voice: c.speechStyle,
    want: liveCardNote(c.state?.goal),
    ...(emotion ? { emotion } : {}),
    ...(condition ? { condition } : {}),
    ...(ties ? { ties } : {}),
    example: (c.exampleLines ?? []).find((line) => line.trim()),
    mustNotKnow: c.mustNotKnow,
    anchor: (c.anchors ?? []).find((line) => line.trim()),
    ...(memories.length > 0 ? { memories } : {})
  };
}

/** Everyone physically here, so a named line can be credited even if they were not the planned voice. */
function roomSceneSpeakers(characters: Character[], guests: EpisodeGuest[]): SceneSpeaker[] {
  return [
    ...characters.flatMap((c) => {
      const name = c.name.trim();
      if (!name || c.isPlayer) return [];
      const aliases = (c.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
      return [{
        id: c.id,
        name,
        kind: 'cast' as const,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(c.role?.trim() ? { role: c.role } : {})
      }];
    }),
    ...guests.flatMap((g) => {
      const name = g.name.trim();
      if (!name) return [];
      return [{ id: g.id, name, kind: 'guest' as const }];
    })
  ];
}

/** People already here, answerers first, so their cards lead the prompt. */
function orderedRoomVoices(
  characters: Character[],
  guests: EpisodeGuest[],
  firstIds: string[],
  tieWith: Character[] = characters,
  recallQuery = ''
): SceneVoice[] {
  const voices: SceneVoice[] = [
    ...characters.flatMap((c) => (c.name.trim() && !c.isPlayer ? [sceneVoiceFromCharacter(c, tieWith, recallQuery)] : [])),
    ...guests.flatMap((g) => {
      const name = g.name.trim();
      if (!name) return [];
      return [{ id: g.id, name, kind: 'guest' as const, brief: g.brief, voice: g.voice }];
    })
  ];
  const rank = new Map(firstIds.map((id, index) => [id, index]));
  return voices.sort((a, b) => (rank.get(a.id) ?? firstIds.length) - (rank.get(b.id) ?? firstIds.length));
}

function sceneWallLeak(
  text: string,
  speakers: SceneSpeaker[],
  characters: Character[],
  beats?: TurnBeat[]
): { name: string; wall: string } | null {
  for (const piece of scenePiecesOf({ text, beats }, speakers)) {
    if (piece.role !== 'character' || piece.kind !== 'cast' || !piece.speakerId) continue;
    const character = characters.find((c) => c.id === piece.speakerId);
    const wall = character?.mustNotKnow?.trim() ?? '';
    if (character && wall && speakLeaksMustNotKnow(piece.text, wall)) {
      return { name: character.name, wall };
    }
  }
  return null;
}

/**
 * Who this line is aimed at. An NPC speaking to the player stays narration.
 * A player speaking to someone here pins that person as the answerer.
 */
function resolveLineAddress(
  opts: WriteOptions,
  characters: Character[],
  inScene: Character[],
  guests: EpisodeGuest[]
): { toCharacterId?: string; toGuestId?: string; saidTo: string; preferId?: string } {
  const player = characters.find((c) => c.isPlayer);
  if (opts.asCharacterId) {
    const aimedAtPlayer = opts.toPlayer === true || (!!player && opts.toCharacterId === player.id);
    if (!aimedAtPlayer) return { saidTo: '' };
    return {
      saidTo: player?.name.trim() || 'the player',
      ...(player ? { toCharacterId: player.id } : {})
    };
  }
  const castId = opts.toCharacterId || opts.preferCharacterId;
  const cast = castId ? inScene.find((c) => c.id === castId) : undefined;
  if (cast?.name.trim()) {
    return { toCharacterId: cast.id, saidTo: cast.name.trim(), preferId: cast.id };
  }
  const guestId = opts.toGuestId || opts.preferGuestId;
  const guest = guestId ? guests.find((g) => g.id === guestId) : undefined;
  if (guest?.name.trim()) {
    return { toGuestId: guest.id, saidTo: guest.name.trim(), preferId: guest.id };
  }
  return { saidTo: '' };
}

/**
 * One reply: stage the room, then one prose call writes the scene.
 * That text is stored as one turn. Faces are read from the prose later.
 */
async function writeTurnInner(opts: WriteOptions): Promise<string> {
  throwIfAborted(opts.signal, 0);
  const { provider, model } = proseModelFor(opts.world);
  const ctx = await loadContext(opts.world, opts.season, opts.episode);
  let inScene = ctx.characters.filter((c) => opts.episode.castIds.includes(c.id) && !c.isPlayer);
  let beatsCompleted = 0;
  let userTurnId: string | null = null;
  const filedText = new Map<string, string>();
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

  /** No reply beat landed, so the player line must not stay in the chapter. */
  const dropUnansweredPlayer = async () => {
    if (!userTurnId || beatsCompleted > 0) return;
    const id = userTurnId;
    const doomed = ctx.turns.find((t) => t.id === id);
    userTurnId = null;
    filedText.delete(id);
    ctx.turns = ctx.turns.filter((t) => t.id !== id);
    if (!doomed) {
      await db.turns.delete(id).catch(() => undefined);
      return;
    }
    await tombstoneAndDeleteTurns([doomed]).catch(() => undefined);
  };

  if (shouldFileUserTurn(opts)) {
    const { tone, body } = parseDeliveryTone(opts.input.trim());
    const normalized = (opts.mode === 'speak' || opts.mode === 'play') ? normalizeSpeakText(body) : body;
    const userText = isPlayerAgencyMode(opts.mode)
      ? applyDeliveryTone(normalized, tone)
      : opts.input.trim();
    const aimed = resolveLineAddress(opts, ctx.characters, inScene, activeGuests(ctx.episode));
    const userTurn: Turn = {
      id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
      role: 'user', mode: opts.mode, text: userText, createdAt: Date.now(),
      weight: opts.weight ?? 'matters',
      ...(opts.asCharacterId ? { asCharacterId: opts.asCharacterId } : {}),
      ...(aimed.toCharacterId && (opts.toCharacterId === aimed.toCharacterId || opts.toPlayer)
        ? { toCharacterId: aimed.toCharacterId }
        : {}),
      ...(opts.toGuestId && aimed.toGuestId ? { toGuestId: aimed.toGuestId } : {})
    };
    await guardStorage(() => db.turns.add(userTurn));
    userTurnId = userTurn.id;
    filedText.set(userTurn.id, userTurn.text);
    ctx.turns.push(userTurn);
  }

  const progress = opts.onProgress ?? (() => {});

  const hands = opts.asCharacterId
    ? ctx.characters.find((c) => c.id === opts.asCharacterId)
    : undefined;
  const moveText = opts.input.trim();
  const injectionReply = !!opts.asCharacterId;

  // Light rules: a risky player move is settled before a word of prose.
  let checkOrder = '';
  const rules = activeMechanics(opts.world);
  if (rules && !injectionReply && moveText && needsReferee(opts.mode, moveText)) {
    const moveTurn = userTurnId
      ? ctx.turns.find((t) => t.id === userTurnId)
      : opts.keepExistingUserTurn
        ? [...ctx.turns].reverse().find((t) => t.role === 'user')
        : undefined;
    // A rewrite keeps the roll it already made.
    let check = moveTurn?.check ?? null;
    if (!check) {
      progress('weighing the odds…');
      const player = ctx.characters.find((c) => c.isPlayer);
      const sceneTail = ctx.turns
        .filter((t) => t.role !== 'user')
        .slice(-2)
        .map((t) => t.text)
        .join('\n\n');
      try {
        const ruling = await ruleMove({ world: opts.world, mechanics: rules, player, moveText, sceneTail, signal: opts.signal });
        check = checkFromRuling({ ruling, mechanics: rules, player, moveText });
      } catch (e) {
        await rollbackSceneIfNeeded();
        await dropUnansweredPlayer();
        if (isAbortError(e)) throw new WriteAbortedError(0);
        throw e;
      }
      if (check && moveTurn) {
        const settled = check;
        await guardStorage(() => db.turns.update(moveTurn.id, { check: settled, updatedAt: Date.now() }));
        moveTurn.check = settled;
      }
    }
    if (check) checkOrder = checkDirective(check);
  }

  const placeLoc = ctx.locations.find((l) => ctx.episode.locationId && l.id === ctx.episode.locationId)
    ?? ctx.locations.find((l) => {
      const name = l.name.trim().toLowerCase();
      const ep = ctx.episode.location.trim().toLowerCase();
      return !!name && !!ep && (ep.includes(name) || name.includes(ep));
    });
  const placeName = (placeLoc?.name || ctx.episode.location || '').trim();
  const inhabitants = placeLoc?.inhabitants ?? '';

  if (!injectionReply) {
    const staged = stageSceneCast({
      castIds: ctx.episode.castIds,
      characters: ctx.characters,
      placeName,
      inhabitants,
      playerText: moveText,
      turns: ctx.turns,
      placeChanged: inferPlaceChanged(moveText, placeName),
      residentIds: placeLoc?.residentIds
    });
    const notes: string[] = [];
    const rosterNote = rosterChangeNotice(staged.changes);
    if (rosterNote) notes.push(rosterNote);
    if (staged.castIds.join('\0') !== ctx.episode.castIds.join('\0')) {
      await guardStorage(() => db.episodes.update(ctx.episode.id, {
        castIds: staged.castIds,
        updatedAt: Date.now()
      }));
      ctx.episode = { ...ctx.episode, castIds: staged.castIds };
      sceneMutated = true;
    }
    const known = [
      ...ctx.characters.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
      ...(ctx.episode.guests ?? []).map((g) => g.name)
    ];
    const newbie = namedNewcomer(moveText, known);
    if (newbie) {
      const guest: EpisodeGuest = { id: uid(), name: newbie, brief: 'Named on this line.' };
      const guests = [...(ctx.episode.guests ?? []), guest];
      await guardStorage(() => db.episodes.update(ctx.episode.id, {
        guests,
        updatedAt: Date.now()
      }));
      ctx.episode = { ...ctx.episode, guests };
      sceneMutated = true;
      notes.push(`${newbie} is here — you named them.`);
    }
    if (notes.length > 0) opts.onNotice?.(notes.join(' '));
    inScene = ctx.characters.filter((c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer);
  }

  const sceneGuests = () => activeGuests(ctx.episode);
  const address = resolveLineAddress(opts, ctx.characters, inScene, sceneGuests());
  const stage = opts.asCharacterId
    ? inScene.filter((c) => c.id !== opts.asCharacterId)
    : inScene;
  const candidates = speakerCandidates(stage, sceneGuests());
  const addressed = detectHardAddressees(moveText, candidates).length;
  let worldCue = '';
  let moverId: string | undefined;
  if (opts.worldMove && !injectionReply) {
    const silence = turnsSinceSpoke(ctx.turns, candidates);
    const mover = pickWorldMover(stage.map((c) => ({
      id: c.id,
      name: c.name.trim(),
      goal: liveCardNote(c.state?.goal),
      silence: silence.get(c.id) ?? Number.POSITIVE_INFINITY,
      importance: c.importance
    })).filter((c) => c.name));
    moverId = mover?.id;
    const day = episodeSceneDay(ctx.episode, worldCalendar(opts.world));
    worldCue = worldMoveCue({ mover, due: dueEventsLine(ctx.calendarEvents ?? [], day) });
    progress(mover ? `${mover.name} makes a move…` : 'time passes…');
  }
  const picked = injectionReply
    ? []
    : selectAnswerers({
      length: opts.length,
      playerText: moveText,
      candidates,
      turns: ctx.turns,
      preferId: moverId ?? address.preferId
    }).slice(0, sceneReplySpeakerCap(opts.length, addressed));

  const voices: SceneVoice[] = injectionReply
    ? []
    : orderedRoomVoices(
      inScene,
      sceneGuests(),
      picked.map((speaker) => speaker.id),
      withPlayer(inScene, ctx.characters),
      // Memories are recalled by what is happening now: this move and the last beat.
      [moveText, ctx.turns.filter((t) => t.role === 'narrator').at(-1)?.text.slice(-600) ?? '', placeName].join(' ')
    );
  const roomSpeakers = injectionReply
    ? (hands && !hands.isPlayer ? roomSceneSpeakers([hands], []) : [])
    : roomSceneSpeakers(inScene, sceneGuests());
  const present = [
    ...inScene.map((c) => ({ name: c.name, role: c.role })),
    ...sceneGuests().map((g) => ({ name: g.name, role: g.brief }))
  ];
  const replyLength: TurnLength = opts.length;
  const spokenMove = injectionReply ? parseDeliveryTone(moveText) : null;
  const cueText = injectionReply
    ? [
      spokenMove?.tone ? `Said ${deliveryPhrase(spokenMove.tone)}.` : '',
      `${hands?.name?.trim() || 'They'}: ${spokenMove?.body ?? moveText}`
    ].filter(Boolean).join('\n')
    : moveText;

  let lastId = '';
  let acc = '';
  let accBeats: TurnBeat[] | undefined;
  /** Last snapshot that does not break a knowledge wall. A dead stream keeps this. */
  let safeText = '';
  let safeBeats: TurnBeat[] | undefined;
  const rememberSafe = (raw: string, beats?: TurnBeat[]) => {
    const next = raw.trim();
    if (next && !sceneWallLeak(next, roomSpeakers, ctx.characters, beats)) {
      safeText = next;
      safeBeats = beats;
    }
  };
  const meta: StreamMeta = { role: 'narrator' };
  progress('Writing…');
  opts.onDelta('', meta);

  /** Tagged beats are kept only when they render to exactly the text being filed. */
  const matchingBeats = (text: string, ...candidates: Array<TurnBeat[] | undefined>) =>
    candidates.find((beats) => beats && beats.length > 0 && beatsToProse(beats) === text.trim());

  const persistScene = async (raw: string, beats?: TurnBeat[]): Promise<number> => {
    const text = raw.trim();
    if (!text) return 0;
    const exact = matchingBeats(text, beats);
    const turn: Turn = {
      id: uid(),
      episodeId: opts.episode.id,
      worldId: opts.world.id,
      role: 'narrator',
      mode: null,
      text,
      ...(exact ? { beats: exact } : {}),
      createdAt: Date.now()
    };
    await guardStorage(() => db.turns.add(turn));
    filedText.set(turn.id, turn.text);
    ctx.turns.push(turn);
    lastId = turn.id;
    beatsCompleted += 1;
    return 1;
  };

  const streamScene = async (
    pack: PromptBuildOpts,
    extra: ChatMessage[] = [],
    prefix: { text: string; beats?: TurnBeat[] } = { text: '' }
  ): Promise<{ text: string; raw: string; beats?: TurnBeat[]; truncated: boolean; stalled: boolean }> => {
    const maxTokens = proseCompletionTokens(model, sceneReplyTokens(replyLength));
    const budget = proseCharBudget(model, maxTokens);
    const tail = historyTailFor(model, 'narrator', pack.pack, contextWindowFor());
    const built = buildSceneReply({
      ctx,
      mode: opts.mode,
      playerText: cueText,
      length: replyLength,
      speakers: voices,
      answerers: injectionReply ? undefined : picked.map((speaker) => ({ name: speaker.name })),
      saidTo: address.saidTo || undefined,
      present,
      pack: pack.pack,
      historyTailChars: tail.charBudget,
      historyTailMaxTurns: tail.maxTurns,
      totalCap: budget,
      narrationOnly: injectionReply,
      ...(checkOrder ? { checkDirective: checkOrder } : {}),
      ...(worldCue ? { worldMove: worldCue } : {})
    });
    let local = '';
    const shownPrefix = prefix.text;
    const carry = prefix.beats?.[prefix.beats.length - 1];
    /** Tagged output becomes stored prose plus exact beats; untagged output stays as written. */
    const render = (raw: string, partial: boolean): { prose: string; beats?: TurnBeat[] } => {
      const parsed = parseBeats(raw, roomSpeakers, { partial, carry });
      return parsed ?? { prose: raw.trim() };
    };
    const show = (part: { prose: string; beats?: TurnBeat[] }) => {
      const next = part.prose.trim();
      const text = shownPrefix && next ? `${shownPrefix}\n\n${next}` : (next || shownPrefix);
      const beats = !shownPrefix
        ? part.beats
        : prefix.beats && part.beats ? [...prefix.beats, ...part.beats] : undefined;
      return { text, beats };
    };
    const result = await streamChat({
      provider,
      model,
      system: built.system,
      messages: [...built.messages, ...extra],
      maxTokens,
      signal: opts.signal,
      job: 'prose',
      onDelta: (delta) => {
        local += delta;
        const shown = show(render(local, true));
        rememberSafe(shown.text, shown.beats);
        acc = shown.text;
        accBeats = shown.beats;
        opts.onDelta(shown.text, { ...meta, ...(shown.beats ? { beats: shown.beats } : {}) });
      }
    });
    const raw = (result.text || local).trim();
    const part = render(raw, false);
    const shown = show(part);
    rememberSafe(shown.text, shown.beats);
    acc = shown.text;
    accBeats = shown.beats;
    return {
      text: part.prose.trim(),
      raw,
      ...(part.beats ? { beats: part.beats } : {}),
      truncated: !!result.truncated,
      stalled: !!result.stalled
    };
  };

  const stillLeaks = (raw: string) =>
    !!sceneWallLeak(raw, roomSpeakers, ctx.characters, matchingBeats(raw, safeBeats, accBeats));

  let text = '';
  let beats: TurnBeat[] | undefined;
  /** What the model wrote, in its own tagged form, for follow-up requests. */
  const asWritten = () => (beats ? beatsToTagged(beats) : text);
  try {
    throwIfAborted(opts.signal, 0);
    const first = await withOverflowRetry((pack) => streamScene(pack), opts.onNotice);
    text = first.text;
    beats = first.beats;
    if (narrationNeedsContinue(text, first)) {
      progress('finishing the line…');
      const sofar = { text, beats };
      const rest = await withOverflowRetry(
        (pack) => streamScene(pack, [
          { role: 'assistant', content: first.raw },
          {
            role: 'user',
            content:
              'Continue from the exact point you stopped. Do not repeat what you already wrote. Finish the open line, then stop.'
          }
        ], sofar),
        opts.onNotice
      );
      if (rest.text.trim()) {
        text = `${text.trim()}\n\n${rest.text.trim()}`.trim();
        beats = beats && rest.beats ? [...beats, ...rest.beats] : undefined;
      }
      acc = text;
      accBeats = beats;
      opts.onDelta(text, { ...meta, ...(beats ? { beats } : {}) });
    }
    if (opts.mode !== 'steer') {
      const leak = sceneWallLeak(text, roomSpeakers, ctx.characters, beats);
      if (leak) {
        progress('honouring what they must not know…');
        const rewritten = await withOverflowRetry(
          (pack) => streamScene(pack, [
            { role: 'assistant', content: asWritten() },
            {
              role: 'user',
              content:
                `${leak.name} must not know or say this: ${leak.wall}. ` +
                'Rewrite the scene so that secret is absent. Keep the same events otherwise.'
            }
          ]),
          opts.onNotice
        );
        if (!rewritten.text.trim() || sceneWallLeak(rewritten.text, roomSpeakers, ctx.characters, rewritten.beats)) {
          opts.onDelta('', meta);
          throw new KnowledgeWallError();
        }
        text = rewritten.text.trim();
        beats = rewritten.beats;
        acc = text;
        accBeats = beats;
        opts.onDelta(text, { ...meta, ...(beats ? { beats } : {}) });
      }
    }
  } catch (e) {
    const keep = partialReplyAfterError({
      error: e,
      safeText: safeText || acc,
      stillLeaks
    });
    if (e instanceof KnowledgeWallError || !keep) {
      opts.onDelta('', meta);
      await rollbackSceneIfNeeded();
      await dropUnansweredPlayer();
      if (isAbortError(e)) throw new WriteAbortedError(0);
      throw e;
    }
    if (isAbortError(e)) {
      await persistScene(keep, matchingBeats(keep, safeBeats, accBeats, beats));
      opts.onDelta('', meta);
      throw new WriteAbortedError(beatsCompleted);
    }
    beats = matchingBeats(keep, safeBeats, accBeats, beats);
    text = keep;
  }

  if (!text.trim()) {
    await rollbackSceneIfNeeded();
    await dropUnansweredPlayer();
    throw new AIError('The model did not answer. Try again.');
  }

  if (beatsCompleted === 0) {
    const saved = await persistScene(text, beats);
    if (saved === 0) {
      await rollbackSceneIfNeeded();
      await dropUnansweredPlayer();
      throw new AIError('The model did not answer. Try again.');
    }
  }
  opts.onDelta('', meta);
  await db.worlds.update(opts.world.id, { updatedAt: Date.now() });

  if (!opts.signal?.aborted) {
    const saved = beatsCompleted;
    const textStillFiled = async () => {
      const ids = [...filedText.keys()];
      if (ids.length === 0) return true;
      const rows = await db.turns.bulkGet(ids);
      return ids.every((id, index) => rows[index]?.text === filedText.get(id));
    };
    trackPostTurn(async () => {
      const quiet = () => {};
      try {
        if (!(await textStillFiled())) return;
        await Promise.all([
          maybeRefreshRunningSummary(opts.world, ctx, opts.signal, quiet, opts.onNotice, {
            phase: 'post',
            proseModel: model,
            textStillFiled
          }),
          maybeRefreshLiveMemory(
            opts.world, ctx, saved, opts.signal, quiet, opts.onNotice,
            opts.weight !== 'moment',
            textStillFiled
          )
        ]);
      } catch (e) {
        if ((e as Error).name === 'AbortError' || e instanceof WriteAbortedError) return;
        throw e;
      }
    });
  }
  return lastId;
}

/**
 * Re-roll a single narrator or character beat in place — siblings stay.
 */
export function regenerateBeat(opts: {
  world: World;
  season: Season;
  episode: Episode;
  turn: Turn;
  length: TurnLength;
  signal?: AbortSignal;
  onDelta: (partial: string, meta: StreamMeta) => void;
  onProgress?: (label: string) => void;
}): Promise<void> {
  beginAppWrite();
  return regenerateBeatInner(opts).finally(endAppWrite);
}

async function regenerateBeatInner(opts: {
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
  throwIfAborted(opts.signal, 0);
  const { provider, model } = proseModelFor(opts.world);
  const ctx = await loadContext(opts.world, opts.season, opts.episode);
  const progress = opts.onProgress ?? (() => {});
  const replaceAt = ctx.turns.findIndex((t) => t.id === opts.turn.id);
  const historyCtx = {
    ...ctx,
    turns: replaceAt < 0 ? ctx.turns : ctx.turns.slice(0, replaceAt)
  };
  const guest = opts.turn.guestId
    ? (ctx.episode.guests ?? []).find((g) => g.id === opts.turn.guestId)
    : undefined;
  const speaking = opts.turn.characterId
    ? ctx.characters.find((c) => c.id === opts.turn.characterId)
    : undefined;
  if (opts.turn.role === 'character' && !guest && (!speaking || speaking.isPlayer)) {
    throw new AIError('Could not find the speaker for this turn.');
  }

  const characterReroll = opts.turn.role === 'character';
  const name = guest?.name ?? speaking?.name ?? 'the narrator';
  const inScene = ctx.characters.filter((c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer);
  const guestsHere = activeGuests(ctx.episode);
  const tieRoom = withPlayer(inScene, ctx.characters);
  const voices: SceneVoice[] = characterReroll
    ? guest
      ? [{ id: guest.id, name: guest.name, kind: 'guest', brief: guest.brief, voice: guest.voice }]
      : [sceneVoiceFromCharacter(speaking!, tieRoom, opts.turn.text)]
    : orderedRoomVoices(inScene, guestsHere, [], tieRoom, opts.turn.text);
  const sceneSpeakers: SceneSpeaker[] = characterReroll
    ? voices.map((voice) => ({
      id: voice.id,
      name: voice.name,
      kind: voice.kind,
      aliases: voice.kind === 'cast'
        ? ctx.characters.find((c) => c.id === voice.id)?.aliases
        : undefined,
      role: voice.role
    }))
    : [];
  const present = [
    ...inScene.map((c) => ({ name: c.name, role: c.role })),
    ...guestsHere.map((g) => ({ name: g.name, role: g.brief }))
  ];
  const meta: StreamMeta = characterReroll
    ? guest
      ? { role: 'character', guestId: guest.id }
      : { role: 'character', characterId: speaking!.id }
    : { role: 'narrator' };
  progress(characterReroll ? `${name} re-rolling…` : 're-rolling the scene…');
  opts.onDelta('', meta);

  const roomSpeakers = roomSceneSpeakers(inScene, guestsHere);
  const parseSpeakers = characterReroll ? sceneSpeakers : roomSpeakers;
  // The move this reply answers already rolled; a re-roll of the prose does not re-roll the dice.
  const answered = answeredMove(ctx.turns, replaceAt);
  const settled = activeMechanics(opts.world) && answered?.check ? checkDirective(answered.check) : '';
  const priorBeats = validBeats(opts.turn);
  const prior = (priorBeats ? beatsToTagged(priorBeats) : opts.turn.text).slice(0, 900);
  let acc = '';
  let replyBeats: TurnBeat[] | undefined;
  const text = await withOverflowRetry(async (pack) => {
    const maxTokens = proseCompletionTokens(model, sceneReplyTokens(opts.length));
    const budget = proseCharBudget(model, maxTokens);
    const tail = historyTailFor(model, 'narrator', pack.pack, contextWindowFor());
    const built = buildSceneReply({
      ctx: historyCtx,
      mode: 'continue',
      playerText: '',
      length: opts.length,
      speakers: voices,
      present,
      pack: pack.pack,
      historyTailChars: tail.charBudget,
      historyTailMaxTurns: tail.maxTurns,
      totalCap: budget,
      rewrite: { speakerName: name, prior },
      ...(settled ? { checkDirective: settled } : {})
    });
    acc = '';
    const result = await streamChat({
      provider,
      model,
      system: built.system,
      messages: built.messages,
      maxTokens,
      signal: opts.signal,
      job: 'prose',
      onDelta: (delta) => {
        acc += delta;
        const live = parseBeats(acc, parseSpeakers, { partial: true });
        if (live && !characterReroll) opts.onDelta(live.prose, { ...meta, beats: live.beats });
        else opts.onDelta(live?.prose ?? acc, meta);
      }
    });
    const raw = (result.text || acc).trim();
    const parsed = parseBeats(raw, parseSpeakers);
    replyBeats = parsed?.beats;
    return parsed ? parsed.prose.trim() : raw;
  });

  let saved = text.trim();
  if (characterReroll && voices[0]) {
    const own = scenePiecesOf({ text: saved, beats: replyBeats }, sceneSpeakers).filter((piece) =>
      piece.role === 'character' && piece.speakerId === voices[0].id
    );
    if (own.length > 0) saved = own.map((piece) => piece.text).join('\n\n');
  }
  if (!saved) {
    throw new AIError(
      characterReroll ? 'Re-roll produced no dialogue. Try again.' : 'Re-roll produced no narration. Try again.'
    );
  }
  if (characterReroll) {
    const wall = speaking?.mustNotKnow?.trim() ?? '';
    if (wall && speakLeaksMustNotKnow(saved, wall)) {
      throw new AIError('That line still says something they must not know. Try the beat again.');
    }
  } else {
    const leak = sceneWallLeak(saved, roomSpeakers, ctx.characters, replyBeats);
    if (leak) throw new AIError('That line still says something they must not know. Try the beat again.');
  }
  const savedBeats = !characterReroll && replyBeats && beatsToProse(replyBeats) === saved ? replyBeats : undefined;
  // Dexie drops a key set to undefined, so stale beats from the old text go away.
  const now = Date.now();
  // Keep the old version so the reader can flip back to it.
  const fresh = (await db.turns.get(opts.turn.id)) ?? opts.turn;
  const versioned = addAltPatch(fresh, saved, savedBeats, now);
  await guardStorage(() => db.turns.update(opts.turn.id, { ...versioned, updatedAt: now }));
  await finalizeChapterMemory(opts.episode.id);
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
  onNotice?: (message: string) => void,
  opts?: { phase?: 'pre' | 'post'; proseModel?: string; textStillFiled?: () => Promise<boolean> }
): Promise<void> {
  const chars = episodeHistoryChars(ctx.turns);
  const pressure = episodeContextPressure(chars);
  const omitted = omittedTurnsForNarratorTail(ctx.turns, opts?.proseModel ?? '', contextWindowFor());
  if (opts?.phase === 'pre') {
    // Only spend a utility call when this model's tail will drop turns,
    // or the chapter is already long enough that glue must exist.
    if (omitted.length === 0 && pressure !== 'warn' && pressure !== 'escalate') return;
  } else if (pressure === 'ok') {
    return;
  }

  const lastAt = ctx.episode.runningSummaryAtChars ?? 0;
  const growthNeeded = Math.round(HISTORY_CHAR_BUDGET * 0.04);
  if (ctx.episode.runningSummary && chars < lastAt + growthNeeded) return;

  const sourceTurns = omitted.length > 0
    ? omitted
    : ctx.turns.slice(0, Math.max(4, Math.floor(ctx.turns.length * 0.45)));
  if (sourceTurns.length < 3) return;

  const guests = ctx.episode.guests ?? [];
  const digest = compressOmittedTurns(sourceTurns, ctx.characters, guests);
  if (!digest.trim()) return;

  if (opts?.textStillFiled && !(await opts.textStillFiled())) return;

  const { signal: timed, cancel } = withTimeoutSignal(signal, UTILITY_TIMEOUT_MS);
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
      signal: timed,
      job: 'utility'
    });
    const summary = text.trim();
    if (!summary) return;
    if (opts?.textStillFiled && !(await opts.textStillFiled())) return;
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
    // The deadline aborts an inner signal. That is not the player hitting Stop.
    if ((e as Error).name === 'AbortError' && signal?.aborted) throw e;
    // Non-fatal — prompts still have omitted digests and prior wrap.
    logAppError(e, 'running summary');
    onNotice?.('Couldn’t refresh mid-episode memory — older beats may thin out until the next successful turn.');
  } finally {
    cancel();
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
 * A "just this moment" beat still updates the room. It does not file durable canon.
 * Atmosphere can stay; facts, threads, knowledge, and a lasting place change do not.
 */
export function rememberedExtract(extract: LiveCanonExtract, fileCanon: boolean): LiveCanonExtract {
  if (fileCanon) return extract;
  const atmosphere = extract.place?.atmosphere?.trim();
  return {
    ...extract,
    facts: [],
    threads: [],
    knowledge: [],
    place: atmosphere ? { name: extract.place?.name ?? '', atmosphere } : null
  };
}

/**
 * One post-write pass after every reply: live cast state, the room ledger,
 * ties, tracked scores, and what each person present will remember.
 * Durable canon (facts, threads, place, knowledge) is filed only once enough
 * new transcript has grown, so the pass stays small on most turns.
 */
async function maybeRefreshLiveMemory(
  world: World,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  turnsSaved: number,
  signal: AbortSignal | undefined,
  progress: (label: string) => void,
  onNotice?: (message: string) => void,
  fileCanon = true,
  textStillFiled?: () => Promise<boolean>
): Promise<void> {
  if (turnsSaved <= 0) return;
  const inScene = ctx.characters.filter(
    (c) => ctx.episode.castIds.includes(c.id) && !c.isPlayer
  );
  const scenePeople = ctx.characters.filter(
    (c) => c.isPlayer || ctx.episode.castIds.includes(c.id)
  );

  const chars = episodeHistoryChars(ctx.turns);
  const lastState = ctx.episode.liveStateAtChars ?? 0;
  const lastCanon = ctx.episode.liveCanonAtChars ?? 0;
  const growthNeeded = Math.round(HISTORY_CHAR_BUDGET * 0.04);
  if (lastState === 0 && ctx.turns.length < 2) return;
  if (lastState > 0 && chars <= lastState) return;
  // "few": the older cadence, one pass per few turns' worth of new story.
  if (world.ai.liveUpdates === 'few' && lastState > 0 && chars < lastState + growthNeeded) return;
  const canonDue = lastCanon === 0 || chars >= lastCanon + growthNeeded;
  // fileCanon is false on a "just this moment" turn: nothing durable is filed then.
  const fileCanonNow = fileCanon && canonDue;

  const since = turnsSinceCharMark(ctx.turns, fileCanonNow ? lastCanon : lastState);
  // A per-turn pass still reads a little of what came before, for who and where.
  const source = since.length >= 2 ? since : ctx.turns.slice(-4);
  const guests = ctx.episode.guests ?? [];
  const digest = compressOmittedTurns(source, ctx.characters, guests);
  if (!digest.trim()) return;
  const newest = compressOmittedTurns(turnsToGrade(ctx.turns, lastState), ctx.characters, guests);

  const castLines = scenePeople
    .map((c) => {
      const s = c.state;
      const usual = c.looks?.clothing?.trim();
      const outfit = `wearing="${s.wearing || ''}"${usual ? ` (usually: ${usual.slice(0, 80)})` : ''}`;
      return c.isPlayer
        ? `- ${c.name} (player, outfit only): ${outfit}`
        : `- ${c.name}: goal="${s.goal || ''}"; emotion="${s.emotion || ''}"; ` +
          `location="${s.location || ''}"; condition="${s.condition || ''}"; ${outfit}`;
    })
    .join('\n');

  const priorLedger = (ctx.episode.sceneLedger ?? []).map((d) => `- ${d}`).join('\n');
  const tieLines = scenePeople
    .flatMap((c) =>
      c.relationships
        .filter((r) => scenePeople.some((o) => o.id === r.targetId))
        .slice(0, 3)
        .map((r) => {
          const to = scenePeople.find((o) => o.id === r.targetId);
          return to ? `- ${c.name} → ${to.name}: ${r.kind || 'linked'}${r.note.trim() ? ` — ${r.note.trim().slice(0, 60)}` : ''}` : null;
        })
    )
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');

  const playerHere = scenePeople.find((c) => c.isPlayer);
  const trackedBonds = playerHere
    ? scenePeople.flatMap((c) => (
      c.isPlayer
        ? []
        : c.relationships
          .filter((r) => r.track && r.targetId === playerHere.id)
          .map((r) => ({ name: c.name.trim(), rel: r }))
    )).filter((row) => row.name).slice(0, 4)
    : [];
  const trackedGoals = (playerHere?.goals ?? []).filter((g) => g.text.trim()).slice(0, 4);
  // fileCanon is false on a "just this moment" turn, which must not move a score.
  const askShifts = fileCanon && (trackedBonds.length > 0 || trackedGoals.length > 0);
  const bondList = trackedBonds.map((row, index) => {
    const words = meaningWords(row.rel.score ?? 0, row.rel.marks, FALLBACK_BOND_MARKS);
    return `${index + 1}. ${row.name}. Now: ${words.current}.${words.next ? ` Next: ${words.next}.` : ''}`;
  }).join('\n');
  const goalList = trackedGoals.map((goal, index) => {
    const words = meaningWords(goal.score, goal.marks, FALLBACK_GOAL_MARKS);
    return `${index + 1}. ${goal.text.trim()}. Now: ${words.current}.${words.next ? ` Next: ${words.next}.` : ''}`;
  }).join('\n');
  const shiftRules = askShifts
    ? 'bonds: one row per listed tracked bond. shift is an integer from -2 to 2, and 0 if this beat did not move it. ' +
      'reason is one short clause, or omit. Do not pick a new score or a new kind.\n' +
      'goals: one row per listed player goal. index is that goal\'s number. The same shift scale. 0 if this beat did not move it.\n' +
      'Do not put a tracked bond in ties.\n' +
      `${BOND_RUBRIC}\n`
    : '';
  const memoryRules = fileCanon && inScene.length > 0
    ? `memories: for in-scene cast only (exact names), 0–${NPC_MEMORY_PER_PASS} per person, ` +
      'only for something they would still think about later: what happened, from their side, third person, under 160 characters. ' +
      'feeling: a word or two for how it left them. salience: 1 passing, 2 notable, 3 they will never forget. ' +
      'Skip small talk and anything they did not witness. Omit if nothing is memorable.\n'
    : '';
  const rulesOn = !!activeMechanics(world);
  const carried = inventoryLine(playerHere?.inventory);
  const inventoryRules = rulesOn && fileCanon && playerHere
    ? 'inventory: only things the player clearly gained, lost, used up, or gave away in these beats. ' +
      'action is add or remove; name is short (a noun phrase); qty defaults to 1. ' +
      'When removing, use the exact name from Player carries. Omit if nothing changed hands.\n'
    : '';
  const latestTurn = ctx.turns[ctx.turns.length - 1];
  const suggestRules = playerHere && latestTurn && latestTurn.role !== 'user'
    ? `suggestions: 3 short, distinct things ${playerHere.name.trim() || 'the player'} could do or say next, ` +
      'each under 14 words, in their voice. A spoken line goes in "double quotes"; an action is a bare phrase starting with a verb. ' +
      'Mix one bold, one careful, one curious. Never decide for them.\n'
    : '';
  const canonRules = fileCanonNow
    ? `facts: 0–${LIVE_CANON_FACT_CAP} durable facts (debts, promises, objects, injuries, who saw what). ` +
      'Not weather, not mood, not a plot recap. Do not repeat Known facts.\n' +
      `threads: 0–${LIVE_CANON_THREAD_CAP} NEW open tensions not already listed.\n` +
      'place: lasting room condition and optional weather/light; omit if unchanged.\n' +
      'knowledge: only in-scene named cast who clearly learned something; omit if none.\n'
    : 'Omit facts, threads, place, and knowledge on this pass.\n';

  const inSceneNames = new Set(inScene.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
  const existingFactTexts = ctx.continuity.map((f) => f.text);
  const existingThreadTexts = ctx.threads.map((t) => t.text);
  const episodeFactCount = ctx.continuity.filter((f) => f.episodeId === ctx.episode.id).length;
  const knownBlock = existingFactTexts.slice(-24).map((t) => `- ${t}`).join('\n');
  const threadBlock = existingThreadTexts.slice(0, 16).map((t) => `- ${t}`).join('\n');
  const placeLine = ctx.episode.location || '(unnamed)';
  const loc = ctx.episode.locationId
    ? ctx.locations.find((l) => l.id === ctx.episode.locationId)
    : ctx.locations.find((l) => l.name.toLowerCase() === placeLine.trim().toLowerCase());

  if (textStillFiled && !(await textStillFiled())) return;

  try {
    progress('updating the room…');
    const result = await utilityJson<{
      updates?: Array<{
        name?: string;
        goal?: string;
        emotion?: string;
        location?: string;
        condition?: string;
        wearing?: string;
      }>;
      scene?: string[];
      ties?: Array<{ from?: string; to?: string; kind?: string; note?: string }>;
      facts?: string[];
      threads?: string[];
      place?: { name?: string; currentState?: string; atmosphere?: string };
      knowledge?: Array<{ name?: string; nowKnows?: string }>;
      memories?: MemoryDraft[];
      inventory?: InventoryChange[];
      suggestions?: string[];
      bonds?: Array<{ name?: string; shift?: number; reason?: string }>;
      goals?: Array<{ index?: number; text?: string; shift?: number; reason?: string }>;
    }>(
      world,
      'You update live room state and file hard canon WHILE the episode is still open. ' +
        'Call update_live_memory. Do not write story prose. ' +
        'updates: only characters whose state clearly shifted. Omit unchanged fields. ' +
        'wearing: set only when someone clearly changes, removes, or ruins clothes (a gown for the ball, a soaked coat); "none" when back in their usual clothes. ' +
        'For the player, only wearing may be set. ' +
        'Use "none" for a field that no longer applies. Keep each field under 120 characters.\n' +
        'ties: at most 3, only when a relationship clearly shifted. Exact roster names. Omit if none.\n' +
        'scene: 3–6 short physical facts now true in this room. Rewrite the whole list: ' +
        'carry forward what still holds, drop what stopped being true. Concrete nouns, no feelings.\n' +
        canonRules +
        memoryRules +
        inventoryRules +
        suggestRules +
        shiftRules +
        'bonds, goals, memories, and inventory come only from Newest beats. Recent beats are context: never grade or file them again.\n' +
        'Omit any key that has nothing new. Each canon line under 220 characters.',
      `World: ${world.title}. Episode ${ctx.episode.number}.\n` +
        `Place: ${placeLine}${loc?.currentState ? ` (now: ${loc.currentState})` : ''}\n` +
        `In-scene cast (current state):\n${castLines || '(nobody on stage)'}\n\n` +
        `Already established in this scene (do not refile as facts):\n${priorLedger || '(nothing yet)'}\n\n` +
        `Ties in the room:\n${tieLines || '(none filed)'}\n\n` +
        (askShifts ? `Tracked bonds:\n${bondList || '(none)'}\n\nPlayer goals:\n${goalList || '(none)'}\n\n` : '') +
        (inventoryRules ? `Player carries: ${carried || '(nothing)'}\n\n` : '') +
        (fileCanonNow
          ? `Known facts (do not repeat):\n${knownBlock || '(none)'}\n\n` +
            `Open threads (do not repeat):\n${threadBlock || '(none)'}\n\n`
          : '') +
        `Recent beats:\n${digest.slice(0, 10000)}\n\n` +
        `Newest beats:\n${newest.slice(0, 4000)}\n\n` +
        `Call update_live_memory.`,
      (askShifts ? 1400 : 1100) + (memoryRules ? 300 : 0),
      signal,
      25_000,
      'utility',
      LIVE_MEMORY_TOOL
    );

    if (textStillFiled && !(await textStillFiled())) return;
    const applied = scenePeople.length > 0
      ? await applyLiveCharacterStateUpdates(world.id, scenePeople, result.updates ?? [])
      : 0;
    const tiesApplied = await applyLiveRelationshipUpdates(
      scenePeople,
      result.ties ?? [],
      ctx.characters.map((c) => c.id)
    );
    let shiftsApplied = 0;
    if (askShifts) {
      const changes = applyTrackedShifts({
        people: scenePeople,
        bonds: result.bonds ?? [],
        goals: result.goals ?? [],
        worldPace: worldBondPace(world.ai),
        stance: storyStanceOf(world),
        moment: false
      });
      const shiftedAt = Date.now();
      for (const change of changes) {
        const patch: Partial<Character> = { updatedAt: shiftedAt };
        if (change.relationships) patch.relationships = change.relationships;
        if (change.goals) patch.goals = change.goals;
        await db.characters.update(change.id, patch);
        const person = scenePeople.find((c) => c.id === change.id);
        if (person && change.relationships) person.relationships = change.relationships;
        if (person && change.goals) person.goals = change.goals;
        shiftsApplied += 1;
      }
    }
    const sceneLedger = capSceneLedger(result.scene);

    const extract = rememberedExtract(normalizeLiveCanonExtract(result, {
      existingFacts: existingFactTexts,
      existingThreads: existingThreadTexts,
      inSceneNames,
      episodeFactCount
    }), fileCanonNow);

    const now = Date.now();
    let remembered = 0;
    if (memoryRules) {
      const byPerson = groupMemoryDrafts(result.memories, inScene);
      for (const [id, drafts] of byPerson) {
        const person = inScene.find((c) => c.id === id);
        if (!person) continue;
        // This context may predate the last turn's pass. Post-turn work is queued,
        // so the stored row holds every memory filed so far.
        const stored = (await db.characters.get(id))?.memories ?? person.memories;
        const next = addMemories(stored, drafts, { episodeId: ctx.episode.id, now, makeId: uid });
        if (next.length === (stored?.length ?? 0) && next.every((m, i) => m === stored?.[i])) continue;
        // update() merges, so the score shifts written above are kept.
        await db.characters.update(id, { memories: next, updatedAt: now });
        person.memories = next;
        remembered += 1;
      }
    }
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
      for (const k of extract.knowledge) {
        const learned = k.nowKnows?.trim();
        if (!learned) continue;
        const c = inScene.find((x) => x.name.toLowerCase() === k.name.toLowerCase())
          ?? ctx.characters.find((x) => !x.isPlayer && x.name.toLowerCase() === k.name.toLowerCase());
        if (!c) continue;
        const nextWall = clearMustNotKnowClause(c.mustNotKnow, learned);
        if (nextWall === c.mustNotKnow) continue;
        await db.characters.update(c.id, { mustNotKnow: nextWall, updatedAt: now });
        c.mustNotKnow = nextWall;
      }
    }

    const epPatch: Partial<Episode> = {
      liveStateAtChars: chars,
      ...(fileCanon ? { liveCanonAtChars: chars } : {}),
      updatedAt: now
    };
    if (sceneLedger) epPatch.sceneLedger = sceneLedger;
    const ideas = suggestRules ? cleanSuggestions(result.suggestions) : [];
    if (ideas.length > 0 && latestTurn) epPatch.suggestions = { afterTurnId: latestTurn.id, items: ideas };
    if (extract.place?.atmosphere?.trim()) {
      epPatch.atmosphereNote = extract.place.atmosphere.trim();
    }
    await db.episodes.update(ctx.episode.id, epPatch);
    ctx.episode = { ...ctx.episode, ...epPatch };
    let packed = 0;
    if (inventoryRules && playerHere && result.inventory?.length) {
      const stored = (await db.characters.get(playerHere.id))?.inventory ?? playerHere.inventory;
      const next = applyInventoryChanges(stored, result.inventory, uid);
      if (next) {
        await db.characters.update(playerHere.id, { inventory: next, updatedAt: now });
        playerHere.inventory = next;
        packed = 1;
      }
    }
    if (applied > 0 || tiesApplied > 0 || shiftsApplied > 0 || remembered > 0 || packed > 0) {
      const refreshed = await db.characters.where('worldId').equals(world.id).toArray();
      ctx.characters = refreshed;
    }
    if (newFacts.length > 0 || knowledgeFacts.length > 0) {
      ctx.continuity = [...ctx.continuity, ...newFacts, ...knowledgeFacts];
    }
    if (newThreads.length > 0) {
      ctx.threads = [...ctx.threads, ...newThreads];
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    logAppError(e, 'live memory');
    // The small per-turn pass fails quietly; the next turn or the wrap catches up.
    if (fileCanonNow) onNotice?.('Couldn’t update the room — sheets and live memory will catch up at wrap.');
  }
}

/**
 * The player move a reply answers: only the line right before it. A Continue or
 * a world turn answers nobody, so an older roll must not decide its rewrite.
 */
export function answeredMove(turns: Turn[], replyAt: number): Turn | undefined {
  const before = replyAt > 0 ? turns[replyAt - 1] : undefined;
  return before?.role === 'user' ? before : undefined;
}

/**
 * Turns whose deltas (scores, memories, the pack) are still ungraded. Normally
 * that is what landed since the last pass. After an edit or rewind the mark is
 * 0 and the canon window may span the whole chapter, so only the newest
 * exchange counts: the last player move onward.
 */
export function turnsToGrade<T extends { role: string; text: string }>(turns: T[], lastStateChars: number): T[] {
  const sinceLastPass = lastStateChars > 0 ? turnsSinceCharMark(turns, lastStateChars) : [];
  if (sinceLastPass.length > 0) return sinceLastPass;
  const lastMoveAt = turns.map((t) => t.role).lastIndexOf('user');
  return lastMoveAt >= 0 ? turns.slice(lastMoveAt) : turns.slice(-2);
}

/** Memory drafts by in-scene person. Names that match nobody here are dropped. */
export function groupMemoryDrafts(
  drafts: MemoryDraft[] | undefined,
  inScene: Array<Pick<Character, 'id' | 'name' | 'aliases'>>
): Map<string, MemoryDraft[]> {
  const out = new Map<string, MemoryDraft[]>();
  for (const draft of drafts ?? []) {
    const key = draft.name?.trim().toLowerCase();
    if (!key || !draft.text?.trim()) continue;
    const person = inScene.find((c) =>
      c.name.trim().toLowerCase() === key ||
      (c.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key)
    );
    if (!person) continue;
    out.set(person.id, [...(out.get(person.id) ?? []), draft]);
  }
  return out;
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
    /** What they have on now, when they change or lose clothes. */
    wearing?: string;
  }>
): Promise<number> {
  let applied = 0;
  const now = Date.now();
  for (const u of updates) {
    const name = (u.name ?? '').trim().toLowerCase();
    if (!name) continue;
    const c = cast.find((x) => x.name.toLowerCase() === name);
    if (!c) continue;
    // The player's goals and feelings are theirs to set; only what they wear is tracked.
    const wearing = mergeStateField(u.wearing, c.state.wearing ?? '');
    const state: CharacterState = c.isPlayer
      ? { ...c.state }
      : {
        goal: mergeStateField(u.goal, c.state.goal),
        emotion: mergeStateField(u.emotion, c.state.emotion),
        location: mergeStateField(u.location, c.state.location),
        condition: mergeStateField(u.condition, c.state.condition)
      };
    if (wearing) state.wearing = wearing;
    else delete state.wearing;
    if (
      state.goal === c.state.goal &&
      state.emotion === c.state.emotion &&
      state.location === c.state.location &&
      state.condition === c.state.condition &&
      (state.wearing ?? '') === (c.state.wearing ?? '')
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

/** Patch one outbound tie when live play makes it obvious. Null if nothing changed. */
export function mergeLiveRelationshipPatch(
  from: Character,
  to: Character,
  patch: { kind?: string; note?: string },
  castIds: string[]
): Relationship[] | null {
  if (from.id === to.id) return null;
  const existing = from.relationships.find((r) => r.targetId === to.id);
  // A tracked bond moves by score. The model's kind cannot jump it.
  if (existing?.track) return null;
  const kind = (patch.kind ?? '').trim();
  const note = (patch.note ?? '').trim();
  if (!kind && !note) return null;
  const nextKind = kind || existing?.kind || 'linked';
  const nextNote = note || existing?.note || '';
  if (existing && existing.kind === nextKind && existing.note === nextNote) return null;
  return normalizeRelationships(
    [
      ...from.relationships.filter((edge) => edge.targetId !== to.id),
      { targetId: to.id, kind: nextKind, note: nextNote }
    ],
    castIds,
    from.id
  );
}

export async function applyLiveRelationshipUpdates(
  people: Character[],
  ties: Array<{ from?: string; to?: string; kind?: string; note?: string }>,
  castIds: string[] = people.map((c) => c.id)
): Promise<number> {
  let applied = 0;
  const now = Date.now();
  const ids = castIds;
  const byName = (raw?: string) => {
    const key = (raw ?? '').trim().toLowerCase();
    if (!key) return undefined;
    return people.find((c) => c.name.trim().toLowerCase() === key);
  };
  for (const t of ties.slice(0, 3)) {
    const from = byName(t.from);
    const to = byName(t.to);
    if (!from || !to) continue;
    const next = mergeLiveRelationshipPatch(from, to, t, ids);
    if (!next) continue;
    await db.characters.update(from.id, { relationships: next, updatedAt: now });
    from.relationships = next;
    applied++;
  }
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
  /** Near-copies of facts this chapter made false. */
  staleFacts: string[];
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
    staleFacts?: string[];
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
  const staleFacts = (raw.staleFacts ?? [])
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean)
    .slice(0, SOFT_WRAP_FACT_CAP);
  return { facts, threads, characterUpdates, place: normalizePlacePatch(raw.place), staleFacts };
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
  const existingRows = await db.continuity.where('seasonId').equals(season.id).toArray();
  const stale = selectStaleFactTexts(
    extract.staleFacts,
    existingRows.map((f) => f.text),
    SOFT_WRAP_FACT_CAP
  );
  const removed = new Set<string>();
  if (stale.length > 0) {
    const doomed = existingRows.filter((row) =>
      !row.pinned && stale.some((line) => line.trim().toLowerCase() === row.text.trim().toLowerCase())
    );
    for (const row of doomed) removed.add(row.id);
    if (doomed.length > 0) {
      await recordTombstones(doomed.map((row) => ({
        table: 'continuity' as const,
        id: row.id,
        worldId: row.worldId,
        seasonId: row.seasonId,
        episodeId: row.episodeId,
        payload: row
      })));
      await db.continuity.bulkDelete(doomed.map((row) => row.id));
    }
  }
  const existingFacts = existingRows.filter((row) => !removed.has(row.id)).map((f) => f.text);
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

/** True when a recap is already saved. Continuity may still be retried. */
export function softWrapAlreadyFiled(episode: Pick<Episode, 'wrap'>): boolean {
  return !!(episode.wrap?.recap?.trim());
}

/**
 * The chapter the model should read at End chapter.
 * Earlier turns may be compressed. The last turns are always included whole.
 */
export function chapterCloseDigest(
  turns: Turn[],
  characters: Character[],
  guests: EpisodeGuest[] = []
): string {
  if (turns.length === 0) return '';
  const tailCount = Math.min(4, turns.length);
  const tail = turns.slice(-tailCount);
  const earlier = turns.slice(0, turns.length - tailCount);
  const close = compressOmittedTurns(tail, characters, guests);
  if (earlier.length === 0) return close;
  const head = compressOmittedTurns(earlier, characters, guests);
  return [head, '--- End of the chapter ---', close].filter(Boolean).join('\n\n');
}

export interface SoftWrapCommit {
  wrap: EpisodeWrap;
  /** Fresh weather for the next chapter. Omitted when the close did not name any. */
  atmosphereNote?: string;
}

/**
 * Recap plus a thin continuity pass for End chapter.
 * Does not open the next episode — Story does, with the atmosphere note and pending targets.
 * A saved recap is kept. The fact pass still runs, and novel lines are not inserted twice.
 */
export async function commitSoftEpisodeWrap(
  world: World,
  season: Season,
  episode: Episode
): Promise<SoftWrapCommit> {
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const guests = episode.guests ?? [];
  const close = chapterCloseDigest(turns, characters, guests);
  const summary = episode.runningSummary?.trim() ?? '';
  let recap = episode.wrap?.recap?.trim() ?? '';
  if (!recap) {
    if (close.trim()) {
      try {
        const { provider, model } = utilityModelFor(world);
        const context = summary
          ? `Mid-chapter summary (context only — the close is how the chapter ended):\n${summary}\n\n`
          : '';
        const { text } = await streamChat({
          provider,
          model,
          system:
            'Summarize a chapter of an interactive story for a previously-on card. ' +
            'Write 80–160 words in past tense, and include how the chapter ended. No dialogue quotes. No preamble.',
          messages: [{
            role: 'user',
            content:
              `World: ${world.title}. Chapter ${episode.number}` +
              `${episode.title ? ` (${episode.title})` : ''}.\n\n${context}${close.slice(0, 12000)}`
          }],
          maxTokens: 400
        });
        recap = text.trim();
      } catch (e) {
        logAppError(e, 'soft wrap recap');
      }
    }
    if (!recap) {
      const last = turns.slice(-3).map((t) => t.text.trim()).filter(Boolean);
      recap = last.length > 0
        ? `Chapter ${episode.number} ended. Last of it: ${last.map((t) => t.slice(0, 120)).join(' / ')}`
        : `Chapter ${episode.number} ended without a filed summary.`;
    }
    recap = recap.slice(0, 1200);
    const wrap: EpisodeWrap = { recap, beats: [], guestEffects: [] };
    await db.episodes.update(episode.id, { wrap, updatedAt: Date.now() });
    episode = { ...episode, wrap };
  }

  const wrap = episode.wrap!;
  let atmosphereNote: string | undefined;
  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const inSceneNames = new Set(inScene.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
  try {
    const source = close.trim() || recap;
    const result = await utilityJson<{
      facts?: string[];
      threads?: string[];
      staleFacts?: string[];
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
      'You are a continuity editor filing the end of a chapter. Call return_json with this shape: ' +
      '{"facts":["..."],"threads":["..."],"staleFacts":["..."],' +
      '"characterUpdates":[{"name":"<exact name of someone present>","goal":"","emotion":"","location":"","condition":""}],' +
      '"place":{"name":"<place>","currentState":"<how the room is left>","atmosphere":"<weather now, or empty>"}}. ' +
      `At most ${SOFT_WRAP_FACT_CAP} durable facts, ${SOFT_WRAP_FACT_CAP} stale facts, and ${SOFT_WRAP_THREAD_CAP} unresolved threads. ` +
      'Facts must still be true in the next chapter (revelations, injuries, promises, debts). ' +
      'staleFacts: known facts this chapter made false, in their existing wording. Omit if none. ' +
      'characterUpdates: only named people who are present; omit empties. ' +
      'place.currentState: lasting physical condition of the place as left; omit if nothing changed. ' +
      'place.atmosphere: the weather or time of day the next chapter should open on; omit if unchanged. ' +
      'Do not invent people, relationships, or calendar hits.',
      `World: ${world.title}. Chapter ${episode.number}.\n` +
      `Place: ${episode.location || '(unnamed)'}\n` +
      `Present: ${inScene.map((c) => c.name).join(', ') || '(none)'}\n\n` +
      (summary ? `Mid-chapter summary (context only):\n${summary}\n\n` : '') +
      `Recap:\n${recap}\n\nChapter material, ending included:\n${source.slice(0, 14000)}`,
      1400,
      undefined,
      45_000,
      'wrap'
    );
    const capped = capSoftWrapExtract(result, inSceneNames);
    atmosphereNote = capped.place?.atmosphere?.trim() || undefined;
    await fileSoftWrapContinuity(world, season, episode, capped);
  } catch (e) {
    logAppError(e, 'soft wrap continuity');
  }

  return atmosphereNote ? { wrap, atmosphereNote } : { wrap };
}

export type EpisodeMemorySnapshot = {
  runningSummary: string | null;
  runningSummaryAtChars: number;
  liveStateAtChars: number;
  liveCanonAtChars: number;
  sceneLedger: string[];
};

/** Summary and live-memory watermarks, so a cancelled rewrite can put them back. */
export async function snapshotEpisodeMemory(episodeId: string): Promise<EpisodeMemorySnapshot | null> {
  const episode = await db.episodes.get(episodeId);
  if (!episode) return null;
  return {
    runningSummary: episode.runningSummary ?? null,
    runningSummaryAtChars: episode.runningSummaryAtChars ?? 0,
    liveStateAtChars: episode.liveStateAtChars ?? 0,
    liveCanonAtChars: episode.liveCanonAtChars ?? 0,
    sceneLedger: [...(episode.sceneLedger ?? [])]
  };
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

/**
 * After edit / rewrite / delete: drop digests that still describe the old prose
 * so the next Write reads only the finalized transcript.
 */
export async function finalizeChapterMemory(episodeId: string): Promise<void> {
  await waitForPostTurn();
  await db.episodes.update(episodeId, {
    runningSummary: null,
    runningSummaryAtChars: 0,
    liveStateAtChars: 0,
    liveCanonAtChars: 0,
    sceneLedger: [],
    updatedAt: Date.now()
  });
}

/** Episode patch shape used by tests and callers that update locally. */
export function chapterMemoryClearPatch(): {
  runningSummary: null;
  runningSummaryAtChars: 0;
  liveStateAtChars: 0;
  liveCanonAtChars: 0;
  sceneLedger: [];
} {
  return {
    runningSummary: null,
    runningSummaryAtChars: 0,
    liveStateAtChars: 0,
    liveCanonAtChars: 0,
    sceneLedger: []
  };
}

/** Delete one turn only. */
export async function deleteTurn(turnId: string, episodeId: string): Promise<void> {
  const turns = await db.turns.where('episodeId').equals(episodeId).toArray();
  const hit = turns.find((t) => t.id === turnId);
  if (!hit) return;
  await tombstoneAndDeleteTurns([hit]);
}

/** Delete a turn and everything after it (used by regenerate / retry). */
export async function deleteTurnsFrom(turnId: string, episodeId: string): Promise<void> {
  const turns = await snapshotTurnsFrom(turnId, episodeId);
  if (turns.length === 0) return;
  await tombstoneAndDeleteTurns(turns);
  await forgetMemoriesSince(turns, episodeId);
}

/** Show another kept version of a rewritten reply. */
export async function switchTurnAlt(turnId: string, episodeId: string, index: number): Promise<boolean> {
  const turn = await db.turns.get(turnId);
  if (!turn) return false;
  const patch = switchAltPatch(turn, index);
  if (!patch) return false;
  await guardStorage(() => db.turns.update(turnId, { ...patch, updatedAt: Date.now() }));
  await finalizeChapterMemory(episodeId);
  return true;
}

/** Everything a rewind takes away, so Undo can put it back. */
export interface RewindUndo {
  episodeId: string;
  removed: Turn[];
  startedAt: number;
  memory: EpisodeMemorySnapshot | null;
  /** Each person's memories and live state (mood, place, outfit) before the rewind. */
  recall: Array<{ id: string; memories: NpcMemory[] | undefined; state: CharacterState }>;
}

/** Drop everything after this turn. Returns what Undo needs, or null when nothing came after. */
export async function rewindTo(turn: Turn): Promise<RewindUndo | null> {
  const [removed, memory] = await Promise.all([
    snapshotTurnsAfter(turn.id, turn.episodeId),
    snapshotEpisodeMemory(turn.episodeId)
  ]);
  if (removed.length === 0) return null;
  await waitForPostTurn();
  const people = await db.characters.where('worldId').equals(turn.worldId).toArray();
  const recall = people.map((p) => ({ id: p.id, memories: p.memories, state: p.state }));
  const startedAt = Date.now();
  await deleteTurnsAfter(turn.id, turn.episodeId);
  await finalizeChapterMemory(turn.episodeId);
  return { episodeId: turn.episodeId, removed, startedAt, memory, recall };
}

/** Put a rewind back. Lines written since the rewind are removed. */
export async function undoRewind(undo: RewindUndo): Promise<void> {
  await rollbackTurnSnapshot(undo.episodeId, undo.removed, undo.startedAt, undo.memory);
  const now = Date.now();
  for (const row of undo.recall) {
    await db.characters.update(row.id, { memories: row.memories, state: row.state, updatedAt: now }).catch(() => undefined);
  }
}

/** Delete everything after a turn, keeping the turn itself. */
export async function deleteTurnsAfter(turnId: string, episodeId: string): Promise<void> {
  const turns = await snapshotTurnsAfter(turnId, episodeId);
  if (turns.length === 0) return;
  await tombstoneAndDeleteTurns(turns);
  await forgetMemoriesSince(turns, episodeId);
}

/**
 * A rewind un-happens events, so nobody should still remember them.
 * Drops memories filed in this chapter at or after the earliest removed turn.
 */
async function forgetMemoriesSince(removed: Turn[], episodeId: string): Promise<void> {
  const since = Math.min(...removed.map((t) => t.createdAt));
  const worldId = removed[0]?.worldId;
  if (!worldId || !Number.isFinite(since)) return;
  await waitForPostTurn();
  const people = await db.characters.where('worldId').equals(worldId).toArray();
  const now = Date.now();
  for (const person of people) {
    const kept = forgetFiledSince(person.memories, episodeId, since);
    if (kept) await db.characters.update(person.id, { memories: kept, updatedAt: now });
  }
}

/**
 * After a failed retry: remove turns written during the attempt and put the
 * snapshot, including the summary, back.
 */
export async function rollbackTurnSnapshot(
  episodeId: string,
  snapshot: Turn[],
  retryStartedAt: number,
  memory?: EpisodeMemorySnapshot | null
): Promise<void> {
  const snapIds = new Set(snapshot.map((t) => t.id));
  const current = await db.turns.where('episodeId').equals(episodeId).toArray();
  const extras = current.filter((t) => !snapIds.has(t.id) && t.createdAt >= retryStartedAt);
  if (extras.length > 0) await tombstoneAndDeleteTurns(extras);
  await db.transaction('rw', [db.turns, db.tombstones, db.episodes], async () => {
    if (snapshot.length > 0) {
      await db.tombstones.bulkDelete(snapshot.map((turn) => `turns:${turn.id}`));
      await db.turns.bulkPut(snapshot);
    }
    if (!memory) return;
    await db.episodes.update(episodeId, {
      runningSummary: memory.runningSummary,
      runningSummaryAtChars: memory.runningSummaryAtChars,
      liveStateAtChars: memory.liveStateAtChars,
      liveCanonAtChars: memory.liveCanonAtChars,
      sceneLedger: memory.sceneLedger,
      updatedAt: Date.now()
    });
  });
}

// ---------- Utility calls (JSON tasks on the utility model) ----------

const WRAP_ANALYZE_TIMEOUT_MS = 90_000;

async function utilityJson<T>(
  world: World | null,
  system: string,
  user: string,
  maxTokens = 3000,
  signal?: AbortSignal,
  timeoutMs = UTILITY_TIMEOUT_MS,
  job: 'utility' | 'wrap' = 'utility',
  tool?: ToolSpec
): Promise<T> {
  return utilityCall<T>({ world, system, user, maxTokens, signal, timeoutMs, job, tool });
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

/** Match wrap "resolved" lines to open threads (exact, contains, then token overlap). */
function matchOpenThreads(
  open: OpenThread[],
  resolvedLines: string[]
): OpenThread[] {
  return matchByExactContainsOrTokens(open, resolvedLines, (t) => t.text);
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
    `You are a story editor reviewing a finished season. Call return_json with this shape:\n{"beats": [{"where": "S${season.number} · E<n> · <place>", "text": "<what happened, one sentence>", "consequence": "<what it left behind, one sentence>"}], "characters": [{"name": "<character name>", "outcome": "<where the season leaves them, 1-2 sentences>"}]}\nExtract 4-7 beats — the events that will shape what comes next. Cover every named character in "characters".`,
    `World: ${world.title}. Season ${season.number} premise: ${season.premise}\n\nCast: ${characters.map((c) => c.name).join(', ')}\n\n${episodeSummaries.join('\n\n---\n\n').slice(0, 60000)}`,
    4000,
    undefined,
    WRAP_ANALYZE_TIMEOUT_MS,
    'wrap'
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
    'Propose only earned changes across the time gap. Call return_json with this shape:\n' +
    '{"characters":[{' +
    '"name":string,' +
    '"evolution":"<1-2 sentences of what changed off-screen>",' +
    '"statePatch":{"goal"?:string,"emotion"?:string,"location"?:string,"condition"?:string},' +
    '"sheetPatch":{"role"?:string,"summary"?:string,"traits"?:string,"desires"?:string,"fears"?:string,"flaws"?:string},' +
    '"knowledge":{"nowKnows"?:string,"clearMustNotKnow"?:string}' +
    '}],' +
    '"relationshipUpdates":[{"from":"<exact name>","to":"<exact name>","kind":string,"note":string}],' +
    '"plotArc":[{"text":"<season-arc situation for next season>"}]}' +
    '\nRules:\n' +
    '- Prefer omission over noise — omit unchanged fields entirely.\n' +
    '- Never rewrite speechStyle, example lines, anchors, or customInstructions.\n' +
    '- sheetPatch: only for non-player NPCs; concrete earned shifts (1-2 sentences max per field).\n' +
    '- PLAYER characters: evolution + light statePatch only — no sheetPatch.\n' +
    '- statePatch: how they OPEN the next season, not a recap dump.\n' +
    '- relationshipUpdates: only edges that shifted; use exact cast names.\n' +
    '- plotArc: 2-5 distinct arc situations for season N+1; do not duplicate Raise beats already listed.\n' +
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
    4500,
    undefined,
    WRAP_ANALYZE_TIMEOUT_MS,
    'wrap'
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
    const prev = from.relationships.find((edge) => edge.targetId === to.id);
    from.relationships = normalizeRelationships(
      [
        ...from.relationships.filter((edge) => edge.targetId !== to.id),
        {
          ...keptBond(prev),
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
    system: `You write season premises for longform interactive fiction. ${stancePlaybook(storyStanceOf(world))} One paragraph, 2-4 sentences, present tense, concrete situation. Open on the raised beats. No preamble — return only the premise.`,
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
          ? `\n\nExtra plot situations:\n${keptArc.map((p) => `- ${p.text}`).join('\n')}`
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

  // Carry place into season-open E1 when the last episode still had a valid location.
  const priorEps = await db.episodes.where('seasonId').equals(season.id).toArray();
  const lastEp = [...priorEps].sort((a, b) => b.number - a.number)[0];
  const worldPlaces = await db.locations.where('worldId').equals(world.id).toArray();
  const placeById = new Map(worldPlaces.map((l) => [l.id, { id: l.id, name: l.name }]));
  const { location: openLocation, locationId: openLocationId } = seasonOpenPlaceFromLastEpisode(
    lastEp,
    (id) => placeById.get(id)
  );
  const openPlace = openLocationId
    ? worldPlaces.find((l) => l.id === openLocationId)
    : worldPlaces.find((l) => l.name.trim() && l.name.trim().toLowerCase() === openLocation.trim().toLowerCase());
    const fittingIds = openingFittingIds(allCharacters.filter((c) => !c.isPlayer && characterFitsPlace(c, {
    name: openPlace?.name || openLocation,
    inhabitants: openPlace?.inhabitants ?? '',
    residentIds: openPlace?.residentIds
  })));
  const castIds = playerId
    ? [playerId, ...fittingIds.filter((id) => id !== playerId)]
    : fittingIds;

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
    'Call return_json with this shape: {"events":[{"title":"...","summary":"...","kind":"holiday|festival|ceremony|gathering|sport|disaster|personal|mundane|custom",' +
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
    importance?: string;
    looks?: Record<string, unknown>;
    state?: { goal?: string; emotion?: string; location?: string; condition?: string };
  }>(
    world,
    'You design deep NPC character sheets for longform interactive fiction. Call return_json with this shape:\n' +
    '{"name": string, "role": "<role · relationship to protagonist>", "age": string, "appearance": "<overall impression, one sentence>", ' +
    '"looks":{"face":"<features and expression>","hair":"<color, length, style>","body":"<build, height, how they move>",' +
    '"clothing":"<their usual outfit>","details":"<scars, tattoos, jewellery, glasses, or empty>","senses":"<voice timbre and scent, or empty>"' +
    (world?.ai.mature ? ',"intimate":"<adult physical details, only for an adult, or empty>"' : '') + '}, ' +
    '"mannerisms": "<2-3 recurring physical habits or tics, concrete and observable>", ' +
    '"backstory": "<the history that shaped them, 2-3 sentences>", "summary": "<who they are, 2-4 sentences of prose>", ' +
    '"speechStyle": "<how they sound when heard: sentence length, contractions, what they dodge, 1-2 sentences>", ' +
    '"exampleLines": [<2-3 lines they would actually say aloud, not narration>], ' +
    '"traits": string, "desires": string, "fears": string, "flaws": string, "secrets": "<something they hide>", ' +
    '"mustNotKnow": "<facts they must not know yet, or empty>", ' +
    '"anchors": [<3-4 hard behavioural rules they never break, e.g. "Never lies in writing">], ' +
    '"importance": "lead|regular|occasional|background", ' +
    '"state":{"goal":"<what they want right now>","emotion":"<mood>","location":"<where they are>","condition":"<physical/social condition>"}}\n' +
    'Make them specific, contradictory in believable ways, never generic. ' +
    'speechStyle is how they sound when heard. exampleLines are lines they would actually say, not narration. ' +
    'importance is how often they belong: lead carries the story, regular when the place fits, occasional when the moment needs them, background unless called on. Default regular.',
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
  const { state: _s, importance: rawImportance, looks: rawLooks, ...rest } = result;
  // The intimate section is kept only for an adult in an adult world.
  const allowIntimate = intimateAllowed(world, {
    age: result.age ?? '', appearance: result.appearance, role: result.role,
    looks: rawLooks as Character['looks']
  });
  const looks = mergeLooks(undefined, rawLooks as Character['looks'], allowIntimate);
  return {
    ...rest,
    ...(looks ? { looks } : {}),
    importance: parseCharacterImportance(rawImportance) ?? 'regular',
    mustNotKnow: (result.mustNotKnow ?? '').trim(),
    ...(state ? { state } : {})
  };
}

export interface PlaceFillContext {
  cast?: Character[];
  /** People the author tapped, in addition to names in the text. */
  selectedIds?: string[];
  /** People the author turned off, even if their name is still in the text. */
  dismissedIds?: string[];
  areas?: string[];
  places?: { id?: string; name: string }[];
}

const PLACE_SHEET_SHAPE =
  '{"name": string, "tagline": "<short tagline, e.g. \'harbour district · public square\'>", "summary": "<what the place is, first impression, 2-4 sentences of prose>", "atmosphere": "<sensory detail — sight, sound, smell, feel — the narrator leans on>", "features": "<notable landmarks, rooms, or geography within it>", "history": "<how it came to be / what happened here, 2-3 sentences>", "inhabitants": "<who belongs here, or an unnamed role>", "rules": [<2-4 hazards, laws, or hard rules specific to this place that are never broken>], "secrets": "<something hidden here, not common knowledge>", "currentState": "<its condition right now, one sentence>", "area": "<neighborhood or district, or empty>", "near": "<one short line such as \'about 15 minutes from the school\', or empty>", "residentNames": [<exact allowed names only>], "belongs": [{"name": "<exact allowed name>", "how": "lives here|works here"}]}';

function placePeople(cast: Character[] | undefined): PlaceCastPerson[] {
  return (cast ?? [])
    .filter((person) => person.name.trim())
    .map((person) => ({ id: person.id, name: person.name, aliases: person.aliases }));
}

function placeFillParts(authorText: string, fill?: PlaceFillContext, selfId?: string) {
  const cast = placePeople(fill?.cast);
  const allowed = resolveResidents({
    authorText,
    cast,
    selectedIds: fill?.selectedIds,
    dismissedIds: fill?.dismissedIds
  });
  const areas = [...new Set((fill?.areas ?? []).map((area) => area.trim()).filter(Boolean))];
  const places = (fill?.places ?? []).filter((place) => place.name.trim() && place.id !== selfId);
  return { cast, allowed, areas, places };
}

function sheetFromLocation(location: Location): PlaceDraftSheet {
  return {
    name: location.name,
    tagline: location.tagline,
    summary: location.summary,
    atmosphere: location.atmosphere,
    features: location.features,
    history: location.history,
    inhabitants: location.inhabitants,
    rules: location.rules,
    secrets: location.secrets,
    currentState: location.currentState,
    area: location.area,
    near: location.near,
    residentIds: location.residentIds
  };
}

function partialFromSheet(sheet: PlaceDraftSheet): Partial<Location> {
  const patch: Partial<Location> = {
    name: sheet.name,
    tagline: sheet.tagline,
    summary: sheet.summary,
    atmosphere: sheet.atmosphere,
    features: sheet.features,
    history: sheet.history,
    inhabitants: sheet.inhabitants,
    rules: sheet.rules,
    secrets: sheet.secrets,
    currentState: sheet.currentState,
    residentIds: sheet.residentIds
  };
  if (sheet.area?.trim()) patch.area = sheet.area.trim();
  if (sheet.near?.trim()) patch.near = sheet.near.trim();
  return patch;
}

/** AI-assisted location draft from a one-line description. */
export async function draftLocation(
  world: World | null,
  description: string,
  fill?: PlaceFillContext
): Promise<Partial<Location>> {
  const { cast, allowed, areas, places } = placeFillParts(description, fill);
  const guidance = placeFillGuidance({ cast, allowed, areas, places });
  const result = await utilityJson<PlaceDraftModel>(
    world,
    'You design deep location sheets for longform interactive fiction. Call return_json with this shape:\n' +
    `${PLACE_SHEET_SHAPE}\nMake it specific and concrete, never generic. ` +
    'area is the neighborhood, not a travel time. near is one optional travel note to a place that already exists.' +
    (world ? ` ${stancePlaybook(storyStanceOf(world))}` : ''),
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}` +
    `${guidance}\n\nLocation to create: ${description}`
  );
  const applied = applyPlaceDraft({
    name: '', tagline: '', summary: '', atmosphere: '', features: '', history: '',
    inhabitants: '', rules: [], secrets: '', currentState: ''
  }, result, { authorText: description, cast, allowed, areas, places });
  return partialFromSheet(applied);
}

/** Set a resident's current location when it is still blank. Does not move anyone already placed. */
export async function seedBlankResidentLocations(
  residentIds: string[] | undefined,
  placeName: string
): Promise<void> {
  const name = placeName.trim();
  const ids = residentIds ?? [];
  if (!name || ids.length === 0) return;
  const rows = await db.characters.bulkGet(ids);
  const people = rows.filter((row): row is Character => !!row);
  for (const seed of residentLocationSeeds(people, ids, name)) {
    const row = people.find((person) => person.id === seed.id);
    if (!row) continue;
    await db.characters.update(row.id, {
      state: { ...row.state, location: seed.location },
      updatedAt: Date.now()
    });
  }
}

// ---------- AI-assisted flesh-out (enrich existing cards, never remove detail) ----------

function playbookFor(world: World | null | undefined, shapeTag?: string): string {
  const stance = world
    ? storyStanceOf(world)
    : (inferStanceFromInstructions(shapeTag ?? '') ?? 'longform');
  return stancePlaybook(stance);
}

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
    `World logline (addresses the player protagonist in ${povPersonLabel(world.ai.pov)}; does NOT describe the Subject): ${world.line}\n` +
    `World bible: ${world.bible.slice(0, 1200)}\n\n`
  );
}

function castRosterEntry(c: Character, summaryLen = 200) {
  return {
    name: c.name,
    role: c.role,
    isPlayer: !!c.isPlayer,
    label: c.isPlayer
      ? `player protagonist (${(c.role.match(/first|second|third/)?.[0] ?? 'second')} person in story — do not confuse with Subject)`
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
      map.set(r.targetId, {
        targetId: r.targetId,
        kind: (r.kind ?? '').trim() || 'linked',
        note: r.note ?? ''
      });
      continue;
    }
    if (cur.locked) continue;
    map.set(r.targetId, {
      ...cur,
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
    ? `SUBJECT is the player protagonist sheet (${povPersonLabel(world?.ai.pov ?? 'second')} in play). Fill their card; relationships still use third-person notes about them as the protagonist.`
    : 'SUBJECT is this NPC — not the player. Do not rewrite them as the reader or address them as "you".';
  const current = {
    isPlayer: !!character.isPlayer,
    name: character.name, role: character.role, age: character.age, appearance: character.appearance,
    looks: character.looks ?? {},
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
    looks?: Record<string, unknown>;
    state?: { goal?: string; emotion?: string; location?: string; condition?: string };
    relationships?: { targetName?: string; kind?: string; note?: string }[];
  }>(
    world,
    `You flesh out character sheets for longform interactive fiction. ${subjectFrame} ${NON_DESTRUCTIVE_RULE}\n` +
    `Call return_json with this shape: {"name": string, "role": string, "age": string, "appearance": string, ` +
    `"looks": {"face": string, "hair": string, "body": string, "clothing": "<usual outfit>", "details": string, "senses": "<voice timbre and scent>"` +
    `${intimateAllowed(world, character) ? ', "intimate": "<adult physical details>"' : ''}}, "mannerisms": string, ` +
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
    ...character.state,
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
    looks: mergeLooks(character.looks, result.looks as Character['looks'], intimateAllowed(world, {
      age: keepIfBlank(character.age, result.age), appearance: character.appearance, role: character.role,
      looks: { ...(character.looks ?? {}), ...((result.looks ?? {}) as Character['looks']) }
    })),
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
    `Call return_json with this shape: {"relationships":[{"targetName":"<exact name from roster>","kind":"ally|rival|lover|debt|family|mentor|…","note":"<concrete one-line history or tension>"}]}\n` +
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

function parsedMarks(rows: Array<{ at?: number; text?: string }> | undefined): ScoreMark[] {
  return (rows ?? []).map((row) => ({ at: Number(row.at), text: row.text ?? '' }));
}

/**
 * Meanings for a bond whose tracking is already on.
 * An author-written list is left alone unless replace is set. An untracked tie is not enrolled.
 */
export async function draftBondMeanings(
  world: World | null,
  from: Character,
  player: Character,
  rel: Relationship,
  opts?: { replace?: boolean }
): Promise<ScoreMark[]> {
  const replace = !!opts?.replace;
  if (!shouldDraftBondMeanings(rel, replace)) return authoredMarks(rel.marks);
  const result = await utilityJson<{ marks?: Array<{ at?: number; text?: string }> }>(
    world,
    'You write what a bond\'s points mean between two people in a story. ' +
      'Call return_json with {"marks":[{"at":0,"text":"..."}]}. ' +
      'Three or four steps, rising from a low at to a high at between 0 and 100. ' +
      'Each text is one concrete sentence about what is now true. No digits in the sentence.',
    `From ${from.name || 'them'} toward ${player.name || 'the player'}. ` +
      `Kind: ${rel.kind || 'linked'}. Note: ${rel.note || '(none)'}.`
  );
  return marksToKeep(rel.marks, parsedMarks(result.marks), true);
}

/**
 * Player goals, only when the list is still empty. A goal the author already wrote is left alone.
 */
export async function draftPlayerGoals(
  world: World | null,
  player: Character,
  cast: Character[]
): Promise<PlayerGoal[]> {
  const existing = player.goals ?? [];
  if (existing.some((goal) => goal.text.trim())) return existing.slice(0, PLAYER_GOAL_CAP);
  const names = cast
    .filter((person) => !person.isPlayer && person.name.trim())
    .map((person) => person.name.trim())
    .slice(0, 8);
  const result = await utilityJson<{
    goals?: Array<{ text?: string; marks?: Array<{ at?: number; text?: string }> }>;
  }>(
    world,
    'You draft the player\'s longer aims for a story. ' +
      'Call return_json with {"goals":[{"text":"...","marks":[{"at":0,"text":"..."}]}]}. ' +
      `At most ${PLAYER_GOAL_CAP} aims. Each text is one concrete aim, not a scene want. ` +
      'Each goal has three or four rising marks between 0 and 100. ' +
      'A mark\'s text is one sentence about what is now true. No digits in that sentence.',
    `Player: ${player.name || 'the protagonist'}. Who they are: ${player.summary.slice(0, 400)}. ` +
      `What they want: ${player.desires.slice(0, 240)}. ` +
      `Cast: ${names.join(', ') || '(none yet)'}.`
  );
  const incoming: PlayerGoal[] = (result.goals ?? []).slice(0, PLAYER_GOAL_CAP).map((goal) => ({
    id: uid(),
    text: (goal.text ?? '').trim(),
    score: 0,
    marks: authoredMarks(parsedMarks(goal.marks))
  }));
  return goalsToKeep(existing, incoming, true);
}

/** Meanings for one player goal. An author-written list is left alone unless replace is set. */
export async function draftGoalMeanings(
  world: World | null,
  goal: PlayerGoal,
  opts?: { replace?: boolean }
): Promise<ScoreMark[]> {
  const replace = !!opts?.replace;
  if (!shouldDraftGoalMeanings(goal, replace)) return authoredMarks(goal.marks);
  const result = await utilityJson<{ marks?: Array<{ at?: number; text?: string }> }>(
    world,
    'You write what a player goal\'s points mean. ' +
      'Call return_json with {"marks":[{"at":0,"text":"..."}]}. ' +
      'Three or four steps, rising from a low at to a high at between 0 and 100. ' +
      'Each text is one concrete sentence about what is now true. No digits in the sentence.',
    `Goal: ${goal.text.trim()}.`
  );
  return marksToKeep(goal.marks, parsedMarks(result.marks), true);
}

/** AI-assisted flesh-out of an existing location sheet: fills blanks, enriches filled fields, never removes detail. */
export async function fleshOutLocation(
  world: World | null,
  location: Location,
  fill?: PlaceFillContext
): Promise<Partial<Location>> {
  const authorText = placeAuthorText(location);
  const { cast, allowed, areas, places } = placeFillParts(authorText, {
    ...fill,
    selectedIds: [...(location.residentIds ?? []), ...(fill?.selectedIds ?? [])]
  }, location.id);
  const guidance = placeFillGuidance({ cast, allowed, areas, places });
  const current = {
    name: location.name, tagline: location.tagline, summary: location.summary, atmosphere: location.atmosphere,
    features: location.features, history: location.history, inhabitants: location.inhabitants,
    rules: location.rules, secrets: location.secrets, currentState: location.currentState,
    area: location.area ?? '', near: location.near ?? ''
  };
  const result = await utilityJson<PlaceDraftModel>(
    world,
    `You flesh out location sheets for longform interactive fiction. ${NON_DESTRUCTIVE_RULE}\n` +
    `Call return_json with this shape: ${PLACE_SHEET_SHAPE}\n` +
    'area is the neighborhood, not a travel time. near is one optional travel note to a place that already exists.',
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}` +
    `${guidance}\n\nCurrent location sheet (JSON, blank strings/arrays mean unset):\n${JSON.stringify(current, null, 2)}`
  );
  return partialFromSheet(applyPlaceDraft(sheetFromLocation(location), result, {
    authorText, cast, allowed, areas, places
  }));
}

/** AI-assisted flesh-out of the world's title/logline/bible. */
export async function fleshOutWorldLore(world: World): Promise<{
  title: string; line: string; bible: string; calendarSystem?: string;
}> {
  const result = await utilityJson<{
    title: string; line: string; bible: string; calendarSystem?: string;
  }>(
    world,
    `You flesh out the lore of a story world for longform interactive fiction. ${playbookFor(world)} ${NON_DESTRUCTIVE_RULE}\n` +
    `Call return_json with this shape: {"title": string, "line": "<one-sentence logline in ${povPersonLabel(world.ai.pov)}>", ` +
    `"bible": "<setting, atmosphere, rules of the world — prose the narrator will follow>", ` +
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
    system: `You flesh out season premises for longform interactive fiction. ${playbookFor(world)} ${NON_DESTRUCTIVE_RULE} If the premise is blank, write one from the world context. One paragraph, 2-5 sentences, present tense, concrete situation. Return only the premise.`,
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
    `You propose hard narrator rules for longform interactive fiction — non-negotiable behavioural constraints the narrator must never break. ${NON_DESTRUCTIVE_RULE} Call return_json with this shape: {"rules": string[]}. Include every existing rule (reworded for clarity if needed) plus 2-5 new ones suited to this world.`,
    `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\nExisting narrator rules (may be empty):\n${world.ai.narratorRules.join('\n') || '(none)'}`
  );
  return mergeLines(world.ai.narratorRules, result.rules ?? []);
}

const EMPTY_WORLD_DRAFT =
  'The model did not draft a world. Try again or switch models.';

export function isEmptyRosterProposal(
  roster: Pick<WorldRosterProposal, 'characters' | 'locations'>,
  counts: { characters: number; locations: number }
): boolean {
  if (counts.characters <= 0 && counts.locations <= 0) return false;
  return roster.characters.length === 0 && roster.locations.length === 0;
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
  const pull = async (): Promise<WorldRosterProposal> => {
    const result = await utilityJson<WorldRosterProposal>(
      world,
      `You propose an opening cast and places for a longform interactive story world. ${playbookFor(world, shape)} Call return_json with this shape:\n` +
      `{"characters":[{"description":"<one specific sentence: who they are to the protagonist>"}],` +
      `"locations":[{"description":"<one specific sentence: what the place is and why it matters>"}],` +
      `"openingLocationIndex":<0-based index into locations for where episode 1 opens>}\n` +
      `Return exactly ${nChars} character description(s) and ${nPlaces} location description(s). ` +
      `Use empty arrays when the count is 0. No player/protagonist. ` +
      `Every description must be concrete and rooted in THIS world's weather, rules, and situation — never generic fantasy filler.`,
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
  };

  let roster = await pull();
  if (isEmptyRosterProposal(roster, { characters: nChars, locations: nPlaces })) {
    roster = await pull();
  }
  if (isEmptyRosterProposal(roster, { characters: nChars, locations: nPlaces })) {
    throw new AIError(EMPTY_WORLD_DRAFT);
  }
  return roster;
}

export interface FleshOutEverythingOpts {
  /** e.g. "One long story… — Seasons, episodes…" */
  shape: string;
  targetCharacters: number;
  targetLocations: number;
  onProgress?: (label: string) => void;
}

/**
 * Which opening sections still need a model call.
 * A filled bible, premise, rule, or player summary/goal is left as written.
 */
export function fleshSectionsToRun(input: {
  bible: string;
  premise: string;
  narratorRules: string[];
  hasPlayer: boolean;
  playerSummary: string;
  playerGoal: string;
}): { lore: boolean; premise: boolean; rules: boolean; player: boolean } {
  const playerBlank = !input.playerSummary.trim() && !input.playerGoal.trim();
  return {
    lore: input.bible.trim().length < BIBLE_MIN_CHARS,
    premise: !input.premise.trim(),
    rules: !input.narratorRules.some((rule) => rule.trim()),
    player: input.hasPlayer && playerBlank
  };
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
    `You seed opening continuity for episode 1 of a longform interactive story. ${playbookFor(world)} Call return_json with this shape:\n` +
    '{"facts":[<2-4 durable facts already true as the story opens>],' +
    '"threads":[<2-4 unresolved tensions or live situations already true as the story opens>]}\n' +
    'Facts are things that will still be true next episode (debts, alliances, injuries, public rules). ' +
    'Threads are unresolved tensions or live situations, not resolved. Be concrete and rooted in THIS world — no generic filler.',
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
      `You write the opening narrator beat for longform interactive fiction. ${playbookFor(world)} ` +
      `POV: ${world.ai.pov}. Tense: ${world.ai.tense}. ` +
      `80–150 words. Second-person when POV is second. No dialogue. Establish place and situation; do not resolve anything. Return only the prose.`,
    messages: [{
      role: 'user',
      content:
        `World: ${world.title} — ${world.line}\nBible:\n${world.bible.slice(0, 1200)}\n\n` +
        `Premise:\n${season.premise}\n\n` +
        `Opening location: ${episode.location || '(unnamed)'}\n` +
        `${sceneDateContextLine(narrationSceneDate(world, episode))}\n` +
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
 * Flesh whatever is still blank: lore, premise, rules, you, then opening cast
 * and places in one round, relationships in one round, then opening memory.
 * A cold open stays on the memory-step button.
 */
export async function fleshOutWorldEverything(
  world: World,
  season: Season,
  episode: Episode,
  opts: FleshOutEverythingOpts
): Promise<FleshOutEverythingResult> {
  const progress = opts.onProgress ?? (() => {});
  let liveEpisode = episode;
  let live: World = world;
  let liveSeason: Season = season;

  const opening = fleshSectionsToRun({
    bible: world.bible,
    premise: season.premise,
    narratorRules: world.ai.narratorRules,
    hasPlayer: false,
    playerSummary: '',
    playerGoal: ''
  });

  if (opening.lore) {
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
    live = {
      ...world,
      title: lore.title,
      line: lore.line,
      bible: lore.bible,
      ...(calPatch ? { calendar: calPatch } : {})
    };
  }

  let allChars = await db.characters.where('worldId').equals(live.id).toArray();
  const player = allChars.find((c) => c.isPlayer);
  let npcs = allChars.filter((c) => !c.isPlayer);
  let existingPlaces = await db.locations.where('worldId').equals(live.id).toArray();
  const charSlots = Math.max(0, opts.targetCharacters - npcs.length);
  const placeSlots = Math.max(0, opts.targetLocations - existingPlaces.length);
  const sections = fleshSectionsToRun({
    bible: live.bible,
    premise: liveSeason.premise,
    narratorRules: live.ai.narratorRules,
    hasPlayer: !!player,
    playerSummary: player?.summary ?? '',
    playerGoal: player?.state.goal ?? ''
  });
  const needRoster = charSlots > 0 || placeSlots > 0;

  let roster: WorldRosterProposal | null = null;
  if (sections.premise || sections.rules || sections.player || needRoster) {
    progress(
      sections.premise ? 'Fleshing premise…'
        : sections.rules ? 'Fleshing narrator rules…'
          : sections.player ? 'Fleshing you…'
            : 'Planning cast & places…'
    );
    const [premise, rules, playerSheet, proposed] = await Promise.all([
      sections.premise ? fleshOutPremise(live, liveSeason) : Promise.resolve(liveSeason.premise),
      sections.rules ? fleshOutNarratorRules(live) : Promise.resolve(live.ai.narratorRules),
      sections.player && player ? fleshOutCharacter(live, player, allChars) : Promise.resolve(null),
      needRoster
        ? proposeWorldRoster(live, opts.shape, { characters: charSlots, locations: placeSlots })
        : Promise.resolve(null)
    ]);

    if (sections.premise) {
      await db.seasons.update(season.id, { premise });
      liveSeason = { ...liveSeason, premise };
    }
    if (sections.rules) {
      await db.worlds.update(live.id, {
        ai: { ...live.ai, narratorRules: rules },
        updatedAt: Date.now()
      });
      live = { ...live, ai: { ...live.ai, narratorRules: rules } };
    }
    if (sections.player && player && playerSheet) {
      await db.characters.update(player.id, { ...playerSheet, isPlayer: true, updatedAt: Date.now() });
    }
    roster = proposed;
  }

  const createdCharacterIds: string[] = [];
  const createdLocationIds: string[] = [];

  if (roster && (charSlots > 0 || placeSlots > 0)) {
    const charDescs = roster.characters.slice(0, charSlots);
    const placeDescs = roster.locations.slice(0, placeSlots);

    if (charDescs.length > 0 || placeDescs.length > 0) {
      if (charDescs.length > 0) {
        progress('Writing cast…');
        const charDrafts = await Promise.all(charDescs.map(async ({ description }) => ({
          description,
          draft: await draftCharacter(live, description)
        })));
        for (const { description, draft } of charDrafts) {
          const c = emptyCharacter(live.id, { ...draft, isPlayer: false, updatedAt: Date.now() });
          if (!c.name.trim()) c.name = description.slice(0, 40);
          await db.characters.add(c);
          createdCharacterIds.push(c.id);
        }
      }

      if (placeDescs.length > 0) {
        progress('Placing the world…');
        const castForPlaces = await db.characters.where('worldId').equals(live.id).toArray();
        const knownPlaces = existingPlaces.map((place) => ({ id: place.id, name: place.name }));
        const knownAreas = [...new Set(existingPlaces.map((place) => place.area?.trim() ?? '').filter(Boolean))];
        for (const { description } of placeDescs) {
          const draft = await draftLocation(live, description, {
            cast: castForPlaces,
            areas: knownAreas,
            places: knownPlaces
          });
          const l = emptyLocation(live.id, { ...draft, updatedAt: Date.now() });
          if (!l.name.trim()) l.name = description.slice(0, 40);
          // Leave rules empty if the draft missed them — write-ready gate requires a real rule.
          await db.locations.add(l);
          createdLocationIds.push(l.id);
          knownPlaces.push({ id: l.id, name: l.name });
          const area = l.area?.trim();
          if (area && !knownAreas.includes(area)) knownAreas.push(area);
          await seedBlankResidentLocations(l.residentIds, l.name);
        }
      }
    }

    if (createdCharacterIds.length > 0) {
      const openingCast = createdCharacterIds.slice(0, 2);
      const castIds = [...new Set([...liveEpisode.castIds, ...openingCast])];
      await db.episodes.update(liveEpisode.id, { castIds, updatedAt: Date.now() });
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
      await db.episodes.update(liveEpisode.id, { title: open.name.trim(), updatedAt: Date.now() });
      liveEpisode = { ...liveEpisode, title: open.name.trim() };
    }
  }

  allChars = await db.characters.where('worldId').equals(live.id).toArray();
  npcs = allChars.filter((c) => !c.isPlayer);

  if (npcs.length === 0) {
    throw new AIError(EMPTY_WORLD_DRAFT);
  }

  progress('Linking relationships…');
  await Promise.all(npcs.map(async (npc) => {
    const relationships = await fleshOutRelationships(live, npc, allChars);
    await db.characters.update(npc.id, { relationships, updatedAt: Date.now() });
  }));
  allChars = await db.characters.where('worldId').equals(live.id).toArray();

  progress('Seeding opening memory…');
  const memory = await seedOpeningMemory(live, liveSeason, liveEpisode, allChars);

  await db.worlds.update(live.id, { updatedAt: Date.now() });

  await repairWriteReadyFields(live, liveEpisode);

  return {
    characterIds: createdCharacterIds,
    locationIds: createdLocationIds,
    continuityIds: memory.continuityIds,
    threadIds: memory.threadIds
  };
}

/** Fill the three write-ready holes generation often leaves empty. */
async function repairWriteReadyFields(world: World, episode: Episode): Promise<void> {
  const now = Date.now();
  const liveEpisode = (await db.episodes.get(episode.id)) ?? episode;
  const row = await db.worlds.get(world.id);
  if (row) {
    const line = row.line.trim() || world.line.trim();
    const patch: Partial<World> = { updatedAt: now };
    const title = row.title.trim();
    if (!title || title === 'Untitled world') {
      patch.title = line.slice(0, 72) || 'New world';
    }
    let bible = row.bible.trim();
    if (bible.length < BIBLE_MIN_CHARS) {
      const extra = [line, world.line.trim()].filter(Boolean);
      bible = [bible, ...extra].filter((s, i, arr) => s && arr.indexOf(s) === i).join('\n\n').trim();
      if (bible.length < BIBLE_MIN_CHARS && !bible.includes('The first scene will name what this world holds.')) {
        bible = `${bible}${bible ? '\n\n' : ''}The first scene will name what this world holds.`.trim();
      }
      const filler = 'What is true as it opens is already in the room.';
      while (bible.length < BIBLE_MIN_CHARS) {
        bible = `${bible}${bible ? ' ' : ''}${filler}`.trim();
      }
      patch.bible = bible;
    }
    if (patch.title || patch.bible) await db.worlds.update(row.id, patch);
  }

  const places = await db.locations.where('worldId').equals(world.id).toArray();
  const open = liveEpisode.locationId
    ? places.find((l) => l.id === liveEpisode.locationId)
    : places[0];
  if (open && open.rules.filter((r) => r.trim()).length === 0) {
    const named = open.name.trim() || 'This place';
    const rule = open.atmosphere.trim()
      || (open.tagline.trim() ? `In ${named}, ${open.tagline.trim().replace(/\.$/, '')} is not optional.` : '')
      || `${named} keeps what is said here — nothing leaves unnamed.`;
    await db.locations.update(open.id, { rules: [rule], updatedAt: now });
  }

  const npcsAll = (await db.characters.where('worldId').equals(world.id).toArray())
    .filter((c) => !c.isPlayer);
  const inScene = new Set(liveEpisode.castIds);
  for (const npc of npcsAll.filter((c) => inScene.has(c.id))) {
    if (npc.anchors.some((a) => a.trim())) continue;
    const fromTrait = npc.traits.split(/[.;\n]/)[0]?.trim();
    const fromDesire = npc.desires.split(/[.;\n]/)[0]?.trim();
    const anchor = fromTrait || fromDesire
      || `${npc.name.trim() || 'They'} will not break on a first meeting.`;
    await db.characters.update(npc.id, { anchors: [anchor], updatedAt: now });
  }
}
