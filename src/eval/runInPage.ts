/**
 * Browser side of the NPC eval. scripts/eval-npc.mjs loads this through the
 * Vite dev server inside a fresh browser context, so every scene runs the real
 * writeTurn against a real IndexedDB, exactly as the Story screen would.
 *
 * Not imported by the app.
 */

import { db, uid } from '../db';
import { createWorld, emptyCharacter, emptyLocation } from '../worldOps';
import { useSettings } from '../store/settings';
import { writeTurn } from '../ai/engine';
import { streamChat } from '../ai/client';
import { extractJson } from '../ai/utilityCall';
import { composeOutgoingLine } from '../ai/composeLine';
import { beatsToProse, scenePiecesOf, validBeats } from '../ai/beatProtocol';
import type { SceneSpeaker } from '../ai/sceneReply';
import type { ComposeMode, EpisodeGuest, ProviderConfig, ProviderKind, Turn, TurnBeat } from '../types';
import { CAST, EVAL_WORLD, SCENARIOS, type EvalScenario } from './scenarios';
import { gradeReply, type EvalCheck, type EvalPiece } from './grade';
import { judgePrompt, parseVerdict, type JudgeVerdict } from './judge';

export interface EvalConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  proseModel: string;
  utilityModel: string;
  judgeModel: string;
  /** Skip the LLM judge (rule checks only). */
  noJudge?: boolean;
}

export interface EvalRunResult {
  scenarioId: string;
  ms: number;
  error?: string;
  pieces: EvalPiece[];
  checks: EvalCheck[];
  verdict?: JudgeVerdict;
  judgeError?: string;
  notices: string[];
}

const PROVIDER_ID = 'eval-provider';

function installProvider(cfg: EvalConfig): ProviderConfig {
  const provider: ProviderConfig = {
    id: PROVIDER_ID, kind: cfg.kind, label: 'Eval', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey
  };
  useSettings.setState({
    providers: [provider],
    proseModel: { providerId: PROVIDER_ID, model: cfg.proseModel },
    utilityModel: { providerId: PROVIDER_ID, model: cfg.utilityModel },
    imageModel: null
  });
  return provider;
}

interface Seeded {
  worldId: string;
  episodeId: string;
  playerId: string;
  /** Character or guest id → scenario key. The player maps to 'player'. */
  keyOf: Map<string, string>;
  idOf: Map<string, string>;
  speakers: SceneSpeaker[];
}

