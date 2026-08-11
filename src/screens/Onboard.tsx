import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useRef, useState } from 'react';
import {
  composeWorldBriefFromInterview, draftColdOpenNarration, fleshOutCharacter, fleshOutLocation,
  fleshOutNarratorRules, fleshOutPremise, fleshOutRelationships, fleshOutWorldEverything,
  fleshOutWorldLore, interviewWorldIdea, seedOpeningMemory, type WorldInterviewQuestion
} from '../ai/engine';
import { db, deleteWorld, safeWrite } from '../db';
import { formatUserError } from '../errors';
import { normalizeRelationships } from '../relationships';
import { useApp } from '../store/app';
import { useSettings } from '../store/settings';
import type { Character, Location, Season, World, WorldAISettings } from '../types';
import { Bar, Chip, ErrorNote, Field, Spinner, Toggle, useVw } from '../ui/bits';
import { fileToPortraitImage } from '../ui/image';
import { avatarStyle, STRIPE } from '../ui/theme';
import {
  characterPortraits, createWorld, DEFAULT_AI, emptyCharacter, emptyLocation,
  evaluateWorldWriteReady, MAX_CHARACTER_PORTRAITS, portraitsPatch, worldWriteReady
} from '../worldOps';

const SHAPES = [
  { label: 'One long story I keep returning to', line: 'Seasons, episodes, a cast that ages and remembers.' },
  { label: 'A world I want to wander', line: 'Loose scenes, many characters, no fixed plot.' },
  { label: 'A single character I want to know', line: 'One person, deeply modelled, many conversations.' },
  { label: 'I want to see what happens', line: 'Start blank. Decide later.' }
];

/** Cast/place counts for bulk flesh-out, tuned by story shape. */
function rosterTargets(shapeIndex: number): { characters: number; locations: number } {
  if (shapeIndex === 1) return { characters: 5, locations: 4 }; // wander
  if (shapeIndex === 2) return { characters: 3, locations: 2 }; // intimate
  return { characters: 4, locations: 3 };
}

const SEED_KINDS = [
  { label: 'A place', line: 'Somewhere with its own weather and its own rules.' },
  { label: 'A rule', line: 'Something in this world cannot be undone.' },
  { label: 'A pressure', line: 'Something is coming and everyone knows it.' },
  { label: 'Notes I already have', line: 'Paste a paragraph of notes — it gets read into a world.' }
];

const LANES = [
  {
    label: 'From an idea',
    line: 'Describe the roleplay. AI asks a few questions, builds the whole world, then you review and perfect.'
  },
  {
    label: 'Step by step',
    line: 'Shape, seed, voice, you, cast, place, memory — fill each yourself, with AI help when you want it.'
  }
];

const PROMISES = [
  { t: 'Idea → interview → world', d: 'Paste a roleplay idea; AI asks clarifying questions, then drafts bible, premise, cast, places, memory, and a cold open — you review before Enter.' },
  { t: 'Bible, premise, cast, place', d: 'Onboard builds a write-ready world: lore, season pressure, voiced NPCs with anchors and live state, and a location with hard rules.' },
  { t: 'Opening memory', d: 'Seed continuity facts and open threads so the first scene already has pressure to lean on.' },
  { t: 'Characters that hold a line', d: 'Behaviour anchors ride along in every Speak turn. They can refuse you, and they will.' },
  { t: 'Direct after you enter', d: 'In Story: Direct edits cast and place, pins continuity, and sets Aim targets. Wrap files memory between episodes.' },
  { t: 'Speak with delivery', d: 'On Speak or Act, pick a tone chip so the scene hears how you mean it. Reply size is Short / Medium / Long.' },
  { t: 'Your key, any model', d: 'OpenRouter, Anthropic, Gemini, Kimi, local models — swap engines per world, any time.' },
  { t: 'Private by design', d: 'Everything lives on this device. Nothing is sent anywhere but the AI endpoint you name.' }
];

/** A not-yet-persisted world shape, just enough context for AI drafting before the world exists in the DB. */
function previewWorld(title: string, seed: string, ai: WorldAISettings): World {
  return {
    id: '', title: title || 'Untitled world', line: seed.slice(0, 140), bible: seed,
    hue: 0, visibility: 'private', ai, proseModel: null, utilityModel: null,
    activeSeasonId: null, calendar: { currentDay: 1, system: '', weekdays: undefined, dayOneWeekday: 0, episodeAdvanceDays: 1 }, createdAt: 0, updatedAt: 0
  };
}

/** A not-yet-persisted season shape, just enough context for premise flesh-out before the season is saved. */
function previewSeason(premise: string): Season {
  return { id: '', worldId: '', number: 1, title: '', premise, timeGap: null, bible: null, status: 'active', createdAt: 0 };
}

function shapeTag(shapeIndex: number): string {
  return `Shape: ${SHAPES[shapeIndex].label} — ${SHAPES[shapeIndex].line}`;
}

