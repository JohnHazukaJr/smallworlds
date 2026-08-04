import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { deleteTurnsAfter, deleteTurnsFrom, extractContinuity, proseModelFor, writeTurn, type StreamMeta } from '../ai/engine';
import { generateSceneImage } from '../ai/image';
import {
  episodeContextPressure, episodeHistoryChars, HISTORY_CHAR_BUDGET
} from '../ai/prompts';
import { WorldEditorSheet } from '../components/WorldEditorSheet';
import { db, uid } from '../db';
import { AVATAR_PX, DEFAULT_DISPLAY, moodFromHue, useApp, type AvatarSize, type StoryLayout } from '../store/app';
import type { Character, ComposeMode, ContinuityFact, Episode, Location, OpenThread, Season, Turn, TurnLength, World } from '../types';
import { Chip, ErrorNote, Mono, Sheet, Spinner, Toggle, useVw } from '../ui/bits';
import { fileToSceneImage } from '../ui/image';
import { avatarStyle, BACKDROPS, MOODS, STRIPE } from '../ui/theme';
import { characterPortraits, emptyLocation, nextEpisode, worldCalendar } from '../worldOps';

// ---------- prose rendering ----------

interface ProseBlock {
  text: string;
  speaker?: string;
  hue?: number;
  portrait?: string | null;
  kind: 'narration' | 'dialogue' | 'direction' | 'action';
}

const DIALOGUE_RE = /^([A-Z][^:\n]{0,48}?):\s*["“](.+?)["”]?\s*$/;

function findByName(characters: Character[], name: string): Character | undefined {
  return characters.find((c) => c.name.toLowerCase() === name.toLowerCase().trim());
}

