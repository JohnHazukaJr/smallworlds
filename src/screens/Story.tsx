import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteTurnsAfter, deleteTurnsFrom, extractContinuity, writeTurn } from '../ai/engine';
import { WorldEditorSheet } from '../components/WorldEditorSheet';
import { db, uid } from '../db';
import { AVATAR_PX, DEFAULT_DISPLAY, useApp, type AvatarSize } from '../store/app';
import type { Character, ComposeMode, ContinuityFact, Episode, OpenThread, Season, Turn, TurnLength, World } from '../types';
import { Chip, ErrorNote, Mono, Sheet, Spinner, useVw } from '../ui/bits';
import { fileToSceneImage } from '../ui/image';
import { avatarStyle, BACKDROPS, MOODS, STRIPE } from '../ui/theme';
import { nextEpisode, worldCalendar } from '../worldOps';

// ---------- prose rendering ----------

interface ProseBlock {
  text: string;
  speaker?: string;
  hue?: number;
  kind: 'narration' | 'dialogue' | 'direction' | 'action';
}

const DIALOGUE_RE = /^([A-Z][^:\n]{0,48}?):\s*["“](.+?)["”]?\s*$/;

function parseTurn(turn: Turn, characters: Character[]): ProseBlock[] {
  const hueFor = (name: string) =>
    characters.find((c) => c.name.toLowerCase() === name.toLowerCase().trim())?.hue;
  if (turn.role === 'user') {
    const player = characters.find((c) => c.isPlayer);
    if (turn.mode === 'speak') {
      return [{ text: `"${turn.text.replace(/^"|"$/g, '')}"`, speaker: player?.name ?? 'you', hue: player?.hue ?? 60, kind: 'dialogue' }];
    }
    if (turn.mode === 'act') {
      return [{ text: turn.text, speaker: player?.name ?? 'you', hue: player?.hue ?? 60, kind: 'action' }];
    }
    return [{ text: turn.text, kind: 'direction' }];
  }
  return turn.text
    .split(/\n{2,}|\n(?=[A-Z][^:\n]{0,48}:\s*["“])/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): ProseBlock => {
      const m = p.match(DIALOGUE_RE);
      if (m) return { text: `"${m[2]}"`, speaker: m[1].trim(), hue: hueFor(m[1]), kind: 'dialogue' };
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
        <div style={{ ...avatarStyle(b.hue, avatarPx, 'rgba(255,255,255,0.2)'), marginTop: 4 }} />
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
  const M = MOODS[mood];
  const BD = BACKDROPS[backdrop];
  const director = layout === 'director' && vw >= 940;
  const avatarPx = AVATAR_PX[display.avatarSize];
  const fontPx = director ? display.textSize - 1.5 : display.textSize;

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
  const [error, setError] = useState('');
  const [wrapOpen, setWrapOpen] = useState<null | 'episode' | 'season'>(null);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [directorSheet, setDirectorSheet] = useState(false);
  const [worldEditOpen, setWorldEditOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length, partial]);

  /** Shared streaming runner behind write / rewrite / retry. */
  const runNarration = async (mode: ComposeMode, text: string): Promise<'ok' | 'error' | 'aborted'> => {
    if (!world || !season || !episode) return 'error';
    setError('');
    setStreaming(true);
    setPartial('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await writeTurn({
        world, season, episode, mode, input: text, length,
        signal: controller.signal, onDelta: setPartial
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
   * Retry from a turn. For a narrator turn: that response and everything after
   * are rewritten. For a player turn: the turn is kept (edits included) and
   * everything after is rewritten from it.
   */
  const retryFrom = async (turn: Turn) => {
    if (!episode || streaming) return;
    const idx = turns.findIndex((t) => t.id === turn.id);
    if (idx < 0) return;
    const below = turns.length - idx - 1;
    if (turn.role === 'narrator') {
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
      world={world} season={season} episode={episode} characters={characters}
      continuity={continuity} threads={threads} accent={M.accent}
      onNudge={(text) => { setComposeMode('steer'); setInput(text); setDirectorSheet(false); }}
    />
  );

  return (
    <div style={{ position: 'relative', minHeight: narrow ? 'auto' : '100vh', height: narrow ? 'calc(100vh - 58px - env(safe-area-inset-bottom))' : '100vh', display: 'flex', flexDirection: 'column', color: M.text }}>
      {/* backdrop — scene image when the episode has one, mood gradient otherwise */}
      {episode.image ? (
        <>
          <div style={{
            position: 'absolute', inset: 0, zIndex: 0,
            backgroundImage: `url(${episode.image})`, backgroundSize: 'cover', backgroundPosition: 'center',
            filter: display.imageBlur > 0 ? `blur(${display.imageBlur}px)` : undefined,
            transform: display.imageBlur > 0 ? 'scale(1.06)' : undefined
          }} />
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
            background: `rgba(8,9,12,${(display.imageDim / 100).toFixed(2)})`,
            transition: 'background 0.2s ease'
          }} />
        </>
      ) : (
        <>
          <div style={{
            position: 'absolute', inset: 0, zIndex: 0,
            background: `linear-gradient(160deg, ${BD.a}, ${BD.b}), ${STRIPE('rgba(255,255,255,0.05)', 'rgba(255,255,255,0.01)')}`,
            opacity: backdrop === 'none' ? 0.25 : 1, transition: 'opacity 0.5s ease'
          }} />
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
            background: 'radial-gradient(720px 520px at 50% 40%, transparent, rgba(8,9,12,0.72) 78%), linear-gradient(180deg, rgba(8,9,12,0.5), rgba(8,9,12,0.2) 30%, rgba(8,9,12,0.6))',
            backdropFilter: 'blur(3px)'
          }} />
        </>
      )}

      {/* header */}
      <div style={{
        position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, padding: narrow ? '11px 14px' : '13px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexWrap: 'wrap', background: 'rgba(8,9,12,0.35)', backdropFilter: 'blur(22px) saturate(140%)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: M.accent, boxShadow: `0 0 16px ${M.accent}` }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <div className="serif" style={{ fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{world.title}</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', opacity: 0.5 }}>
              season {season.number} · episode {episode.number}{episode.location ? ` · ${episode.location.split(',')[0].split('.')[0].toLowerCase()}` : ''} · day {worldCalendar(world).currentDay} · {M.label.toLowerCase()}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {vw >= 940 && (
            <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.05)' }}>
              {([['immersive', 'Read'], ['director', 'Direct']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setLayout(id)} style={{
                  border: 0, background: layout === id ? 'rgba(255,255,255,0.14)' : 'transparent',
                  color: 'inherit', opacity: layout === id ? 1 : 0.55, padding: '7px 14px',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer'
                }}>{label}</button>
              ))}
            </div>
          )}
          {vw < 940 && (
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11 }} onClick={() => setDirectorSheet(true)}>Direct</button>
          )}
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
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>mood</span>
            {(Object.entries(MOODS) as Array<[typeof mood, typeof M]>).map(([id, m]) => (
              <button key={id} title={m.label} onClick={() => setMood(id)} style={{
                width: 13, height: 13, borderRadius: '50%', cursor: 'pointer', background: m.accent,
                border: `1px solid ${mood === id ? 'rgba(255,255,255,0.85)' : 'transparent'}`,
                opacity: mood === id ? 1 : 0.45, padding: 0
              }} />
            ))}
          </div>
          <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setDisplayOpen(true)}>Display</button>
          <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWorldEditOpen(true)}>Edit world</button>
          <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWrapOpen('episode')}>Wrap up</button>
        </div>
      </div>

      {/* body */}
      <div style={{
        position: 'relative', zIndex: 2, flex: 1, display: 'grid', minHeight: 0,
        gridTemplateColumns: director ? (vw >= 1240 ? '252px minmax(0, 1fr) 264px' : '238px minmax(0, 1fr)') : 'minmax(0, 1fr)'
      }}>
        {director && (
          <aside style={{
            borderRight: '1px solid rgba(255,255,255,0.07)', padding: '20px 16px', display: 'flex',
            flexDirection: 'column', gap: 22, overflow: 'auto', background: 'rgba(8,9,12,0.28)', backdropFilter: 'blur(20px)'
          }}>
            <SceneCastPanel episode={episode} characters={characters} accent={M.accent} />
            <ScenePlatePanel episode={episode} bd={BD} />
            <ContinuityPanel continuity={continuity} world={world} season={season} />
          </aside>
        )}

        <section ref={scrollRef} style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div style={{
            maxWidth: director ? 680 : 740,
            margin: display.textScrim > 0 ? '18px auto' : '0 auto',
            width: display.textScrim > 0 ? 'calc(100% - 24px)' : '100%',
            padding: narrow ? '26px 18px 40px' : director ? '32px 30px 56px' : '52px 28px 76px',
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
                    : 'A blank page. Steer, speak, act — or just press Write on and see where the narrator opens.'}
                </p>
              </div>
            )}

            {blocks.map(({ turn, blocks: bs }, ti) => (
              <TurnRow
                key={turn.id}
                turn={turn}
                blocks={bs}
                accent={M.accent}
                prose={M.prose}
                fontPx={fontPx}
                avatarPx={avatarPx}
                streaming={streaming}
                hasBelow={ti < blocks.length - 1}
                onRetry={() => void retryFrom(turn)}
                onDeleteBelow={() => void deleteBelow(turn)}
              />
            ))}

            {streaming && partial && (
              parseTurn({ id: 'partial', episodeId: episode.id, worldId: world.id, role: 'narrator', mode: null, text: partial, createdAt: 0 }, characters)
                .map((b, i) => <ProseBlockView key={`p${i}`} b={b} accent={M.accent} prose={M.prose} fontPx={fontPx} avatarPx={avatarPx} />)
            )}

            {streaming && (
              <div style={{ marginTop: 22 }}>
                <Spinner accent={M.accent} label={partial ? 'writing…' : 'thinking…'} />
              </div>
            )}

          </div>
        </section>

        {director && vw >= 1240 && (
          <aside style={{
            borderLeft: '1px solid rgba(255,255,255,0.07)', padding: '20px 16px', display: 'flex',
            flexDirection: 'column', gap: 22, overflow: 'auto', background: 'rgba(8,9,12,0.28)', backdropFilter: 'blur(20px)'
          }}>
            <ThreadsPanel threads={threads} />
            <NudgesPanel threads={threads} inScene={inScene} onNudge={(t) => { setComposeMode('steer'); setInput(t); }} />
          </aside>
        )}
      </div>

      {/* composer */}
      <div style={{
        position: 'relative', zIndex: 2, borderTop: '1px solid rgba(255,255,255,0.08)',
        padding: narrow ? '11px 12px 12px' : '15px 24px 18px',
        display: 'flex', flexDirection: 'column', gap: 11,
        background: 'rgba(8,9,12,0.42)', backdropFilter: 'blur(24px) saturate(140%)'
      }}>
        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['continue', 'steer', 'speak', 'act'] as const).map((m) => (
            <Chip key={m} active={composeMode === m} accent={M.accent} onClick={() => setComposeMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </Chip>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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
            rows={narrow ? 2 : 2}
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
        {!narrow && (
          <div style={{ display: 'flex', gap: 16, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.4, flexWrap: 'wrap' }}>
            <span>{inScene.filter((c) => !c.isPlayer).map((c) => c.name).join(' · ') || 'no cast in scene'}</span>
            <span>memory: {continuity.length} facts · {threads.length} open threads</span>
            <span>{world.ai.mature ? 'adult world · unrestricted' : 'general audience'}</span>
            <span>⌘↵ write on</span>
          </div>
        )}
      </div>

      {/* wrap sheet */}
      <Sheet open={wrapOpen !== null} onClose={() => setWrapOpen(null)} narrow={narrow}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.5 }}>
              season {season.number} · episode {episode.number}
            </div>
            <div className="serif" style={{ fontWeight: 300, fontSize: 27, lineHeight: 1.15, color: '#f6f4f0' }}>
              {wrapOpen === 'season' ? 'Close the season.' : 'Wrap this episode.'}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.62, maxWidth: '46ch', color: '#eceae6' }}>
              {wrapOpen === 'season'
                ? 'The season review reads the whole season back, proposes the beats that mattered, and asks what carries into the next one. It runs on your utility model.'
                : 'Ending the episode files what happened into continuity (via your utility model) and opens the next episode with the same cast.'}
            </div>
          </div>
          <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={() => setWrapOpen(null)}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 7 }}>
          <Chip active={wrapOpen === 'episode'} onClick={() => setWrapOpen('episode')}>End episode</Chip>
          <Chip active={wrapOpen === 'season'} onClick={() => setWrapOpen('season')}>End season</Chip>
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 14 }}>
          <div className="serif" style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.7, color: '#eceae6' }}>
            {wrapOpen === 'season'
              ? `Season ${season.number} closes. The review opens on the Next season screen.`
              : `Episode ${episode.number + 1} opens where this one leaves off, cast carried over.`}
          </div>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
            {wrapOpen === 'season' ? (
              <button className="btn-primary" disabled={wrapBusy} onClick={() => { setWrapOpen(null); go('sequel'); }}>
                Open the season review
              </button>
            ) : (
              <button className="btn-primary" disabled={wrapBusy} onClick={() => void endEpisode()}>
                {wrapBusy ? 'Filing continuity…' : `Start episode ${episode.number + 1}`}
              </button>
            )}
          </div>
        </div>
      </Sheet>

      {/* mobile director sheet */}
      <Sheet open={directorSheet} onClose={() => setDirectorSheet(false)} narrow={narrow || vw < 940}>
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
      />

      {/* display settings */}
      <DisplaySheet open={displayOpen} onClose={() => setDisplayOpen(false)} narrow={narrow} episode={episode} />
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