export function Onboard() {
  const vw = useVw();
  const narrow = vw < 1000;
  const { go, openWorld, goCast, goLocations } = useApp();
  const matureDefault = useSettings((s) => s.matureDefault);
  const providers = useSettings((s) => s.providers);

  const [step, setStep] = useState(0);
  const [lane, setLane] = useState(0); // 0 = From an idea, 1 = Step by step
  const [shape, setShape] = useState(0);
  const [seedKind, setSeedKind] = useState(0);
  const [seed, setSeed] = useState('');
  const [idea, setIdea] = useState('');
  const [interviewQs, setInterviewQs] = useState<WorldInterviewQuestion[]>([]);
  const [interviewAnswers, setInterviewAnswers] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [ai, setAi] = useState<WorldAISettings>(() => ({ ...DEFAULT_AI, mature: matureDefault }));
  const [castName, setCastName] = useState('');
  const [castNotes, setCastNotes] = useState('');
  const [expandedCastId, setExpandedCastId] = useState<string | null>(null);
  const [placeName, setPlaceName] = useState('');
  const [placeNotes, setPlaceNotes] = useState('');
  const [expandedPlaceId, setExpandedPlaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [gateNote, setGateNote] = useState('');
  const [reviewBanner, setReviewBanner] = useState('');

  // The world is created as soon as we leave step 1 — everything after that is a real, live record.
  const [worldId, setWorldId] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);

  const hasAI = providers.length > 0;
  const ideaLane = lane === 0;

  const characters = useLiveQuery(
    async () => (worldId ? db.characters.where('worldId').equals(worldId).toArray() : []),
    [worldId]
  ) ?? [];
  const player = characters.find((c) => c.isPlayer);
  const npcCast = characters.filter((c) => !c.isPlayer);
  const places = useLiveQuery(
    async () => (worldId ? db.locations.where('worldId').equals(worldId).toArray() : []),
    [worldId]
  ) ?? [];
  const episode = useLiveQuery(
    async () => (worldId ? db.episodes.where('worldId').equals(worldId).first() : undefined),
    [worldId]
  );
  const continuity = useLiveQuery(
    async () => (seasonId ? db.continuity.where('seasonId').equals(seasonId).toArray() : []),
    [seasonId]
  ) ?? [];
  const threads = useLiveQuery(
    async () => (seasonId
      ? db.threads.where('seasonId').equals(seasonId).filter((t) => t.status === 'open').toArray()
      : []),
    [seasonId]
  ) ?? [];
  const turnCount = useLiveQuery(
    async () => (episode ? db.turns.where('episodeId').equals(episode.id).count() : 0),
    [episode?.id]
  ) ?? 0;
  const season = useLiveQuery(
    async () => (seasonId ? db.seasons.get(seasonId) : undefined),
    [seasonId]
  );
  const worldRow = useLiveQuery(
    async () => (worldId ? db.worlds.get(worldId) : undefined),
    [worldId]
  );

  const ready = useMemo(
    () => evaluateWorldWriteReady({
      world: worldRow ?? (worldId ? previewWorld(title, seed, ai) : null),
      season: season ?? (seasonId ? previewSeason(premise) : null),
      episode,
      characters,
      locations: places,
      continuityCount: continuity.length
    }),
    [worldRow, worldId, title, seed, ai, season, seasonId, premise, episode, characters, places, continuity.length]
  );

  const patchAI = (p: Partial<WorldAISettings>) => {
    setAi((prev) => {
      const next = { ...prev, ...p };
      if (worldId) {
        void safeWrite(
          () => db.worlds.update(worldId, { ai: next, updatedAt: Date.now() }),
          setError
        );
      }
      return next;
    });
  };

  const setPremiseAndSave = (v: string) => {
    setPremise(v);
    if (seasonId) {
      void safeWrite(() => db.seasons.update(seasonId, { premise: v }), setError);
    }
  };

  /** Current world state (title/seed/ai + who's already in it) shaped for AI context, live or not. */
  const worldContext = (): World => {
    const base = previewWorld(title.trim(), seed.trim(), ai);
    const bits = [shapeTag(shape)];
    const castNames = npcCast.map((c) => c.name).filter(Boolean).join(', ');
    const placeNames = places.map((l) => l.name).filter(Boolean).join(', ');
    if (castNames) bits.push(`Cast already in this world: ${castNames}.`);
    if (placeNames) bits.push(`Locations already in this world: ${placeNames}.`);
    return { ...base, bible: `${base.bible}\n\n${bits.join(' ')}`.trim() };
  };

  const fleshOutSeed = async () => {
    setBusy('Fleshing out the world…');
    setError('');
    try {
      const result = await fleshOutWorldLore(worldContext());
      setTitle(result.title);
      setSeed(result.bible);
      if (worldId) {
        const patch: Partial<World> = {
          title: result.title, line: result.line, bible: result.bible, updatedAt: Date.now()
        };
        if (result.calendarSystem) {
          const w = await db.worlds.get(worldId);
          if (w && !(w.calendar?.system ?? '').trim()) {
            patch.calendar = { ...w.calendar!, system: result.calendarSystem };
          }
        }
        void safeWrite(() => db.worlds.update(worldId, patch), setError);
      }
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const fleshOutRules = async () => {
    setBusy('Fleshing out the rules…');
    setError('');
    try {
      const rules = await fleshOutNarratorRules(worldContext());
      patchAI({ narratorRules: rules });
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const fleshOutPremiseField = async () => {
    setBusy('Fleshing out the premise…');
    setError('');
    try {
      const result = await fleshOutPremise(worldContext(), previewSeason(premise));
      setPremiseAndSave(result);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const fleshPlayer = async () => {
    if (!worldId || !player) return;
    setBusy('Fleshing you…');
    setError('');
    try {
      const cast = await db.characters.where('worldId').equals(worldId).toArray();
      const sheet = await fleshOutCharacter(worldContext(), player, cast);
      await db.characters.update(player.id, { ...sheet, isPlayer: true, updatedAt: Date.now() });
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const patchPlayer = (p: Partial<Character>) => {
    if (!player) return;
    void safeWrite(
      () => db.characters.update(player.id, { ...p, isPlayer: true, updatedAt: Date.now() }),
      setError
    );
  };

  const addCastPlain = async () => {
    if (!worldId) return;
    const name = castName.trim();
    const notes = castNotes.trim();
    if (!name && !notes) return;
    const c = emptyCharacter(worldId, { name: name || notes.slice(0, 40), summary: notes });
    await db.characters.add(c);
    if (episode) await db.episodes.update(episode.id, { castIds: [...episode.castIds, c.id] });
    setCastName('');
    setCastNotes('');
    setExpandedCastId(c.id);
  };

  const addCastGenerate = async () => {
    if (!worldId) return;
    const name = castName.trim();
    const notes = castNotes.trim();
    if (!name && !notes) return;
    setBusy('Generating…');
    setError('');
    try {
      const draft = emptyCharacter(worldId, { name: name || notes.slice(0, 40), summary: notes });
      const existingCast = await db.characters.where('worldId').equals(worldId).toArray();
      const sheet = await fleshOutCharacter(worldContext(), draft, existingCast);
      const c: Character = { ...draft, ...sheet, updatedAt: Date.now() };
      await db.characters.add(c);
      if (episode) await db.episodes.update(episode.id, { castIds: [...episode.castIds, c.id] });
      setCastName('');
      setCastNotes('');
      setExpandedCastId(c.id);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const removeCastEntry = async (id: string) => {
    await db.characters.delete(id);
    if (episode) await db.episodes.update(episode.id, { castIds: episode.castIds.filter((cid) => cid !== id) });
  };

  const toggleSelfTag = async (id: string) => {
    const c = characters.find((x) => x.id === id);
    if (!c) return;
    const next = !c.selfTag;
    if (next) {
      const others = characters.filter((x) => x.id !== id && x.selfTag);
      await Promise.all(others.map((x) => db.characters.update(x.id, { selfTag: false, updatedAt: Date.now() })));
    }
    await db.characters.update(id, { selfTag: next, updatedAt: Date.now() });
  };

  const addPlacePlain = async () => {
    if (!worldId) return;
    const name = placeName.trim();
    const notes = placeNotes.trim();
    if (!name && !notes) return;
    const l = emptyLocation(worldId, { name: name || notes.slice(0, 40), summary: notes });
    await db.locations.add(l);
    if (episode && !episode.locationId && !episode.location && l.name) {
      await db.episodes.update(episode.id, { location: l.name, locationId: l.id });
    }
    setPlaceName('');
    setPlaceNotes('');
    setExpandedPlaceId(l.id);
  };

  const addPlaceGenerate = async () => {
    if (!worldId) return;
    const name = placeName.trim();
    const notes = placeNotes.trim();
    if (!name && !notes) return;
    setBusy('Generating…');
    setError('');
    try {
      const draft = emptyLocation(worldId, { name: name || notes.slice(0, 40), summary: notes });
      const sheet = await fleshOutLocation(worldContext(), draft);
      const l: Location = { ...draft, ...sheet, updatedAt: Date.now() };
      await db.locations.add(l);
      if (episode && !episode.locationId && !episode.location && l.name) {
        await db.episodes.update(episode.id, { location: l.name, locationId: l.id });
      }
      setPlaceName('');
      setPlaceNotes('');
      setExpandedPlaceId(l.id);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const removePlaceEntry = async (id: string) => {
    await db.locations.delete(id);
    if (episode?.locationId === id) {
      await db.episodes.update(episode.id, { location: '', locationId: null });
    }
  };

  const setOpeningPlace = async (id: string) => {
    if (!episode) return;
    const loc = places.find((l) => l.id === id);
    if (!loc) return;
    const patch: Partial<typeof episode> = { location: loc.name, locationId: loc.id };
    if (!(episode.title ?? '').trim() && loc.name.trim()) patch.title = loc.name.trim();
    await db.episodes.update(episode.id, patch);
  };

  const openFullEditor = (screen: 'cast' | 'locations') => {
    if (!worldId) return;
    useApp.setState({ currentWorldId: worldId });
    if (screen === 'cast') {
      const focus = expandedCastId ?? npcCast[0]?.id ?? null;
      goCast(focus);
    } else {
      const focus = expandedPlaceId ?? places[0]?.id ?? null;
      goLocations(focus);
    }
  };

  const runSeedMemory = async () => {
    if (!worldId || !seasonId || !episode || !hasAI) return;
    setBusy('Seeding opening memory…');
    setError('');
    try {
      const world = await db.worlds.get(worldId);
      const s = await db.seasons.get(seasonId);
      if (!world || !s) throw new Error('World not found.');
      const cast = await db.characters.where('worldId').equals(worldId).toArray();
      await seedOpeningMemory(world, s, episode, cast);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const runColdOpen = async () => {
    if (!worldId || !seasonId || !episode || !hasAI) return;
    setBusy('Drafting cold open…');
    setError('');
    try {
      const world = await db.worlds.get(worldId);
      const s = await db.seasons.get(seasonId);
      if (!world || !s) throw new Error('World not found.');
      const text = await draftColdOpenNarration(world, s, episode);
      if (!text) setGateNote('Episode already has turns — cold open skipped.');
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const runRelinkRelationships = async () => {
    if (!worldId || !hasAI) return;
    setBusy('Linking relationships…');
    setError('');
    try {
      const world = await db.worlds.get(worldId);
      if (!world) throw new Error('World not found.');
      const cast = await db.characters.where('worldId').equals(worldId).toArray();
      const ids = cast.map((c) => c.id);
      for (const npc of cast.filter((c) => !c.isPlayer)) {
        const next = await fleshOutRelationships(world, npc, cast);
        await db.characters.update(npc.id, {
          relationships: normalizeRelationships(next, ids, npc.id),
          updatedAt: Date.now()
        });
      }
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const jumpForMissing = (msg: string) => {
    const m = msg.toLowerCase();
    if (m.includes('who you are') || m.includes('player')) setStep(3);
    else if (m.includes('npc') || m.includes('cast') || m.includes('voice')) setStep(4);
    else if (m.includes('location') || m.includes('place') || m.includes('rule')) setStep(5);
    else if (m.includes('continuity') || m.includes('memory') || m.includes('premise') || m.includes('bible') || m.includes('title') || m.includes('logline')) {
      if (m.includes('continuity') || m.includes('memory')) setStep(6);
      else if (m.includes('premise')) setStep(2);
      else setStep(1);
    }
  };

  const checklistPanel = (compact: boolean) => (
    <div className="glass" style={{ padding: compact ? '12px 14px' : '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: compact ? 12.5 : 13.5, fontWeight: 600, color: '#f0eee9' }}>
        {compact ? 'Write-ready' : 'Write-ready checklist'}
      </div>
      {ready.ok ? (
        <div style={{ fontSize: 12.5, color: 'oklch(0.78 0.08 145)' }}>Ready to enter Story.</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.65)' }}>
          {ready.missing.map((m) => (
            <li key={m}>
              <button
                type="button"
                className="btn-quiet"
                style={{ fontSize: 12.5, padding: 0, textAlign: 'left', color: 'rgba(236,234,230,0.75)' }}
                onClick={() => jumpForMissing(m)}
              >
                {m}
              </button>
            </li>
          ))}
        </ul>
      )}
      {ready.warnings.map((w) => (
        <button
          key={w}
          type="button"
          className="btn-quiet"
          style={{ fontSize: 12, padding: 0, textAlign: 'left', color: 'oklch(0.78 0.06 195)' }}
          onClick={() => jumpForMissing(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );

  const relationshipLines = useMemo(() => {
    const byId = new Map(characters.map((c) => [c.id, c]));
    const lines: { key: string; text: string }[] = [];
    for (const c of npcCast) {
      for (const r of c.relationships) {
        const target = byId.get(r.targetId);
        if (!target) continue;
        const note = r.note.trim() ? ` — ${r.note.trim()}` : '';
        lines.push({
          key: `${c.id}-${r.targetId}`,
          text: `${c.name || 'unnamed'} → ${r.kind || 'linked'} → ${target.name || 'unnamed'}${note}`
        });
      }
    }
    return lines.slice(0, 12);
  }, [characters, npcCast]);

  const finish = async () => {
    setError('');
    setGateNote('');
    if (!worldId) {
      setError('Give the world at least one true thing (or a title) first.');
      return;
    }
    const check = await worldWriteReady(worldId);
    if (!check.ok) {
      setGateNote(check.missing.join(' · '));
      setError('This world is not write-ready yet. Fix the checklist below.');
      return;
    }
    if (check.warnings.length) setGateNote(check.warnings.join(' · '));
    openWorld(worldId);
  };

  const discardAndLeave = async () => {
    if (worldId) {
      const ok = window.confirm(
        'Discard this unfinished world? It will be deleted. Cancel to keep editing.'
      );
      if (!ok) return;
      setBusy('Discarding…');
      try {
        await deleteWorld(worldId);
      } catch (e) {
        setError(formatUserError(e));
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    go('library');
  };

  /**
   * Bulk flesh-out after the world exists. Never opens Story — jumps to You
   * so the user can review generated people (places + memory still ahead).
   */
  const runFleshEverything = async (opts?: { jumpToReview?: boolean }) => {
    if (!worldId || !seasonId || !episode || !hasAI) return;
    setError('');
    setBusy('Fleshing lore…');
    try {
      const world = await db.worlds.get(worldId);
      const s = await db.seasons.get(seasonId);
      if (!world || !s) throw new Error('World not found — finish giving it one true thing first.');
      // Persist shape intent once if custom instructions are empty.
      let liveWorld = world;
      if (!(world.ai.customInstructions ?? '').trim()) {
        const tagged = { ...world.ai, customInstructions: shapeTag(shape) };
        await db.worlds.update(world.id, { ai: tagged, updatedAt: Date.now() });
        setAi(tagged);
        liveWorld = { ...world, ai: tagged };
      }
      const targets = rosterTargets(shape);
      await fleshOutWorldEverything(liveWorld, s, episode, {
        shape: shapeTag(shape),
        targetCharacters: targets.characters,
        targetLocations: targets.locations,
        seedColdOpen: true,
        onProgress: setBusy
      });
      const refreshed = await db.worlds.get(worldId);
      if (refreshed) {
        setTitle(refreshed.title);
        setSeed(refreshed.bible);
        setAi(refreshed.ai);
      }
      const refreshedSeason = await db.seasons.get(seasonId);
      if (refreshedSeason) setPremise(refreshedSeason.premise);
      setReviewBanner(
        'Generated from your idea — review You, Cast, Place, and Memory. Edit anything, then Enter when the checklist is green.'
      );
      setStep(opts?.jumpToReview === false ? step : 3);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  /** Idea lane: create world from idea text and load clarifying questions. */
  const startIdeaInterview = async () => {
    const text = idea.trim();
    if (!text) {
      setError('Describe the roleplay you want first.');
      return false;
    }
    if (!hasAI) {
      setError('Add an AI provider in Settings to use From an idea — or switch to Step by step.');
      return false;
    }
    setError('');
    setBusy('Building the world…');
    try {
      let wid = worldId;
      let sid = seasonId;
      if (!wid) {
        const custom = shapeTag(shape);
        const world = await createWorld({
          title: title.trim(),
          line: text.slice(0, 140),
          bible: text,
          premise: '',
          ai: { ...ai, customInstructions: custom }
        });
        wid = world.id;
        sid = world.activeSeasonId;
        setWorldId(world.id);
        setSeasonId(world.activeSeasonId);
        setAi(world.ai);
        setSeed(text);
        setTitle(world.title);
      } else {
        await db.worlds.update(wid, {
          line: text.slice(0, 140),
          bible: text,
          updatedAt: Date.now()
        });
        setSeed(text);
      }
      setBusy('Asking clarifying questions…');
      const qs = await interviewWorldIdea(text, shapeTag(shape));
      if (qs.length === 0) {
        // Fallback questions if the model returns nothing
        setInterviewQs([
          { id: 'who', question: 'Who are you in this story, and what do you want as it opens?', hint: 'e.g. A smuggler under a false name, trying to keep the ledger quiet.' },
          { id: 'pressure', question: 'What pressure will not wait — the opening conflict?', hint: 'e.g. Someone is asking about your handwriting.' },
          { id: 'cast', question: 'Who shares the opening scene with you?', hint: 'e.g. The registrar who saw the false signature.' },
          { id: 'place', question: 'Where does episode 1 open, and what rule does that place enforce?', hint: 'e.g. The long room above customs — nothing spoken there is public unless carried downstairs.' },
          { id: 'walls', question: 'What must the narrator never do, and what content is off-limits?', hint: 'e.g. Never kill a named character off-page. No sexual content involving minors.' }
        ]);
      } else {
        setInterviewQs(qs);
      }
      setInterviewAnswers({});
      return true;
    } catch (e) {
      setError(formatUserError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** Idea lane: merge answers into the world, then flesh everything and jump to review. */
  const generateFromInterview = async () => {
    if (!hasAI) {
      setError('Add an AI provider in Settings to generate from an idea.');
      return false;
    }
    const text = idea.trim() || seed.trim();
    if (!text) {
      setError('Describe the roleplay you want first.');
      return false;
    }
    setError('');
    setBusy('Composing world brief…');
    try {
      const brief = await composeWorldBriefFromInterview(
        text,
        shapeTag(shape),
        interviewQs.map((q) => ({
          question: q.question,
          answer: interviewAnswers[q.id] ?? ''
        }))
      );

      let wid = worldId;
      let sid = seasonId;
      const nextAi: WorldAISettings = {
        ...ai,
        contentNotes: brief.contentNotes || ai.contentNotes,
        narratorRules: brief.narratorRules.length ? brief.narratorRules : ai.narratorRules,
        mature: brief.mature,
        customInstructions: brief.customInstructions || shapeTag(shape)
      };

      if (!wid) {
        const world = await createWorld({
          title: brief.title,
          line: brief.line,
          bible: brief.bible,
          premise: brief.premise,
          ai: nextAi
        });
        wid = world.id;
        sid = world.activeSeasonId;
        setWorldId(world.id);
        setSeasonId(world.activeSeasonId);
      } else {
        await db.worlds.update(wid, {
          title: brief.title,
          line: brief.line,
          bible: brief.bible,
          ai: nextAi,
          updatedAt: Date.now()
        });
        if (sid) await db.seasons.update(sid, { premise: brief.premise });
      }

      setTitle(brief.title);
      setSeed(brief.bible);
      setPremise(brief.premise);
      setAi(nextAi);

      // Wait for episode row (just created) if needed
      let ep = wid ? await db.episodes.where('worldId').equals(wid).first() : undefined;
      const world = wid ? await db.worlds.get(wid) : undefined;
      const s = sid ? await db.seasons.get(sid) : undefined;
      if (!world || !s || !ep) throw new Error('World scaffolding missing — try again.');

      setBusy('Fleshing lore…');
      await fleshOutWorldEverything(world, s, ep, {
        shape: shapeTag(shape),
        targetCharacters: rosterTargets(shape).characters,
        targetLocations: rosterTargets(shape).locations,
        seedColdOpen: true,
        onProgress: setBusy
      });

      const refreshed = await db.worlds.get(wid);
      if (refreshed) {
        setTitle(refreshed.title);
        setSeed(refreshed.bible);
        setAi(refreshed.ai);
      }
      const refreshedSeason = await db.seasons.get(s.id);
      if (refreshedSeason) setPremise(refreshedSeason.premise);

      setReviewBanner(
        'Generated from your idea — walk through You, Cast, Place, and Memory. Perfect anything, then Enter when write-ready.'
      );
      setStep(3);
      return true;
    } catch (e) {
      setError(formatUserError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const fleshEverythingPanel = worldId && hasAI ? (
    <div className="glass" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>Flesh out everything</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
        Fills bible, premise, narrator rules, you, cast to roster targets, places, relationships, and opening memory.
        You review each step after — Story opens only when the write-ready checklist passes.
      </div>
      <button
        className="btn-primary"
        style={{ padding: '9px 16px', fontSize: 12.5, alignSelf: 'flex-start' }}
        disabled={!!busy}
        onClick={() => void runFleshEverything()}
      >
        {busy || '✦ Flesh out everything'}
      </button>
    </div>
  ) : null;

  const steps = [
    {
      title: 'How do you want to begin?',
      body: ideaLane
        ? 'Describe a roleplay. AI will ask a few questions, generate the full world, then you review every sheet before Enter.'
        : 'Small Worlds does not hand you a story. Pick a shape — then build seed, voice, cast, and place step by step.',
      cta: ideaLane ? 'Next — your idea' : 'Next — the world',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <OptionList options={LANES} value={lane} onChange={(i) => { setLane(i); setInterviewQs([]); setInterviewAnswers({}); setReviewBanner(''); }} />
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'rgba(236,234,230,0.7)' }}>Story shape</div>
          <OptionList options={SHAPES} value={shape} onChange={setShape} />
          {ideaLane && !hasAI && (
            <div style={{ fontSize: 12.5, color: 'oklch(0.78 0.06 195)' }}>
              From an idea needs an AI provider. Add one in Settings, or switch to Step by step.
            </div>
          )}
        </div>
      )
    },
    ideaLane
      ? {
          title: 'Describe the roleplay.',
          body: 'Setting, who you are, the pressure that opens the story, tone — a paragraph is enough. AI will ask follow-ups next.',
          cta: 'Next — clarifying questions',
          content: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <textarea
                rows={8}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. I want a tense harbour intrigue where I’m living under a false name, the debt ledger is public, and the registrar who noticed my handwriting has asked for a meeting in the long room…"
                className="serif"
                style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.65 }}
              />
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional — drafted from your idea)"
              />
            </div>
          )
        }
      : {
          title: 'Give the world one true thing.',
          body: 'A place, a rule, a pressure. One sentence is enough to start — flesh with AI when you want a full bible, then keep editing.',
          cta: 'Next — how it writes',
          content: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <OptionList options={SEED_KINDS} value={seedKind} onChange={setSeedKind} />
              <textarea
                rows={3} value={seed} onChange={(e) => setSeed(e.target.value)}
                placeholder={[
                  'A port where every debt is public record, and yours is written under a false name.',
                  'In this valley, a promise spoken aloud cannot be broken — only traded.',
                  'The ice is going out three weeks early, and the town owes its god a winter.',
                  'Paste your notes here — a paragraph or a page.'
                ][seedKind]}
                className="serif" style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.65 }}
              />
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional — one gets drafted if blank)" />
              {hasAI && (
                <div>
                  <button className="btn-ghost" disabled={!!busy || (!title.trim() && !seed.trim())} onClick={() => void fleshOutSeed()}>
                    {busy === 'Fleshing out the world…' ? 'Working…' : '✦ Flesh out with AI'}
                  </button>
                </div>
              )}
            </div>
          )
        },
    ideaLane
      ? {
          title: 'A few questions to lock it in.',
          body: 'Answer what you can — skip the rest. Then AI generates the full world. You still review and edit every sheet.',
          cta: busy ? busy : '✦ Generate world & review',
          content: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {interviewQs.length === 0 ? (
                <div style={{ fontSize: 13, color: 'rgba(236,234,230,0.55)' }}>
                  Questions appear after you continue from your idea.
                </div>
              ) : (
                interviewQs.map((q) => (
                  <Field key={q.id} label={q.question} note={q.hint}>
                    <textarea
                      rows={2}
                      value={interviewAnswers[q.id] ?? ''}
                      onChange={(e) => setInterviewAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder={q.hint || 'Your answer (optional)'}
                    />
                  </Field>
                ))
              )}
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.5)' }}>
                Generation fills bible, premise, narrator rules, you, cast, places, relationships, opening memory, and a cold open — then opens review.
              </div>
            </div>
          )
        }
      : {
          title: 'How should this world write?',
          body: 'These ride in every prompt for this world. Set defaults now so the first scene already feels right — change them later from Story → Edit world.',
          cta: 'Next — who you are',
          content: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 14 }}>
                <Field label="Point of view">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(['second', 'first', 'third'] as const).map((pov) => (
                      <Chip key={pov} active={ai.pov === pov} onClick={() => patchAI({ pov })}>{pov}</Chip>
                    ))}
                  </div>
                </Field>
                <Field label="Tense">
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['present', 'past'] as const).map((tense) => (
                      <Chip key={tense} active={ai.tense === tense} onClick={() => patchAI({ tense })}>{tense}</Chip>
                    ))}
                  </div>
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
                <SliderCard
                  label="Purple-ness"
                  value={ai.proseDensity}
                  onChange={(v) => patchAI({ proseDensity: v })}
                  note={ai.proseDensity < 34 ? 'Concrete over ornamental. Few adverbs.' : ai.proseDensity < 67 ? 'Balanced. Texture where it earns its place.' : 'Rich and atmospheric. Imagery leans in.'}
                  valueLabel={ai.proseDensity < 34 ? 'restrained' : ai.proseDensity < 67 ? 'balanced' : 'ornamental'}
                />
                <SliderCard
                  label="Pacing"
                  value={ai.pacing}
                  onChange={(v) => patchAI({ pacing: v })}
                  note={ai.pacing < 34 ? 'Linger. Tension accumulates slowly.' : ai.pacing < 67 ? 'Scenes develop naturally.' : 'Propulsive. Cut the connective tissue.'}
                  valueLabel={ai.pacing < 34 ? 'slow-burn' : ai.pacing < 67 ? 'measured' : 'propulsive'}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <Toggle on={ai.mature} onClick={() => patchAI({ mature: !ai.mature })} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.6)' }}>
                  {ai.mature
                    ? 'Adult world — graphic violence, sex, and darker themes permitted where the story calls for them.'
                    : 'General audience — imply rather than depict.'}
                </div>
              </div>

              <Field label="Season 1 premise" note="required — the pressure the season opens under">
                <textarea
                  rows={3}
                  value={premise}
                  onChange={(e) => setPremiseAndSave(e.target.value)}
                  placeholder="Where the story opens — concrete pressure, present tense. Required before you enter."
                />
              </Field>
              {hasAI && (
                <div>
                  <button className="btn-ghost" disabled={!!busy} onClick={() => void fleshOutPremiseField()}>
                    {busy === 'Fleshing out the premise…' ? 'Working…' : '✦ Flesh out with AI'}
                  </button>
                </div>
              )}

              <Field label="Narrator hard rules" note="one per line — never broken">
                <textarea
                  rows={3}
                  value={ai.narratorRules.join('\n')}
                  onChange={(e) => patchAI({ narratorRules: e.target.value.split('\n') })}
                  onBlur={() => patchAI({
                    narratorRules: ai.narratorRules.map((l) => l.trim()).filter(Boolean)
                  })}
                  placeholder={'Never skip time without asking.\nNever kill a named character without the player in the scene.'}
                />
              </Field>
              {hasAI && (
                <div>
                  <button className="btn-ghost" disabled={!!busy} onClick={() => void fleshOutRules()}>
                    {busy === 'Fleshing out the rules…' ? 'Working…' : '✦ Flesh out with AI'}
                  </button>
                </div>
              )}
              <Field label="Content boundaries" note="lines that are never crossed">
                <textarea
                  rows={2}
                  value={ai.contentNotes}
                  onChange={(e) => patchAI({ contentNotes: e.target.value })}
                  placeholder="e.g. No sexual content involving minors. Violence stays grounded, never cartoonish."
                />
              </Field>
              <Field label="World instructions" note="verbatim in narrator, character, and guest prompts">
                <textarea
                  rows={3}
                  value={ai.customInstructions}
                  onChange={(e) => patchAI({ customInstructions: e.target.value })}
                  placeholder="Themes to circle, imagery to reuse, what the story is really about…"
                />
              </Field>
              {fleshEverythingPanel}
            </div>
          )
        },
    {
      title: 'Who are you in this world?',
      body: 'Your sheet is the protagonist the cast reacts to. Summary or a live goal is required before Enter — desires, fears, and state help the first scene land.',
      cta: 'Next — the cast',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {checklistPanel(true)}
          {ideaLane && (
            <Field label="Season 1 premise" note="from your idea — edit freely">
              <textarea
                rows={3}
                value={premise}
                onChange={(e) => setPremiseAndSave(e.target.value)}
                placeholder="Opening pressure for this season"
              />
            </Field>
          )}
          {!player ? (
            <div style={{ fontSize: 13, color: 'rgba(236,234,230,0.55)' }}>Player sheet not found — go back one step and recreate the world.</div>
          ) : (
            <>
              <Field label="Who you are">
                <textarea
                  rows={3}
                  defaultValue={player.summary}
                  key={`sum-${player.id}-${player.updatedAt}`}
                  onBlur={(e) => patchPlayer({ summary: e.target.value })}
                  placeholder="Second-person summary — who you are as the story opens."
                />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 10 }}>
                <Field label="Goal now">
                  <input
                    defaultValue={player.state.goal}
                    key={`g-${player.updatedAt}`}
                    onBlur={(e) => patchPlayer({ state: { ...player.state, goal: e.target.value } })}
                    placeholder="What you want right now"
                  />
                </Field>
                <Field label="Emotion">
                  <input
                    defaultValue={player.state.emotion}
                    key={`e-${player.updatedAt}`}
                    onBlur={(e) => patchPlayer({ state: { ...player.state, emotion: e.target.value } })}
                  />
                </Field>
                <Field label="Where">
                  <input
                    defaultValue={player.state.location}
                    key={`l-${player.updatedAt}`}
                    onBlur={(e) => patchPlayer({ state: { ...player.state, location: e.target.value } })}
                  />
                </Field>
                <Field label="Condition">
                  <input
                    defaultValue={player.state.condition}
                    key={`c-${player.updatedAt}`}
                    onBlur={(e) => patchPlayer({ state: { ...player.state, condition: e.target.value } })}
                  />
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10 }}>
                <Field label="Desires">
                  <textarea rows={2} defaultValue={player.desires} key={`d-${player.updatedAt}`} onBlur={(e) => patchPlayer({ desires: e.target.value })} />
                </Field>
                <Field label="Fears">
                  <textarea rows={2} defaultValue={player.fears} key={`f-${player.updatedAt}`} onBlur={(e) => patchPlayer({ fears: e.target.value })} />
                </Field>
              </div>
              <Field label="Appearance">
                <textarea rows={2} defaultValue={player.appearance} key={`a-${player.updatedAt}`} onBlur={(e) => patchPlayer({ appearance: e.target.value })} />
              </Field>
              {hasAI && (
                <button className="btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void fleshPlayer()}>
                  {busy === 'Fleshing you…' ? 'Working…' : '✦ Flesh out with AI'}
                </button>
              )}
            </>
          )}
        </div>
      )
    },
    {
      title: 'Who is in it with you?',
      body: hasAI
        ? 'Add NPCs with voice, anchors, and live state. At least one scene NPC with speech style, summary, and an anchor is required before Enter.'
        : 'No AI provider yet — add characters by hand now; configure a key in Settings before writing.',
      cta: 'Next — the opening place',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {checklistPanel(true)}
          {npcCast.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 340, overflowY: 'auto', paddingRight: 2 }}>
              {npcCast.map((c) => (
                <CastCard
                  key={c.id} c={c} expanded={expandedCastId === c.id}
                  hasAI={hasAI}
                  fleshBusy={busy === `Fleshing ${c.name || 'cast'}…`}
                  onToggle={() => setExpandedCastId((id) => (id === c.id ? null : c.id))}
                  onRemove={() => void removeCastEntry(c.id)}
                  onPatch={(p) => void safeWrite(
                    () => db.characters.update(c.id, { ...p, updatedAt: Date.now() }),
                    setError
                  )}
                  onToggleSelfTag={() => void toggleSelfTag(c.id)}
                  onFlesh={() => void (async () => {
                    setBusy(`Fleshing ${c.name || 'cast'}…`);
                    setError('');
                    try {
                      const cast = await db.characters.where('worldId').equals(worldId!).toArray();
                      const sheet = await fleshOutCharacter(worldContext(), c, cast);
                      await db.characters.update(c.id, { ...sheet, updatedAt: Date.now() });
                    } catch (e) {
                      setError(formatUserError(e));
                    } finally {
                      setBusy(null);
                    }
                  })()}
                />
              ))}
            </div>
          )}
          <input value={castName} onChange={(e) => setCastName(e.target.value)} placeholder="Name (or just an idea)" />
          <textarea
            rows={2} value={castNotes} onChange={(e) => setCastNotes(e.target.value)}
            placeholder="Anything you already know — optional. Traits, backstory, a line of dialogue…"
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-ghost" disabled={!!busy || (!castName.trim() && !castNotes.trim())} onClick={() => void addCastPlain()}>+ Add</button>
            {hasAI && (
              <button className="btn-primary" style={{ padding: '8px 16px', fontSize: 12.5 }}
                disabled={!!busy || (!castName.trim() && !castNotes.trim())} onClick={() => void addCastGenerate()}>
                {busy === 'Generating…' ? 'Generating…' : '✦ Generate with AI'}
              </button>
            )}
            {busy === 'Generating…' && <Spinner label="the utility model is fleshing out the sheet" />}
          </div>
          {npcCast.length > 0 && (
            <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }} onClick={() => openFullEditor('cast')}>
              full editor → Cast
            </button>
          )}
        </div>
      )
    },
    {
      title: 'Where does it begin?',
      body: hasAI
        ? 'Opening location needs a name and at least one hard rule, linked to episode 1. Mark which place the story opens in.'
        : 'Add a location by hand and give it a hard rule. Link it as the opening place.',
      cta: 'Next — memory & enter',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {checklistPanel(true)}
          {places.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 340, overflowY: 'auto', paddingRight: 2 }}>
              {places.map((l) => (
                <PlaceCard
                  key={l.id} l={l} expanded={expandedPlaceId === l.id}
                  isOpening={episode?.locationId === l.id}
                  hasAI={hasAI}
                  fleshBusy={busy === `Fleshing ${l.name || 'place'}…`}
                  onToggle={() => setExpandedPlaceId((id) => (id === l.id ? null : l.id))}
                  onRemove={() => void removePlaceEntry(l.id)}
                  onSetOpening={() => void setOpeningPlace(l.id)}
                  onPatch={(p) => void safeWrite(
                    () => db.locations.update(l.id, { ...p, updatedAt: Date.now() }),
                    setError
                  )}
                  onFlesh={() => void (async () => {
                    setBusy(`Fleshing ${l.name || 'place'}…`);
                    setError('');
                    try {
                      const sheet = await fleshOutLocation(worldContext(), l);
                      await db.locations.update(l.id, { ...sheet, updatedAt: Date.now() });
                    } catch (e) {
                      setError(formatUserError(e));
                    } finally {
                      setBusy(null);
                    }
                  })()}
                />
              ))}
            </div>
          )}
          <input value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="Name (or just an idea)" />
          <textarea
            rows={2} value={placeNotes} onChange={(e) => setPlaceNotes(e.target.value)}
            placeholder="Anything you already know — optional. Atmosphere, a rule, who runs it…"
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-ghost" disabled={!!busy || (!placeName.trim() && !placeNotes.trim())} onClick={() => void addPlacePlain()}>+ Add</button>
            {hasAI && (
              <button className="btn-primary" style={{ padding: '8px 16px', fontSize: 12.5 }}
                disabled={!!busy || (!placeName.trim() && !placeNotes.trim())} onClick={() => void addPlaceGenerate()}>
                {busy === 'Generating…' ? 'Generating…' : '✦ Generate with AI'}
              </button>
            )}
            {busy === 'Generating…' && <Spinner label="the utility model is fleshing out the sheet" />}
          </div>
          {places.length > 0 && (
            <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }} onClick={() => openFullEditor('locations')}>
              full editor → Locations
            </button>
          )}
        </div>
      )
    },
    {
      title: 'Memory, then enter.',
      body: 'Seed opening continuity and threads so episode 1 already has pressure. Enter is blocked until the write-ready checklist passes.',
      cta: busy ? busy : 'Enter the world',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {checklistPanel(false)}

          <div className="glass" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>Opening continuity</div>
            <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.55)' }}>
              {continuity.length} fact{continuity.length === 1 ? '' : 's'} · {threads.length} open thread{threads.length === 1 ? '' : 's'}
              {turnCount > 0 ? ` · ${turnCount} opening turn${turnCount === 1 ? '' : 's'}` : ''}
            </div>
            {continuity.slice(0, 4).map((f) => (
              <div key={f.id} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.7)' }}>· {f.text}</div>
            ))}
            {threads.slice(0, 4).map((t) => (
              <div key={t.id} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'oklch(0.74 0.05 195)' }}>⟳ {t.text}</div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {hasAI && (
                <button className="btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void runSeedMemory()}>
                  {busy === 'Seeding opening memory…' ? 'Working…' : '✦ Seed opening memory'}
                </button>
              )}
              {hasAI && turnCount === 0 && (
                <button className="btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void runColdOpen()}>
                  {busy === 'Drafting cold open…' ? 'Working…' : '✦ Draft cold open'}
                </button>
              )}
            </div>
          </div>

          <div className="glass" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>Relationships</div>
            {relationshipLines.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.5)' }}>
                No cast links yet — flesh cast or re-link after NPCs exist.
              </div>
            ) : (
              relationshipLines.map((line) => (
                <div key={line.key} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.7)' }}>
                  {line.text}
                </div>
              ))
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {hasAI && npcCast.length > 0 && (
                <button className="btn-ghost" disabled={!!busy} onClick={() => void runRelinkRelationships()}>
                  {busy === 'Linking relationships…' ? 'Working…' : '✦ Re-link with AI'}
                </button>
              )}
              {npcCast.length > 0 && (
                <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => openFullEditor('cast')}>
                  full editor → Cast
                </button>
              )}
            </div>
          </div>

          {gateNote && (
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.55)' }}>{gateNote}</div>
          )}
        </div>
      )
    }
  ];
  const ob = steps[step];
  const lastStep = steps.length - 1;

  const goNext = async () => {
    if (step === 0) {
      if (ideaLane && !hasAI) {
        setError('From an idea needs an AI provider. Add one in Settings, or switch to Step by step.');
        return;
      }
      setError('');
      setStep(1);
      return;
    }

    if (step === 1) {
      if (ideaLane) {
        const ok = await startIdeaInterview();
        if (!ok) return;
        setStep(2);
        return;
      }
      const t = title.trim();
      const s = seed.trim();
      if (!t && !s) {
        setError('Give the world at least one true thing (or a title) first.');
        return;
      }
      setError('');
      if (!worldId) {
        setBusy('Building the world…');
        try {
          const custom = (ai.customInstructions ?? '').trim() ? ai.customInstructions : shapeTag(shape);
          const world = await createWorld({
            title: t, line: s.slice(0, 140), bible: s, premise: '',
            ai: { ...ai, customInstructions: custom }
          });
          setWorldId(world.id);
          setSeasonId(world.activeSeasonId);
          setAi(world.ai);
        } catch (e) {
          setError(formatUserError(e));
          setBusy(null);
          return;
        }
        setBusy(null);
      } else {
        void safeWrite(
          () => db.worlds.update(worldId, { title: t, line: s.slice(0, 140), bible: s, updatedAt: Date.now() }),
          setError
        );
      }
      setStep(2);
      return;
    }

    if (step === 2) {
      if (ideaLane) {
        const ok = await generateFromInterview();
        if (!ok) return;
        return; // generateFromInterview sets step to 3
      }
      if (!premise.trim()) {
        setError('Season premise is required — write one or flesh it with AI.');
        return;
      }
      setStep(3);
      return;
    }

    if (step < lastStep) setStep((v) => v + 1);
    else await finish();
  };

  return (
    <div className="fade-in" style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '1.05fr 1fr' }}>
      <div style={{ padding: narrow ? '30px 20px 46px' : '52px 44px 56px', display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 660 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {steps.map((_, i) => (
            <div key={i} style={{
              width: i === step ? 26 : 9, height: 4, borderRadius: 2,
              background: i <= step ? 'oklch(0.72 0.06 195)' : 'rgba(255,255,255,0.14)',
              transition: 'all 0.3s ease'
            }} />
          ))}
          <div className="label" style={{ marginLeft: 8 }}>
            Step {step + 1} of {steps.length}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 32 : 42, lineHeight: 1.1, margin: 0, color: '#f8f6f2' }}>{ob.title}</h1>
          <div style={{ fontSize: 15, lineHeight: 1.7, color: 'rgba(236,234,230,0.58)', maxWidth: '54ch' }}>{ob.body}</div>
          {reviewBanner && step >= 3 && (
            <div className="glass" style={{ padding: '12px 14px', fontSize: 12.5, lineHeight: 1.55, color: 'oklch(0.78 0.06 195)' }}>
              {reviewBanner}
            </div>
          )}
        </div>

        {ob.content}

        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        {busy && !busy.startsWith('Generating') && <Spinner label={busy} />}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 'auto', flexWrap: 'wrap' }}>
          {step > 0 && <button className="btn-ghost" disabled={!!busy} onClick={() => setStep(step - 1)}>Back</button>}
          <button
            className="btn-primary" style={{ padding: '12px 24px', fontSize: 13.5 }}
            disabled={!!busy || (step === lastStep && !ready.ok)}
            onClick={() => void goNext()}
          >
            {ob.cta}
          </button>
          <button className="btn-quiet" disabled={!!busy} onClick={() => void discardAndLeave()}>
            {worldId ? 'Skip — discard world' : 'Skip — back to worlds'}
          </button>
        </div>
      </div>

      {!narrow && (
        <div style={{
          borderLeft: '1px solid rgba(255,255,255,0.08)', padding: '46px 40px', display: 'flex',
          flexDirection: 'column', gap: 20, justifyContent: 'center', background: 'rgba(12,14,16,0.35)'
        }}>
          <div className="label">What onboard delivers</div>
          <div style={{
            height: 200, borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'flex-end', padding: 14,
            background: `linear-gradient(155deg, oklch(0.72 0.06 195 / 0.12), rgba(10,12,14,0.92)), ${STRIPE('rgba(255,255,255,0.05)', 'rgba(255,255,255,0.012)')}`
          }}>
            <span className="mono meta" style={{
              color: 'rgba(230,233,235,0.65)', background: 'rgba(10,12,14,0.55)', padding: '5px 9px', borderRadius: 4
            }}>
              World plate
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {PROMISES.map((p) => (
              <div key={p.t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
                <div style={{ width: 2, height: 14, background: 'oklch(0.72 0.06 195)', marginTop: 4, flexShrink: 0 }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f2f4f5' }}>{p.t}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(230,233,235,0.55)' }}>{p.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SliderCard({ label, value, onChange, note, valueLabel }: {
  label: string; value: number; onChange: (v: number) => void; note: string; valueLabel: string;
}) {
  return (
    <div className="glass" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(236,234,230,0.92)' }}>{label}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.72 0.06 195)' }}>{valueLabel}</div>
      </div>
      <Bar pct={value} />
      <input
        type="range" min={0} max={100} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'rgba(236,234,230,0.5)' }}>{note}</div>
    </div>
  );
}

function CastCard({ c, expanded, hasAI, fleshBusy, onToggle, onRemove, onPatch, onToggleSelfTag, onFlesh }: {
  c: Character; expanded: boolean; hasAI: boolean; fleshBusy: boolean;
  onToggle: () => void; onRemove: () => void;
  onPatch: (p: Partial<Character>) => void; onToggleSelfTag: () => void; onFlesh: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const gallery = characterPortraits(c);
  const primary = gallery[0] ?? null;

  const onFile = async (file: File) => {
    if (gallery.length >= MAX_CHARACTER_PORTRAITS) {
      setError(`Up to ${MAX_CHARACTER_PORTRAITS} photos per character.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const url = await fileToPortraitImage(file);
      onPatch(portraitsPatch([...gallery, url]));
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass" style={{ borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={onToggle}>
        <div style={{
          ...avatarStyle(c.hue, 34), flexShrink: 0,
          ...(primary ? { backgroundImage: `url(${primary})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {})
        }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>{c.name || 'unnamed'}{c.selfTag ? ' · me' : ''}</div>
          {c.role && (
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.role}
            </div>
          )}
        </div>
        <button className="btn-quiet" style={{ fontSize: 11, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); onRemove(); }}>remove</button>
        <span style={{ fontSize: 10, color: 'rgba(236,234,230,0.4)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '2px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
          <input
            ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
          />
          {gallery.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {gallery.map((url, i) => (
                <div key={`${i}-${url.slice(0, 20)}`} style={{ position: 'relative' }}>
                  <button
                    type="button"
                    title={i === 0 ? 'Primary face' : 'Make primary'}
                    onClick={() => {
                      if (i === 0) return;
                      onPatch(portraitsPatch([url, ...gallery.filter((_, j) => j !== i)]));
                    }}
                    style={{
                      width: 44, height: 44, borderRadius: 9, padding: 0, cursor: 'pointer',
                      border: i === 0 ? '2px solid oklch(0.72 0.06 195)' : '1px solid rgba(255,255,255,0.16)',
                      backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center'
                    }}
                  />
                  <button
                    type="button"
                    className="btn-quiet"
                    title="Remove"
                    onClick={() => onPatch(portraitsPatch(gallery.filter((_, j) => j !== i)))}
                    style={{
                      position: 'absolute', top: -5, right: -5, width: 16, height: 16, padding: 0,
                      borderRadius: '50%', fontSize: 9, lineHeight: '16px',
                      background: 'rgba(8,9,12,0.85)', border: '1px solid rgba(255,255,255,0.2)'
                    }}
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn-ghost"
              style={{ fontSize: 11, padding: '6px 12px' }}
              disabled={busy || gallery.length >= MAX_CHARACTER_PORTRAITS}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? 'Uploading…' : gallery.length ? 'Add photo' : 'Upload photo'}
            </button>
            <button className="btn-quiet" style={{ fontSize: 11 }} onClick={onToggleSelfTag}>
              {c.selfTag ? '✓ tagged as me — untag' : 'tag as "this is me"'}
            </button>
            {hasAI && (
              <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }} disabled={fleshBusy || busy} onClick={onFlesh}>
                {fleshBusy ? 'Working…' : '✦ Flesh this sheet'}
              </button>
            )}
          </div>
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          <Field label="Role"><input defaultValue={c.role} onBlur={(e) => onPatch({ role: e.target.value })} /></Field>
          <Field label="Who they are"><textarea rows={3} defaultValue={c.summary} onBlur={(e) => onPatch({ summary: e.target.value })} /></Field>
          <Field label="Backstory"><textarea rows={2} defaultValue={c.backstory} onBlur={(e) => onPatch({ backstory: e.target.value })} /></Field>
          <Field label="How they talk"><textarea rows={2} defaultValue={c.speechStyle} onBlur={(e) => onPatch({ speechStyle: e.target.value })} /></Field>
          <Field label="Example lines" note="one per line">
            <textarea rows={2} defaultValue={c.exampleLines.join('\n')} onBlur={(e) => onPatch({ exampleLines: e.target.value.split('\n').filter((l) => l.trim()) })} />
          </Field>
          <Field label="Anchors" note="one per line — never broken">
            <textarea rows={2} defaultValue={c.anchors.join('\n')} onBlur={(e) => onPatch({ anchors: e.target.value.split('\n').filter((l) => l.trim()) })} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 10 }}>
            <Field label="Goal now">
              <input defaultValue={c.state.goal} onBlur={(e) => onPatch({ state: { ...c.state, goal: e.target.value } })} />
            </Field>
            <Field label="Emotion">
              <input defaultValue={c.state.emotion} onBlur={(e) => onPatch({ state: { ...c.state, emotion: e.target.value } })} />
            </Field>
            <Field label="Where">
              <input defaultValue={c.state.location} onBlur={(e) => onPatch({ state: { ...c.state, location: e.target.value } })} />
            </Field>
            <Field label="Condition">
              <input defaultValue={c.state.condition} onBlur={(e) => onPatch({ state: { ...c.state, condition: e.target.value } })} />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10 }}>
            <Field label="Traits"><textarea rows={2} defaultValue={c.traits} onBlur={(e) => onPatch({ traits: e.target.value })} /></Field>
            <Field label="Flaws"><textarea rows={2} defaultValue={c.flaws} onBlur={(e) => onPatch({ flaws: e.target.value })} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10 }}>
            <Field label="Desires"><textarea rows={2} defaultValue={c.desires} onBlur={(e) => onPatch({ desires: e.target.value })} /></Field>
            <Field label="Fears"><textarea rows={2} defaultValue={c.fears} onBlur={(e) => onPatch({ fears: e.target.value })} /></Field>
          </div>
          <Field label="Secrets"><textarea rows={2} defaultValue={c.secrets} onBlur={(e) => onPatch({ secrets: e.target.value })} /></Field>
          <Field label="Must not know"><textarea rows={2} defaultValue={c.mustNotKnow} onBlur={(e) => onPatch({ mustNotKnow: e.target.value })} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10 }}>
            <Field label="Appearance"><textarea rows={2} defaultValue={c.appearance} onBlur={(e) => onPatch({ appearance: e.target.value })} /></Field>
            <Field label="Mannerisms"><textarea rows={2} defaultValue={c.mannerisms} onBlur={(e) => onPatch({ mannerisms: e.target.value })} /></Field>
          </div>
        </div>
      )}
    </div>
  );
}