function portraitPlate(hue: number, size: number, portrait?: string | null, border = 'rgba(255,255,255,0.2)'): CSSProperties {
  return {
    ...avatarStyle(hue, size, border),
    ...(portrait ? { backgroundImage: `url(${portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {})
  };
}

function parseTurn(turn: Turn, characters: Character[]): ProseBlock[] {
  if (turn.role === 'user') {
    const player = characters.find((c) => c.isPlayer);
    if (turn.mode === 'speak') {
      return [{
        text: `"${turn.text.replace(/^"|"$/g, '')}"`,
        speaker: player?.name ?? 'you',
        hue: player?.hue ?? 60,
        portrait: player ? characterPortraits(player)[0] : null,
        kind: 'dialogue'
      }];
    }
    if (turn.mode === 'act') {
      return [{
        text: turn.text,
        speaker: player?.name ?? 'you',
        hue: player?.hue ?? 60,
        portrait: player ? characterPortraits(player)[0] : null,
        kind: 'action'
      }];
    }
    return [{ text: turn.text, kind: 'direction' }];
  }
  if (turn.role === 'character') {
    const who = characters.find((c) => c.id === turn.characterId);
    const line = turn.text.replace(/^["“]|["”]$/g, '').trim();
    return [{
      text: `"${line}"`,
      speaker: who?.name ?? 'someone',
      hue: who?.hue ?? 200,
      portrait: who ? characterPortraits(who)[0] : null,
      kind: 'dialogue'
    }];
  }
  // Legacy narrator turns may still embed Name: "…" dialogue.
  return turn.text
    .split(/\n{2,}|\n(?=[A-Z][^:\n]{0,48}:\s*["“])/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): ProseBlock => {
      const m = p.match(DIALOGUE_RE);
      if (m) {
        const who = findByName(characters, m[1]);
        return {
          text: `"${m[2]}"`,
          speaker: m[1].trim(),
          hue: who?.hue,
          portrait: who ? characterPortraits(who)[0] : null,
          kind: 'dialogue'
        };
      }
      return { text: p, kind: 'narration' };
    });
}

function ProseBlockView({ b, accent, prose, fontPx, avatarPx }: {
  b: ProseBlock; accent: string; prose: string; fontPx: number; avatarPx: number;
}) {
  const isDialog = b.kind === 'dialogue' || b.kind === 'action';
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: isDialog ? 24 : 22 }}>
      {isDialog && b.hue !== undefined && (
        <div style={{ ...portraitPlate(b.hue, avatarPx, b.portrait), marginTop: 4 }} />
      )}
      <div style={{
        flex: 1, minWidth: 0,
        ...(isDialog ? { borderLeft: `1px solid ${accent}55`, paddingLeft: 14 } : {})
      }}>
        {isDialog && b.speaker && (
          <div style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: accent, marginBottom: 6
          }}>
            {b.speaker}{b.kind === 'action' ? ' · acts' : ''}
          </div>
        )}
        {b.kind === 'direction' ? (
          <p style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, lineHeight: 1.7, margin: 0,
            color: 'rgba(236,234,230,0.45)', borderLeft: '1px solid rgba(255,255,255,0.14)', paddingLeft: 12
          }}>
            you direct: {b.text}
          </p>
        ) : (
          <p className="serif" style={{
            fontSize: fontPx, lineHeight: 1.78, margin: 0, color: prose,
            fontStyle: b.kind === 'dialogue' ? 'italic' : 'normal', textWrap: 'pretty'
          }}>
            {b.text}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- main screen ----------

export function Story() {
  const vw = useVw();
  const narrow = vw < 780;
  const { currentWorldId, layout, setLayout, mood, setMood, backdrop, setBackdrop, go, display } = useApp();
  const goLocations = () => go('locations');
  const M = MOODS[mood];
  const BD = BACKDROPS[backdrop];
  const readMode = layout === 'read';
  const avatarPx = AVATAR_PX[display.avatarSize];
  const fontPx = readMode ? display.textSize + 1 : display.textSize;

  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const season = useLiveQuery(
    async () => (world?.activeSeasonId ? db.seasons.get(world.activeSeasonId) : undefined),
    [world?.activeSeasonId]
  );
  const episode = useLiveQuery(
    async () => season
      ? db.episodes.where('seasonId').equals(season.id).filter((e) => e.status === 'active').first()
      : undefined,
    [season?.id]
  );
  const turns = useLiveQuery(
    async () => (episode ? db.turns.where('episodeId').equals(episode.id).sortBy('createdAt') : []),
    [episode?.id]
  ) ?? [];
  const characters = useLiveQuery(
    async () => (world ? db.characters.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];
  const locations = useLiveQuery(
    async () => (world ? db.locations.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];
  const continuity = useLiveQuery(
    async () => (season ? db.continuity.where('seasonId').equals(season.id).toArray() : []),
    [season?.id]
  ) ?? [];
  const threads = useLiveQuery(
    async () => (world ? db.threads.where('worldId').equals(world.id).filter((t) => t.status === 'open').toArray() : []),
    [world?.id]
  ) ?? [];

  // writing state
  const [composeMode, setComposeMode] = useState<ComposeMode>('continue');
  const [length, setLength] = useState<TurnLength>('scene');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState('');
  const [partialMeta, setPartialMeta] = useState<StreamMeta>({ role: 'narrator' });
  const [progressLabel, setProgressLabel] = useState('writing…');
  const [error, setError] = useState('');
  /** How many turns from the end are mounted — keeps long episodes responsive. */
  const [turnWindow, setTurnWindow] = useState(60);
  useEffect(() => { setTurnWindow(60); }, [episode?.id]);
  const [wrapOpen, setWrapOpen] = useState<null | 'episode' | 'season'>(null);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [directorSheet, setDirectorSheet] = useState(false);
  const [worldEditOpen, setWorldEditOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [sceneFadeKey, setSceneFadeKey] = useState(0);
  /** Context-pressure nudge: dismiss until chars rise ~10% of budget or location changes. */
  const [nudgeDismissedAtChars, setNudgeDismissedAtChars] = useState(0);
  const [nudgeDismissedLocId, setNudgeDismissedLocId] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  const activeLocation = locations.find((l) => l.id === episode?.locationId)
    ?? locations.find((l) => episode?.location && l.name && episode.location.toLowerCase().includes(l.name.toLowerCase()));

  const episodeChars = useMemo(() => episodeHistoryChars(turns), [turns]);
  const pressure = episodeContextPressure(episodeChars);
  const locationShiftNudge = nudgeDismissedLocId !== undefined
    && (episode?.locationId ?? null) !== nudgeDismissedLocId
    && episodeChars >= HISTORY_CHAR_BUDGET * 0.25;
  const pressurePastDismiss = pressure !== 'ok'
    && episodeChars >= nudgeDismissedAtChars + HISTORY_CHAR_BUDGET * 0.1;
  const showWrapNudge = !!episode && turns.length > 0 && (
    (pressure !== 'ok' && (nudgeDismissedAtChars === 0 || pressurePastDismiss))
    || locationShiftNudge
  );

  useEffect(() => {
    setSceneFadeKey((k) => k + 1);
  }, [episode?.image, mood, episode?.locationId]);

  useEffect(() => {
    if (!readMode) setComposerOpen(true);
    else setComposerOpen(false);
  }, [readMode]);

  // Reset nudge baseline when the active episode changes.
  useEffect(() => {
    setNudgeDismissedAtChars(0);
    setNudgeDismissedLocId(episode?.locationId ?? null);
  }, [episode?.id]);

  // Location hue → mood when the episode hasn't pinned a mood.
  useEffect(() => {
    if (!episode || !activeLocation || episode.moodPinned) return;
    setMood(moodFromHue(activeLocation.hue));
  }, [episode?.id, episode?.locationId, episode?.moodPinned, activeLocation?.id, activeLocation?.hue, setMood]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length, partial]);

  const pinMood = (id: typeof mood) => {
    setMood(id);
    if (episode) void db.episodes.update(episode.id, { moodPinned: true });
  };

  const dismissWrapNudge = () => {
    setNudgeDismissedAtChars(episodeChars);
    setNudgeDismissedLocId(episode?.locationId ?? null);
  };

  /** Shared streaming runner behind write / rewrite / retry. */
  const runNarration = async (mode: ComposeMode, text: string): Promise<'ok' | 'error' | 'aborted'> => {
    if (!world || !season || !episode) return 'error';
    setError('');
    setStreaming(true);
    setPartial('');
    setPartialMeta({ role: 'narrator' });
    setProgressLabel('planning…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await writeTurn({
        world, season, episode, mode, input: text, length,
        signal: controller.signal,
        onProgress: setProgressLabel,
        onDelta: (p, meta) => {
          setPartialMeta(meta);
          setPartial(p);
        }
      });
      setPartial('');
      return 'ok';
    } catch (e) {
      setPartial('');
      if ((e as Error).name === 'AbortError') return 'aborted';
      setError(e instanceof Error ? e.message : String(e));
      return 'error';
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const write = async () => {
    if (!world || !season || !episode || streaming) return;
    if (composeMode !== 'continue' && !input.trim()) return;
    const text = input;
    setInput('');
    const result = await runNarration(composeMode, text);
    if (result === 'ok') {
      if (composeMode !== 'continue') setComposeMode('continue');
    } else if (result === 'error') {
      setInput(text);
    }
  };

  /**
   * Retry from a turn. For narrator/character turns: that response and everything
   * after are rewritten. For a player turn: the turn is kept and everything after
   * is rewritten from it.
   */
  const retryFrom = async (turn: Turn) => {
    if (!episode || streaming) return;
    const idx = turns.findIndex((t) => t.id === turn.id);
    if (idx < 0) return;
    const below = turns.length - idx - 1;
    if (turn.role === 'narrator' || turn.role === 'character') {
      if (below > 0 && !confirm(`Rewrite this response? The ${below} turn${below > 1 ? 's' : ''} after it will be replaced.`)) return;
      await deleteTurnsFrom(turn.id, episode.id);
    } else {
      if (below > 0 && !confirm(`Retry from here? The ${below} turn${below > 1 ? 's' : ''} after this will be replaced.`)) return;
      await deleteTurnsAfter(turn.id, episode.id);
    }
    await runNarration('continue', '');
  };

  /** Delete everything after a turn, keeping the turn itself. */
  const deleteBelow = async (turn: Turn) => {
    if (!episode || streaming) return;
    const idx = turns.findIndex((t) => t.id === turn.id);
    const below = turns.length - idx - 1;
    if (idx < 0 || below === 0) return;
    if (!confirm(`Delete the ${below} turn${below > 1 ? 's' : ''} below this one? This cannot be undone.`)) return;
    await deleteTurnsAfter(turn.id, episode.id);
  };

  const endEpisode = async () => {
    if (!world || !season || !episode) return;
    setWrapBusy(true);
    setError('');
    try {
      if (turns.length > 0) {
        try {
          await extractContinuity(world, season, episode);
        } catch (e) {
          // Continuity extraction is best-effort; the episode still ends.
          console.warn('continuity extraction failed', e);
        }
      }
      await nextEpisode(episode);
      setWrapOpen(null);
      setNudgeDismissedAtChars(0);
      setNudgeDismissedLocId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWrapBusy(false);
    }
  };

  const blocks = useMemo(() => {
    const out: { turn: Turn; blocks: ProseBlock[] }[] = [];
    for (const t of turns) out.push({ turn: t, blocks: parseTurn(t, characters) });
    return out;
  }, [turns, characters]);

  if (!world) {
    return (
      <div className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: '#f8f6f2' }}>Open a world to start writing.</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button>
        </div>
      </div>
    );
  }
  if (!season || !episode) {
    return <div style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }

  const inScene = characters.filter((c) => episode.castIds.includes(c.id));
  const composerPlaceholder: Record<ComposeMode, string> = {
    continue: 'Press write on — the narrator takes the next beat from here.',
    steer: 'Tell the narrator what should happen, in your words. Everyone stays in character while it happens.',
    speak: 'Dialogue only — no words will be put in your mouth beyond this.',
    act: 'You do something. No dialogue, no narration from you.'
  };
  const modeHint: Record<ComposeMode, string> = { continue: 'continue', steer: 'you direct', speak: 'you say', act: 'you do' };

  const directorContent = (
    <DirectorContent
      world={world} season={season} episode={episode} characters={characters} locations={locations}
      continuity={continuity} threads={threads} accent={M.accent}
      onGoLocations={goLocations}
      onNudge={(text) => { setComposeMode('steer'); setInput(text); setDirectorSheet(false); }}
    />
  );

  const shellHeight = narrow && !readMode
    ? 'calc(100vh - 58px - env(safe-area-inset-bottom))'
    : '100vh';
  const locLabel = (activeLocation?.name || episode.location || '')
    .split(',')[0].split('.')[0].toLowerCase();

  return (
    <div style={{ position: 'relative', minHeight: narrow && !readMode ? 'auto' : '100vh', height: shellHeight, display: 'flex', flexDirection: 'column', color: M.text }}>
      {/* backdrop — scene image when the episode has one, mood gradient otherwise */}
      {episode.image ? (
        <>
          <div
            key={`img-${sceneFadeKey}`}
            className={display.imageBlur > 0 ? 'scene-crossfade' : 'scene-crossfade scene-backdrop-drift'}
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              backgroundImage: `url(${episode.image})`, backgroundSize: 'cover', backgroundPosition: 'center',
              filter: display.imageBlur > 0 ? `blur(${display.imageBlur}px)` : undefined,
              transform: display.imageBlur > 0 ? 'scale(1.06)' : undefined
            }}
          />
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
            background: `rgba(8,9,12,${(display.imageDim / 100).toFixed(2)})`,
            transition: 'background 0.35s ease'
          }} />
        </>
      ) : (
        <>
          <div
            key={`mood-${sceneFadeKey}`}
            className="scene-crossfade"
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              background: `linear-gradient(160deg, ${BD.a}, ${BD.b}), ${STRIPE('rgba(255,255,255,0.05)', 'rgba(255,255,255,0.01)')}`,
              opacity: backdrop === 'none' ? 0.25 : 1, transition: 'opacity 0.45s ease'
            }}
          />
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
            background: 'radial-gradient(720px 520px at 50% 40%, transparent, rgba(8,9,12,0.72) 78%), linear-gradient(180deg, rgba(8,9,12,0.5), rgba(8,9,12,0.2) 30%, rgba(8,9,12,0.6))',
            backdropFilter: 'blur(3px)'
          }} />
        </>
      )}

      {/* header — thin strip in Read mode */}
      {readMode ? (
        <div style={{
          position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
          paddingTop: narrow ? 'calc(10px + env(safe-area-inset-top))' : 11,
          paddingBottom: narrow ? 10 : 11,
          paddingLeft: narrow ? 14 : 22,
          paddingRight: narrow ? 14 : 22,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(8,9,12,0.28)', backdropFilter: 'blur(18px) saturate(140%)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: M.accent, boxShadow: `0 0 12px ${M.accent}` }} />
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, letterSpacing: '0.08em', opacity: 0.72, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {world.title.toLowerCase()} · ep {episode.number}{locLabel ? ` · ${locLabel}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {showWrapNudge && (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11 }}
                onClick={() => setWrapOpen('episode')}>File episode?</button>
            )}
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }}
              onClick={() => setComposerOpen((o) => !o)}>
              {composerOpen ? 'Hide write' : 'Write'}
            </button>
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }}
              onClick={() => setLayout('write')}>Exit read</button>
          </div>
        </div>
      ) : (
        <div style={{
          position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 14,
          paddingTop: narrow ? 'calc(11px + env(safe-area-inset-top))' : 13,
          paddingBottom: narrow ? 11 : 13,
          paddingLeft: narrow ? 14 : 24,
          paddingRight: narrow ? 14 : 24,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexWrap: 'wrap', background: 'rgba(8,9,12,0.35)', backdropFilter: 'blur(22px) saturate(140%)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: M.accent, boxShadow: `0 0 16px ${M.accent}` }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{world.title}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', opacity: 0.5 }}>
                season {season.number} · episode {episode.number}{locLabel ? ` · ${locLabel}` : ''} · day {worldCalendar(world).currentDay} · {M.label.toLowerCase()}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.05)' }}>
              {([['write', 'Write'], ['read', 'Read']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setLayout(id as StoryLayout)} style={{
                  border: 0, background: layout === id ? 'rgba(255,255,255,0.14)' : 'transparent',
                  color: 'inherit', opacity: layout === id ? 1 : 0.55, padding: '7px 12px',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer'
                }}>{label}</button>
              ))}
            </div>
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11 }} onClick={() => setDirectorSheet(true)}>Direct</button>
            {!narrow && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 9px', background: 'rgba(255,255,255,0.05)' }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>backdrop</span>
                {(Object.keys(BACKDROPS) as Array<keyof typeof BACKDROPS>).map((id) => (
                  <Chip key={id} active={backdrop === id} accent={M.accent} onClick={() => setBackdrop(id)}>
                    {id === 'none' ? 'Off' : id[0].toUpperCase() + id.slice(1)}
                  </Chip>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 9px', background: 'rgba(255,255,255,0.05)' }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>
                mood{episode.moodPinned ? ' · pinned' : ''}
              </span>
              {(Object.entries(MOODS) as Array<[typeof mood, typeof M]>).map(([id, m]) => (
                <button key={id} title={m.label} onClick={() => pinMood(id)} style={{
                  width: 13, height: 13, borderRadius: '50%', cursor: 'pointer', background: m.accent,
                  border: `1px solid ${mood === id ? 'rgba(255,255,255,0.85)' : 'transparent'}`,
                  opacity: mood === id ? 1 : 0.45, padding: 0
                }} />
              ))}
            </div>
            <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setDisplayOpen(true)}>Display</button>
            <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWorldEditOpen(true)}>Edit world</button>
            <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWrapOpen('episode')}>Wrap</button>
          </div>
        </div>
      )}

      {/* body — single column; Director is always a sheet overlay */}
      <div style={{
        position: 'relative', zIndex: 2, flex: 1, display: 'grid', minHeight: 0,
        gridTemplateColumns: 'minmax(0, 1fr)'
      }}>
        <section ref={scrollRef} style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div style={{
            maxWidth: 740,
            margin: display.textScrim > 0 ? '18px auto' : '0 auto',
            width: display.textScrim > 0 ? 'calc(100% - 24px)' : '100%',
            padding: narrow ? '26px 18px 40px' : '52px 28px 76px',
            // Optional plate behind the text so prose stays readable over scene images.
            ...(display.textScrim > 0 ? {
              background: `rgba(8,9,12,${(display.textScrim / 100).toFixed(2)})`,
              borderRadius: 20,
              backdropFilter: 'blur(10px)'
            } : {})
          }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', opacity: 0.42, marginBottom: 24 }}>
              season {numberWord(season.number)}, episode {numberWord(episode.number)}{episode.title ? ` — ${episode.title.toLowerCase()}` : ''}
            </div>

            {season.bible && turns.length === 0 && (
              <div className="glass" style={{ padding: '16px 18px', marginBottom: 26 }}>
                <Mono style={{ marginBottom: 8 }}>previously</Mono>
                <p className="serif" style={{ fontSize: 15.5, lineHeight: 1.7, margin: 0, color: 'rgba(236,234,230,0.75)' }}>{season.bible.recap}</p>
              </div>
            )}

            {turns.length === 0 && !streaming && (
              <div style={{ opacity: 0.55, fontSize: 14, lineHeight: 1.7 }}>
                <p className="serif" style={{ fontSize: 17 }}>
                  {season.premise
                    ? <>The premise is set: <em>{season.premise}</em></>
                    : 'A blank page. Steer, speak, act — or just press Write and see where the story opens.'}
                </p>
              </div>
            )}

            {blocks.length > turnWindow && (
              <div style={{ marginBottom: 22 }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '8px 14px' }}
                  onClick={() => setTurnWindow((n) => n + 60)}
                >
                  Show earlier turns ({blocks.length - turnWindow} hidden)
                </button>
              </div>
            )}

            {blocks.slice(-turnWindow).map(({ turn, blocks: bs }, ti, visible) => (
              <TurnRow
                key={turn.id}
                turn={turn}
                blocks={bs}
                characters={characters}
                accent={M.accent}
                prose={M.prose}
                fontPx={fontPx}
                avatarPx={avatarPx}
                streaming={streaming}
                hasBelow={ti < visible.length - 1 || streaming}
                onRetry={() => void retryFrom(turn)}
                onDeleteBelow={() => void deleteBelow(turn)}
              />
            ))}

            {streaming && partial && (
              parseTurn({
                id: 'partial',
                episodeId: episode.id,
                worldId: world.id,
                role: partialMeta.role,
                mode: null,
                characterId: partialMeta.characterId,
                text: partial,
                createdAt: 0
              }, characters)
                .map((b, i) => <ProseBlockView key={`p${i}`} b={b} accent={M.accent} prose={M.prose} fontPx={fontPx} avatarPx={avatarPx} />)
            )}

            {streaming && (
              <div style={{ marginTop: 22 }}>
                <Spinner accent={M.accent} label={progressLabel || 'writing…'} />
              </div>
            )}

          </div>
        </section>
      </div>

      {/* composer — collapses to a handle in Read mode */}
      {readMode && !composerOpen ? (
        <div style={{
          position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'center',
          padding: '10px 16px calc(12px + env(safe-area-inset-bottom))',
          background: 'linear-gradient(180deg, transparent, rgba(8,9,12,0.55))'
        }}>
          <button
            onClick={() => setComposerOpen(true)}
            style={{
              border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(8,9,12,0.55)',
              color: 'inherit', borderRadius: 999, padding: '10px 22px', cursor: 'pointer',
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.12em',
              textTransform: 'uppercase', opacity: 0.85, backdropFilter: 'blur(16px)'
            }}
          >
            Write · continue
          </button>
        </div>
      ) : (
        <div style={{
          position: 'relative', zIndex: 2, borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: narrow ? '11px 12px 12px' : '15px 24px 18px',
          display: 'flex', flexDirection: 'column', gap: 11,
          background: 'rgba(8,9,12,0.42)', backdropFilter: 'blur(24px) saturate(140%)'
        }}>
          {showWrapNudge && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, padding: '12px 14px',
              background: pressure === 'escalate' ? 'rgba(224,165,95,0.12)' : 'rgba(255,255,255,0.05)'
            }}>
              <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.78)' }}>
                {pressure === 'escalate'
                  ? 'Earlier beats may already be dropping from context. File this episode so continuity keeps them.'
                  : locationShiftNudge && pressure === 'ok'
                    ? 'The scene moved. End the episode to file key details into continuity before they crowd the narrator\'s memory.'
                    : 'This episode is getting long for the narrator\'s memory. End it to file key details into continuity.'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12 }}
                  disabled={wrapBusy} onClick={() => setWrapOpen('episode')}>End episode</button>
                <button className="btn-quiet" style={{ fontSize: 11 }} onClick={dismissWrapNudge}>Not yet</button>
              </div>
            </div>
          )}
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {(['continue', 'steer', 'speak', 'act'] as const).map((m) => (
              <Chip key={m} active={composeMode === m} accent={M.accent} onClick={() => setComposeMode(m)}>
                {m[0].toUpperCase() + m.slice(1)}
              </Chip>
            ))}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {readMode && (
                <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => setComposerOpen(false)}>collapse</button>
              )}
              {!narrow && <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>length</span>}
              {(['beat', 'scene', 'episode'] as const).map((l) => (
                <Chip key={l} active={length === l} accent={M.accent} onClick={() => setLength(l)}>
                  {l[0].toUpperCase() + l.slice(1)}
                </Chip>
              ))}
            </div>
          </div>
          <div style={{
            display: 'flex', gap: 13, alignItems: 'flex-end', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 16, padding: narrow ? '10px 12px' : '14px 16px',
            background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(20px) saturate(140%)'
          }}>
            {!narrow && (
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.42, paddingBottom: 8, whiteSpace: 'nowrap' }}>
                {modeHint[composeMode]}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void write(); }
              }}
              placeholder={composerPlaceholder[composeMode]}
              rows={2}
              disabled={streaming || composeMode === 'continue'}
              style={{
                flex: 1, border: 0, background: 'transparent', padding: '4px 0',
                fontFamily: 'Spectral, serif', fontSize: narrow ? 15 : 16.5, lineHeight: 1.6,
                minHeight: 26, opacity: composeMode === 'continue' ? 0.45 : 1
              }}
            />
            {streaming ? (
              <button className="btn-ghost" style={{ alignSelf: 'flex-end' }} onClick={() => abortRef.current?.abort()}>Stop</button>
            ) : (
              <button className="btn-primary" style={{ alignSelf: 'flex-end', padding: '10px 19px' }} onClick={() => void write()}>
                Write on
              </button>
            )}
          </div>
          {!narrow && !readMode && (
            <div style={{ display: 'flex', gap: 16, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.4, flexWrap: 'wrap' }}>
              <span>{inScene.filter((c) => !c.isPlayer).map((c) => c.name).join(' · ') || 'no cast in scene'}</span>
              <span>memory: {continuity.length} facts · {threads.length} open threads</span>
              <span>{world.ai.mature ? 'adult world · unrestricted' : 'general audience'}</span>
              <span>⌘↵ write on</span>
            </div>
          )}
        </div>
      )}

      {/* wrap sheet */}
      <Sheet open={wrapOpen !== null} onClose={() => setWrapOpen(null)} narrow={narrow}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.5 }}>
              season {season.number} · episode {episode.number}
            </div>
            <div className="serif" style={{ fontWeight: 300, fontSize: 27, lineHeight: 1.15, color: '#f6f4f0' }}>
              {wrapOpen === 'season' ? 'End the season.' : 'End the episode.'}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.62, maxWidth: '48ch', color: '#eceae6' }}>
              {wrapOpen === 'season'
                ? 'Opens the season review to choose what carries forward into the next season.'
                : 'Files durable facts out of the hot transcript into continuity, then opens the next episode with the same cast — so key details survive when the narrator\'s memory fills up.'}
            </div>
          </div>
          <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={() => setWrapOpen(null)}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <Chip active={wrapOpen === 'episode'} onClick={() => setWrapOpen('episode')}>End episode</Chip>
          <Chip active={wrapOpen === 'season'} onClick={() => setWrapOpen('season')}>End season</Chip>
        </div>

        <div style={{
          fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.7)',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '12px 14px',
          background: 'rgba(255,255,255,0.04)'
        }}>
          {wrapOpen === 'season'
            ? 'The review reads the season back, proposes beats, and asks what to Drop / Soften / Keep / Raise. It runs on your utility model.'
            : 'Continuity facts and open threads are extracted with your utility model. Episode prose stays saved; only the active episode stays in the writing loop.'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Mono style={{ fontSize: 9 }}>held in continuity</Mono>
          {continuity.slice(-6).map((f) => (
            <div key={f.id} className="glass" style={{ borderRadius: 13, padding: '12px 14px', fontSize: 13, lineHeight: 1.5, color: 'rgba(236,234,230,0.8)' }}>
              {f.text}
            </div>
          ))}
          {continuity.length === 0 && <div style={{ fontSize: 12.5, opacity: 0.5, color: '#eceae6' }}>Nothing filed yet — end an episode to extract what mattered.</div>}
        </div>

        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 14 }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
            {wrapOpen === 'season' ? (
              <button className="btn-primary" disabled={wrapBusy} onClick={() => { setWrapOpen(null); go('sequel'); }}>
                Open the season review
              </button>
            ) : (
              <button className="btn-primary" disabled={wrapBusy} onClick={() => void endEpisode()}>
                {wrapBusy ? 'Filing continuity…' : `End episode · start ${episode.number + 1}`}
              </button>
            )}
          </div>
        </div>
      </Sheet>

      {/* director overlay — cast, places, continuity, threads (all widths) */}
      <Sheet open={directorSheet} onClose={() => setDirectorSheet(false)} narrow={narrow}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Director</div>
          <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0 }} onClick={() => setDirectorSheet(false)}>×</button>
        </div>
        {directorContent}
      </Sheet>

      {/* live world editor */}
      <WorldEditorSheet
        open={worldEditOpen}
        onClose={() => setWorldEditOpen(false)}
        narrow={narrow}
        world={world}
        season={season}
        episode={episode}
        characters={characters}
        locations={locations}
      />

      {/* display settings */}
      <DisplaySheet
        open={displayOpen} onClose={() => setDisplayOpen(false)} narrow={narrow}
        episode={episode} world={world} locations={locations}
      />
    </div>
  );
}

