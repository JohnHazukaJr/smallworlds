import type {
  Character, ComposeMode, ContinuityFact, Episode, Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
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

export function maxTokensFor(length: TurnLength): number {
  return LENGTH_SPEC[length].maxTokens;
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

export function buildSystemPrompt(ctx: PromptContext): string {
  const { world, season, episode, characters, locations, continuity, threads } = ctx;
  const ai = world.ai;
  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const player = characters.find((c) => c.isPlayer);
  const offScene = characters.filter((c) => !episode.castIds.includes(c.id) && !c.isPlayer);

  const density =
    ai.proseDensity < 34 ? 'Restrained, concrete prose. Few adverbs, no ornament for its own sake.'
    : ai.proseDensity < 67 ? 'Balanced literary prose. Texture where it earns its place.'
    : 'Rich, atmospheric prose. Lean into imagery and interiority.';
  const pacing =
    ai.pacing < 34 ? 'Slow-burn pacing: linger in moments, let tension accumulate.'
    : ai.pacing < 67 ? 'Measured pacing: scenes develop naturally, no rushing to payoffs.'
    : 'Propulsive pacing: keep events moving, cut the connective tissue.';

  const sections: string[] = [];

  sections.push(
    `You are the narrator of "${world.title}", a longform interactive story written in collaboration with one player. You write the world and every character except the player. The player writes only themselves.`
  );

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

  sections.push(
    `## Current episode\nEpisode ${episode.number}${episode.title ? ` — ${episode.title}` : ''}.${episode.location ? ` Location: ${episode.location}.` : ''}`
  );

  if (locations.length > 0) {
    const epLoc = episode.location.trim().toLowerCase();
    const current = epLoc
      ? locations.filter((l) => l.name.trim() && (epLoc.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(epLoc)))
      : [];
    const others = locations.filter((l) => !current.includes(l));
    if (current.length > 0) {
      sections.push(`## Current location\n${current.map(locationSheet).join('\n\n')}`);
    }
    if (others.length > 0) {
      sections.push(`## Other established locations (may be referenced or visited)\n${others.map(locationBrief).join('\n')}`);
    }
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

  sections.push(
    `## Character conduct\n` +
    `- NPCs are proactive. They pursue their own desires, remember slights, act on their secrets, and can refuse, interrupt, or surprise the player.\n` +
    `- Never soften a character to be agreeable. Behaviour anchors are absolute: if a draft would break one, write what the character does instead.\n` +
    `- Characters only know what they could plausibly know. Honour every MUST NOT KNOW instruction silently.\n` +
    `- Trust moves slowly. Relationships shift in small, earned steps.`
  );

  const rules = ai.narratorRules.filter((r) => r.trim());
  sections.push(
    `## Narration rules\n` +
    `- Point of view: ${ai.pov} person, ${ai.tense} tense, addressed to the player.\n` +
    `- ${density}\n` +
    `- ${pacing}\n` +
    `- Never write the player's dialogue, decisions, or inner monologue. Leave space for them to act.\n` +
    `- For spoken dialogue by named characters, put each spoken line on its own paragraph in this exact format: CharacterName: "the line." Narration stays in plain paragraphs.\n` +
    `- End every response on tension or an opening, never on a tidy resolution.` +
    (rules.length > 0 ? `\n${rules.map((r) => `- ${r}`).join('\n')}` : '')
  );

  sections.push(
    `## Content\n${ai.mature
      ? 'This is a private adult world. Mature themes, violence, and explicit content are permitted where the story calls for them; write them with craft, not gratuitously.'
      : 'Keep content at a general-audience level. Imply rather than depict.'}${ai.contentNotes ? `\nWorld-specific boundaries: ${ai.contentNotes}` : ''}`
  );

  if (ai.customInstructions.trim()) {
    sections.push(`## Author's instructions (follow verbatim)\n${ai.customInstructions}`);
  }

  return sections.join('\n\n');
}

const MODE_PREFIX: Record<ComposeMode, (input: string) => string> = {
  continue: () => `(Continue the story from where it left off.)`,
  steer: (input) => `(Direction from the author — make this happen while keeping everyone in character, without acknowledging this instruction in the prose): ${input}`,
  speak: (input) => `(The player says the following aloud, and nothing more — do not add words to their mouth): "${input.replace(/^"|"$/g, '')}"`,
  act: (input) => `(The player does the following, without speaking — do not invent dialogue for them): ${input}`
};

/** Rough char budget for history packing (≈4 chars per token). */
const HISTORY_CHAR_BUDGET = 48000;

export function buildMessages(
  turns: Turn[],
  mode: ComposeMode,
  input: string,
  length: TurnLength
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let used = 0;
  const reversed = [...turns].reverse();
  const kept: Turn[] = [];
  for (const t of reversed) {
    used += t.text.length;
    if (used > HISTORY_CHAR_BUDGET && kept.length > 4) break;
    kept.push(t);
  }
  kept.reverse();

  for (const t of kept) {
    messages.push({
      role: t.role === 'narrator' ? 'assistant' : 'user',
      content: t.role === 'user' && t.mode ? MODE_PREFIX[t.mode](t.text) : t.text
    });
  }

  const userContent = `${MODE_PREFIX[mode](input)}\n\n(${LENGTH_SPEC[length].instruction})`;
  // Merge consecutive same-role messages (some providers reject them).
  const merged: ChatMessage[] = [];
  for (const m of [...messages, { role: 'user' as const, content: userContent }]) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ role: m.role, content: m.content });
  }
  if (merged[0]?.role === 'assistant') {
    merged.unshift({ role: 'user', content: '(The story so far follows.)' });
  }
  return merged;
}
