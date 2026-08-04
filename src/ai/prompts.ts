import type {
  Character, ComposeMode, ContinuityFact, Episode, Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
import { worldCalendar } from '../worldOps';
import type { ChatMessage } from './client';

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

/** Character speak turns stay short — a line or two, not a monologue. */
const CHARACTER_SPEAK_TOKENS = 280;

export function maxTokensFor(length: TurnLength): number {
  return LENGTH_SPEC[length].maxTokens;
}

export function narrationBeatTokens(length: TurnLength): number {
  return NARRATION_BEAT_TOKENS[length];
}

export function characterSpeakTokens(): number {
  return CHARACTER_SPEAK_TOKENS;
}

function characterSheet(c: Character, all: Character[]): string {
  const rel = c.relationships
    .map((r) => {
      const target = all.find((x) => x.id === r.targetId);
      return target ? `- ${r.kind} of ${target.name}: ${r.note}` : null;
    })
    .filter(Boolean)
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
    `## This season\nSeason ${season.number}${season.title ? ` — ${season.title}` : ''}. Premise: ${season.premise || 'unwritten; discover it in play.'}${season.timeGap ? ` It opens ${season.timeGap.toLowerCase()} after the previous season.` : ''}`
  );

  const cal = worldCalendar(world);
  sections.push(
    `## Calendar\n${cal.system ? `${cal.system}\n` : ''}Today is day ${cal.currentDay} of the story.`
  );

  sections.push(
    `## Current episode\nEpisode ${episode.number}${episode.title ? ` — ${episode.title}` : ''}.${episode.location ? ` Location: ${episode.location}.` : ''}`
  );

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
    sections.push(`## Continuity — established facts, never contradict these\n${continuity.map((f) => `- ${f.text}`).join('\n')}`);
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
    `- NEVER write spoken dialogue, quoted speech, or lines in the form CharacterName: "…". If someone would speak, describe only the silence, gesture, or that they are about to answer — their words come from them, not you.\n` +
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
  const sections: string[] = [];

  sections.push(
    `You ARE ${character.name} in the story "${world.title}". You speak and act only as yourself. ` +
    `You are not the narrator. You do not write other characters' dialogue or the player's lines. ` +
    `Reply in your own voice — what you say aloud, and at most a brief physical beat of your own body.`
  );

  sections.push(`## The world\n${world.bible || world.line}`);
  sections.push(
    `## Current episode\nEpisode ${ctx.episode.number}${ctx.episode.title ? ` — ${ctx.episode.title}` : ''}.` +
    `${ctx.episode.location ? ` Location: ${ctx.episode.location}.` : ''}`
  );

  sections.push(`## You\n${characterSheet(character, characters)}`);

  if (others.length > 0) {
    sections.push(
      `## Others you may address or react to\n` +
      others.map((c) => briefSheet(c)).join('\n')
    );
  }

  if (ctx.continuity.length > 0) {
    sections.push(
      `## Continuity — facts you may know if you could plausibly know them\n` +
      ctx.continuity.map((f) => `- ${f.text}`).join('\n')
    );
  }

  sections.push(
    `## How you respond\n` +
    `- Speak as ${character.name}. Prefer one or two spoken lines in your natural voice.\n` +
    `- Output ONLY your dialogue (and optionally one short physical beat of your own). No narration of the room, weather, or other people.\n` +
    `- Do NOT prefix with your name. Do NOT write other speakers.\n` +
    `- Honour behaviour anchors and MUST NOT KNOW. Never soften yourself to please the player.\n` +
    (character.speechStyle ? `- Voice guide: ${character.speechStyle}\n` : '') +
    (character.exampleLines.length > 0
      ? `- Example rhythm (never reuse verbatim):\n${character.exampleLines.map((l) => `  "${l}"`).join('\n')}\n`
      : '') +
    `- Stay in ${ai.tense} tense for any physical beat; spoken words are in your voice as said aloud.`
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

/** Rough char budget for history packing (≈4 chars per token). */
export const HISTORY_CHAR_BUDGET = 48000;

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

function turnToChatContent(t: Turn, characters: Character[]): { role: 'user' | 'assistant'; content: string } {
  if (t.role === 'user') {
    return {
      role: 'user',
      content: t.mode ? MODE_PREFIX[t.mode](t.text) : t.text
    };
  }
  if (t.role === 'character') {
    const name = characters.find((c) => c.id === t.characterId)?.name ?? 'Someone';
    const line = t.text.replace(/^["“]|["”]$/g, '').trim();
    return { role: 'assistant', content: `${name}: "${line}"` };
  }
  return { role: 'assistant', content: t.text };
}

function packTurns(turns: Turn[]): Turn[] {
  let used = 0;
  const reversed = [...turns].reverse();
  const kept: Turn[] = [];
  for (const t of reversed) {
    used += t.text.length;
    if (used > HISTORY_CHAR_BUDGET && kept.length > 4) break;
    kept.push(t);
  }
  kept.reverse();
  return kept;
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
  characters: Character[] = []
): ChatMessage[] {
  const kept = packTurns(turns);
  const messages: ChatMessage[] = kept.map((t) => turnToChatContent(t, characters));

  const userContent = `${MODE_PREFIX[mode](input)}\n\n(${LENGTH_SPEC[length].instruction})`;
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

/** History + a narration-beat instruction (no full-length LENGTH_SPEC). */
export function buildNarrationBeatMessages(
  turns: Turn[],
  characters: Character[],
  brief: string,
  length: TurnLength
): ChatMessage[] {
  const kept = packTurns(turns);
  const messages: ChatMessage[] = kept.map((t) => turnToChatContent(t, characters));
  const sizeHint =
    length === 'beat' ? 'Keep this narration slice short (about 40–100 words).'
    : length === 'scene' ? 'This narration slice: about 80–180 words.'
    : 'This narration slice: about 120–250 words.';
  const userContent =
    `(Narration only — no spoken dialogue, no CharacterName: "…" lines.)\n` +
    `Beat brief: ${brief}\n\n${sizeHint}`;
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

/** History + a character-speak instruction. */
export function buildCharacterSpeakMessages(
  turns: Turn[],
  characters: Character[],
  speaking: Character,
  brief: string
): ChatMessage[] {
  const kept = packTurns(turns);
  const messages: ChatMessage[] = kept.map((t) => turnToChatContent(t, characters));
  const userContent =
    `(You are ${speaking.name}. Respond now in character.)\n` +
    `Intent for this line: ${brief}\n\n` +
    `Speak as yourself — one or two lines of dialogue. Optional: one short physical beat of your own. No other speakers.`;
  return mergeMessages([...messages, { role: 'user', content: userContent }]);
}

export type DirectorBeat =
  | { type: 'narration'; brief: string }
  | { type: 'speak'; characterId: string; brief: string };

export function directorSystemPrompt(): string {
  return (
    'You are the scene director for an interactive story. ' +
    'Plan cast changes and an ordered list of beats. ' +
    'Respond with JSON only: ' +
    '{"castDelta":{"enter":["<characterId>",...],"leave":["<characterId>",...]},' +
    '"beats":[{"type":"narration","brief":"..."}|{"type":"speak","characterId":"<id>","brief":"..."}]}' +
    '\n' +
    'castDelta.enter: NPCs who arrive or join this beat (from the off-scene list). ' +
    'castDelta.leave: NPCs who exit and should leave the scene. Use empty arrays when unchanged. ' +
    'After applying enter/leave, speak characterIds must be in the resulting in-scene cast (never the player). ' +
    'Narration briefs describe atmosphere or physical action — never finished dialogue. ' +
    'Speak briefs are intent only (tone/goal), never the finished line. ' +
    'Not everyone must speak. Typical: 1–3 narration beats and 1–4 speak beats. ' +
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
  const castList = inScene.length > 0
    ? inScene.map((c) => `- ${c.id} · ${c.name}${c.role ? ` (${c.role})` : ''}`).join('\n')
    : '(no NPCs in scene yet)';
  const offList = offScene.length > 0
    ? offScene.map((c) => `- ${c.id} · ${c.name}${c.role ? ` (${c.role})` : ''}`).join('\n')
    : '(none)';

  const recent = packTurns(ctx.turns).slice(-8);
  const transcript = recent.map((t) => {
    if (t.role === 'user') return `[player ${t.mode ?? 'turn'}]: ${t.text}`;
    if (t.role === 'character') {
      const name = ctx.characters.find((c) => c.id === t.characterId)?.name ?? 'NPC';
      return `[${name}]: ${t.text}`;
    }
    return `[narrator]: ${t.text}`;
  }).join('\n\n');

  return (
    `World: ${ctx.world.title}\n` +
    `Episode ${ctx.episode.number}${ctx.episode.location ? ` @ ${ctx.episode.location}` : ''}\n\n` +
    `In-scene cast:\n${castList}\n\n` +
    `Off-scene cast (may enter via castDelta.enter):\n${offList}\n\n` +
    `Latest player move: ${MODE_PREFIX[mode](input)}\n\n` +
    `Recent transcript:\n${transcript || '(episode just opened)'}\n\n` +
    `Plan castDelta and beats as JSON.`
  );
}
