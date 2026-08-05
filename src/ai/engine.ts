import { db, guardStorage, recordTombstones, uid } from '../db';
import { resolveModel, useSettings } from '../store/settings';
import { GAP_DAYS, GAP_LABELS } from '../ui/theme';
import type {
  Character, ComposeMode, Episode, EpisodeGuest, EpisodeWrap, EpisodeWrapBeat, Location, ModelRef,
  Relationship, Season, SeasonWrap, Turn, TurnLength, TurnRole, World, WrapBeat
} from '../types';
import { normalizeRelationships } from '../relationships';
import { emptyCharacter, emptyLocation, nextEpisode, worldCalendar } from '../worldOps';
import { AIError, streamChat, type ChatMessage, type StreamRequest } from './client';
import { normalizeSpeakText } from './dialogueFormat';
import {
  activeGuests,
  buildCharacterSpeakMessages,
  buildCharacterSystemPrompt,
  buildGuestSpeakMessages,
  buildGuestSystemPrompt,
  buildNarrationBeatMessages,
  buildNarratorSystemPrompt,
  characterSpeakTokens,
  directorSystemPrompt,
  directorUserPrompt,
  type DirectorBeat,
  narrationBeatTokens
} from './prompts';

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
  'finish the unfinished *action* or "dialogue" only. Do not restart or repeat completed words. ' +
  'Keep the same *action* / "speech" format.';

/**
 * Stream a character/guest speak beat; if the provider stops for length, make one
 * continuation call and stitch before normalizing.
 */
async function streamSpeakComplete(opts: {
  provider: StreamRequest['provider'];
  model: string;
  system: string;
  messages: ChatMessage[];
  length: TurnLength;
  signal?: AbortSignal;
  onProgress: (label: string) => void;
  onAccumulated: (text: string) => void;
}): Promise<string> {
  const maxTokens = characterSpeakTokens(opts.length);
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
      maxTokens,
      signal: opts.signal,
      onDelta: (d) => {
        acc += d;
        opts.onAccumulated(acc);
      }
    });
  }
  return normalizeSpeakText(acc);
}

