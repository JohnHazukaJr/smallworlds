import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type ReactNode } from 'react';
import { fleshOutNarratorRules, fleshOutPremise, fleshOutWorldLore } from '../ai/engine';
import {
  episodeSceneDay, preferBucketsForEpisodes, selectDirectorFacts, selectDirectorThreads
} from '../ai/prompts';
import { db, safeWrite } from '../db';
import { evaluateCalendarEvents } from '../calendarEvents';
import { formatUserError } from '../errors';
import { ModelPicker } from '../screens/Settings';
import { useApp } from '../store/app';
import type {
  Character, ContinuityFact, Episode, Location, OpenThread, Season, World, WorldAISettings
} from '../types';
import { Bar, Chip, ErrorNote, Field, Mono, Sheet, Spinner, Toggle } from '../ui/bits';
import { avatarStyle } from '../ui/theme';
import {
  advanceMonths, calendarPatch, dayFromParts, emptyCharacter, emptyLocation,
  formatEpisodeDateRange, formatStoryDate, formatStoryDateShort, partsForDay, PLOT_TARGET_CAP,
  worldCalendar
} from '../worldOps';

type Tab = 'context' | 'lore' | 'plot' | 'instructions' | 'settings' | 'cast' | 'locations';

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
  const [tab, setTab] = useState<Tab>('context');
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
  const [saveError, setSaveError] = useState('');

  const onSaveFail = (msg: string) => setSaveError(msg);
  const patchWorld = (p: Partial<World>) =>
    void safeWrite(() => db.worlds.update(world.id, { ...p, updatedAt: Date.now() }), onSaveFail);
  const patchAI = (p: Partial<WorldAISettings>) => patchWorld({ ai: { ...world.ai, ...p } });
  const patchSeason = (p: Partial<Season>) =>
    void safeWrite(() => db.seasons.update(season.id, { ...p, updatedAt: Date.now() }), onSaveFail);
  const patchEpisode = (p: Partial<Episode>) =>
    void safeWrite(() => db.episodes.update(episode.id, { ...p, updatedAt: Date.now() }), onSaveFail);
  const patchChar = (id: string, p: Partial<Character>) =>
    void safeWrite(() => db.characters.update(id, { ...p, updatedAt: Date.now() }), onSaveFail);
  const patchLoc = (id: string, p: Partial<Location>) =>
    void safeWrite(async () => {
      await db.locations.update(id, { ...p, updatedAt: Date.now() });
      if (episode.locationId === id && typeof p.name === 'string') {
        await db.episodes.update(episode.id, { location: p.name, updatedAt: Date.now() });
      }
    }, onSaveFail);

  const runFlesh = async (kind: 'lore' | 'plot' | 'rules', task: () => Promise<void>) => {
    setFlesh({ busy: kind, error: '', errorFor: null });
    try {
      await task();
      setAiVersion((v) => v + 1);
      setFlesh({ busy: null, error: '', errorFor: null });
    } catch (e) {
      setFlesh({ busy: null, error: formatUserError(e), errorFor: kind });
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
  const monoPx = narrow ? 11 : 9;

  return (
    <Sheet open={open} onClose={onClose} narrow={narrow} width={520}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Edit the world</div>
          <Mono style={{ fontSize: monoPx }}>changes apply from the next turn</Mono>
        </div>
        <button className="btn-ghost" style={{ width: narrow ? 44 : 30, height: narrow ? 44 : 30, padding: 0, flexShrink: 0, fontSize: narrow ? 18 : undefined }} onClick={onClose}>×</button>
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {(['context', 'lore', 'plot', 'instructions', 'settings', 'cast', 'locations'] as const).map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)}>
            {t === 'context' ? 'Context' : t[0].toUpperCase() + t.slice(1)}
          </Chip>
        ))}
      </div>

      {saveError && <ErrorNote error={saveError} onDismiss={() => setSaveError('')} />}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16, paddingRight: 2 }}>
        {tab === 'context' && (
          <ContextPreview
            world={world} season={season} episode={episode}
            characters={characters} locations={locations}
            onEditLore={() => setTab('lore')}
            onEditPlot={() => setTab('plot')}
            monoPx={monoPx}
          />
        )}

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
            <Field label="World bible — lore" note="setting, rules, pressures · narrator / character / guest">
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
            <Field label={`Season ${season.number} premise`} note="living plot pressure — updates when you wrap an episode">
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
            <Field label="Calendar" note="full tracker also lives in Story → Direct; advances on episode end by your rule">
              {(() => {
                const cal = worldCalendar(world);
                const today = partsForDay(cal, cal.currentDay);
                const monthLen = cal.monthLengths[today.monthIndex] ?? 30;
                const patchCal = (p: Parameters<typeof calendarPatch>[1]) =>
                  patchWorld({ calendar: calendarPatch(world, p) });
                /** Match Direct calendar: advancing today also stamps active episode scene day. */
                const setDay = (day: number) => {
                  const next = Math.max(1, Math.floor(day));
                  const fromDay = cal.currentDay;
                  void safeWrite(async () => {
                    await db.worlds.update(world.id, {
                      calendar: calendarPatch(world, { currentDay: next }),
                      updatedAt: Date.now()
                    });
                    if (episode.status === 'active') {
                      await db.episodes.update(episode.id, { storyDay: next, updatedAt: Date.now() });
                    }
                    if (next > fromDay) {
                      await evaluateCalendarEvents({
                        worldId: world.id,
                        seasonId: season.id,
                        fromDay,
                        toDay: next,
                        mode: 'advance',
                        world
                      });
                    }
                  }, onSaveFail);
                };
                const setParts = (year: number, monthIndex: number, dayOfMonth: number) =>
                  setDay(dayFromParts(cal, year, monthIndex, dayOfMonth));
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#f0eee9' }}>
                      {formatStoryDateShort(cal, cal.currentDay)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <Chip onClick={() => setDay(cal.currentDay - 1)}>−1</Chip>
                      <Chip onClick={() => setDay(cal.currentDay + 1)}>+1 day</Chip>
                      <Chip onClick={() => setDay(cal.currentDay + 7)}>+7 days</Chip>
                      <Chip onClick={() => setDay(advanceMonths(cal, cal.currentDay, 1))}>+1 month</Chip>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1.4fr 0.9fr', gap: 8 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
                        Day
                        <input
                          type="number"
                          min={1}
                          max={monthLen}
                          value={today.dayOfMonth}
                          onChange={(e) => setParts(today.year, today.monthIndex, Number(e.target.value) || 1)}
                          style={{ ...MONO_INPUT, width: '100%' }}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
                        Month
                        <select
                          value={today.monthIndex}
                          onChange={(e) => setParts(today.year, Number(e.target.value), today.dayOfMonth)}
                          style={{ fontSize: 13, padding: '8px 10px' }}
                        >
                          {cal.months.map((name, i) => (
                            <option key={name + i} value={i}>{name}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
                        Year
                        <input
                          type="number"
                          value={today.year}
                          onChange={(e) => setParts(Number(e.target.value) || cal.yearOne, today.monthIndex, today.dayOfMonth)}
                          style={{ ...MONO_INPUT, width: '100%' }}
                        />
                      </label>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.75 }}>
                      Absolute day
                      <input
                        type="number"
                        min={1}
                        value={cal.currentDay}
                        onChange={(e) => setDay(Math.max(1, Number(e.target.value) || 1))}
                        style={{ width: 72, ...MONO_INPUT }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: 0.75 }}>
                      Days to advance when an episode ends
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        {[0, 1, 2, 7, 14].map((n) => (
                          <Chip key={n} active={cal.episodeAdvanceDays === n} onClick={() => patchCal({ episodeAdvanceDays: n })}>
                            {n === 0 ? 'same day' : `+${n}`}
                          </Chip>
                        ))}
                        <input
                          type="number"
                          min={0}
                          max={365}
                          value={cal.episodeAdvanceDays}
                          onChange={(e) => patchCal({
                            episodeAdvanceDays: Math.max(0, Math.min(365, Number(e.target.value) || 0))
                          })}
                          style={{ width: 64, ...MONO_INPUT }}
                          title="Custom advance days"
                        />
                      </div>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: 0.75 }}>
                      Weekday of story day 1
                      <select
                        value={cal.dayOneWeekday}
                        onChange={(e) => patchCal({ dayOneWeekday: Number(e.target.value) })}
                        style={{ fontSize: 13, padding: '8px 10px' }}
                      >
                        {cal.weekdays.map((name, i) => (
                          <option key={name + i} value={i}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.4fr 0.9fr', gap: 8 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
                        Month of day 1
                        <select
                          value={cal.dayOneMonth}
                          onChange={(e) => patchCal({ dayOneMonth: Number(e.target.value) })}
                          style={{ fontSize: 13, padding: '8px 10px' }}
                        >
                          {cal.months.map((name, i) => (
                            <option key={name + i} value={i}>{name}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
                        Date of day 1
                        <input
                          type="number"
                          min={1}
                          max={cal.monthLengths[cal.dayOneMonth] ?? 30}
                          value={cal.dayOneDate}
                          onChange={(e) => patchCal({ dayOneDate: Math.max(1, Number(e.target.value) || 1) })}
                          style={{ ...MONO_INPUT, width: '100%' }}
                        />
                      </label>
                    </div>
                    <input
                      key={world.id + '-weekdays'}
                      defaultValue={cal.weekdays.join(', ')}
                      onBlur={(e) => {
                        const weekdays = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                        if (weekdays.length) {
                          patchCal({
                            weekdays,
                            dayOneWeekday: Math.min(cal.dayOneWeekday, weekdays.length - 1)
                          });
                        }
                      }}
                      placeholder="Weekday names, comma-separated"
                    />
                    <input
                      key={world.id + '-months'}
                      defaultValue={cal.months.join(', ')}
                      onBlur={(e) => {
                        const months = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                        if (!months.length) return;
                        const monthLengths = months.map((_, i) => cal.monthLengths[i] ?? 30);
                        patchCal({
                          months,
                          monthLengths,
                          dayOneMonth: Math.min(cal.dayOneMonth, months.length - 1)
                        });
                      }}
                      placeholder="Month names, comma-separated"
                    />
                    <input
                      key={world.id + '-month-lengths'}
                      defaultValue={cal.monthLengths.join(', ')}
                      onBlur={(e) => {
                        const monthLengths = e.target.value
                          .split(',')
                          .map((s) => Math.max(1, Math.min(90, Number(s.trim()) || 30)));
                        if (!monthLengths.length) return;
                        while (monthLengths.length < cal.months.length) monthLengths.push(30);
                        patchCal({ monthLengths: monthLengths.slice(0, cal.months.length) });
                      }}
                      placeholder="Days per month, comma-separated"
                    />
                    <textarea key={world.id + '-cal-system'} rows={2} defaultValue={cal.system}
                      onBlur={(e) => patchCal({ system: e.target.value })}
                      placeholder="Optional — era name, feast days. Narrator follows this verbatim." />
                  </div>
                );
              })()}
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
                onBlur={(e) => {
                  const text = e.target.value;
                  const linked = episode.locationId
                    ? locations.find((l) => l.id === episode.locationId)
                    : null;
                  const byName = locations.find(
                    (l) => l.name.trim() && l.name.trim().toLowerCase() === text.trim().toLowerCase()
                  );
                  const keepId = linked && linked.name.trim().toLowerCase() === text.trim().toLowerCase()
                    ? linked.id
                    : byName?.id ?? null;
                  patchEpisode({ location: text, locationId: keepId });
                }} />
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
            <Field label="World instructions" note="verbatim in narrator, character, and guest prompts">
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 12 }}>
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
                  onChange={(m) => patchWorld({ proseModel: m })}
                />
                {world.proseModel && (
                  <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                    onClick={() => patchWorld({ proseModel: null })}>use global default</button>
                )}
              </Field>
              <Field label="Utility model for this world" note="unset = global default">
                <ModelPicker
                  value={world.utilityModel}
                  onChange={(m) => patchWorld({ utilityModel: m })}
                />
                {world.utilityModel && (
                  <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                    onClick={() => patchWorld({ utilityModel: null })}>use global default</button>
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
            <Mono style={{ fontSize: monoPx }}>pick a character to edit</Mono>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
              <Field label="Name">
                <input key={selected.id + '-name'} defaultValue={selected.name}
                  onBlur={(e) => patchChar(selected.id, { name: e.target.value })} />
              </Field>
              <Field label="Role">
                <input key={selected.id + '-role'} defaultValue={selected.role}
                  onBlur={(e) => patchChar(selected.id, { role: e.target.value })} />
              </Field>
            </div>
            <Field label="Who they are" note="summary when in scene (narrator / speak)">
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
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
            <Field label="Behaviour anchors" note="one per line — when in scene (narrator / speak)">
              <textarea key={selected.id + '-anchors'} rows={3} defaultValue={selected.anchors.join('\n')}
                onBlur={(e) => patchChar(selected.id, { anchors: e.target.value.split('\n').filter((l) => l.trim()) })} />
            </Field>
            <Field label="AI directives for this character" note="verbatim when in scene (narrator / speak)">
              <textarea key={selected.id + '-ci'} rows={3} defaultValue={selected.customInstructions}
                onBlur={(e) => patchChar(selected.id, { customInstructions: e.target.value })} />
            </Field>
            <Mono style={{ fontSize: monoPx }}>current state — right now in the story</Mono>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
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
            <Mono style={{ fontSize: monoPx }}>pick a location to edit</Mono>
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
                patchEpisode({
                  locationId: selectedLoc.id,
                  location: selectedLoc.name,
                  ...(selectedLoc.portrait ? { image: selectedLoc.portrait } : {})
                });
              }}>use as scene</button>
              <button className="btn-quiet" style={{ fontSize: 10 }} onClick={() => { onClose(); goLocations(selectedLoc.id); }}>full editor</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
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
            <Field label="AI directives for this location" note="verbatim when this is the current scene">
              <textarea key={selectedLoc.id + '-ci'} rows={2} defaultValue={selectedLoc.customInstructions}
                onBlur={(e) => patchLoc(selectedLoc.id, { customInstructions: e.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Sheet>
  );
}

function clipPreview(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function ContextSection({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <Mono style={{ fontSize: 9, opacity: 0.55 }}>{title}</Mono>
        {note && <span style={{ fontSize: 11, opacity: 0.45 }}>{note}</span>}
      </div>
      <div style={{
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12,
        padding: '12px 14px', background: 'rgba(0,0,0,0.18)',
        display: 'flex', flexDirection: 'column', gap: 8,
        fontSize: 13, lineHeight: 1.55, color: 'rgba(236,234,230,0.88)'
      }}>
        {children}
      </div>
    </div>
  );
}

/** Soft mirror of director-plan context (plus a clipped world bible the narrator also sees). */
function ContextPreview({
  world, season, episode, characters, locations, onEditLore, onEditPlot, monoPx
}: {
  world: World;
  season: Season;
  episode: Episode;
  characters: Character[];
  locations: Location[];
  onEditLore: () => void;
  onEditPlot: () => void;
  monoPx: number;
}) {
  const continuity = useLiveQuery(
    () => db.continuity.where('seasonId').equals(season.id).toArray(),
    [season.id]
  ) ?? [];
  const threads = useLiveQuery(
    () => db.threads.where('seasonId').equals(season.id).filter((t) => t.status === 'open').toArray(),
    [season.id]
  ) ?? [];
  const priorEps = useLiveQuery(
    async () => {
      const all = await db.episodes.where('seasonId').equals(season.id).toArray();
      return all
        .filter((e) => e.number < episode.number && e.status === 'ended' && !!e.wrap?.recap?.trim())
        .sort((a, b) => a.number - b.number)
        .slice(-3);
    },
    [season.id, episode.number]
  ) ?? [];

  const cal = worldCalendar(world);
  const sceneDay = episodeSceneDay(episode, cal);
  const dateLine = formatEpisodeDateRange(cal, episode.storyDay, episode.storyDayEnd);
  const currentLoc = episode.locationId
    ? locations.find((l) => l.id === episode.locationId)
    : locations.find((l) => {
      const epLoc = episode.location.trim().toLowerCase();
      if (!epLoc || !l.name.trim()) return false;
      const n = l.name.toLowerCase();
      return epLoc.includes(n) || n.includes(epLoc);
    });
  const locName = episode.location.trim() || currentLoc?.name || '—';
  const inScene = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
  const player = characters.find((c) => c.isPlayer);
  const offScene = characters.filter((c) => !episode.castIds.includes(c.id) && !c.isPlayer);
  const guests = (episode.guests ?? []).filter((g) => {
    const active = episode.activeGuestIds;
    if (active === undefined) return true;
    return active.includes(g.id);
  });
  const prefer = preferBucketsForEpisodes(priorEps, episode);
  const facts = selectDirectorFacts(continuity, prefer);
  const openThreads = selectDirectorThreads(threads, prefer);
  // Match director: walls for all NPCs (enter-this-turn cast must be visible before castDelta).
  const walls = characters.filter((c) => !c.isPlayer && c.mustNotKnow?.trim());
  const bible = season.bible;
  const carried = (bible?.carriedBeats ?? [])
    .filter((b) => b.disposition === 'raise' || b.disposition === 'keep')
    .slice(0, 4);
  const worldClip = clipPreview(world.bible || world.line || '', 320);
  const running = episode.runningSummary?.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
        What the director plans from on the next turn (soft preview, not a raw dump). Narration also gets the world bible below.
      </div>

      <ContextSection title="now" note="episode · date · place · cast">
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: monoPx }}>
          S{season.number} · E{episode.number}
          {episode.title ? ` — ${episode.title}` : ''}
        </div>
        <div>Today (this scene): {formatStoryDateShort(cal, sceneDay)}</div>
        {cal.currentDay !== sceneDay && (
          <div style={{ opacity: 0.7 }}>World clock: {formatStoryDate(cal, cal.currentDay)}</div>
        )}
        <div style={{ opacity: 0.7 }}>Episode date: {dateLine}</div>
        {episode.dateNote?.trim() && (
          <div style={{ opacity: 0.7 }}>Date note: {episode.dateNote.trim()}</div>
        )}
        <div style={{ opacity: 0.7 }}>Location: {locName}</div>
        {currentLoc && currentLoc.rules.length > 0 && (
          <div style={{ opacity: 0.7 }}>
            HARD RULES ({currentLoc.rules.length}): {currentLoc.rules[0]}
            {currentLoc.rules.length > 1 ? '…' : ''}
          </div>
        )}
        {player && (
          <div style={{ opacity: 0.7 }}>Player: {player.name || 'unnamed'}</div>
        )}
        <div style={{ opacity: 0.7 }}>
          In scene:{' '}
          {inScene.length
            ? inScene.map((c) => `${c.name || 'unnamed'}${c.role ? ` (${c.role})` : ''}`).join(', ')
            : '(no NPCs)'}
        </div>
        <div style={{ opacity: 0.7 }}>
          Off scene:{' '}
          {offScene.length
            ? offScene.map((c) => c.name || 'unnamed').join(', ')
            : '(none)'}
        </div>
        {guests.length > 0 && (
          <div style={{ opacity: 0.7 }}>
            Walk-ons:{' '}
            {guests.map((g) => `${g.name}${g.brief ? ` — ${clipPreview(g.brief, 80)}` : ''}`).join('; ')}
          </div>
        )}
      </ContextSection>

      <ContextSection title="pressure" note="season premise">
        <div style={{ whiteSpace: 'pre-wrap' }}>
          {season.premise?.trim() || '(unwritten)'}
        </div>
        <button type="button" className="btn-quiet" style={{ fontSize: 11, alignSelf: 'flex-start' }} onClick={onEditPlot}>
          Edit in Plot
        </button>
      </ContextSection>

      {(() => {
        const epTargets = (episode.plotTargets ?? []).filter((t) => t.status === 'pending' && t.text.trim());
        const seaTargets = (season.plotTargets ?? []).filter((t) => t.status === 'pending' && t.text.trim());
        if (epTargets.length === 0 && seaTargets.length === 0) return null;
        return (
          <ContextSection title="plot targets" note="work toward when natural">
            {epTargets.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {epTargets.slice(0, PLOT_TARGET_CAP).map((t) => (
                  <li key={t.id}>{t.text}</li>
                ))}
              </ul>
            )}
            {seaTargets.length > 0 && (
              <>
                <div style={{ opacity: 0.55, fontSize: 12 }}>Season arc</div>
                <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.85 }}>
                  {seaTargets.slice(0, PLOT_TARGET_CAP).map((t) => (
                    <li key={t.id}>{t.text}</li>
                  ))}
                </ul>
              </>
            )}
          </ContextSection>
        );
      })()}

      {priorEps.length > 0 && (
        <ContextSection title="recent episode memory" note="last 2–3 wraps">
          {[...priorEps].reverse().map((ep, idx) => (
            <div key={ep.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: monoPx, opacity: 0.65 }}>
                E{ep.number}{ep.title ? ` — ${ep.title}` : ''}{idx === 0 ? ' · immediate prior' : ''}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {clipPreview(ep.wrap?.recap ?? '', idx === 0 ? 520 : 220)}
              </div>
              {(ep.wrap?.beats?.length ?? 0) > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.75 }}>
                  {(ep.wrap!.beats ?? []).slice(0, idx === 0 ? 6 : 2).map((b, i) => (
                    <li key={i}>
                      {clipPreview(b.text, 200)}
                      {b.consequence ? ` → ${clipPreview(b.consequence, 120)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {idx === 0 && (ep.wrap?.guestEffects?.length ?? 0) > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.65 }}>
                  {(ep.wrap!.guestEffects ?? []).slice(0, 4).map((g, i) => (
                    <li key={`g${i}`}>{clipPreview(g, 180)}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </ContextSection>
      )}

      {running && (
        <ContextSection title="earlier this episode" note="running summary · director clip">
          <div style={{ whiteSpace: 'pre-wrap' }}>{clipPreview(running, 400)}</div>
        </ContextSection>
      )}

      <ContextSection title="continuity" note={`director cap ${facts.length} / ${continuity.length}`}>
        {facts.length === 0 ? (
          <div style={{ opacity: 0.5 }}>(none yet)</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {facts.map((f: ContinuityFact) => (
              <li key={f.id}>{f.text}</li>
            ))}
          </ul>
        )}
      </ContextSection>

      <ContextSection title="open threads" note={`director cap ${openThreads.length} / ${threads.length}`}>
        {openThreads.length === 0 ? (
          <div style={{ opacity: 0.5 }}>(none)</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {openThreads.map((t: OpenThread) => (
              <li key={t.id}>
                {t.text}
                <span style={{ opacity: 0.45 }}> · {t.openedLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </ContextSection>

      {walls.length > 0 && (
        <ContextSection title="knowledge walls" note="must not know yet">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {walls.map((c) => (
              <li key={c.id}>
                <strong style={{ fontWeight: 600 }}>{c.name || 'unnamed'}:</strong> {c.mustNotKnow}
              </li>
            ))}
          </ul>
        </ContextSection>
      )}

      {(bible?.recap?.trim() || carried.length > 0) && (
        <ContextSection title="season bible" note="prior season handoff">
          {bible?.recap?.trim() && (
            <div style={{ whiteSpace: 'pre-wrap' }}>{clipPreview(bible.recap, 320)}</div>
          )}
          {carried.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.8 }}>
              {carried.map((b, i) => (
                <li key={i}>
                  [{b.disposition.toUpperCase()}] {clipPreview(b.text, 160)}
                </li>
              ))}
            </ul>
          )}
        </ContextSection>
      )}

      <ContextSection title="world bible" note="narrator system · clipped">
        <div style={{ whiteSpace: 'pre-wrap' }}>{worldClip || '(empty)'}</div>
        <button type="button" className="btn-quiet" style={{ fontSize: 11, alignSelf: 'flex-start' }} onClick={onEditLore}>
          Edit in Lore
        </button>
      </ContextSection>
    </div>
  );
}

function MiniSlider({ label, value, onChange, valueLabel }: {
  label: string; value: number; onChange: (v: number) => void; valueLabel: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(236,234,230,0.9)' }}>{label}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.72 0.06 195)' }}>{valueLabel}</div>
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