async function seedScene(scenario: EvalScenario): Promise<Seeded> {
  const world = await createWorld({
    title: EVAL_WORLD.title,
    line: EVAL_WORLD.line,
    bible: EVAL_WORLD.bible,
    premise: EVAL_WORLD.premise,
    // Keep background bookkeeping light; the eval grades the reply itself.
    ai: { liveUpdates: 'few' }
  });
  const episode = await db.episodes.where('worldId').equals(world.id).first();
  const player = await db.characters.where('worldId').equals(world.id).first();
  if (!episode || !player) throw new Error('createWorld did not make an episode and player');
  await db.characters.update(player.id, { name: EVAL_WORLD.player.name, summary: EVAL_WORLD.player.summary });

  const keyOf = new Map<string, string>([[player.id, 'player']]);
  const idOf = new Map<string, string>([['player', player.id]]);
  const now = Date.now() - 120_000;

  for (const p of CAST) {
    const here = scenario.present.includes(p.key);
    const c = emptyCharacter(world.id, {
      name: p.name, role: p.role, aliases: p.aliases ?? [], importance: p.importance, hue: p.hue,
      age: p.age, summary: p.summary, speechStyle: p.speechStyle, exampleLines: p.exampleLines,
      traits: p.traits, desires: p.desires, fears: p.fears,
      secrets: p.secrets ?? '', mustNotKnow: p.mustNotKnow ?? '', anchors: p.anchors ?? [],
      state: {
        goal: p.goal ?? '', emotion: p.emotion ?? '', condition: '',
        location: here ? EVAL_WORLD.place.name : 'elsewhere in Saltmere'
      },
      relationships: p.towardPlayer ? [{ targetId: player.id, ...p.towardPlayer }] : [],
      memories: (p.memories ?? []).map((m, i) => ({
        id: uid(), text: m.text, feeling: m.feeling, salience: m.salience, episodeId: episode.id, createdAt: now + i
      }))
    });
    await db.characters.add(c);
    keyOf.set(c.id, p.key);
    idOf.set(p.key, c.id);
  }

  const guests: EpisodeGuest[] = (scenario.guests ?? []).map((g) => {
    const id = uid();
    keyOf.set(id, g.key);
    idOf.set(g.key, id);
    return { id, name: g.name, brief: g.brief, ...(g.voice ? { voice: g.voice } : {}) };
  });

  const place = emptyLocation(world.id, {
    name: EVAL_WORLD.place.name, summary: EVAL_WORLD.place.summary, atmosphere: EVAL_WORLD.place.atmosphere
  });
  await db.locations.add(place);
  await db.episodes.update(episode.id, {
    castIds: [player.id, ...scenario.present.map((k) => idOf.get(k)!).filter(Boolean)],
    locationId: place.id,
    location: place.name,
    guests,
    activeGuestIds: guests.map((g) => g.id),
    // Seeded currents, marked drafted so the post-turn pass does not redraft them.
    ...(scenario.currents?.length
      ? {
        plotTargets: scenario.currents.map((text) => ({ id: uid(), text, status: 'pending' as const, source: 'outline' as const })),
        currentsAt: Date.now()
      }
      : {})
  });

  // Earlier lines in the chapter.
  const base = { episodeId: episode.id, worldId: world.id };
  const guestKeys = new Set((scenario.guests ?? []).map((g) => g.key));
  const turns: Turn[] = scenario.history.map((line, i) => {
    const createdAt = now + 100 + i;
    if (line.who === 'player') {
      const { mode } = composeOutgoingLine({ direct: false, asCharacterId: null, sceneHasOthers: true, tone: null, text: line.text });
      return { ...base, id: uid(), role: 'user', mode, weight: 'matters', text: line.text, createdAt };
    }
    if (line.who === 'narrator') {
      return { ...base, id: uid(), role: 'narrator', mode: null, text: line.text, createdAt };
    }
    const speakerId = idOf.get(line.who);
    const name = CAST.find((p) => p.key === line.who)?.name ?? scenario.guests?.find((g) => g.key === line.who)?.name;
    if (!speakerId || !name) throw new Error(`history line from unknown "${line.who}"`);
    const beats: TurnBeat[] = [{
      role: 'character', text: line.text, speakerId, kind: guestKeys.has(line.who) ? 'guest' : 'cast', name
    }];
    return { ...base, id: uid(), role: 'narrator', mode: null, text: beatsToProse(beats), beats, createdAt };
  });
  if (turns.length) await db.turns.bulkAdd(turns);

  // Everyone who could be credited, present or not, so a stray voice is caught.
  const speakers: SceneSpeaker[] = [
    ...CAST.map((p) => ({
      id: idOf.get(p.key)!, name: p.name, kind: 'cast' as const,
      ...(p.aliases?.length ? { aliases: p.aliases } : {}), role: p.role
    })),
    ...guests.map((g) => ({ id: g.id, name: g.name, kind: 'guest' as const }))
  ];

  return { worldId: world.id, episodeId: episode.id, playerId: player.id, keyOf, idOf, speakers };
}

function nameFor(key: string | undefined, scenario: EvalScenario): string | undefined {
  if (!key) return undefined;
  if (key === 'player') return EVAL_WORLD.player.name;
  return CAST.find((p) => p.key === key)?.name ?? scenario.guests?.find((g) => g.key === key)?.name;
}