async function loadContext(world: World, season: Season, episode: Episode) {
  const [characters, locations, continuity, threads, turns, seasonEpisodes] = await Promise.all([
    db.characters.where('worldId').equals(world.id).toArray(),
    db.locations.where('worldId').equals(world.id).toArray(),
    db.continuity.where('seasonId').equals(season.id).toArray(),
    db.threads.where('worldId').equals(world.id).filter((t) => t.status === 'open').toArray(),
    db.turns.where('episodeId').equals(episode.id).sortBy('createdAt'),
    db.episodes.where('seasonId').equals(season.id).sortBy('number')
  ]);
  const priorEpisode = seasonEpisodes
    .filter((e) => e.number < episode.number && e.status === 'ended')
    .at(-1) ?? null;
  return { world, season, episode, characters, locations, continuity, threads, turns, priorEpisode };
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
  /** Partial text of the beat currently streaming. */
  onDelta: (partial: string, meta: StreamMeta) => void;
  /** High-level stage labels for the UI spinner (planning / narrating / Name speaking). */
  onProgress?: (label: string) => void;
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

function normalizeBeats(
  raw: { beats?: Array<{ type?: string; brief?: string; characterId?: string; guestId?: string }> },
  inScene: Character[],
  guests: EpisodeGuest[],
  /** Map introduce-name → guest id for newly created walk-ons */
  introduceNameToId: Map<string, string>
): DirectorBeat[] {
  const allowedCast = new Set(inScene.map((c) => c.id));
  const allowedGuests = new Set(guests.map((g) => g.id));
  const beats: DirectorBeat[] = [];
  let speakCount = 0;
  for (const b of raw.beats ?? []) {
    if (beats.length >= MAX_TOTAL_BEATS) break;
    const brief = (b.brief ?? '').trim();
    if (!brief) continue;
    if (b.type === 'speak') {
      if (speakCount >= MAX_SPEAK_BEATS) continue;
      const guestRaw = (b.guestId ?? '').trim();
      const castId = (b.characterId ?? '').trim();
      if (guestRaw) {
        const byId = allowedGuests.has(guestRaw) ? guestRaw : introduceNameToId.get(guestRaw.toLowerCase());
        if (!byId || !allowedGuests.has(byId)) continue;
        beats.push({ type: 'speak', guestId: byId, brief });
        speakCount++;
      } else if (castId && allowedCast.has(castId)) {
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
  return beats;
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

/** Apply director enter/leave to episode cast; only known non-player ids may enter/leave. */
function applyCastDelta(
  castIds: string[],
  characters: Character[],
  delta?: { enter?: string[]; leave?: string[] }
): string[] {
  const npcIds = new Set(characters.filter((c) => !c.isPlayer).map((c) => c.id));
  const playerId = characters.find((c) => c.isPlayer)?.id;
  const enter = (delta?.enter ?? []).map((id) => id.trim()).filter((id) => npcIds.has(id));
  const leave = new Set((delta?.leave ?? []).map((id) => id.trim()).filter((id) => npcIds.has(id)));
  const known = (id: string) => id === playerId || npcIds.has(id);
  const next = [...new Set([...castIds.filter(known), ...enter])].filter((id) => !leave.has(id));
  if (playerId && castIds.includes(playerId) && !next.includes(playerId)) next.unshift(playerId);
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
  leaveIds: string[] | undefined
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

  const leave = new Set((leaveIds ?? []).map((id) => id.trim()));
  active = active.filter((id) => !leave.has(id));

  return { guests, activeGuestIds: active, nameToId };
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

function asWriteAbort(e: unknown, beatsCompleted: number): never {
  if (e instanceof WriteAbortedError) throw e;
  if ((e as Error)?.name === 'AbortError') throw new WriteAbortedError(beatsCompleted);
  throw e;
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

  if (opts.mode !== 'continue' && opts.input.trim()) {
    const userText = opts.mode === 'speak'
      ? normalizeSpeakText(opts.input.trim())
      : opts.input.trim();
    const userTurn: Turn = {
      id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
      role: 'user', mode: opts.mode, text: userText, createdAt: Date.now()
    };
    await guardStorage(() => db.turns.add(userTurn));
    ctx.turns.push(userTurn);
  }

  const progress = opts.onProgress ?? (() => {});

  // Director plans cast/guest changes + ordered narration / speak beats (utility model).
  let beats: DirectorBeat[];
  try {
    progress('planning…');
    const plan = await utilityJson<{
      castDelta?: { enter?: string[]; leave?: string[]; introduce?: IntroduceSpec[] };
      beats: Array<{ type?: string; brief?: string; characterId?: string; guestId?: string }>;
    }>(
      opts.world,
      directorSystemPrompt(),
      directorUserPrompt(ctx, opts.mode, opts.input.trim()),
      1400,
      opts.signal
    );
    const nextCast = applyCastDelta(castIds, ctx.characters, plan.castDelta);
    const guestDelta = applyGuestDelta(
      { ...ctx.episode, castIds, guests, activeGuestIds },
      plan.castDelta?.introduce,
      plan.castDelta?.leave
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
      ctx.episode = { ...ctx.episode, ...episodePatch, castIds, guests, activeGuestIds };
      inScene = ctx.characters.filter((c) => castIds.includes(c.id) && !c.isPlayer);
    }
    beats = normalizeBeats(plan, inScene, activeGuests(ctx.episode), guestDelta.nameToId);
  } catch (e) {
    if ((e as Error).name === 'AbortError') asWriteAbort(e, beatsCompleted);
    beats = [{
      type: 'narration',
      brief: 'Continue the scene with atmosphere and physical action; leave space for the player.'
    }];
  }

  const sceneGuests = () => activeGuests(ctx.episode);

  let lastId = '';
  try {
    for (const beat of beats) {
      throwIfAborted(opts.signal, beatsCompleted);

      if (beat.type === 'narration') {
        const meta: StreamMeta = { role: 'narrator' };
        progress('narrating…');
        opts.onDelta('', meta);
        let acc = '';
        const { text } = await streamChat({
          provider, model,
          system: buildNarratorSystemPrompt(ctx),
          messages: buildNarrationBeatMessages(
            ctx.turns, ctx.characters, beat.brief, opts.length, sceneGuests()
          ),
          maxTokens: narrationBeatTokens(opts.length),
          signal: opts.signal,
          onDelta: (d) => { acc += d; opts.onDelta(acc, meta); }
        });
        const narrText = text.trim();
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
        const cleaned = await streamSpeakComplete({
          provider, model,
          system: buildGuestSystemPrompt(ctx, guest),
          messages: buildGuestSpeakMessages(
            ctx.turns, ctx.characters, guest, beat.brief, sceneGuests()
          ),
          length: opts.length,
          signal: opts.signal,
          onProgress: progress,
          onAccumulated: (acc) => opts.onDelta(acc, meta)
        });
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
        opts.onDelta('', meta);
        continue;
      }

      const speaking = ctx.characters.find((c) => c.id === ('characterId' in beat ? beat.characterId : ''));
      if (!speaking || speaking.isPlayer) continue;

      const meta: StreamMeta = { role: 'character', characterId: speaking.id };
      progress(`${speaking.name} speaking…`);
      opts.onDelta('', meta);
      const cleaned = await streamSpeakComplete({
        provider, model,
        system: buildCharacterSystemPrompt(ctx, speaking),
        messages: buildCharacterSpeakMessages(
          ctx.turns, ctx.characters, speaking, beat.brief, sceneGuests()
        ),
        length: opts.length,
        signal: opts.signal,
        onProgress: progress,
        onAccumulated: (acc) => opts.onDelta(acc, meta)
      });
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
      opts.onDelta('', meta);
    }
  } catch (e) {
    asWriteAbort(e, beatsCompleted);
  }

  await db.worlds.update(opts.world.id, { updatedAt: Date.now() });
  return lastId;
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

/** Delete a turn and everything after it (used by regenerate / retry). */
export async function deleteTurnsFrom(turnId: string, episodeId: string): Promise<void> {
  const turns = await snapshotTurnsFrom(turnId, episodeId);
  if (turns.length === 0) return;
  await db.turns.bulkDelete(turns.map((t) => t.id));
}

/** Delete everything after a turn, keeping the turn itself. */
export async function deleteTurnsAfter(turnId: string, episodeId: string): Promise<void> {
  const turns = await snapshotTurnsAfter(turnId, episodeId);
  if (turns.length === 0) return;
  await db.turns.bulkDelete(turns.map((t) => t.id));
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
  signal?: AbortSignal
): Promise<T> {
  const { provider, model } = utilityModelFor(world);
  const { signal: timed, cancel } = withTimeoutSignal(signal, UTILITY_TIMEOUT_MS);
  try {
    const { text: raw } = await streamChat({
      provider, model, system,
      messages: [{ role: 'user', content: user }],
      maxTokens, temperature: 0.4, signal: timed
    });
    return extractJson<T>(raw);
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !signal?.aborted) {
      throw new AIError(`Utility model timed out after ${UTILITY_TIMEOUT_MS / 1000}s.`);
    }
    throw e;
  } finally {
    cancel();
  }
}

/** Extract new continuity facts + open threads after an episode ends. */
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
      id: uid(), worldId: world.id, seasonId: season.id, text: f.trim(), source: 'auto' as const, createdAt: now
    }))
  );
  await db.threads.bulkAdd(
    result.threads.filter((t) => t.trim()).map((t) => ({
      id: uid(), worldId: world.id, seasonId: season.id, text: t.trim(),
      openedLabel: `opened S${season.number} · E${episode.number}`, status: 'open' as const, createdAt: now
    }))
  );
}

export interface EpisodeWrapDraft {
  recap: string;
  beats: EpisodeWrapBeat[];
  facts: string[];
  threads: string[];
  guestEffects: string[];
}

/** Season-like episode analysis for the wrap review UI. */
export async function analyzeEpisode(
  world: World,
  season: Season,
  episode: Episode
): Promise<EpisodeWrapDraft> {
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const existing = await db.continuity.where('seasonId').equals(season.id).toArray();
  const guests = episode.guests ?? [];
  const text = turns.map((t) => labelTurn(t, characters, guests)).join('\n\n');

  if (!text.trim()) {
    return {
      recap: 'The episode opened without lasting prose yet.',
      beats: [],
      facts: [],
      threads: [],
      guestEffects: []
    };
  }

  const guestBlock = guests.length > 0
    ? `Walk-ons this episode:\n${guests.map((g) => `- ${g.name}: ${g.brief}`).join('\n')}\n\n`
    : '';

  const result = await utilityJson<{
    recap?: string;
    beats?: { text?: string; consequence?: string }[];
    facts?: string[];
    threads?: string[];
    guestEffects?: string[];
  }>(
    world,
    'You are a story editor closing an interactive fiction episode. Respond with JSON only:\n' +
    '{"recap":"<80-160 word previously-on paragraph for the NEXT episode>",' +
    '"beats":[{"text":"<what happened, one sentence>","consequence":"<what it leaves for later, one sentence>"}],' +
    '"facts":["<durable continuity facts, 0-6>"],' +
    '"threads":["<unresolved tensions, 0-6>"],' +
    '"guestEffects":["<how temporary walk-ons changed the story, if any — omit empties>"]}\n' +
    'Beats: 2-5 events that matter later. Facts must not repeat known facts. Guest effects only for walk-ons, not Cast cards.',
    `World: ${world.title}. Season ${season.number}, episode ${episode.number}.\n` +
    `Known facts:\n${existing.map((f) => `- ${f.text}`).join('\n') || '(none)'}\n\n` +
    guestBlock +
    `Episode text:\n${text.slice(0, 24000)}`,
    2500
  );

  return {
    recap: (result.recap ?? '').trim() || 'The episode closed without a clear recap.',
    beats: (result.beats ?? [])
      .map((b) => ({ text: (b.text ?? '').trim(), consequence: (b.consequence ?? '').trim() }))
      .filter((b) => b.text)
      .slice(0, 7),
    facts: (result.facts ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 8),
    threads: (result.threads ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 8),
    guestEffects: (result.guestEffects ?? []).map((g) => g.trim()).filter(Boolean).slice(0, 6)
  };
}

export interface CommitEpisodeWrapInput {
  recap: string;
  beats: EpisodeWrapBeat[];
  facts: string[];
  threads: string[];
  guestEffects: string[];
}

/**
 * Persist wrap onto the ended episode, file continuity/threads, open the next episode.
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

  await db.episodes.update(episode.id, { wrap, updatedAt: Date.now() });

  const now = Date.now();
  const factLines = [
    ...input.facts.map((f) => f.trim()).filter(Boolean),
    ...wrap.guestEffects
  ];
  if (factLines.length > 0) {
    await db.continuity.bulkAdd(
      factLines.map((text) => ({
        id: uid(), worldId: world.id, seasonId: season.id, text, source: 'auto' as const, createdAt: now
      }))
    );
  }
  const threadLines = input.threads.map((t) => t.trim()).filter(Boolean);
  if (threadLines.length > 0) {
    await db.threads.bulkAdd(
      threadLines.map((text) => ({
        id: uid(), worldId: world.id, seasonId: season.id, text,
        openedLabel: `opened S${season.number} · E${episode.number}`,
        status: 'open' as const, createdAt: now
      }))
    );
  }

  const next = await nextEpisode({ ...episode, wrap });
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

  const wrap: SeasonWrap = {
    id: uid(), seasonId: season.id, worldId: world.id,
    beats: result.beats.map((b) => ({ ...b, disposition: 'keep' as const })),
    characters: characters.filter((c) => !c.isPlayer).map((c) => ({
      characterId: c.id,
      name: c.name,
      outcome: result.characters.find((r) => r.name.toLowerCase() === c.name.toLowerCase())?.outcome ?? '',
      evolution: '',
      returning: true
    })),
    gap: 1, premise: '', status: 'draft', createdAt: Date.now()
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

/** Step 3: propose what changed off-screen for each returning character. */
export async function evolveCharacters(world: World, wrap: SeasonWrap, gapLabel: string): Promise<SeasonWrap> {
  const returning = wrap.characters.filter((c) => c.returning);
  if (returning.length === 0) return wrap;
  const result = await utilityJson<{ name: string; evolution: string }[]>(
    world,
    'You evolve story characters across a time gap. For each character, given where the season left them, propose what changed off-screen during the gap: circumstances, relationships, hardening or healing. 1-2 sentences each, concrete, no purple prose. Respond with JSON only: [{"name": string, "evolution": string}]',
    `World: ${world.title}\nTime gap before next season: ${gapLabel}\n\nBeats carried forward:\n${wrap.beats.filter((b) => b.disposition !== 'drop').map((b) => `- [${b.disposition}] ${b.text} → ${b.consequence}`).join('\n')}\n\nCharacters:\n${returning.map((c) => `- ${c.name}: ${c.outcome || 'unknown outcome'}`).join('\n')}`
  );
  const updated: SeasonWrap = {
    ...wrap,
    characters: wrap.characters.map((c) => ({
      ...c,
      evolution: c.returning
        ? result.find((r) => r.name.toLowerCase() === c.name.toLowerCase())?.evolution ?? c.evolution
        : c.evolution
    }))
  };
  await db.wraps.put(updated);
  return updated;
}

/** Draft (or redraft) the next-season premise from the wrap sheet. */
export async function draftPremise(world: World, season: Season, wrap: SeasonWrap, gapLabel: string): Promise<string> {
  const { provider, model } = utilityModelFor(world);
  const { text: premise } = await streamChat({
    provider, model,
    system: 'You write season premises for longform interactive fiction. One paragraph, 2-4 sentences, present tense, concrete and pressurized. Open on the raised beats. No preamble — return only the premise.',
    messages: [{
      role: 'user',
      content: `World: ${world.title} — ${world.line}\nSeason ${season.number} just ended. Season ${season.number + 1} opens ${gapLabel.toLowerCase()} later.\n\nBeats:\n${wrap.beats.map((b) => `- [${b.disposition}] ${b.text} → ${b.consequence}`).join('\n')}\n\nReturning cast:\n${wrap.characters.filter((c) => c.returning).map((c) => `- ${c.name}: ${c.evolution || c.outcome}`).join('\n')}`
    }],
    maxTokens: 500, temperature: 0.9
  });
  return premise.trim();
}

/** Steps 4-5: build the season bible, create season N+1, evolve character states. */
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

  const offscreen = wrap.characters
    .filter((c) => c.returning && c.evolution)
    .map((c) => `- ${c.name}: ${c.evolution}`)
    .join('\n');

  const next: Season = {
    id: uid(), worldId: world.id, number: season.number + 1,
    title: '', premise: wrap.premise, timeGap: gapLabel,
    bible: {
      recap: recap.trim(),
      carriedBeats: kept.map(({ where: _where, ...b }): { text: string; consequence: string; disposition: WrapBeat['disposition'] } => b),
      offscreenChanges: offscreen
    },
    status: 'active', createdAt: Date.now()
  };

  const firstEpisode: Episode = {
    id: uid(), seasonId: next.id, worldId: world.id, number: 1,
    title: '', location: '', locationId: null,
    castIds: wrap.characters.filter((c) => c.returning).map((c) => c.characterId),
    status: 'active', createdAt: Date.now()
  };

  await db.transaction('rw', [db.seasons, db.episodes, db.worlds, db.wraps, db.characters, db.threads], async () => {
    await db.seasons.update(season.id, { status: 'wrapped' });
    await db.seasons.add(next);
    await db.episodes.add(firstEpisode);
    const gapIdx = GAP_LABELS.indexOf(gapLabel);
    const cal = worldCalendar(world);
    const bumpedCalendar = { ...cal, currentDay: cal.currentDay + (gapIdx >= 0 ? GAP_DAYS[gapIdx] : 0) };
    await db.worlds.update(world.id, { activeSeasonId: next.id, calendar: bumpedCalendar, updatedAt: Date.now() });
    await db.wraps.update(wrap.id, { status: 'committed' });
    // Rewrite character current-state snapshots for the new season.
    for (const c of wrap.characters) {
      const patch = c.returning
        ? { 'state.goal': '', 'state.condition': c.evolution || c.outcome, updatedAt: Date.now() }
        : { 'state.location': 'departed — not in this season', updatedAt: Date.now() };
      await db.characters.update(c.characterId, patch as never);
    }
    // Dropped beats close their threads; carried ones stay open in the new season.
    const threads = await db.threads.where('worldId').equals(world.id).filter((t) => t.status === 'open').toArray();
    for (const t of threads) {
      await db.threads.update(t.id, { seasonId: next.id });
    }
  });

  return next;
}