// ---------- display settings (scene image, text plate, sizes) ----------

function SliderRow({ label, value, min, max, unit, onChange }: {
  label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Mono style={{ fontSize: 9 }}>{label}</Mono>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.85 0.1 62)' }}>
          {value}{unit ?? ''}
        </span>
      </div>
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
    </div>
  );
}

function DisplaySheet({ open, onClose, narrow, episode, world, locations }: {
  open: boolean; onClose: () => void; narrow: boolean;
  episode: Episode; world: World; locations: Location[];
}) {
  const { display, setDisplay, mood, setMood } = useApp();
  const [imgError, setImgError] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [note, setNote] = useState(episode.atmosphereNote ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setNote(episode.atmosphereNote ?? ''); }, [episode.id, episode.atmosphereNote]);

  const sceneLoc = locations.find((l) => l.id === episode.locationId)
    ?? locations.find((l) => episode.location && l.name
      && (episode.location.toLowerCase().includes(l.name.toLowerCase())
        || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));

  const onFile = async (file: File) => {
    setImgBusy(true);
    setImgError('');
    try {
      const image = await fileToSceneImage(file);
      await db.episodes.update(episode.id, { image });
    } catch (e) {
      setImgError(e instanceof Error ? e.message : String(e));
    } finally {
      setImgBusy(false);
    }
  };

  const generateFromLocation = async () => {
    if (!sceneLoc) {
      setImgError('Pick a location card first — generation uses its name, atmosphere, and features.');
      return;
    }
    setGenBusy(true);
    setImgError('');
    try {
      const { provider, model } = proseModelFor(world);
      const image = await generateSceneImage({
        provider, model, world, location: sceneLoc,
        atmosphereNote: episode.atmosphereNote
      });
      await db.episodes.update(episode.id, { image });
    } catch (e) {
      setImgError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} narrow={narrow}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Display</div>
          <Mono style={{ fontSize: 9 }}>sizes & plate settings stay on this device · the image stays with the episode</Mono>
        </div>
        <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={onClose}>×</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 22, paddingRight: 2 }}>
        {/* atmosphere */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>atmosphere for this scene</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
            Weather, time of day, or a sensory note the narrator should keep returning to.
            Location hue also suggests mood unless you pin it.
          </div>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              const next = note.trim();
              if (next !== (episode.atmosphereNote ?? '')) {
                void db.episodes.update(episode.id, { atmosphereNote: next || undefined });
              }
            }}
            placeholder="rain on the glass · late afternoon · cold iron smell…"
            style={{ fontSize: 13 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.5 }}>
              mood {episode.moodPinned ? 'pinned' : 'follows location'}
            </span>
            <Toggle
              on={!!episode.moodPinned}
              onClick={() => {
                const next = !episode.moodPinned;
                void db.episodes.update(episode.id, { moodPinned: next });
                if (!next && sceneLoc) setMood(moodFromHue(sceneLoc.hue));
              }}
            />
            {(Object.entries(MOODS) as Array<[typeof mood, (typeof MOODS)[typeof mood]]>).map(([id, m]) => (
              <button key={id} title={m.label} onClick={() => {
                setMood(id);
                void db.episodes.update(episode.id, { moodPinned: true });
              }} style={{
                width: 13, height: 13, borderRadius: '50%', cursor: 'pointer', background: m.accent,
                border: `1px solid ${mood === id ? 'rgba(255,255,255,0.85)' : 'transparent'}`,
                opacity: mood === id ? 1 : 0.45, padding: 0
              }} />
            ))}
          </div>
        </div>

        {/* scene image */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>scene image — episode {episode.number}</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
            A picture of what's happening right now, shown behind the story text. Swap it whenever
            the scene changes; each episode keeps its own.
          </div>
          {episode.image && (
            <div style={{
              height: 120, borderRadius: 13, border: '1px solid rgba(255,255,255,0.12)',
              backgroundImage: `url(${episode.image})`, backgroundSize: 'cover', backgroundPosition: 'center'
            }} />
          )}
          {imgError && <ErrorNote error={imgError} onDismiss={() => setImgError('')} />}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ fontSize: 12, padding: '8px 14px' }}
              disabled={genBusy || imgBusy || !sceneLoc}
              onClick={() => void generateFromLocation()}>
              {genBusy ? 'Generating…' : sceneLoc ? `Generate from ${sceneLoc.name}` : 'Generate from location'}
            </button>
            <button className="btn-ghost" style={{ fontSize: 12 }} disabled={imgBusy || genBusy} onClick={() => fileRef.current?.click()}>
              {imgBusy ? 'Processing…' : episode.image ? 'Replace image' : 'Upload image'}
            </button>
            {episode.image && (
              <button className="btn-quiet" style={{ fontSize: 11 }}
                onClick={() => void db.episodes.update(episode.id, { image: null })}>remove</button>
            )}
            <input
              ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
            />
          </div>
          {episode.image && (
            <>
              <SliderRow label="image darkness" value={display.imageDim} min={0} max={90} unit="%"
                onChange={(v) => setDisplay({ imageDim: v })} />
              <SliderRow label="image blur" value={display.imageBlur} min={0} max={20} unit="px"
                onChange={(v) => setDisplay({ imageBlur: v })} />
            </>
          )}
        </div>

        {/* text visibility */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>text</Mono>
          <SliderRow label="plate behind text" value={display.textScrim} min={0} max={80} unit="%"
            onChange={(v) => setDisplay({ textScrim: v })} />
          <SliderRow label="text size" value={display.textSize} min={15} max={24} unit="px"
            onChange={(v) => setDisplay({ textSize: v })} />
        </div>

        {/* avatars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>avatar size in the story</Mono>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(['S', 'M', 'L'] as AvatarSize[]).map((s) => (
              <Chip key={s} active={display.avatarSize === s} onClick={() => setDisplay({ avatarSize: s })}>
                {s === 'S' ? 'Small' : s === 'M' ? 'Medium' : 'Large'}
              </Chip>
            ))}
            <div style={{ ...avatarStyle(200, AVATAR_PX[display.avatarSize], 'rgba(255,255,255,0.25)'), marginLeft: 'auto' }} />
          </div>
        </div>

        <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
          onClick={() => setDisplay(DEFAULT_DISPLAY)}>reset display to defaults</button>
      </div>
    </Sheet>
  );
}

// ---------- turn row with edit / retry / delete-below ----------

function TurnRow({ turn, blocks, characters, accent, prose, fontPx, avatarPx, streaming, hasBelow, onRetry, onDeleteBelow }: {
  turn: Turn;
  blocks: ProseBlock[];
  characters: Character[];
  accent: string;
  prose: string;
  fontPx: number;
  avatarPx: number;
  streaming: boolean;
  hasBelow: boolean;
  onRetry: () => void;
  onDeleteBelow: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const characterName = turn.role === 'character'
    ? (characters.find((c) => c.id === turn.characterId)?.name ?? 'character')
    : null;
  const editLabel =
    turn.role === 'narrator' ? 'the narrator'
    : turn.role === 'character' ? characterName!
    : `your ${turn.mode ?? 'turn'}`;
  const retryLabel = turn.role === 'user' ? 'retry from here' : 'retry';

  const save = async () => {
    const text = draft.trim();
    if (text && text !== turn.text) await db.turns.update(turn.id, { text });
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ marginBottom: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.5 }}>
          editing {editLabel} — saved into story memory
        </div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(16, Math.max(4, Math.ceil(draft.length / 70)))}
          style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.7, width: '100%' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-primary" style={{ padding: '7px 14px', fontSize: 12 }} onClick={() => void save()}>Save</button>
          <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => setEditing(false)}>cancel</button>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.4, marginLeft: 'auto' }}>⌘↵ save · esc cancel</span>
        </div>
      </div>
    );
  }

  return (
    <div className="turn-row" style={{ position: 'relative' }}>
      {blocks.map((b, i) => <ProseBlockView key={i} b={b} accent={accent} prose={prose} fontPx={fontPx} avatarPx={avatarPx} />)}
      <div className="turn-tools" style={{ display: 'flex', gap: 10, marginTop: -8, marginBottom: 20 }}>
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} disabled={streaming}
          onClick={() => { setDraft(turn.text); setEditing(true); }}>✎ edit</button>
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} disabled={streaming}
          onClick={onRetry}>↻ {retryLabel}</button>
        {hasBelow && (
          <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} disabled={streaming}
            onClick={onDeleteBelow}>⌫ delete below</button>
        )}
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} disabled={streaming}
          onClick={async () => {
            if (confirm('Delete this turn? The turns after it are kept.')) await db.turns.delete(turn.id);
          }}>× delete</button>
      </div>
    </div>
  );
}

// ---------- director sub-panels ----------

function SceneCastPanel({ episode, characters, accent }: { episode: Episode; characters: Character[]; accent: string }) {
  const toggle = async (id: string) => {
    const castIds = episode.castIds.includes(id)
      ? episode.castIds.filter((x) => x !== id)
      : [...episode.castIds, id];
    await db.episodes.update(episode.id, { castIds });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>in the scene</Mono>
      {characters.map((c) => {
        const active = episode.castIds.includes(c.id);
        return (
          <div key={c.id} onClick={() => void toggle(c.id)} style={{
            display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, cursor: 'pointer',
            background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
            border: `1px solid ${active ? 'rgba(255,255,255,0.08)' : 'transparent'}`,
            opacity: active ? 1 : 0.45
          }}>
            <div style={portraitPlate(c.hue, 30, characterPortraits(c)[0])} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{c.name}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {active ? (c.state.emotion || c.role || 'in scene') : 'off-page'}
              </div>
            </div>
            <div style={{
              width: 14, height: 14, borderRadius: 5, flexShrink: 0,
              border: `1px solid ${active ? accent : 'rgba(255,255,255,0.18)'}`,
              background: active ? accent : 'transparent'
            }} />
          </div>
        );
      })}
    </div>
  );
}

function locationThumb(l: Location, size = 30): CSSProperties {
  if (l.portrait) {
    return {
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center',
      border: '1px solid rgba(255,255,255,0.18)'
    };
  }
  return avatarStyle(l.hue, size);
}

function SceneLocationsPanel({ episode, locations, accent, world, onGoLocations }: {
  episode: Episode; locations: Location[]; accent: string; world?: World; onGoLocations: () => void;
}) {
  const { setMood } = useApp();
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState('');

  const activeLoc = locations.find((l) => l.id === episode.locationId)
    ?? locations.find((l) => !!episode.location && l.name.trim()
      && (episode.location.toLowerCase().includes(l.name.toLowerCase())
        || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));

  const select = async (l: Location) => {
    const active = episode.locationId === l.id;
    if (active) {
      await db.episodes.update(episode.id, { locationId: null, location: '' });
      return;
    }
    const patch: Partial<Episode> = { locationId: l.id, location: l.name };
    if (l.portrait) patch.image = l.portrait;
    await db.episodes.update(episode.id, patch);
    if (!episode.moodPinned) setMood(moodFromHue(l.hue));
  };

  const addQuick = async () => {
    const l = emptyLocation(episode.worldId, { name: 'New location' });
    await db.locations.add(l);
    await db.episodes.update(episode.id, {
      locationId: l.id, location: l.name,
      ...(l.portrait ? { image: l.portrait } : {})
    });
    if (!episode.moodPinned) setMood(moodFromHue(l.hue));
  };

  const generate = async () => {
    if (!world || !activeLoc) return;
    setGenBusy(true);
    setGenError('');
    try {
      const { provider, model } = proseModelFor(world);
      const image = await generateSceneImage({
        provider, model, world, location: activeLoc,
        atmosphereNote: episode.atmosphereNote
      });
      await db.episodes.update(episode.id, { image });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>locations</Mono>
      {locations.map((l) => {
        const active = episode.locationId === l.id
          || (!episode.locationId && !!episode.location && l.name.trim()
            && (episode.location.toLowerCase().includes(l.name.toLowerCase())
              || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));
        return (
          <div key={l.id} onClick={() => void select(l)} style={{
            display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, cursor: 'pointer',
            background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
            border: `1px solid ${active ? 'rgba(255,255,255,0.08)' : 'transparent'}`,
            opacity: active ? 1 : 0.45
          }}>
            <div style={locationThumb(l, 30)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{l.name || 'unnamed'}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {active ? (l.tagline || l.currentState || 'scene setting') : (l.tagline || 'off-scene')}
              </div>
            </div>
            <div style={{
              width: 14, height: 14, borderRadius: 5, flexShrink: 0,
              border: `1px solid ${active ? accent : 'rgba(255,255,255,0.18)'}`,
              background: active ? accent : 'transparent'
            }} />
          </div>
        );
      })}
      {locations.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5, color: '#eceae6' }}>No saved locations yet.</div>
      )}
      {genError && <ErrorNote error={genError} onDismiss={() => setGenError('')} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} onClick={() => void addQuick()}>+ new</button>
        {activeLoc && world && (
          <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} disabled={genBusy}
            onClick={() => void generate()}>
            {genBusy ? 'generating…' : 'generate scene image'}
          </button>
        )}
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} onClick={onGoLocations}>full editor → Locations</button>
      </div>
    </div>
  );
}

function ScenePlatePanel({ episode, bd }: { episode: Episode; bd: { tag: string; a: string; b: string } }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(episode.location);
  useEffect(() => setValue(episode.location), [episode.id, episode.location]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>scene note — free text</Mono>
      <div style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, overflow: 'hidden', background: 'rgba(255,255,255,0.04)' }}>
        <div style={{
          height: 98, display: 'flex', alignItems: 'flex-end', padding: 9,
          background: episode.image
            ? `linear-gradient(rgba(8,9,12,0.15), rgba(8,9,12,0.3)), url(${episode.image}) center / cover`
            : `linear-gradient(155deg, ${bd.a}, ${bd.b}), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`
        }}>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: 'rgba(236,234,230,0.6)', background: 'rgba(8,9,12,0.5)', padding: '4px 7px', borderRadius: 5 }}>
            {bd.tag}
          </span>
        </div>
        {editing ? (
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea rows={2} value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: 12 }}
              placeholder="One-off spot not in the library…" />
            <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 10px' }} onClick={async () => {
              // Free-text override clears the library link so the cards don't fight it.
              await db.episodes.update(episode.id, { location: value, locationId: null });
              setEditing(false);
            }}>Save</button>
          </div>
        ) : (
          <div onClick={() => setEditing(true)} style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.5, opacity: 0.7, cursor: 'pointer', color: '#eceae6' }}>
            {episode.location || 'Optional free-text override — or pick a location card above.'}
          </div>
        )}
      </div>
    </div>
  );
}

function ContinuityPanel({ continuity, world, season }: { continuity: ContinuityFact[]; world: World; season: Season }) {
  const [adding, setAdding] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Mono style={{ fontSize: 9 }}>continuity held</Mono>
      {continuity.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.68, paddingLeft: 12, borderLeft: '1px solid rgba(255,255,255,0.14)', flex: 1, color: '#eceae6' }}>
            {f.text}
          </div>
          <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 12 }} onClick={() => void db.continuity.delete(f.id)}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="add a fact…"
          style={{ fontSize: 11.5, padding: '7px 9px' }}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && adding.trim()) {
              await db.continuity.add({ id: uid(), worldId: world.id, seasonId: season.id, text: adding.trim(), source: 'manual', createdAt: Date.now() });
              setAdding('');
            }
          }}
        />
      </div>
    </div>
  );
}

function ThreadsPanel({ threads }: { threads: OpenThread[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>open threads</Mono>
      {threads.map((t) => (
        <div key={t.id} style={{ border: '1px solid rgba(255,255,255,0.09)', borderRadius: 11, padding: '10px 12px', background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.4, color: '#eceae6' }}>{t.text}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.45 }}>{t.openedLabel}</div>
            <button className="btn-quiet" style={{ padding: 0, fontSize: 10 }} onClick={() => void db.threads.update(t.id, { status: 'resolved' })}>resolve</button>
          </div>
        </div>
      ))}
      {threads.length === 0 && <div style={{ fontSize: 12, opacity: 0.5, color: '#eceae6' }}>No open threads yet.</div>}
    </div>
  );
}

function NudgesPanel({ threads, inScene, onNudge }: { threads: OpenThread[]; inScene: Character[]; onNudge: (t: string) => void }) {
  const nudges = [
    'Let the silence run — do not fill it for me.',
    ...inScene.filter((c) => !c.isPlayer).slice(0, 2).map((c) => `${c.name} presses toward what they want.`),
    ...threads.slice(0, 2).map((t) => `Bring this to the surface: ${t.text}`),
    'Cut away — a different place, right after.'
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>nudge the scene</Mono>
      {nudges.map((n, i) => (
        <button key={i} onClick={() => onNudge(n)} style={{
          textAlign: 'left', border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)',
          color: 'inherit', borderRadius: 11, padding: '10px 12px', fontSize: 12.5, cursor: 'pointer', lineHeight: 1.4
        }} className="hover-border">
          {n}
        </button>
      ))}
    </div>
  );
}

function DirectorContent(props: {
  world: World; season: Season; episode: Episode; characters: Character[]; locations: Location[];
  continuity: ContinuityFact[]; threads: OpenThread[]; accent: string;
  onGoLocations: () => void;
  onNudge: (t: string) => void;
}) {
  const inScene = props.characters.filter((c) => props.episode.castIds.includes(c.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, overflow: 'auto' }}>
      <SceneCastPanel episode={props.episode} characters={props.characters} accent={props.accent} />
      <SceneLocationsPanel
        episode={props.episode} locations={props.locations} accent={props.accent}
        world={props.world} onGoLocations={props.onGoLocations}
      />
      <ScenePlatePanel episode={props.episode} bd={BACKDROPS.scene} />
      <ContinuityPanel continuity={props.continuity} world={props.world} season={props.season} />
      <ThreadsPanel threads={props.threads} />
      <NudgesPanel threads={props.threads} inScene={inScene} onNudge={props.onNudge} />
    </div>
  );
}

function numberWord(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return words[n] ?? String(n);
}
