import { useState } from 'react';
import { fleshOutNarratorRules, fleshOutPremise, fleshOutWorldLore } from '../ai/engine';
import { db } from '../db';
import { ModelPicker } from '../screens/Settings';
import { useApp } from '../store/app';
import type { Character, Episode, Location, Season, World, WorldAISettings } from '../types';
import { Bar, Chip, ErrorNote, Field, Mono, Sheet, Spinner, Toggle } from '../ui/bits';
import { avatarStyle } from '../ui/theme';
import { emptyCharacter, emptyLocation, worldCalendar } from '../worldOps';

type Tab = 'lore' | 'plot' | 'instructions' | 'settings' | 'cast' | 'locations';

const MONO_INPUT = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 } as const;

/**
 * Live world editing without leaving the story. Every field writes straight to the
 * database on blur; prompts are rebuilt from the database each turn, so changes
 * take effect on the very next AI response.
 */
export function WorldEditorSheet({ open, onClose, narrow, world, season, episode, characters, locations }: {
  open: boolean;
  onClose: () => void;
  narrow: boolean;
  world: World;
  season: Season;
  episode: Episode;
  characters: Character[];
  locations: Location[];
}) {
  const go = useApp((s) => s.go);
  const goCast = useApp((s) => s.goCast);
  const goLocations = useApp((s) => s.goLocations);
  const [tab, setTab] = useState<Tab>('lore');
  const [charId, setCharId] = useState<string | null>(null);
  const [locId, setLocId] = useState<string | null>(null);
  const selected = characters.find((c) => c.id === charId) ?? null;
  const selectedLoc = locations.find((l) => l.id === locId) ?? null;

  const [aiVersion, setAiVersion] = useState(0);
  const [flesh, setFlesh] = useState<{ busy: 'lore' | 'plot' | 'rules' | null; error: string; errorFor: 'lore' | 'plot' | 'rules' | null }>(
    { busy: null, error: '', errorFor: null }
  );
  const [undoLore, setUndoLore] = useState<{ title: string; line: string; bible: string } | null>(null);
  const [undoPlot, setUndoPlot] = useState<string | null>(null);
  const [undoRules, setUndoRules] = useState<string[] | null>(null);

  const patchWorld = (p: Partial<World>) => void db.worlds.update(world.id, { ...p, updatedAt: Date.now() });
  const patchAI = (p: Partial<WorldAISettings>) => patchWorld({ ai: { ...world.ai, ...p } });
  const patchSeason = (p: Partial<Season>) => void db.seasons.update(season.id, { ...p, updatedAt: Date.now() });
  const patchEpisode = (p: Partial<Episode>) => void db.episodes.update(episode.id, { ...p, updatedAt: Date.now() });
  const patchChar = (id: string, p: Partial<Character>) =>
    void db.characters.update(id, { ...p, updatedAt: Date.now() });
  const patchLoc = (id: string, p: Partial<Location>) =>
    void db.locations.update(id, { ...p, updatedAt: Date.now() }).then(() => {
      // Keep episode location name in sync if this place is the active setting.
      if (episode.locationId === id && typeof p.name === 'string') {
        void db.episodes.update(episode.id, { location: p.name });
      }
    });

  const runFlesh = async (kind: 'lore' | 'plot' | 'rules', task: () => Promise<void>) => {
    setFlesh({ busy: kind, error: '', errorFor: null });
    try {
      await task();
      setAiVersion((v) => v + 1);
      setFlesh({ busy: null, error: '', errorFor: null });
    } catch (e) {
      setFlesh({ busy: null, error: e instanceof Error ? e.message : String(e), errorFor: kind });
    }
  };

  const handleFleshLore = () => void runFlesh('lore', async () => {
    const result = await fleshOutWorldLore(world);
    setUndoLore({ title: world.title, line: world.line, bible: world.bible });
    patchWorld(result);
  });
  const handleFleshPlot = () => void runFlesh('plot', async () => {
    const premise = await fleshOutPremise(world, season);
    setUndoPlot(season.premise);
    patchSeason({ premise });
  });
  const handleFleshRules = () => void runFlesh('rules', async () => {
    const narratorRules = await fleshOutNarratorRules(world);
    setUndoRules(world.ai.narratorRules);
    patchAI({ narratorRules });
  });

  const undoLoreFn = () => { if (undoLore) { patchWorld(undoLore); setAiVersion((v) => v + 1); } setUndoLore(null); };
  const undoPlotFn = () => { if (undoPlot !== null) { patchSeason({ premise: undoPlot }); setAiVersion((v) => v + 1); } setUndoPlot(null); };
  const undoRulesFn = () => { if (undoRules) { patchAI({ narratorRules: undoRules }); setAiVersion((v) => v + 1); } setUndoRules(null); };

  return (
    <Sheet open={open} onClose={onClose} narrow={narrow} width={520}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Edit the world</div>
          <Mono style={{ fontSize: 9 }}>changes apply from the next turn</Mono>
        </div>
        <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={onClose}>×</button>
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {(['lore', 'plot', 'instructions', 'settings', 'cast', 'locations'] as const).map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Chip>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16, paddingRight: 2 }}>
        {tab === 'lore' && (
          <>
            <Field label="Title">
              <input key={world.id + '-title-' + aiVersion} defaultValue={world.title}
                onBlur={(e) => patchWorld({ title: e.target.value.trim() || world.title })} />
            </Field>
            <Field label="Logline" note="the one-line pitch">
              <input key={world.id + '-line-' + aiVersion} defaultValue={world.line}
                onBlur={(e) => patchWorld({ line: e.target.value })} />
            </Field>
            <Field label="World bible — lore" note="setting, rules, pressures · in every prompt">
              <textarea key={world.id + '-bible-' + aiVersion} rows={14} defaultValue={world.bible}
                onBlur={(e) => patchWorld({ bible: e.target.value })}
                style={{ fontFamily: 'Spectral, serif', fontSize: 14.5, lineHeight: 1.65 }} />
            </Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}
                  disabled={flesh.busy === 'lore'} onClick={handleFleshLore}>
                  {flesh.busy === 'lore' ? 'Working…' : '✦ Flesh out with AI'}
                </button>
                {undoLore && <button className="btn-quiet" style={{ fontSize: 11 }} onClick={undoLoreFn}>undo</button>}
              </div>
              {flesh.busy === 'lore' && <Spinner label="the utility model is fleshing out the lore" />}
              {flesh.errorFor === 'lore' && (
                <ErrorNote error={flesh.error} onDismiss={() => setFlesh({ busy: null, error: '', errorFor: null })} />
              )}
            </div>
          </>
        )}

        {tab === 'plot' && (
          <>
            <Field label={`Season ${season.number} premise`} note="the plot the narrator is steering toward">
              <textarea key={season.id + '-premise-' + aiVersion} rows={5} defaultValue={season.premise}
                onBlur={(e) => patchSeason({ premise: e.target.value })}
                style={{ fontFamily: 'Spectral, serif', fontSize: 14.5, lineHeight: 1.65 }} />
            </Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}
                  disabled={flesh.busy === 'plot'} onClick={handleFleshPlot}>
                  {flesh.busy === 'plot' ? 'Working…' : '✦ Flesh out with AI'}
                </button>
                {undoPlot !== null && <button className="btn-quiet" style={{ fontSize: 11 }} onClick={undoPlotFn}>undo</button>}
              </div>
              {flesh.busy === 'plot' && <Spinner label="the utility model is fleshing out the premise" />}
              {flesh.errorFor === 'plot' && (
                <ErrorNote error={flesh.error} onDismiss={() => setFlesh({ busy: null, error: '', errorFor: null })} />
              )}
            </div>
            <Field label="Calendar" note="advances automatically each episode and season gap">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#f0eee9' }}>
                  Day {worldCalendar(world).currentDay}
                </div>
                <Chip onClick={() => patchWorld({ calendar: { ...worldCalendar(world), currentDay: worldCalendar(world).currentDay + 1 } })}>+1 day</Chip>
                <Chip onClick={() => patchWorld({ calendar: { ...worldCalendar(world), currentDay: worldCalendar(world).currentDay + 7 } })}>+7 days</Chip>
              </div>
              <textarea key={world.id + '-cal-system'} rows={2} defaultValue={worldCalendar(world).system}
                onBlur={(e) => patchWorld({ calendar: { ...worldCalendar(world), system: e.target.value } })}
                placeholder="Optional — describe this world's calendar system (month names, seasons, etc). Left blank, the narrator just tracks the day count." />
            </Field>
            <Field label="Season title" note="optional">
              <input key={season.id + '-title'} defaultValue={season.title}
                onBlur={(e) => patchSeason({ title: e.target.value })} />
            </Field>
            <Field label={`Episode ${episode.number} title`} note="optional">
              <input key={episode.id + '-title'} defaultValue={episode.title}
                onBlur={(e) => patchEpisode({ title: e.target.value })} />
            </Field>
            <Field label="Episode location note" note="free text · pick a saved location from the Locations tab or Story Direct">
              <textarea key={episode.id + '-loc'} rows={2} defaultValue={episode.location}
                onBlur={(e) => patchEpisode({ location: e.target.value, locationId: null })} />
            </Field>
            {season.bible && (
              <Field label="Season recap — previously on" note="carried from the last season">
                <textarea key={season.id + '-recap'} rows={6} defaultValue={season.bible.recap}
                  onBlur={(e) => patchSeason({ bible: { ...season.bible!, recap: e.target.value } })}
                  style={{ fontFamily: 'Spectral, serif', fontSize: 14, lineHeight: 1.6 }} />
              </Field>
            )}
          </>
        )}

        {tab === 'instructions' && (
          <>
            <Field label="World instructions" note="passed to the model verbatim, every request">
              <textarea key={world.id + '-custom'} rows={6} defaultValue={world.ai.customInstructions}
                onBlur={(e) => patchAI({ customInstructions: e.target.value })}
                placeholder="Themes to circle, imagery to reuse, what the story is really about…" />
            </Field>
            <Field label="Narrator hard rules" note="one per line — never broken">
              <textarea key={world.id + '-rules-' + aiVersion} rows={4} defaultValue={world.ai.narratorRules.join('\n')}
                onBlur={(e) => patchAI({ narratorRules: e.target.value.split('\n').filter((l) => l.trim()) })}
                placeholder={'Never skip time without asking.\nNever kill a named character without the player in the scene.'} />
            </Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}
                  disabled={flesh.busy === 'rules'} onClick={handleFleshRules}>
                  {flesh.busy === 'rules' ? 'Working…' : '✦ Flesh out with AI'}
                </button>
                {undoRules && <button className="btn-quiet" style={{ fontSize: 11 }} onClick={undoRulesFn}>undo</button>}
              </div>
              {flesh.busy === 'rules' && <Spinner label="the utility model is proposing narrator rules" />}
              {flesh.errorFor === 'rules' && (
                <ErrorNote error={flesh.error} onDismiss={() => setFlesh({ busy: null, error: '', errorFor: null })} />
              )}
            </div>
            <Field label="Content boundaries" note="lines that are never crossed">
              <textarea key={world.id + '-content'} rows={3} defaultValue={world.ai.contentNotes}
                onBlur={(e) => patchAI({ contentNotes: e.target.value })} />
            </Field>
          </>
        )}

        {tab === 'settings' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <Field label="Point of view">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['second', 'first', 'third'] as const).map((pov) => (
                    <Chip key={pov} active={world.ai.pov === pov} onClick={() => patchAI({ pov })}>{pov}</Chip>
                  ))}
                </div>
              </Field>
              <Field label="Tense">
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['present', 'past'] as const).map((tense) => (
                    <Chip key={tense} active={world.ai.tense === tense} onClick={() => patchAI({ tense })}>{tense}</Chip>
                  ))}
                </div>
              </Field>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Toggle on={world.ai.mature} onClick={() => patchAI({ mature: !world.ai.mature })} />
              <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.6)' }}>
                {world.ai.mature ? 'Adult world — unrestricted' : 'General audience'}
              </div>
            </div>

            <MiniSlider
              label="Purple-ness"
              value={world.ai.proseDensity}
              onChange={(v) => patchAI({ proseDensity: v })}
              valueLabel={world.ai.proseDensity < 34 ? 'restrained' : world.ai.proseDensity < 67 ? 'balanced' : 'ornamental'}
            />
            <MiniSlider
              label="Pacing"
              value={world.ai.pacing}
              onChange={(v) => patchAI({ pacing: v })}
              valueLabel={world.ai.pacing < 34 ? 'slow-burn' : world.ai.pacing < 67 ? 'measured' : 'propulsive'}
            />

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Prose model for this world" note="unset = global default">
                <ModelPicker
                  value={world.proseModel}
                  onChange={(m) => void db.worlds.update(world.id, { proseModel: m })}
                />
                {world.proseModel && (
                  <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                    onClick={() => void db.worlds.update(world.id, { proseModel: null })}>use global default</button>
                )}
              </Field>
              <Field label="Utility model for this world" note="unset = global default">
                <ModelPicker
                  value={world.utilityModel}
                  onChange={(m) => void db.worlds.update(world.id, { utilityModel: m })}
                />
                {world.utilityModel && (
                  <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                    onClick={() => void db.worlds.update(world.id, { utilityModel: null })}>use global default</button>
                )}
              </Field>
            </div>

            <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
              onClick={() => { onClose(); go('settings'); }}>
              providers, keys & app settings → Settings
            </button>
          </>
        )}

        {tab === 'cast' && !selected && (
          <>
            <Mono style={{ fontSize: 9 }}>pick a character to edit</Mono>
            {characters.map((c) => (
              <div key={c.id} onClick={() => setCharId(c.id)} className="hover-bright" style={{
                display: 'flex', gap: 11, alignItems: 'center', padding: '10px 12px', borderRadius: 13,
                cursor: 'pointer', border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)'
              }}>
                <div style={avatarStyle(c.hue, 34)} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>
                    {c.name || 'unnamed'}{c.isPlayer ? ' · player' : ''}
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.role || 'no role set'}
                  </div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Chip onClick={() => {
                const c = emptyCharacter(world.id, { name: 'New character' });
                void db.characters.add(c).then(() => setCharId(c.id));
              }}>+ new character</Chip>
              <Chip onClick={() => { onClose(); goCast(); }}>full editor → Cast</Chip>
            </div>
          </>
        )}

        {tab === 'cast' && selected && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <button className="btn-quiet" style={{ fontSize: 11, padding: '4px 6px' }} onClick={() => setCharId(null)}>← cast</button>
              <div style={avatarStyle(selected.hue, 30)} />
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f0eee9', flex: 1 }}>
                {selected.name || 'unnamed'}{selected.isPlayer ? ' · player' : ''}
              </div>
              <button className="btn-quiet" style={{ fontSize: 10 }} onClick={() => { onClose(); goCast(selected.id); }}>full editor</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <Field label="Name">
                <input key={selected.id + '-name'} defaultValue={selected.name}
                  onBlur={(e) => patchChar(selected.id, { name: e.target.value })} />
              </Field>
              <Field label="Role">
                <input key={selected.id + '-role'} defaultValue={selected.role}
                  onBlur={(e) => patchChar(selected.id, { role: e.target.value })} />
              </Field>
            </div>
            <Field label="Who they are" note="summary in every prompt when in scene">
              <textarea key={selected.id + '-summary'} rows={4} defaultValue={selected.summary}
                onBlur={(e) => patchChar(selected.id, { summary: e.target.value })} />
            </Field>
            <Field label="Appearance">
              <textarea key={selected.id + '-appearance'} rows={2} defaultValue={selected.appearance}
                onBlur={(e) => patchChar(selected.id, { appearance: e.target.value })} />
            </Field>
            <Field label="Mannerisms" note="recurring physical habits and tics">
              <textarea key={selected.id + '-mannerisms'} rows={2} defaultValue={selected.mannerisms ?? ''}
                onBlur={(e) => patchChar(selected.id, { mannerisms: e.target.value })} />
            </Field>
            <Field label="Backstory" note="revealed only in earned fragments">
              <textarea key={selected.id + '-backstory'} rows={3} defaultValue={selected.backstory ?? ''}
                onBlur={(e) => patchChar(selected.id, { backstory: e.target.value })} />
            </Field>
            <Field label="Voice" note="how they talk">
              <textarea key={selected.id + '-voice'} rows={2} defaultValue={selected.speechStyle}
                onBlur={(e) => patchChar(selected.id, { speechStyle: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <Field label="Desires">
                <textarea key={selected.id + '-desires'} rows={2} defaultValue={selected.desires}
                  onBlur={(e) => patchChar(selected.id, { desires: e.target.value })} />
              </Field>
              <Field label="Fears">
                <textarea key={selected.id + '-fears'} rows={2} defaultValue={selected.fears}
                  onBlur={(e) => patchChar(selected.id, { fears: e.target.value })} />
              </Field>
            </div>
            <Field label="Secrets" note="acted on, never announced">
              <textarea key={selected.id + '-secrets'} rows={2} defaultValue={selected.secrets}
                onBlur={(e) => patchChar(selected.id, { secrets: e.target.value })} />
            </Field>
            <Field label="Must not know yet" note="the AI never lets them learn this">
              <textarea key={selected.id + '-mnk'} rows={2} defaultValue={selected.mustNotKnow}
                onBlur={(e) => patchChar(selected.id, { mustNotKnow: e.target.value })} />
            </Field>
            <Field label="Behaviour anchors" note="one per line — never broken">
              <textarea key={selected.id + '-anchors'} rows={3} defaultValue={selected.anchors.join('\n')}
                onBlur={(e) => patchChar(selected.id, { anchors: e.target.value.split('\n').filter((l) => l.trim()) })} />
            </Field>
            <Field label="AI directives for this character" note="passed verbatim">
              <textarea key={selected.id + '-ci'} rows={3} defaultValue={selected.customInstructions}
                onBlur={(e) => patchChar(selected.id, { customInstructions: e.target.value })} />
            </Field>
            <Mono style={{ fontSize: 9 }}>current state — right now in the story</Mono>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {([['goal', 'Goal'], ['emotion', 'Emotion'], ['location', 'Location'], ['condition', 'Condition']] as const).map(([k, label]) => (
                <Field key={k} label={label}>
                  <input key={selected.id + '-st-' + k} defaultValue={selected.state[k]} style={MONO_INPUT}
                    onBlur={(e) => patchChar(selected.id, { state: { ...selected.state, [k]: e.target.value } })} />
                </Field>
              ))}
            </div>
          </>
        )}

        {tab === 'locations' && !selectedLoc && (
          <>
            <Mono style={{ fontSize: 9 }}>pick a location to edit</Mono>
            {locations.map((l) => (
              <div key={l.id} onClick={() => setLocId(l.id)} className="hover-bright" style={{
                display: 'flex', gap: 11, alignItems: 'center', padding: '10px 12px', borderRadius: 13,
                cursor: 'pointer', border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)'
              }}>
                <div style={l.portrait
                  ? { width: 34, height: 34, borderRadius: '50%', flexShrink: 0, backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid rgba(255,255,255,0.18)' }
                  : avatarStyle(l.hue, 34)} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>
                    {l.name || 'unnamed'}{episode.locationId === l.id ? ' · scene' : ''}
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.tagline || 'no tagline'}
                  </div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Chip onClick={() => {
                const l = emptyLocation(world.id, { name: 'New location' });
                void db.locations.add(l).then(() => setLocId(l.id));
              }}>+ new location</Chip>
              <Chip onClick={() => { onClose(); goLocations(); }}>full editor → Locations</Chip>
            </div>
          </>
        )}

        {tab === 'locations' && selectedLoc && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <button className="btn-quiet" style={{ fontSize: 11, padding: '4px 6px' }} onClick={() => setLocId(null)}>← locations</button>
              <div style={selectedLoc.portrait
                ? { width: 30, height: 30, borderRadius: '50%', flexShrink: 0, backgroundImage: `url(${selectedLoc.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid rgba(255,255,255,0.18)' }
                : avatarStyle(selectedLoc.hue, 30)} />
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f0eee9', flex: 1 }}>
                {selectedLoc.name || 'unnamed'}
              </div>
              <button className="btn-quiet" style={{ fontSize: 10 }} onClick={() => {
                void db.episodes.update(episode.id, {
                  locationId: selectedLoc.id,
                  location: selectedLoc.name,
                  ...(selectedLoc.portrait ? { image: selectedLoc.portrait } : {})
                });
              }}>use as scene</button>
              <button className="btn-quiet" style={{ fontSize: 10 }} onClick={() => { onClose(); goLocations(selectedLoc.id); }}>full editor</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <Field label="Name">
                <input key={selectedLoc.id + '-name'} defaultValue={selectedLoc.name}
                  onBlur={(e) => patchLoc(selectedLoc.id, { name: e.target.value })} />
              </Field>
              <Field label="Tagline">
                <input key={selectedLoc.id + '-tag'} defaultValue={selectedLoc.tagline}
                  onBlur={(e) => patchLoc(selectedLoc.id, { tagline: e.target.value })} />
              </Field>
            </div>
            <Field label="Summary" note="what the place is">
              <textarea key={selectedLoc.id + '-summary'} rows={3} defaultValue={selectedLoc.summary}
                onBlur={(e) => patchLoc(selectedLoc.id, { summary: e.target.value })} />
            </Field>
            <Field label="Atmosphere" note="sensory detail the narrator leans on">
              <textarea key={selectedLoc.id + '-atm'} rows={3} defaultValue={selectedLoc.atmosphere}
                onBlur={(e) => patchLoc(selectedLoc.id, { atmosphere: e.target.value })} />
            </Field>
            <Field label="Features">
              <textarea key={selectedLoc.id + '-feat'} rows={2} defaultValue={selectedLoc.features}
                onBlur={(e) => patchLoc(selectedLoc.id, { features: e.target.value })} />
            </Field>
            <Field label="Hard rules" note="one per line — never broken here">
              <textarea key={selectedLoc.id + '-rules'} rows={3} defaultValue={selectedLoc.rules.join('\n')}
                onBlur={(e) => patchLoc(selectedLoc.id, { rules: e.target.value.split('\n').filter((x) => x.trim()) })} />
            </Field>
            <Field label="Current state">
              <textarea key={selectedLoc.id + '-state'} rows={2} defaultValue={selectedLoc.currentState}
                onBlur={(e) => patchLoc(selectedLoc.id, { currentState: e.target.value })} />
            </Field>
            <Field label="AI directives for this location" note="passed verbatim">
              <textarea key={selectedLoc.id + '-ci'} rows={2} defaultValue={selectedLoc.customInstructions}
                onBlur={(e) => patchLoc(selectedLoc.id, { customInstructions: e.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Sheet>
  );
}

function MiniSlider({ label, value, onChange, valueLabel }: {
  label: string; value: number; onChange: (v: number) => void; valueLabel: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(236,234,230,0.9)' }}>{label}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.85 0.1 62)' }}>{valueLabel}</div>
      </div>
      <Bar pct={value} />
      <input
        type="range" min={0} max={100} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
    </div>
  );
}
