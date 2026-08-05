import type {
  Character, ComposeMode, ContinuityFact, Episode, EpisodeGuest, Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
import { formatEpisodeDateRange, formatStoryDate, worldCalendar } from '../worldOps';
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
  /** Immediately prior episode in this season (for wrap.recap), if any */
  priorEpisode?: Episode | null;
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

/** Newest-first cap for continuity bullets in every agent frame. */
const CONTINUITY_FACT_CAP = 24;

function worldFrameSections(ctx: PromptContext): string[] {
  const { world, season, episode, characters, locations, continuity, threads } = ctx;
  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const player = characters.find((c) => c.isPlayer);
  const offScene = characters.filter((c) => !episode.castIds.includes(c.id) && !c.isPlayer);
  const sections: string[] = [];

  sections.push(`## The world\n${world.bible || world.line}`);

  if (season.bible) {
    const beats = season.bible.carriedBeats
      .filter((b) => b.disposition !== 'drop')
      .map((b) => `- [${b.disposition.toUpperCase()}] ${b.text} → ${b.consequence}`)
      .join('\n');
    sections.push(
      `## Previously (season ${season.number - 1} recap)\n${season.bible.recap}` +
      (beats ? `\n\nCarried beats — RAISE means active pressure now, KEEP means alive background, SOFTEN means distant echo:\n${beats}` : '') +
      (season.bible.offscreenChanges ? `\n\nWhat changed during the gap:\n${season.bible.offscreenChanges}` : '')
    );
  }

  sections.push(
    `## This season\nSeason ${season.number}${season.title ? ` — ${season.title}` : ''}. ` +
    `Premise (current pressure): ${season.premise || 'unwritten; discover it in play.'}` +
    `${season.timeGap ? ` It opens ${season.timeGap.toLowerCase()} after the previous season.` : ''}`
  );

  const priorRecap = ctx.priorEpisode?.wrap?.recap?.trim();
  if (priorRecap && ctx.priorEpisode && ctx.priorEpisode.number < episode.number) {
    const priorBeats = (ctx.priorEpisode.wrap?.beats ?? [])
      .map((b) => `- ${b.text}${b.consequence ? ` → ${b.consequence}` : ''}`)
      .join('\n');
    const guestFx = (ctx.priorEpisode.wrap?.guestEffects ?? [])
      .map((g) => g.trim())
      .filter(Boolean)
      .map((g) => `- ${g}`)
      .join('\n');
    sections.push(
      `## Previously this season (episode ${ctx.priorEpisode.number})\n${priorRecap}` +
      (priorBeats ? `\n\nCarried episode beats:\n${priorBeats}` : '') +
      (guestFx ? `\n\nWalk-on effects that still matter:\n${guestFx}` : '')
    );
  }

  const running = episode.runningSummary?.trim();
  if (running) {
    sections.push(`## Earlier this episode (running summary)\n${running}`);
  }

  const cal = worldCalendar(world);
  const epStart = episode.storyDay ?? cal.currentDay;
  const epEnd = episode.storyDayEnd ?? null;
  const dateLine = formatEpisodeDateRange(cal, epStart, epEnd);
  sections.push(
    `## Calendar\n` +
    (cal.system ? `${cal.system}\n` : '') +
    `Week cycle: ${cal.weekdays.join(', ')} (day 1 of the story was a ${cal.weekdays[cal.dayOneWeekday]}).\n` +
    `Today is ${formatStoryDate(cal, cal.currentDay)}.\n` +
    `This episode's date: ${dateLine}.` +
    (episode.dateNote?.trim() ? `\nDate note: ${episode.dateNote.trim()}` : '')
  );

  sections.push(
    `## Current episode\nEpisode ${episode.number}${episode.title ? ` — ${episode.title}` : ''}.` +
    `${episode.location ? ` Location: ${episode.location}.` : ''} Date: ${dateLine}.`
  );

  const guests = activeGuests(episode);
  if (guests.length > 0) {
    sections.push(
      `## Walk-ons in this episode (not Cast cards — temporary)\n` +
      guests.map((g) => `- ${g.name}: ${g.brief}${g.voice ? ` Voice: ${g.voice}` : ''}`).join('\n')
    );
  }

  let currentLocations: Location[] = [];
  if (locations.length > 0) {
    const byId = episode.locationId
      ? locations.filter((l) => l.id === episode.locationId)
      : [];
    const epLoc = episode.location.trim().toLowerCase();
    const byName = byId.length === 0 && epLoc
      ? locations.filter((l) => l.name.trim() && (epLoc.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(epLoc)))
      : [];
    currentLocations = byId.length > 0 ? byId : byName;
    const others = locations.filter((l) => !currentLocations.includes(l));
    if (currentLocations.length > 0) {
      sections.push(`## Current location\n${currentLocations.map(locationSheet).join('\n\n')}`);
    }
    if (others.length > 0) {
      sections.push(`## Other established locations (may be referenced or visited)\n${others.map(locationBrief).join('\n')}`);
    }
  }

  const sensoryBits = [
    currentLocations[0]?.atmosphere,
    episode.atmosphereNote
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

  if (continuity.length > 0) {
    // Newest facts first — cap so the system frame does not crowd out transcript history.
    const capped = [...continuity]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, CONTINUITY_FACT_CAP);
    sections.push(
      `## Continuity — established facts, never contradict these\n` +
      capped.map((f) => `- ${f.text}`).join('\n')
    );
  }
  if (threads.length > 0) {
    sections.push(`## Open threads — unresolved tensions to draw on (do not resolve them all at once)\n${threads.map((t) => `- ${t.text} (${t.openedLabel})`).join('\n')}`);
  }

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
function priorEpisodeSection(ctx: PromptContext): string | null {
  const priorRecap = ctx.priorEpisode?.wrap?.recap?.trim();
  if (!priorRecap || !ctx.priorEpisode || ctx.priorEpisode.number >= ctx.episode.number) return null;
  const priorBeats = (ctx.priorEpisode.wrap?.beats ?? [])
    .slice(0, 5)
    .map((b) => `- ${b.text}${b.consequence ? ` → ${b.consequence}` : ''}`)
    .join('\n');
  return (
    `## Previously this season (episode ${ctx.priorEpisode.number})\n${priorRecap}` +
    (priorBeats ? `\n\nWhat still hangs:\n${priorBeats}` : '')
  );
}

function cappedContinuityLines(continuity: ContinuityFact[]): string[] {
  return [...continuity]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, CONTINUITY_FACT_CAP)
    .map((f) => `- ${f.text}`);
}

export function buildCharacterSystemPrompt(ctx: PromptContext, character: Character): string {
  const { world, characters, season } = ctx;
  const ai = world.ai;
  const others = characters.filter((c) => c.id !== character.id);
  const guests = activeGuests(ctx.episode);
  const sections: string[] = [];

  sections.push(
    `You ARE ${character.name} in the story "${world.title}". You speak and act only as yourself. ` +
    `You are not the narrator. You do not write other characters' dialogue or the player's lines. ` +
    `Reply in your own voice — looks/mannerisms plus what you say aloud.`
  );

  sections.push(`## The world\n${world.bible || world.line}`);
  sections.push(
    `## This season\nPremise (current pressure): ${season.premise || 'unwritten; discover it in play.'}`
  );
  const prior = priorEpisodeSection(ctx);
  if (prior) sections.push(prior);
  const running = ctx.episode.runningSummary?.trim();
  if (running) sections.push(`## Earlier this episode (running summary)\n${running}`);
  {
    const cal = worldCalendar(ctx.world);
    const dateLine = formatEpisodeDateRange(cal, ctx.episode.storyDay, ctx.episode.storyDayEnd);
    sections.push(
      `## Current episode\nEpisode ${ctx.episode.number}${ctx.episode.title ? ` — ${ctx.episode.title}` : ''}.` +
      `${ctx.episode.location ? ` Location: ${ctx.episode.location}.` : ''} Date: ${dateLine}.` +
      `\nToday is ${formatStoryDate(cal, cal.currentDay)}.`
    );
  }

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

  const contLines = cappedContinuityLines(ctx.continuity);
  if (contLines.length > 0) {
    sections.push(
      `## Continuity — facts you may know if you could plausibly know them\n` +
      contLines.join('\n')
    );
  }
  if (ctx.threads.length > 0) {
    sections.push(
      `## Open threads — tensions you may lean on if you know them\n` +
      ctx.threads.map((t) => `- ${t.text} (${t.openedLabel})`).join('\n')
    );
  }

  sections.push(
    `## How you respond\n` +
    `- Speak as ${character.name}. Prefer one or two spoken lines in your natural voice.\n` +
    `- No narration of the room, weather, or other people — only your body and your words.\n` +
    `- Honour behaviour anchors and MUST NOT KNOW. Never soften yourself to please the player.\n` +
    (character.speechStyle ? `- Voice guide: ${character.speechStyle}\n` : '') +
    (character.exampleLines.length > 0
      ? `- Example spoken rhythm (wording only — still emit *actions* and "quotes" as required):\n${character.exampleLines.map((l) => `  ${l}`).join('\n')}\n`
      : '') +
    `- Stay in ${ai.tense} tense for any physical beat.\n\n` +
    SPEAK_FORMAT_RULES
  );

  sections.push(contentSection(ai));

  if (ai.customInstructions.trim()) {
    sections.push(`## Author's world instructions\n${ai.customInstructions}`);
  }

  return sections.join('\n\n');
}

/** Guest walk-on agent — short sheet, same speak format. */
export function buildGuestSystemPrompt(ctx: PromptContext, guest: EpisodeGuest): string {
  const { world, characters, season } = ctx;
  const ai = world.ai;
  const inScene = characters.filter((c) => ctx.episode.castIds.includes(c.id));
  const sections: string[] = [];

  sections.push(
    `You ARE ${guest.name}, a temporary walk-on in "${world.title}" (not a permanent cast member). ` +
    `You speak and act only as yourself for this scene.`
  );
  sections.push(`## The world\n${world.bible || world.line}`);
  sections.push(
    `## This season\nPremise (current pressure): ${season.premise || 'unwritten; discover it in play.'}`
  );
  const prior = priorEpisodeSection(ctx);
  if (prior) sections.push(prior);
  const running = ctx.episode.runningSummary?.trim();
  if (running) sections.push(`## Earlier this episode (running summary)\n${running}`);
  sections.push(`## Who you are this scene\n${guest.brief}${guest.voice ? `\nVoice: ${guest.voice}` : ''}`);
  if (inScene.length > 0) {
    sections.push(`## Others present\n${inScene.map((c) => briefSheet(c)).join('\n')}`);
  }
  const contLines = cappedContinuityLines(ctx.continuity);
  if (contLines.length > 0) {
    sections.push(`## Continuity you may know if plausible\n${contLines.join('\n')}`);
  }
  if (ctx.threads.length > 0) {
    sections.push(
      `## Open threads\n` +
      ctx.threads.map((t) => `- ${t.text} (${t.openedLabel})`).join('\n')
    );
  }
  sections.push(
    `## How you respond\n` +
    `- Prefer one or two spoken lines. Optional short physical beat of your own body.\n` +
    `- Do not steal the scene from the main cast; add pressure or texture.\n` +
    `- Stay in ${ai.tense} tense for physical beats.\n\n` +
    SPEAK_FORMAT_RULES
  );
  sections.push(contentSection(ai));
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

/** Rough char budget for history packing (≈4 chars per token). */
export const HISTORY_CHAR_BUDGET = 96000;

/** Minimum turns kept even when over budget. */
const PACK_MIN_TURNS = 4;

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

/** Pack newest turns into the char budget; expose what fell off the front. */
export function packTurnsDetailed(turns: Turn[]): PackedTurns {
  let used = 0;
  const reversed = [...turns].reverse();
  const kept: Turn[] = [];
  for (const t of reversed) {
    used += t.text.length;
    if (used > HISTORY_CHAR_BUDGET && kept.length > PACK_MIN_TURNS) break;
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

/** History prefix when older turns were packed out (running summary + omitted digest). */
function earlierEpisodePrefix(
  episode: Episode | undefined,
  omitted: Turn[],
  characters: Character[],
  guests: EpisodeGuest[]
): ChatMessage | null {
  const parts: string[] = [];
  const running = episode?.runningSummary?.trim();
  if (running) parts.push(`Running summary:\n${running}`);
  const digest = compressOmittedTurns(omitted, characters, guests);
  if (digest) parts.push(`Compressed earlier beats:\n${digest}`);
  if (parts.length === 0) return null;
  return {
    role: 'user',
    content: `(Earlier this episode — compressed; recent turns follow.)\n\n${parts.join('\n\n')}`
  };
}

function historyMessages(
  turns: Turn[],
  characters: Character[],
  guests: EpisodeGuest[] = [],
  episode?: Episode
): ChatMessage[] {
  const { kept, omitted } = packTurnsDetailed(turns);
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
  episode?: Episode
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, episode);
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
  episode?: Episode
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, episode);
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
  opts?: { requireDialogue?: boolean; episode?: Episode }
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, opts?.episode);
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
  opts?: { requireDialogue?: boolean; episode?: Episode }
): ChatMessage[] {
  const messages = historyMessages(turns, characters, guests, opts?.episode);
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
    'castDelta.enter: saved Cast NPCs who arrive (from the off-scene list). ' +
    'castDelta.leave: Cast ids or guest ids who exit the scene. ' +
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

  const priorOneLiner = ctx.priorEpisode?.wrap?.recap?.trim()
    ? ctx.priorEpisode.wrap!.recap!.trim().slice(0, 480)
    : '';
  const running = ctx.episode.runningSummary?.trim();

  const cal = worldCalendar(ctx.world);
  const dateLine = formatEpisodeDateRange(cal, ctx.episode.storyDay, ctx.episode.storyDayEnd);

  return (
    `World: ${ctx.world.title}\n` +
    `Episode ${ctx.episode.number}${ctx.episode.location ? ` @ ${ctx.episode.location}` : ''} · ${dateLine}\n` +
    `Today: ${formatStoryDate(cal, cal.currentDay)}\n` +
    `Premise (current pressure): ${ctx.season.premise || '(unwritten)'}\n` +
    (priorOneLiner ? `Prior episode recap (clip): ${priorOneLiner}\n` : '') +
    (running ? `Earlier this episode (summary): ${running.slice(0, 400)}\n` : '') +
    `\n` +
    `In-scene cast:\n${castList}\n\n` +
    `Off-scene cast (may enter via castDelta.enter):\n${offList}\n\n` +
    `Active walk-ons (guest ids):\n${guestList}\n\n` +
    `Latest player move: ${MODE_PREFIX[mode](input)}\n\n` +
    `Recent transcript:\n${transcript || '(episode just opened)'}\n\n` +
    `Plan castDelta and beats as JSON.`
  );
}