function PlaceCard({ l, expanded, isOpening, hasAI, fleshBusy, onToggle, onRemove, onSetOpening, onPatch, onFlesh }: {
  l: Location; expanded: boolean; isOpening: boolean; hasAI: boolean; fleshBusy: boolean;
  onToggle: () => void; onRemove: () => void;
  onSetOpening: () => void; onPatch: (p: Partial<Location>) => void; onFlesh: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onFile = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      onPatch({ portrait: await fileToPortraitImage(file) });
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass" style={{ borderRadius: 12, overflow: 'hidden', outline: isOpening ? '1px solid oklch(0.72 0.06 195)' : undefined }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={onToggle}>
        <div style={{ ...avatarStyle(l.hue, 34), flexShrink: 0, ...(l.portrait ? { backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}) }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>
            {l.name || 'unnamed'}{isOpening ? ' · opening' : ''}
          </div>
          {l.tagline && (
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {l.tagline}
            </div>
          )}
        </div>
        <button className="btn-quiet" style={{ fontSize: 11, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); onRemove(); }}>remove</button>
        <span style={{ fontSize: 10, color: 'rgba(236,234,230,0.4)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '2px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
          <input
            ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }} disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? 'Uploading…' : l.portrait ? 'Change photo' : 'Upload photo'}
            </button>
            {l.portrait && <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => onPatch({ portrait: null })}>remove photo</button>}
            {!isOpening && (
              <button className="btn-quiet" style={{ fontSize: 11 }} onClick={onSetOpening}>set as opening</button>
            )}
            {hasAI && (
              <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }} disabled={fleshBusy || busy} onClick={onFlesh}>
                {fleshBusy ? 'Working…' : '✦ Flesh this sheet'}
              </button>
            )}
          </div>
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          <Field label="Name"><input defaultValue={l.name} onBlur={(e) => onPatch({ name: e.target.value })} /></Field>
          <Field label="Tagline"><input defaultValue={l.tagline} onBlur={(e) => onPatch({ tagline: e.target.value })} /></Field>
          <Field label="What it is"><textarea rows={3} defaultValue={l.summary} onBlur={(e) => onPatch({ summary: e.target.value })} /></Field>
          <Field label="Atmosphere"><textarea rows={2} defaultValue={l.atmosphere} onBlur={(e) => onPatch({ atmosphere: e.target.value })} /></Field>
          <Field label="Features"><textarea rows={2} defaultValue={l.features} onBlur={(e) => onPatch({ features: e.target.value })} /></Field>
          <Field label="History"><textarea rows={2} defaultValue={l.history} onBlur={(e) => onPatch({ history: e.target.value })} /></Field>
          <Field label="Inhabitants"><textarea rows={2} defaultValue={l.inhabitants} onBlur={(e) => onPatch({ inhabitants: e.target.value })} /></Field>
          <Field label="Rules" note="one per line — at least one required">
            <textarea rows={2} defaultValue={l.rules.join('\n')} onBlur={(e) => onPatch({ rules: e.target.value.split('\n').filter((r) => r.trim()) })} />
          </Field>
          <Field label="Secrets"><textarea rows={2} defaultValue={l.secrets} onBlur={(e) => onPatch({ secrets: e.target.value })} /></Field>
          <Field label="Current state"><textarea rows={2} defaultValue={l.currentState} onBlur={(e) => onPatch({ currentState: e.target.value })} /></Field>
        </div>
      )}
    </div>
  );
}

function OptionList({ options, value, onChange }: {
  options: Array<{ label: string; line: string }>; value: number; onChange: (i: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
      {options.map((o, i) => {
        const active = value === i;
        return (
          <button key={o.label} onClick={() => onChange(i)} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            border: 0,
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            borderLeft: `2px solid ${active ? 'oklch(0.72 0.06 195)' : 'transparent'}`,
            background: active ? 'oklch(0.72 0.06 195 / 0.08)' : 'transparent',
            color: active ? '#f2f4f5' : 'rgba(230,233,235,0.62)',
            borderRadius: 0, padding: '15px 14px', cursor: 'pointer', textAlign: 'left'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'left', flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{o.label}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.68 }}>{o.line}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
