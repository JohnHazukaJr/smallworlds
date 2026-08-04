import { db, uid } from '../db';
import { resolveModel, useSettings } from '../store/settings';
import { GAP_DAYS, GAP_LABELS } from '../ui/theme';
import type {
  Character, ComposeMode, Episode, Location, ModelRef, Season, SeasonWrap, Turn, TurnLength, TurnRole, World, WrapBeat
} from '../types';
import { emptyCharacter, emptyLocation, worldCalendar } from '../worldOps';
import { AIError, streamChat } from './client';
import {
  buildCharacterSpeakMessages,
  buildCharacterSystemPrompt,
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

async function loadContext(world: World, season: Season, episode: Episode) {
  const [characters, locations, continuity, threads, turns] = await Promise.all([
    db.characters.where('worldId').equals(world.id).toArray(),
    db.locations.where('worldId').equals(world.id).toArray(),
    db.continuity.where('seasonId').equals(season.id).toArray(),
    db.threads.where('worldId').equals(world.id).filter((t) => t.status === 'open').toArray(),
    db.turns.where('episodeId').equals(episode.id).sortBy('createdAt')
  ]);
  return { world, season, episode, characters, locations, continuity, threads, turns };
}

export interface StreamMeta {
  role: TurnRole;
  characterId?: string;
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
}

function labelTurn(t: Turn, characters: Character[]): string {
  if (t.role === 'user') return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
  if (t.role === 'character') {
    const name = characters.find((c) => c.id === t.characterId)?.name ?? 'NPC';
    return `[${name}]: ${t.text}`;
  }
  return `[narrator]: ${t.text}`;
}

function normalizeBeats(
  raw: { beats?: Array<{ type?: string; brief?: string; characterId?: string }> },
  inScene: Character[]
): DirectorBeat[] {
  const allowed = new Set(inScene.map((c) => c.id));
  const beats: DirectorBeat[] = [];
  for (const b of raw.beats ?? []) {
    const brief = (b.brief ?? '').trim();
    if (!brief) continue;
    if (b.type === 'speak') {
      const id = (b.characterId ?? '').trim();
      if (!allowed.has(id)) continue;
      beats.push({ type: 'speak', characterId: id, brief });
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

/**
 * Core writing loop: persist the user turn (unless continue), plan beats with
 * the director, then stream narrator (narration-only) and character agents.
 * Each completed beat is persisted immediately. Returns the last turn id.
 */
export async function writeTurn(opts: WriteOptions): Promise<string> {
  const { provider, model } = proseModelFor(opts.world);
  const ctx = await loadContext(opts.world, opts.season, opts.episode);
  const inScene = ctx.characters.filter((c) => opts.episode.castIds.includes(c.id) && !c.isPlayer);

  if (opts.mode !== 'continue' && opts.input.trim()) {
    const userTurn: Turn = {
      id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
      role: 'user', mode: opts.mode, text: opts.input.trim(), createdAt: Date.now()
    };
    await db.turns.add(userTurn);
    ctx.turns.push(userTurn);
  }

  // Director plans ordered narration / speak beats (utility model).
  let beats: DirectorBeat[];
  try {
    const plan = await utilityJson<{ beats: Array<{ type?: string; brief?: string; characterId?: string }> }>(
      opts.world,
      directorSystemPrompt(),
      directorUserPrompt(ctx, opts.mode, opts.input.trim()),
      1200,
      opts.signal
    );
    beats = normalizeBeats(plan, inScene);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Fall back to a single narration beat if the director fails.
    beats = [{
      type: 'narration',
      brief: 'Continue the scene with atmosphere and physical action; leave space for the player.'
    }];
  }

  let lastId = '';
  for (const beat of beats) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (beat.type === 'narration') {
      const meta: StreamMeta = { role: 'narrator' };
      opts.onDelta('', meta);
      let acc = '';
      const text = await streamChat({
        provider, model,
        system: buildNarratorSystemPrompt(ctx),
        messages: buildNarrationBeatMessages(ctx.turns, ctx.characters, beat.brief, opts.length),
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
      await db.turns.add(narratorTurn);
      ctx.turns.push(narratorTurn);
      lastId = narratorTurn.id;
      opts.onDelta('', meta);
      continue;
    }

    const speaking = ctx.characters.find((c) => c.id === beat.characterId);
    if (!speaking || speaking.isPlayer) continue;

    const meta: StreamMeta = { role: 'character', characterId: speaking.id };
    opts.onDelta('', meta);
    let acc = '';
    const text = await streamChat({
      provider, model,
      system: buildCharacterSystemPrompt(ctx, speaking),
      messages: buildCharacterSpeakMessages(ctx.turns, ctx.characters, speaking, beat.brief),
      maxTokens: characterSpeakTokens(),
      signal: opts.signal,
      onDelta: (d) => { acc += d; opts.onDelta(acc, meta); }
    });
    const cleaned = text.trim().replace(/^[A-Z][^:\n]{0,48}:\s*/, '').trim();
    if (!cleaned) {
      opts.onDelta('', meta);
      continue;
    }
    const characterTurn: Turn = {
      id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
      role: 'character', mode: null, characterId: speaking.id,
      text: cleaned, createdAt: Date.now()
    };
    await db.turns.add(characterTurn);
    ctx.turns.push(characterTurn);
    lastId = characterTurn.id;
    opts.onDelta('', meta);
  }

  await db.worlds.update(opts.world.id, { updatedAt: Date.now() });
  return lastId;
}

/** Delete a turn and everything after it (used by regenerate / retry). */
export async function deleteTurnsFrom(turnId: string, episodeId: string): Promise<void> {
  const turns = await db.turns.where('episodeId').equals(episodeId).sortBy('createdAt');
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return;
  await db.turns.bulkDelete(turns.slice(idx).map((t) => t.id));
}

/** Delete everything after a turn, keeping the turn itself. */
export async function deleteTurnsAfter(turnId: string, episodeId: string): Promise<void> {
  const turns = await db.turns.where('episodeId').equals(episodeId).sortBy('createdAt');
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return;
  await db.turns.bulkDelete(turns.slice(idx + 1).map((t) => t.id));
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
  const raw = await streamChat({
    provider, model, system,
    messages: [{ role: 'user', content: user }],
    maxTokens, temperature: 0.4, signal
  });
  return extractJson<T>(raw);
}

/** Extract new continuity facts + open threads after an episode ends. */
export async function extractContinuity(world: World, season: Season, episode: Episode): Promise<void> {
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  if (turns.length === 0) return;
  const existing = await db.continuity.where('seasonId').equals(season.id).toArray();
  const characters = await db.characters.where('worldId').equals(world.id).toArray();
  const text = turns.map((t) => labelTurn(t, characters)).join('\n\n');

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

/** Step 1 of the sequel pipeline: read the season, propose beats + character outcomes. */
export async function analyzeSeason(world: World, season: Season): Promise<SeasonWrap> {
  const episodes = await db.episodes.where('seasonId').equals(season.id).sortBy('number');
  const characters = await db.characters.where('worldId').equals(world.id).toArray();

  // Map-reduce: summarize each episode, then analyze the summaries.
  const episodeSummaries: string[] = [];
  for (const ep of episodes) {
    const turns = await db.turns.where('episodeId').equals(ep.id).sortBy('createdAt');
    if (turns.length === 0) continue;
    const text = turns.map((t) => labelTurn(t, characters)).join('\n\n');
    if (text.length < 6000) {
      episodeSummaries.push(`Episode ${ep.number}${ep.title ? ` (${ep.title})` : ''}:\n${text}`);
    } else {
      const { provider, model } = utilityModelFor(world);
      const summary = await streamChat({
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
  await db.wraps.bulkDelete(old.map((w) => w.id));
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
  const premise = await streamChat({
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
  const recap = await streamChat({
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

/** Union two line lists without ever dropping an existing line (case-insensitive de-dupe). */
function mergeLines(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  return [...existing, ...incoming.filter((s) => s.trim() && !seen.has(s.trim().toLowerCase()))];
}

/** Defensive fallback: never let a blank AI response wipe out existing text. */
function keepIfBlank(existing: string, incoming: string | undefined): string {
  return incoming && incoming.trim() ? incoming : existing;
}

/** AI-assisted flesh-out of an existing character sheet: fills blanks, enriches filled fields, never removes detail. */
export async function fleshOutCharacter(world: World | null, character: Character): Promise<Partial<Character>> {
  const current = {
    name: character.name, role: character.role, age: character.age, appearance: character.appearance,
    mannerisms: character.mannerisms, backstory: character.backstory, summary: character.summary,
    speechStyle: character.speechStyle, exampleLines: character.exampleLines, traits: character.traits,
    desires: character.desires, fears: character.fears, flaws: character.flaws, secrets: character.secrets,
    anchors: character.anchors
  };
  const result = await utilityJson<{
    name: string; role: string; age: string; appearance: string; mannerisms: string;
    backstory: string; summary: string;
    speechStyle: string; exampleLines: string[]; traits: string; desires: string;
    fears: string; flaws: string; secrets: string; anchors: string[];
  }>(
    world,
    `You flesh out NPC character sheets for longform interactive fiction. ${NON_DESTRUCTIVE_RULE}\nRespond with JSON only, same shape as the input: {"name": string, "role": string, "age": string, "appearance": string, "mannerisms": string, "backstory": string, "summary": string, "speechStyle": string, "exampleLines": string[], "traits": string, "desires": string, "fears": string, "flaws": string, "secrets": string, "anchors": string[]}`,
    `${world ? `World: ${world.title} — ${world.line}\nWorld bible: ${world.bible.slice(0, 1200)}\n\n` : ''}Current character sheet (JSON, blank strings/arrays mean unset):\n${JSON.stringify(current, null, 2)}`
  );
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
    anchors: mergeLines(character.anchors, result.anchors ?? [])
  };
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
  const premise = await streamChat({
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
    const sheet = await fleshOutCharacter(live, player);
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
