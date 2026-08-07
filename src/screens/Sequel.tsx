import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { analyzeSeason, beginNextSeason, draftPremise, evolveCharacters } from '../ai/engine';
import { db, safeWrite } from '../db';
import { formatUserError } from '../errors';
import { useApp } from '../store/app';
import type { BeatDisposition, SeasonWrap } from '../types';
import { Chip, ErrorNote, Mono, Spinner, useVw } from '../ui/bits';
import { avatarStyle, GAP_EFFECTS, GAP_LABELS } from '../ui/theme';

const BEAT_OPTS: Array<[BeatDisposition, string]> = [
  ['drop', 'Drop'], ['soften', 'Soften'], ['keep', 'Keep'], ['raise', 'Raise']
];

/** Sticky bar + content spacer so the last card isn’t covered on portrait. */
const STICKY_BAR_RESERVE = 132;

export function Sequel() {
  const vw = useVw();
  const narrow = vw < 780;
  const { currentWorldId, go } = useApp();
  const [busy, setBusy] = useState<null | 'analyze' | 'evolve' | 'premise' | 'begin'>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<SeasonWrap | null>(null);

  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const season = useLiveQuery(
    async () => (world?.activeSeasonId ? db.seasons.get(world.activeSeasonId) : undefined),
    [world?.activeSeasonId]
  );
  const storedWrap = useLiveQuery(
    async () => season
      ? db.wraps.where('seasonId').equals(season.id).filter((w) => w.status === 'draft').first()
      : undefined,
    [season?.id]
  );
  const characters = useLiveQuery(
    async () => (world ? db.characters.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];
  const episodeCount = useLiveQuery(
    async () => (season ? db.episodes.where('seasonId').equals(season.id).count() : 0),
    [season?.id]
  ) ?? 0;

  // Local editable copy of the wrap, debounced back to the DB.
  useEffect(() => {
    if (storedWrap && storedWrap.id !== draft?.id) setDraft(storedWrap);
    if (!storedWrap) setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedWrap?.id]);
  const timer = useRef<number>(undefined);
  const clearDebounce = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const patch = (p: Partial<SeasonWrap>) => {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...p, updatedAt: Date.now() };
      clearDebounce();
      timer.current = window.setTimeout(
        () => void safeWrite(() => db.wraps.put(next), setError),
        400
      );
      return next;
    });
  };

  const run = async (
    kind: 'analyze' | 'evolve' | 'premise' | 'begin',
    fn: () => Promise<void>
  ) => {
    // Flush pending local edits so AI writes cannot be overwritten by a stale put.
    clearDebounce();
    setBusy(kind);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!world || !season) {
    return (
      <div className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: '#f8f6f2' }}>Open a world to review its season.</div>
        <div><button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button></div>
      </div>
    );
  }

  const pad = narrow ? '26px 18px 70px' : '42px 46px 70px';
  const contentPadBottom = narrow && draft
    ? `calc(${STICKY_BAR_RESERVE}px + env(safe-area-inset-bottom) + 58px)`
    : undefined;

  // ---------- stage 1: no analysis yet ----------
  if (!draft) {
    return (
      <div className="fade-in" style={{ padding: pad, maxWidth: 1020 }}>
        <button className="btn-quiet" style={{ fontSize: 12, marginBottom: 16, alignSelf: 'flex-start' }}
          onClick={() => go('story')}>← Back to story</button>
        <Mono style={{ letterSpacing: '0.16em', marginBottom: 11 }}>season {season.number} · {episodeCount} episode{episodeCount === 1 ? '' : 's'} so far</Mono>
        <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 30 : 40, lineHeight: 1.12, margin: '0 0 11px', color: '#f8f6f2' }}>
          When the season ends, tell me what mattered.
        </h1>
        <div style={{ fontSize: 14.5, lineHeight: 1.65, color: 'rgba(236,234,230,0.58)', maxWidth: '62ch', marginBottom: 28 }}>
          The review reads the whole season back and proposes the beats that will shape the next one. You mark each
          beat — drop it and it stays in the past, raise it and the cast arrives already carrying it. Then a time gap,
          who returns, and the premise the next season opens on.
        </div>
        {error && <div style={{ marginBottom: 16 }}><ErrorNote error={error} onDismiss={() => setError('')} /></div>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn-primary"
            style={{ minHeight: 44 }}
            disabled={busy !== null}
            onClick={() => void run('analyze', async () => { await analyzeSeason(world, season); })}
          >
            {busy === 'analyze' ? 'Reading the season back…' : `Read season ${season.number} back`}
          </button>
          {busy === 'analyze' && <Spinner label="the utility model is extracting beats and outcomes" />}
        </div>
      </div>
    );
  }

  // ---------- stage 2: showrunner review ----------
  const raised = draft.beats.filter((b) => b.disposition === 'raise').length;
  const dropped = draft.beats.filter((b) => b.disposition === 'drop').length;
  const gapLabel = GAP_LABELS[draft.gap];

  const beginSeason = () => void run('begin', async () => {
    await beginNextSeason(world, season, draft, gapLabel);
    go('story');
  });

  const redraftPremise = () => void run('premise', async () => {
    const premise = await draftPremise(world, season, draft, gapLabel);
    patch({ premise });
  });

  return (
    <div className="fade-in" style={{ position: 'relative', maxWidth: 1020 }}>
      <div style={{
        padding: pad,
        paddingBottom: contentPadBottom ?? (narrow ? 70 : 70)
      }}>
        <button className="btn-quiet" style={{ fontSize: 12, marginBottom: 16 }}
          onClick={() => go('story')}>← Back to story</button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 28 }}>
          <Mono style={{ letterSpacing: '0.16em' }}>season {season.number} closing · season {season.number + 1} setup</Mono>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 30 : 40, lineHeight: 1.12, margin: 0, color: '#f8f6f2' }}>
            Before we go on, tell me what mattered.
          </h1>
          <div style={{ fontSize: 14.5, lineHeight: 1.65, color: 'rgba(236,234,230,0.58)', maxWidth: '62ch' }}>
            I read the whole season back. Here is what I think happened. Mark what should shape the next one — anything
            you drop stays in the past, anything you raise becomes pressure the characters carry into season {season.number + 1}.
          </div>
        </div>

        {error && <div style={{ marginBottom: 16 }}><ErrorNote error={error} onDismiss={() => setError('')} /></div>}

        <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          {['What mattered', 'How it continues', 'Who returns'].map((label, i) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: `1px solid rgba(255,255,255,${i === 0 ? '0.2' : '0.09'})`,
              background: i === 0 ? 'linear-gradient(150deg, rgba(224,165,95,0.14), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)',
              backdropFilter: 'blur(16px)', color: i === 0 ? '#f4f2ee' : 'rgba(236,234,230,0.5)',
              borderRadius: 20, padding: '8px 16px', fontSize: 12.5, fontWeight: 600
            }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.55 }}>0{i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
          <button
            className="btn-quiet" style={{ marginLeft: 'auto' }}
            disabled={!!busy}
            onClick={() => {
              if (confirm('Discard this review and re-read the season?')) {
                void safeWrite(async () => {
                  await db.wraps.delete(draft.id);
                  setDraft(null);
                }, setError);
              }
            }}
          >discard &amp; re-read</button>
        </div>

        {/* beats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 34 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.5)', marginBottom: 4 }}>
            Raised beats become season plot targets the director works toward. Keep/Soften stay as ambient pressure in the season bible.
          </div>
          {draft.beats.map((b, i) => {
            const hot = b.disposition === 'raise';
            return (
              <div key={i} style={{
                border: `1px solid rgba(255,255,255,${hot ? '0.2' : '0.09'})`,
                borderRadius: 16,
                background: hot ? 'linear-gradient(150deg, rgba(224,165,95,0.14), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.045)',
                backdropFilter: 'blur(20px) saturate(140%)',
                padding: '16px 18px',
                display: 'flex',
                flexDirection: narrow ? 'column' : 'row',
                alignItems: narrow ? 'stretch' : 'center',
                gap: narrow ? 14 : 20,
                flexWrap: 'wrap',
                opacity: b.disposition === 'drop' ? 0.42 : 1
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', color: 'rgba(236,234,230,0.4)' }}>{b.where}</div>
                  <input
                    className="serif"
                    value={b.text}
                    onChange={(e) => patch({ beats: draft.beats.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
                    style={{ fontFamily: 'Spectral, serif', fontSize: 18, lineHeight: 1.45, color: '#f0eee9', background: 'transparent', border: 0, padding: 0, borderRadius: 0, width: '100%' }}
                  />
                  <input
                    value={b.consequence}
                    onChange={(e) => patch({ beats: draft.beats.map((x, j) => (j === i ? { ...x, consequence: e.target.value } : x)) })}
                    style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.5)', lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, borderRadius: 0, width: '100%' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {BEAT_OPTS.map(([id, label]) => (
                    <Chip key={id} active={b.disposition === id}
                      onClick={() => patch({ beats: draft.beats.map((x, j) => (j === i ? { ...x, disposition: id } : x)) })}>
                      {label}
                    </Chip>
                  ))}
                  <button className="btn-quiet" style={{ fontSize: 11, padding: '4px 4px', minHeight: 40 }}
                    onClick={() => patch({ beats: draft.beats.filter((_, j) => j !== i) })}>×</button>
                </div>
              </div>
            );
          })}
          <div>
            <Chip onClick={() => patch({
              beats: [...draft.beats, { where: `S${season.number}`, text: 'A beat the review missed.', consequence: '', disposition: 'keep' }]
            })}>+ add a beat by hand</Chip>
          </div>
        </div>

        {/* gap + returning */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 282px), 1fr))', gap: 15, marginBottom: 30 }}>
          <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 15, minWidth: 0 }}>
            <Mono style={{ fontSize: 9 }}>time between</Mono>
            <div className="serif" style={{ fontWeight: 300, fontSize: 27, color: '#f8f6f2' }}>{gapLabel}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {GAP_LABELS.map((label, i) => (
                <Chip key={label} active={draft.gap === i} onClick={() => patch({ gap: i })}>{label}</Chip>
              ))}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.55)', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 13 }}>
              {GAP_EFFECTS[draft.gap]}
            </div>
            <button
              className="btn-ghost" disabled={busy !== null}
              onClick={() => void run('evolve', async () => {
                clearDebounce();
                const updated = await evolveCharacters(world, draft, gapLabel);
                clearDebounce();
                setDraft(updated);
              })}
            >
              {busy === 'evolve' ? 'Evolving the cast…' : 'Propose what changed off-screen'}
            </button>
          </div>

          <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 11, minWidth: 0 }}>
            <Mono style={{ fontSize: 9 }}>who returns</Mono>
            {draft.characters.map((c, i) => {
              const ch = characters.find((x) => x.id === c.characterId);
              return (
                <div key={c.characterId} style={{
                  display: 'flex', flexDirection: 'column', gap: 8, padding: '9px 10px', borderRadius: 12,
                  border: `1px solid rgba(255,255,255,${c.returning ? '0.14' : '0.06'})`,
                  background: `rgba(255,255,255,${c.returning ? '0.06' : '0'})`,
                  opacity: c.returning ? 1 : 0.45
                }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                    onClick={() => patch({ characters: draft.characters.map((x, j) => (j === i ? { ...x, returning: !x.returning } : x)) })}
                  >
                    <div style={avatarStyle(ch?.hue ?? 200, 28)} />
                    <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{c.name}</div>
                    <div style={{
                      width: 16, height: 16, borderRadius: 6, flexShrink: 0,
                      border: `1px solid ${c.returning ? 'oklch(0.85 0.1 62)' : 'rgba(255,255,255,0.18)'}`,
                      background: c.returning ? 'oklch(0.85 0.1 62)' : 'transparent'
                    }} />
                  </div>
                  <textarea
                    rows={2}
                    value={c.evolution || c.outcome}
                    placeholder="where the season leaves them…"
                    onChange={(e) => patch({
                      characters: draft.characters.map((x, j) => (j === i ? { ...x, evolution: e.target.value } : x))
                    })}
                    style={{ fontSize: 11.5, padding: '7px 9px' }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* premise */}
        <div style={{
          border: '1px solid rgba(255,255,255,0.13)', borderRadius: 18, padding: narrow ? '18px 18px' : '24px 26px',
          background: 'linear-gradient(150deg, rgba(224,165,95,0.12), rgba(255,255,255,0.04))',
          backdropFilter: 'blur(22px)', display: 'flex', flexDirection: 'column', gap: 14
        }}>
          <Mono style={{ fontSize: 9 }}>the premise season {season.number + 1} opens on</Mono>
          <textarea
            rows={3}
            className="serif"
            value={draft.premise}
            onChange={(e) => patch({ premise: e.target.value })}
            placeholder="Write it yourself, or have it drafted from your beat choices…"
            style={{ fontFamily: 'Spectral, serif', fontSize: narrow ? 17 : 21, lineHeight: 1.55, color: '#f6f4f0', background: 'rgba(8,9,12,0.3)' }}
          />
          {!narrow && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingTop: 6 }}>
              <button
                className="btn-primary" style={{ padding: '12px 22px', fontSize: 13.5, minHeight: 44 }}
                disabled={busy !== null || !draft.premise.trim()}
                onClick={beginSeason}
              >
                {busy === 'begin' ? 'Building the season bible…' : `Begin season ${season.number + 1}`}
              </button>
              <button
                className="btn-ghost"
                disabled={busy !== null}
                onClick={redraftPremise}
              >
                {busy === 'premise' ? 'Drafting…' : draft.premise ? 'Redraft the premise' : 'Draft the premise'}
              </button>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)', marginLeft: 'auto' }}>
                {raised} raised · {dropped} dropped · {draft.beats.length} beats reviewed
              </div>
            </div>
          )}
          {busy === 'begin' && <Spinner label="writing the recap and evolving character states" />}
          {narrow && (
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)' }}>
              {raised} raised · {dropped} dropped · {draft.beats.length} beats reviewed
            </div>
          )}
        </div>
      </div>

      {/* Portrait sticky CTAs — always reachable above the tab bar */}
      {narrow && (
        <div style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 40,
          borderTop: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(10,12,16,0.96)',
          backdropFilter: 'blur(24px) saturate(140%)',
          padding: '12px 16px calc(12px + 58px + env(safe-area-inset-bottom))',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          boxShadow: '0 -16px 40px rgba(0,0,0,0.35)'
        }}>
          <button
            className="btn-primary"
            style={{ width: '100%', minHeight: 44, fontSize: 14 }}
            disabled={busy !== null || !draft.premise.trim()}
            onClick={beginSeason}
          >
            {busy === 'begin' ? 'Building the season bible…' : `Begin season ${season.number + 1}`}
          </button>
          <button
            className="btn-ghost"
            style={{ width: '100%', minHeight: 40 }}
            disabled={busy !== null}
            onClick={redraftPremise}
          >
            {busy === 'premise' ? 'Drafting…' : draft.premise ? 'Redraft the premise' : 'Draft the premise'}
          </button>
        </div>
      )}
    </div>
  );
}
