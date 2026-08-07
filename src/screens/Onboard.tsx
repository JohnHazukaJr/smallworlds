import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import {
  fleshOutCharacter, fleshOutLocation, fleshOutNarratorRules, fleshOutPremise,
  fleshOutWorldEverything, fleshOutWorldLore
} from '../ai/engine';
import { db, safeWrite } from '../db';
import { formatUserError } from '../errors';
import { useApp } from '../store/app';
import { useSettings } from '../store/settings';
import type { Character, Location, Season, World, WorldAISettings } from '../types';
import { Bar, Chip, ErrorNote, Field, Mono, Spinner, Toggle, useVw } from '../ui/bits';
import { fileToPortraitImage } from '../ui/image';
import { avatarStyle, STRIPE } from '../ui/theme';
import {
  characterPortraits, createWorld, DEFAULT_AI, emptyCharacter, emptyLocation,
  MAX_CHARACTER_PORTRAITS, portraitsPatch
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

const PLACE_KINDS = [
  { label: 'Describe it, get a full sheet', line: 'One sentence in, atmosphere, rules and history out — editable after.' },
  { label: 'Write it myself, later', line: 'Locations screen any time.' },
  { label: 'Nowhere in particular yet', line: 'Skip for now — start the story and let it emerge.' }
];

const CAST_KINDS = [
  { label: 'Describe them, get a full sheet', line: 'One sentence in, a deep NPC sheet out — editable after.' },
  { label: 'Write them myself, later', line: 'Voice and anchors when you’re ready. Cast screen any time.' },
  { label: 'Only me for now', line: 'Second person, no cast yet.' }
];

const PROMISES = [
  { t: 'Characters that hold a line', d: 'Behaviour anchors ride along in every prompt. They can refuse you, and they will.' },
  { t: 'Your key, any model', d: 'OpenRouter, Anthropic, Gemini, Kimi, local models — swap engines per world, any time.' },
  { t: 'Seasons that remember selectively', d: 'At each season’s end the story is read back and you decide what the next one carries.' },
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

export function Onboard() {
  const vw = useVw();
  const narrow = vw < 1000;
  const { go, openWorld, goCast, goLocations } = useApp();
  const matureDefault = useSettings((s) => s.matureDefault);
  const providers = useSettings((s) => s.providers);

  const [step, setStep] = useState(0);
  const [shape, setShape] = useState(0);
  const [seedKind, setSeedKind] = useState(0);
  const [seed, setSeed] = useState('');
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [ai, setAi] = useState<WorldAISettings>(() => ({ ...DEFAULT_AI, mature: matureDefault }));
  const [castKind, setCastKind] = useState(0);
  const [castName, setCastName] = useState('');
  const [castNotes, setCastNotes] = useState('');
  const [expandedCastId, setExpandedCastId] = useState<string | null>(null);
  const [placeKind, setPlaceKind] = useState(0);
  const [placeName, setPlaceName] = useState('');
  const [placeNotes, setPlaceNotes] = useState('');
  const [expandedPlaceId, setExpandedPlaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // The world is created as soon as we leave step 1 — everything after that is a real, live record.
  const [worldId, setWorldId] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);

  const hasAI = providers.length > 0;

  const characters = useLiveQuery(
    async () => (worldId ? db.characters.where('worldId').equals(worldId).toArray() : []),
    [worldId]
  ) ?? [];
  const npcCast = characters.filter((c) => !c.isPlayer);
  const places = useLiveQuery(
    async () => (worldId ? db.locations.where('worldId').equals(worldId).toArray() : []),
    [worldId]
  ) ?? [];
  const episode = useLiveQuery(
    async () => (worldId ? db.episodes.where('worldId').equals(worldId).first() : undefined),
    [worldId]
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
    const bits = [`Desired story shape: ${SHAPES[shape].label} — ${SHAPES[shape].line}`];
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
        void safeWrite(
          () => db.worlds.update(worldId, { title: result.title, line: result.line, bible: result.bible, updatedAt: Date.now() }),
          setError
        );
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
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const removePlaceEntry = async (id: string) => {
    await db.locations.delete(id);
  };

  const openFullEditor = (screen: 'cast' | 'locations') => {
    if (!worldId) return;
    // openWorld jumps to Story — set world then open the full editor on the focused sheet.
    useApp.setState({ currentWorldId: worldId });
    if (screen === 'cast') {
      const focus = expandedCastId ?? npcCast[0]?.id ?? null;
      goCast(focus);
    } else {
      const focus = expandedPlaceId ?? places[0]?.id ?? null;
      goLocations(focus);
    }
  };

  const finish = async () => {
    setError('');
    if (!worldId) {
      setError('Give the world at least one true thing (or a title) first.');
      return;
    }
    openWorld(worldId);
  };

  /**
   * Bulk flesh-out after the world exists. Never opens Story — jumps to cast
   * so the user can review generated people (places are on the next step).
   */
  const runFleshEverything = async () => {
    if (!worldId || !seasonId || !episode || !hasAI) return;
    setError('');
    setBusy('Fleshing lore…');
    try {
      const world = await db.worlds.get(worldId);
      const season = await db.seasons.get(seasonId);
      if (!world || !season) throw new Error('World not found — finish giving it one true thing first.');
      const targets = rosterTargets(shape);
      await fleshOutWorldEverything(world, season, episode, {
        shape: `${SHAPES[shape].label} — ${SHAPES[shape].line}`,
        targetCharacters: targets.characters,
        targetLocations: targets.locations,
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
      setCastKind(0);
      setPlaceKind(0);
      setStep(3); // cast step — review before Finish
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const fleshEverythingPanel = worldId && hasAI ? (
    <div className="glass" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>Flesh out everything</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
        Fills bible, premise, and narrator rules, then invents opening cast and locations.
        You stay here to review and edit — Story opens only when you finish.
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
      title: 'Start from nothing.',
      body: 'Small Worlds does not hand you a story. It gives you a world that behaves consistently and characters who hold their own line — then gets out of the way while you write into it.',
      cta: 'Next — the world',
      content: (
        <OptionList options={SHAPES} value={shape} onChange={setShape} />
      )
    },
    {
      title: 'Give the world one true thing.',
      body: 'A place, a rule, a pressure. One sentence is enough — the rest gets asked about as the story needs it, rather than making you fill in a form now.',
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
    {
      title: 'How should this world write?',
      body: 'These ride in every prompt for this world. You can change them any time from Story → Edit world or Settings — set the defaults now so the first scene already feels right.',
      cta: 'Next — the first character',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
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
            <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.6)' }}>
              {ai.mature
                ? 'Adult world — graphic violence, sex, and darker themes permitted where the story calls for them.'
                : 'General audience — imply rather than depict.'}
            </div>
          </div>

          <Field label="Season 1 premise" note="optional — the plot the narrator steers toward">
            <textarea
              rows={3}
              value={premise}
              onChange={(e) => setPremiseAndSave(e.target.value)}
              placeholder="Where the story opens — leave blank and a premise gets drafted from your seed once you're writing."
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
          <Field label="World instructions" note="passed to the model verbatim, every request">
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
      title: 'Who is in it with you?',
      body: hasAI
        ? 'Give a name — or just an idea — and Generate drafts a full sheet from it: voice, desires, secrets, anchors, all editable right here. Add as many as you like, one at a time, then move on. Everything you add is saved immediately, so it’s safe even if you stop partway.'
        : 'No AI provider configured yet — you can still add characters by hand now and add a key in Settings before writing.',
      cta: 'Next — the first place',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {fleshEverythingPanel}
          <OptionList options={CAST_KINDS} value={castKind} onChange={setCastKind} />
          {castKind === 0 && (
            <>
              {npcCast.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto', paddingRight: 2 }}>
                  {npcCast.map((c) => (
                    <CastCard
                      key={c.id} c={c} expanded={expandedCastId === c.id}
                      onToggle={() => setExpandedCastId((id) => (id === c.id ? null : c.id))}
                      onRemove={() => void removeCastEntry(c.id)}
                      onPatch={(p) => void safeWrite(
                        () => db.characters.update(c.id, { ...p, updatedAt: Date.now() }),
                        setError
                      )}
                      onToggleSelfTag={() => void toggleSelfTag(c.id)}
                    />
                  ))}
                </div>
              )}
              <input value={castName} onChange={(e) => setCastName(e.target.value)} placeholder="Name (or just an idea)" />
              <textarea
                rows={2} value={castNotes} onChange={(e) => setCastNotes(e.target.value)}
                placeholder="Anything you already know — optional. Traits, backstory, a line of dialogue… the AI fills in the rest."
              />
              {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
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
            </>
          )}
        </div>
      )
    },
    {
      title: 'Where does it begin?',
      body: hasAI
        ? 'Give a name — or just an idea — and Generate drafts a full sheet: atmosphere, features, hard rules, all editable right here. The first one becomes episode one’s location. Add as many as you like, one at a time.'
        : 'No AI provider configured yet — you can still add locations by hand now and add a key in Settings before writing.',
      cta: busy ? busy : 'Enter the world',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {fleshEverythingPanel}
          <OptionList options={PLACE_KINDS} value={placeKind} onChange={setPlaceKind} />
          {placeKind === 0 && (
            <>
              {places.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto', paddingRight: 2 }}>
                  {places.map((l) => (
                    <PlaceCard
                      key={l.id} l={l} expanded={expandedPlaceId === l.id}
                      onToggle={() => setExpandedPlaceId((id) => (id === l.id ? null : l.id))}
                      onRemove={() => void removePlaceEntry(l.id)}
                      onPatch={(p) => void safeWrite(
                        () => db.locations.update(l.id, { ...p, updatedAt: Date.now() }),
                        setError
                      )}
                    />
                  ))}
                </div>
              )}
              <input value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="Name (or just an idea)" />
              <textarea
                rows={2} value={placeNotes} onChange={(e) => setPlaceNotes(e.target.value)}
                placeholder="Anything you already know — optional. Atmosphere, a rule, who runs it… the AI fills in the rest."
              />
              {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
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
            </>
          )}
        </div>
      )
    }
  ];
  const ob = steps[step];
  const lastStep = steps.length - 1;

  const goNext = async () => {
    if (step === 1) {
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
          const world = await createWorld({ title: t, line: s.slice(0, 140), bible: s, premise: '', ai });
          setWorldId(world.id);
          setSeasonId(world.activeSeasonId);
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
              background: i <= step ? 'oklch(0.85 0.1 62)' : 'rgba(255,255,255,0.14)',
              transition: 'all 0.3s ease'
            }} />
          ))}
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.12em', color: 'rgba(236,234,230,0.4)', marginLeft: 8 }}>
            step {step + 1} of {steps.length}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 32 : 42, lineHeight: 1.1, margin: 0, color: '#f8f6f2' }}>{ob.title}</h1>
          <div style={{ fontSize: 15, lineHeight: 1.7, color: 'rgba(236,234,230,0.58)', maxWidth: '54ch' }}>{ob.body}</div>
        </div>

        {ob.content}

        {step !== 3 && step !== 4 && error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        {busy && !busy.startsWith('Generating') && <Spinner label={busy} />}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 'auto', flexWrap: 'wrap' }}>
          {step > 0 && <button className="btn-ghost" disabled={!!busy} onClick={() => setStep(step - 1)}>Back</button>}
          <button
            className="btn-primary" style={{ padding: '12px 24px', fontSize: 13.5 }}
            disabled={!!busy}
            onClick={() => void goNext()}
          >
            {ob.cta}
          </button>
          <button className="btn-quiet" disabled={!!busy} onClick={() => go('library')}>Skip — back to worlds</button>
        </div>
      </div>

      {!narrow && (
        <div style={{
          borderLeft: '1px solid rgba(255,255,255,0.07)', padding: '46px 40px', display: 'flex',
          flexDirection: 'column', gap: 20, justifyContent: 'center', background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(20px)'
        }}>
          <Mono>what you get</Mono>
          <div style={{
            height: 244, borderRadius: 18, border: '1px solid rgba(255,255,255,0.11)',
            display: 'flex', alignItems: 'flex-end', padding: 14,
            background: `linear-gradient(155deg, rgba(224,165,95,0.18), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`
          }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.62)', background: 'rgba(8,9,12,0.5)', backdropFilter: 'blur(6px)', padding: '5px 9px', borderRadius: 6 }}>
              world plate
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {PROMISES.map((p) => (
              <div key={p.t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'oklch(0.85 0.1 62)', marginTop: 8, flexShrink: 0 }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>{p.t}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.55)' }}>{p.d}</div>
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
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.85 0.1 62)' }}>{valueLabel}</div>
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

function CastCard({ c, expanded, onToggle, onRemove, onPatch, onToggleSelfTag }: {
  c: Character; expanded: boolean; onToggle: () => void; onRemove: () => void;
  onPatch: (p: Partial<Character>) => void; onToggleSelfTag: () => void;
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
                      border: i === 0 ? '2px solid oklch(0.85 0.1 62)' : '1px solid rgba(255,255,255,0.16)',
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
          </div>
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          <Field label="Who they are"><textarea rows={3} defaultValue={c.summary} onBlur={(e) => onPatch({ summary: e.target.value })} /></Field>
          <Field label="Backstory"><textarea rows={2} defaultValue={c.backstory} onBlur={(e) => onPatch({ backstory: e.target.value })} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <Field label="Desires"><textarea rows={2} defaultValue={c.desires} onBlur={(e) => onPatch({ desires: e.target.value })} /></Field>
            <Field label="Fears"><textarea rows={2} defaultValue={c.fears} onBlur={(e) => onPatch({ fears: e.target.value })} /></Field>
          </div>
          <Field label="Secrets"><textarea rows={2} defaultValue={c.secrets} onBlur={(e) => onPatch({ secrets: e.target.value })} /></Field>
          <Field label="Anchors" note="one per line — never broken">
            <textarea rows={2} defaultValue={c.anchors.join('\n')} onBlur={(e) => onPatch({ anchors: e.target.value.split('\n').filter((l) => l.trim()) })} />
          </Field>
        </div>
      )}
    </div>
  );
}

function PlaceCard({ l, expanded, onToggle, onRemove, onPatch }: {
  l: Location; expanded: boolean; onToggle: () => void; onRemove: () => void; onPatch: (p: Partial<Location>) => void;
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
    <div className="glass" style={{ borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={onToggle}>
        <div style={{ ...avatarStyle(l.hue, 34), flexShrink: 0, ...(l.portrait ? { backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}) }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>{l.name || 'unnamed'}</div>
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
          </div>
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          <Field label="What it is"><textarea rows={3} defaultValue={l.summary} onBlur={(e) => onPatch({ summary: e.target.value })} /></Field>
          <Field label="Atmosphere"><textarea rows={2} defaultValue={l.atmosphere} onBlur={(e) => onPatch({ atmosphere: e.target.value })} /></Field>
          <Field label="History"><textarea rows={2} defaultValue={l.history} onBlur={(e) => onPatch({ history: e.target.value })} /></Field>
          <Field label="Rules" note="one per line — never broken">
            <textarea rows={2} defaultValue={l.rules.join('\n')} onBlur={(e) => onPatch({ rules: e.target.value.split('\n').filter((r) => r.trim()) })} />
          </Field>
        </div>
      )}
    </div>
  );
}

function OptionList({ options, value, onChange }: {
  options: Array<{ label: string; line: string }>; value: number; onChange: (i: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {options.map((o, i) => {
        const active = value === i;
        return (
          <button key={o.label} onClick={() => onChange(i)} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            border: `1px solid rgba(255,255,255,${active ? '0.2' : '0.09'})`,
            background: active ? 'linear-gradient(150deg, rgba(224,165,95,0.13), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)',
            color: active ? '#f6f4f0' : 'rgba(236,234,230,0.62)',
            borderRadius: 14, padding: '15px 17px', cursor: 'pointer', backdropFilter: 'blur(16px)'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'left', flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{o.label}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.68 }}>{o.line}</div>
            </div>
            <div style={{
              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
              border: `1px solid ${active ? 'oklch(0.85 0.1 62)' : 'rgba(255,255,255,0.18)'}`,
              background: active ? 'oklch(0.85 0.1 62)' : 'transparent',
              boxShadow: active ? 'inset 0 0 0 3px rgba(8,9,12,0.9)' : 'none'
            }} />
          </button>
        );
      })}
    </div>
  );
}