/** AI-assisted character draft from a one-line description. */
export async function draftCharacter(world: World | null, description: string): Promise<Partial<Character>> {
  const result = await utilityJson<{
    name: string; role: string; age: string; appearance: string; mannerisms: string;
    backstory: string; summary: string;
    speechStyle: string; exampleLines: string[]; traits: string; desires: string;
    fears: string; flaws: string; secrets: string; anchors: string[];
  }>(
    world,
    'You design deep NPC character sheets for longform interactive fiction. Respond with JSON only:\n{"name": string, "role": "<role · relationship to protagonist>", "age": string, "appearance": string, "mannerisms": "<2-3 recurring physical habits or tics, concrete and observable>", "backstory": "<the history that shaped them, 2-3 sentences>", "summary": "<who they are, 2-4 sentences of prose>", "speechStyle": "<how they talk, 1-2 sentences>", "exampleLines": [<2-3 sample spoken lines>], "traits": string, "desires": string, "fears": string, "flaws": string, "secrets": "<something they hide>", "anchors": [<3-4 hard behavioural rules they never break, e.g. "Never lies in writing">]}\nMake them specific, contradictory in believable ways, never generic.',
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}Character to create: ${description}`
  );
  return result;
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
    anchors: character.anchors,
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
    fears: string; flaws: string; secrets: string; anchors: string[];
    relationships?: { targetName?: string; kind?: string; note?: string }[];
  }>(
    world,
    `You flesh out character sheets for longform interactive fiction. ${subjectFrame} ${NON_DESTRUCTIVE_RULE}\n` +
    `Respond with JSON only: {"name": string, "role": string, "age": string, "appearance": string, "mannerisms": string, ` +
    `"backstory": string, "summary": string, "speechStyle": string, "exampleLines": string[], "traits": string, ` +
    `"desires": string, "fears": string, "flaws": string, "secrets": string, "anchors": string[], ` +
    `"relationships":[{"targetName":"<exact name from Other cast>","kind":"ally|rival|lover|debt|family|…","note":"<one-line history>"}]}\n` +
    `Only link to names listed in Other cast. Prefer unlinked cast first. If Other cast is empty, return relationships: []. ${RELATIONSHIP_POV_RULES}`,
    worldFleshPreamble(world) +
    `Other cast (relationship targets):\n${JSON.stringify(roster, null, 2)}\n\n` +
    `SUBJECT sheet (JSON, blank strings/arrays mean unset):\n${JSON.stringify(current, null, 2)}`
  );

  const castIds = cast.map((c) => c.id);
  const relIncoming = others.length > 0
    ? resolveRelationshipsByName(result.relationships ?? [], others)
    : [];

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
    anchors: mergeLines(character.anchors, result.anchors ?? []),
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
export async function fleshOutWorldLore(world: World): Promise<{ title: string; line: string; bible: string }> {
  const result = await utilityJson<{ title: string; line: string; bible: string }>(
    world,
    `You flesh out the lore of a story world for longform interactive fiction. ${NON_DESTRUCTIVE_RULE}\nRespond with JSON only: {"title": string, "line": "<one-sentence logline in second person>", "bible": "<setting, atmosphere, rules of the world, pressures at work — prose the narrator will follow>"}`,
    `Current world sheet (JSON, blank strings mean unset):\n${JSON.stringify({ title: world.title, line: world.line, bible: world.bible }, null, 2)}`
  );
  return {
    title: keepIfBlank(world.title, result.title),
    line: keepIfBlank(world.line, result.line),
    bible: keepIfBlank(world.bible, result.bible)
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

/** AI-assisted world draft from onboarding inputs. */
export async function draftWorld(seed: string, shape: string): Promise<{ title: string; line: string; bible: string; premise: string }> {
  return utilityJson<{ title: string; line: string; bible: string; premise: string }>(
    null,
    'You design story worlds for longform interactive fiction. Respond with JSON only:\n{"title": "<evocative 1-4 word title>", "line": "<one-sentence logline in second person>", "bible": "<the world bible: setting, atmosphere, rules of the world, pressures at work — 150-300 words of prose the narrator will follow>", "premise": "<season one premise: where the story opens, 2-3 sentences>"}\nBe specific and concrete. The world should have its own weather, its own rules, and at least one pressure that will not wait.',
    `Story shape the player wants: ${shape}\n\nThe one true thing about this world: ${seed}`
  );
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
}

export interface FleshOutEverythingResult {
  characterIds: string[];
  locationIds: string[];
}

/**
 * Flesh lore/premise/rules, invent opening cast & places when the world is thin,
 * and link them to episode 1. Does not open Story — caller leaves the user to review.
 */
export async function fleshOutWorldEverything(
  world: World,
  season: Season,
  episode: Episode,
  opts: FleshOutEverythingOpts
): Promise<FleshOutEverythingResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Fleshing lore…');
  const lore = await fleshOutWorldLore(world);
  await db.worlds.update(world.id, {
    title: lore.title, line: lore.line, bible: lore.bible, updatedAt: Date.now()
  });
  let live: World = { ...world, ...lore };

  progress('Fleshing premise…');
  const premise = await fleshOutPremise(live, season);
  await db.seasons.update(season.id, { premise });

  progress('Fleshing narrator rules…');
  const rules = await fleshOutNarratorRules(live);
  await db.worlds.update(live.id, {
    ai: { ...live.ai, narratorRules: rules },
    updatedAt: Date.now()
  });
  live = { ...live, ai: { ...live.ai, narratorRules: rules } };

  const allChars = await db.characters.where('worldId').equals(live.id).toArray();
  const player = allChars.find((c) => c.isPlayer);
  if (player && !player.summary.trim() && !player.speechStyle.trim()) {
    progress('Fleshing you…');
    const sheet = await fleshOutCharacter(live, player, allChars);
    await db.characters.update(player.id, { ...sheet, isPlayer: true, updatedAt: Date.now() });
  }

  const npcs = allChars.filter((c) => !c.isPlayer);
  const existingPlaces = await db.locations.where('worldId').equals(live.id).toArray();
  const needChars = npcs.length < 2;
  const needPlaces = existingPlaces.length < 1;
  const charSlots = needChars ? Math.max(0, opts.targetCharacters - npcs.length) : 0;
  const placeSlots = needPlaces ? Math.max(0, opts.targetLocations - existingPlaces.length) : 0;

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
      await db.locations.add(l);
      createdLocationIds.push(l.id);
    }

    // Link new NPCs into episode cast; set opening location if episode has none.
    if (createdCharacterIds.length > 0) {
      const castIds = [...new Set([...episode.castIds, ...createdCharacterIds])];
      await db.episodes.update(episode.id, { castIds });
    }

    if (createdLocationIds.length > 0 && !episode.locationId && !episode.location.trim()) {
      const idx = Math.max(0, Math.min(createdLocationIds.length - 1, roster.openingLocationIndex));
      const openId = createdLocationIds[idx] ?? createdLocationIds[0];
      const open = await db.locations.get(openId);
      if (open) {
        await db.episodes.update(episode.id, { location: open.name, locationId: open.id });
      }
    }
  }

  await db.worlds.update(live.id, { updatedAt: Date.now() });
  return { characterIds: createdCharacterIds, locationIds: createdLocationIds };
}
