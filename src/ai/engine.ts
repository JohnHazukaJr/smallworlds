import { db, uid } from '../db';
import { resolveModel, useSettings } from '../store/settings';
import type {
  Character, ComposeMode, Episode, Location, ModelRef, Season, SeasonWrap, TurnLength, World, WrapBeat
} from '../types';
import { AIError, streamChat } from './client';
import { buildMessages, buildSystemPrompt, maxTokensFor } from './prompts';

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

export interface WriteOptions {
  world: World;
  season: Season;
  episode: Episode;
  mode: ComposeMode;
  input: string;
  length: TurnLength;
  signal?: AbortSignal;
  onDelta: (partial: string) => void;
}

/**
 * The core writing loop: persists the user turn (unless continue),
 * streams the narrator's response, persists it, and returns the turn id.
 */
export async function writeTurn(opts: WriteOptions): Promise<string> {
  const { provider, model } = proseModelFor(opts.world);
  const ctx = await loadContext(opts.world, opts.season, opts.episode);

  if (opts.mode !== 'continue' && opts.input.trim()) {
    const userTurn = {
      id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
      role: 'user' as const, mode: opts.mode, text: opts.input.trim(), createdAt: Date.now()
    };
    await db.turns.add(userTurn);
    ctx.turns.push(userTurn);
  }

  const system = buildSystemPrompt(ctx);
  const messages = buildMessages(ctx.turns, opts.mode, opts.input.trim(), opts.length);

  let acc = '';
  const text = await streamChat({
    provider, model, system, messages,
    maxTokens: maxTokensFor(opts.length),
    signal: opts.signal,
    onDelta: (d) => { acc += d; opts.onDelta(acc); }
  });

  const narratorTurn = {
    id: uid(), episodeId: opts.episode.id, worldId: opts.world.id,
    role: 'narrator' as const, mode: null, text, createdAt: Date.now()
  };
  await db.turns.add(narratorTurn);
  await db.worlds.update(opts.world.id, { updatedAt: Date.now() });
  return narratorTurn.id;
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

async function utilityJson<T>(world: World | null, system: string, user: string, maxTokens = 3000): Promise<T> {
  const { provider, model } = utilityModelFor(world);
  const raw = await streamChat({
    provider, model, system,
    messages: [{ role: 'user', content: user }],
    maxTokens, temperature: 0.4
  });
  return extractJson<T>(raw);
}

/** Extract new continuity facts + open threads after an episode ends. */
export async function extractContinuity(world: World, season: Season, episode: Episode): Promise<void> {
  const turns = await db.turns.where('episodeId').equals(episode.id).sortBy('createdAt');
  if (turns.length === 0) return;
  const existing = await db.continuity.where('seasonId').equals(season.id).toArray();
  const text = turns.map((t) => (t.role === 'user' ? `[player ${t.mode}]: ${t.text}` : t.text)).join('\n\n');

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
    const text = turns.map((t) => (t.role === 'user' ? `[player]: ${t.text}` : t.text)).join('\n\n');
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
    title: '', location: '', castIds: wrap.characters.filter((c) => c.returning).map((c) => c.characterId),
    status: 'active', createdAt: Date.now()
  };

  await db.transaction('rw', [db.seasons, db.episodes, db.worlds, db.wraps, db.characters, db.threads], async () => {
    await db.seasons.update(season.id, { status: 'wrapped' });
    await db.seasons.add(next);
    await db.episodes.add(firstEpisode);
    await db.worlds.update(world.id, { activeSeasonId: next.id, updatedAt: Date.now() });
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

/** AI-assisted world draft from onboarding inputs. */
export async function draftWorld(seed: string, shape: string): Promise<{ title: string; line: string; bible: string; premise: string }> {
  return utilityJson<{ title: string; line: string; bible: string; premise: string }>(
    null,
    'You design story worlds for longform interactive fiction. Respond with JSON only:\n{"title": "<evocative 1-4 word title>", "line": "<one-sentence logline in second person>", "bible": "<the world bible: setting, atmosphere, rules of the world, pressures at work — 150-300 words of prose the narrator will follow>", "premise": "<season one premise: where the story opens, 2-3 sentences>"}\nBe specific and concrete. The world should have its own weather, its own rules, and at least one pressure that will not wait.',
    `Story shape the player wants: ${shape}\n\nThe one true thing about this world: ${seed}`
  );
}