function DisplaySheet({ open, onClose, narrow, episode }: {
  open: boolean; onClose: () => void; narrow: boolean; episode: Episode;
}) {
  const { display, setDisplay } = useApp();
  const [imgError, setImgError] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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
            <button className="btn-ghost" style={{ fontSize: 12 }} disabled={imgBusy} onClick={() => fileRef.current?.click()}>
              {imgBusy ? 'Processing…' : episode.image ? 'Replace image' : 'Add an image'}
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

function TurnRow({ turn, blocks, accent, prose, fontPx, avatarPx, streaming, hasBelow, onRetry, onDeleteBelow }: {
  turn: Turn;
  blocks: ProseBlock[];
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

  const save = async () => {
    const text = draft.trim();
    if (text && text !== turn.text) await db.turns.update(turn.id, { text });
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ marginBottom: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.5 }}>
          editing {turn.role === 'narrator' ? 'the narrator' : `your ${turn.mode ?? 'turn'}`} — saved into story memory
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
          onClick={onRetry}>↻ {turn.role === 'narrator' ? 'retry' : 'retry from here'}</button>
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
            <div style={avatarStyle(c.hue, 30)} />
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

function ScenePlatePanel({ episode, bd }: { episode: Episode; bd: { tag: string; a: string; b: string } }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(episode.location);
  useEffect(() => setValue(episode.location), [episode.id, episode.location]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>scene plate</Mono>
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
            <textarea rows={2} value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: 12 }} />
            <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 10px' }} onClick={async () => {
              await db.episodes.update(episode.id, { location: value });
              setEditing(false);
            }}>Save location</button>
          </div>
        ) : (
          <div onClick={() => setEditing(true)} style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.5, opacity: 0.7, cursor: 'pointer', color: '#eceae6' }}>
            {episode.location || 'Where does this episode take place? Click to set — it feeds the prompt.'}
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
  world: World; season: Season; episode: Episode; characters: Character[];
  continuity: ContinuityFact[]; threads: OpenThread[]; accent: string;
  onNudge: (t: string) => void;
}) {
  const inScene = props.characters.filter((c) => props.episode.castIds.includes(c.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, overflow: 'auto' }}>
      <SceneCastPanel episode={props.episode} characters={props.characters} accent={props.accent} />
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