function piecesOf(turns: Turn[], seeded: Seeded, scenario: EvalScenario): EvalPiece[] {
  return turns.flatMap((turn): EvalPiece[] => {
    if (turn.role === 'character' && !validBeats(turn)) {
      const key = seeded.keyOf.get(turn.characterId ?? turn.guestId ?? '');
      return [{ role: 'character', text: turn.text, who: key, name: nameFor(key, scenario) }];
    }
    return scenePiecesOf(turn, seeded.speakers).map((p) => {
      const key = p.speakerId ? seeded.keyOf.get(p.speakerId) : undefined;
      return { role: p.role, text: p.text, ...(key ? { who: key, name: nameFor(key, scenario) } : {}) };
    });
  });
}

function moveFor(scenario: EvalScenario, seeded: Seeded): { mode: ComposeMode; input: string } & Record<string, unknown> {
  const { move } = scenario;
  const to = move.to ? seeded.idOf.get(move.to) : undefined;
  const isGuest = !!move.to && !!scenario.guests?.some((g) => g.key === move.to);
  const address = to ? (isGuest ? { toGuestId: to } : { toCharacterId: to }) : {};
  if (move.continue) return { mode: 'continue', input: '' };
  if (move.direct) return { mode: 'steer', input: move.input.trim() };
  const out = composeOutgoingLine({ direct: false, asCharacterId: null, sceneHasOthers: true, tone: null, text: move.input });
  return { mode: out.mode, input: out.text, ...address };
}

async function judge(cfg: EvalConfig, provider: ProviderConfig, scenario: EvalScenario, pieces: EvalPiece[]): Promise<JudgeVerdict> {
  const { system, user } = judgePrompt(scenario, pieces);
  const res = await streamChat({
    provider,
    model: cfg.judgeModel,
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1500,
    temperature: 0,
    job: 'utility',
    thinking: false
  });
  return parseVerdict(extractJson<unknown>(res.text));
}

/** Seed one scene, play its move, grade the reply. Never throws: errors land in the result. */
export async function runScenario(id: string, cfg: EvalConfig): Promise<EvalRunResult> {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) return { scenarioId: id, ms: 0, error: `no scenario "${id}"`, pieces: [], checks: [], notices: [] };
  const provider = installProvider(cfg);
  const notices: string[] = [];
  const started = performance.now();
  try {
    const seeded = await seedScene(scenario);
    const world = await db.worlds.get(seeded.worldId);
    const episode = await db.episodes.get(seeded.episodeId);
    const season = world?.activeSeasonId ? await db.seasons.get(world.activeSeasonId) : undefined;
    if (!world || !episode || !season) throw new Error('seeded world did not load');

    const before = Date.now();
    await writeTurn({
      world, season, episode,
      length: scenario.move.length ?? 'beat',
      weight: 'matters',
      ...moveFor(scenario, seeded),
      onDelta: () => {},
      onNotice: (m) => notices.push(m)
    } as Parameters<typeof writeTurn>[0]);
    const ms = Math.round(performance.now() - started);

    const fresh = (await db.turns.where('episodeId').equals(seeded.episodeId).toArray())
      .filter((t) => t.createdAt >= before && t.role !== 'user')
      .sort((a, b) => a.createdAt - b.createdAt);
    const pieces = piecesOf(fresh, seeded, scenario);
    const checks = gradeReply(scenario, pieces, { playerName: EVAL_WORLD.player.name });

    const result: EvalRunResult = { scenarioId: id, ms, pieces, checks, notices };
    if (!cfg.noJudge) {
      try {
        result.verdict = await judge(cfg, provider, scenario, pieces);
      } catch (e) {
        result.judgeError = String((e as Error)?.message ?? e);
      }
    }
    return result;
  } catch (e) {
    return {
      scenarioId: id,
      ms: Math.round(performance.now() - started),
      error: String((e as Error)?.message ?? e),
      pieces: [],
      checks: [],
      notices
    };
  }
}

export function scenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}
