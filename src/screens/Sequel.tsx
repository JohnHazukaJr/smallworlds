import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { analyzeSeason, beginNextSeason, draftPremise, evolveCharacters } from '../ai/engine';
import { db, recordTombstones, safeWrite } from '../db';
import { formatUserError } from '../errors';
import { useApp } from '../store/app';
import type {
  BeatDisposition, CharacterState, SeasonWrap, WrapCharacterOutcome
} from '../types';
import { characterAvatarStyle } from '../ui/avatar';
import { Chip, ErrorNote, Mono, Spinner, phoneChrome, tabBarInset, useViewport } from '../ui/bits';
import { GAP_EFFECTS, GAP_LABELS, ACCENT, ACCENT_RGBA } from '../ui/theme';

const BEAT_OPTS: Array<[BeatDisposition, string]> = [
  ['drop', 'Drop'], ['soften', 'Soften'], ['keep', 'Keep'], ['raise', 'Raise']
];

/** Sticky bar + content spacer so the last card isn’t covered on portrait. */
const STICKY_BAR_RESERVE = 132;

const SHEET_FIELDS = ['role', 'summary', 'traits', 'desires', 'fears', 'flaws'] as const;
const STATE_FIELDS = ['goal', 'emotion', 'location', 'condition'] as const;

function patchCharacter(
  draft: SeasonWrap,
  index: number,
  partial: Partial<WrapCharacterOutcome>
): SeasonWrap['characters'] {
  return draft.characters.map((x, j) => (j === index ? { ...x, ...partial } : x));
}

export function Sequel() {
  const { band } = useViewport();
  const phone = phoneChrome(band);
  const compact = band === 'compact';
  const narrow = phone;
  const { currentWorldId, go } = useApp();
  const [busy, setBusy] = useState<null | 'analyze' | 'evolve' | 'premise' | 'begin'>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<SeasonWrap | null>(null);

  const world = useLiveQuery(
    async () => {
      if (!currentWorldId) return null;
      return (await db.worlds.get(currentWorldId)) ?? null;
    },
    [currentWorldId]
  );
  const season = useLiveQuery(
    async () => {
      if (!world?.activeSeasonId) return null;
      return (await db.seasons.get(world.activeSeasonId)) ?? null;
    },
    [world?.id, world?.activeSeasonId]
  );
  const storedWrap = useLiveQuery(
    async () => {
      if (!season) return null;
      return (await db.wraps.where('seasonId').equals(season.id).filter((w) => w.status === 'draft').first()) ?? null;
    },
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
  // undefined = the live query is still loading; null = there is no draft wrap.
  useEffect(() => {
    if (storedWrap === undefined) return;
    if (storedWrap === null) {
      setDraft(null);
      return;
    }
    setDraft((current) => (current?.id === storedWrap.id ? current : storedWrap));
  }, [storedWrap]);
  const timer = useRef<number>(undefined);
  const dirty = useRef(false);
  const draftRef = useRef<SeasonWrap | null>(null);
  draftRef.current = draft;
  const clearDebounce = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => () => {
    const unsaved = dirty.current;
    clearDebounce();
    const live = draftRef.current;
    if (!unsaved || !live) return;
    dirty.current = false;
    void safeWrite(() => db.wraps.put({ ...live, updatedAt: Date.now() }));
  }, []);
  /** Persist the in-memory draft immediately so Begin/evolve cannot commit a stale wrap. */
  const flushWrap = async (w: SeasonWrap) => {
    clearDebounce();
    dirty.current = false;
    const next = { ...w, updatedAt: Date.now() };
    await safeWrite(() => db.wraps.put(next), setError);
    setDraft(next);
    return next;
  };
  const patch = (p: Partial<SeasonWrap>) => {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...p, updatedAt: Date.now() };
      clearDebounce();
      dirty.current = true;
      timer.current = window.setTimeout(() => {
        dirty.current = false;
        timer.current = undefined;
        void safeWrite(() => db.wraps.put(next), setError);
      }, 400);
      return next;
    });
  };

  const run = async (
    kind: 'analyze' | 'evolve' | 'premise' | 'begin',
    fn: () => Promise<void>
  ) => {
    // Flush pending local edits so AI writes cannot be overwritten by a stale put.
    clearDebounce();
    const live = draftRef.current;
    if (live && dirty.current) {
      dirty.current = false;
      await safeWrite(() => db.wraps.put({ ...live, updatedAt: Date.now() }), setError);
    }
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

  if (currentWorldId && world === undefined) {
    return <div style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }
  if (!world) {
    return (
      <div className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>Open a world to review its season.</div>
        <div><button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button></div>
      </div>
    );
  }
  if (world.activeSeasonId && season === undefined) {
    return <div style={{ padding: 60 }}><Spinner label="opening the season" /></div>;
  }
  if (!season) {
    return (
      <div className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no season</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>This world has no season to review.</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={() => go('story')}>Back to story</button>
          <button className="btn-ghost" onClick={() => go('library')}>Go to Worlds</button>
        </div>
      </div>
    );
  }

  const pagePad = {
    paddingTop: phone ? 'calc(26px + env(safe-area-inset-top))' : 42,
    paddingRight: phone ? 18 : 46,
    paddingBottom: (phone && draft ? STICKY_BAR_RESERVE : 70) as number | string,
    paddingLeft: phone ? 18 : 46
  };

  // ---------- stage 1: no analysis yet ----------
  if (!draft) {
    return (
      <div className="fade-in" style={{ ...pagePad, maxWidth: 1020 }}>
        <button className="btn-quiet" style={{ fontSize: 12, marginBottom: 16, alignSelf: 'flex-start' }}
          onClick={() => go('story')}>← Back to writing</button>
        <Mono style={{ letterSpacing: '0.16em', marginBottom: 11 }}>season {season.number} · {episodeCount} episode{episodeCount === 1 ? '' : 's'} so far</Mono>
        <h1 className="serif" style={{ fontWeight: 300, fontSize: compact ? 26 : phone ? 30 : 40, lineHeight: 1.12, margin: '0 0 11px', color: 'var(--ink-heading)' }}>
          When this season ends, say what mattered.
        </h1>
        <div style={{ fontSize: 14.5, lineHeight: 1.65, color: 'var(--ink-muted)', maxWidth: '62ch', marginBottom: 28 }}>
          The review reads the season back and proposes what the next one should carry. You mark each
          piece — leave it in the past, or let the people arrive already holding it. Then a time gap,
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
            {busy === 'analyze' ? 'Reviewing season…' : `Review season ${season.number}`}
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
    const live = draftRef.current ?? draft;
    const flushed = await flushWrap(live);
    await beginNextSeason(world, season, flushed, GAP_LABELS[flushed.gap]);
    go('story');
  });

  const redraftPremise = () => void run('premise', async () => {
    const live = draftRef.current ?? draft;
    const premise = await draftPremise(world, season, live, GAP_LABELS[live.gap]);
    patch({ premise });
  });

  return (
    <div className="fade-in" style={{ position: 'relative', maxWidth: 1020 }}>
      <div style={pagePad}>
        <button className="btn-quiet" style={{ fontSize: 12, marginBottom: 16 }}
          onClick={() => go('story')}>← Back to story</button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 28 }}>
          <Mono style={{ letterSpacing: '0.16em' }}>season {season.number} closing · season {season.number + 1} setup</Mono>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: compact ? 26 : phone ? 30 : 40, lineHeight: 1.12, margin: 0, color: 'var(--ink-heading)' }}>
            Before the next season, say what mattered.
          </h1>
          <div style={{ fontSize: 14.5, lineHeight: 1.65, color: 'var(--ink-muted)', maxWidth: '62ch' }}>
            I reviewed the season. Here is what I think happened. Mark what should shape the next one — anything
            you drop stays in the past, anything you raise is carried into season {season.number + 1}.
          </div>
        </div>

        {error && <div style={{ marginBottom: 16 }}><ErrorNote error={error} onDismiss={() => setError('')} /></div>}

        <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          {['What mattered', 'How it continues', 'Who returns'].map((label, i) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--rule)',
              background: i === 0 ? ACCENT_RGBA.a12 : 'transparent',
              color: i === 0 ? 'var(--ink-heading)' : 'var(--ink-muted)',
              borderRadius: 4, padding: '8px 14px', fontSize: 12.5, fontWeight: 600,
              boxShadow: i === 0 ? `inset 0 -2px 0 ${ACCENT}` : 'none'
            }}>
              <span className="mono meta" style={{ opacity: 0.55 }}>0{i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
          <button
            className="btn-quiet" style={{ marginLeft: 'auto' }}
            disabled={!!busy}
            onClick={() => {
              if (confirm('Discard this review and re-read the season?')) {
                void safeWrite(async () => {
                  await recordTombstones([{
                    table: 'wraps',
                    id: draft.id,
                    worldId: draft.worldId,
                    seasonId: draft.seasonId,
                    payload: draft
                  }]);
                  await db.wraps.delete(draft.id);
                  dirty.current = false;
                  draftRef.current = null;
                  setDraft(null);
                }, setError);
              }
            }}
          >discard &amp; re-read</button>
        </div>

        {/* beats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 34 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)', marginBottom: 4 }}>
            Raised pieces become aims the next season works toward. What you keep stays as situation.
          </div>
          {draft.beats.map((b, i) => {
            const hot = b.disposition === 'raise';
            return (
              <div key={i} style={{
                border: '1px solid var(--rule)',
                borderRadius: 4,
                background: hot ? ACCENT_RGBA.a10 : 'transparent',
                boxShadow: hot ? `inset 3px 0 0 ${ACCENT_RGBA.a70}` : 'none',
                padding: '16px 18px',
                display: 'flex',
                flexDirection: narrow ? 'column' : 'row',
                alignItems: narrow ? 'stretch' : 'center',
                gap: narrow ? 14 : 20,
                flexWrap: 'wrap',
                opacity: b.disposition === 'drop' ? 0.42 : 1
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', color: 'var(--ink-muted)' }}>{b.where}</div>
                  <input
                    className="serif"
                    value={b.text}
                    onChange={(e) => patch({ beats: draft.beats.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
                    style={{ fontSize: 18, lineHeight: 1.45, color: 'var(--ink-heading)', background: 'transparent', border: 0, padding: 0, borderRadius: 0, width: '100%' }}
                  />
                  <input
                    value={b.consequence}
                    onChange={(e) => patch({ beats: draft.beats.map((x, j) => (j === i ? { ...x, consequence: e.target.value } : x)) })}
                    style={{ fontSize: 12.5, color: 'var(--ink-muted)', lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, borderRadius: 0, width: '100%' }}
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
          <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 15, minWidth: 0 }}>
            <Mono style={{ fontSize: 9 }}>time between</Mono>
            <div className="serif" style={{ fontWeight: 300, fontSize: 27, color: 'var(--ink-heading)' }}>{gapLabel}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {GAP_LABELS.map((label, i) => (
                <Chip key={label} active={draft.gap === i} onClick={() => patch({ gap: i })}>{label}</Chip>
              ))}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-muted)', borderTop: '1px solid var(--rule)', paddingTop: 13 }}>
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
              {busy === 'evolve' ? 'Evolving cast, relationships, and plot…' : 'Propose what changed off-screen'}
            </button>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
              Begin applies only kept patches below. Voice and anchors stay identity.
            </div>
          </div>

          <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 11, minWidth: 0 }}>
            <Mono style={{ fontSize: 9 }}>who returns</Mono>
            {draft.characters.map((c, i) => {
              const ch = characters.find((x) => x.id === c.characterId);
              return (
                <div key={c.characterId} style={{
                  display: 'flex', flexDirection: 'column', gap: 8, padding: '9px 10px', borderRadius: 12,
                  border: '1px solid var(--rule)',
                  background: c.returning ? 'oklch(0.32 0.12 25 / 0.06)' : 'transparent',
                  opacity: c.returning ? 1 : 0.45
                }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                    onClick={() => patch({ characters: patchCharacter(draft, i, { returning: !c.returning }) })}
                  >
                    <div style={characterAvatarStyle(
                      ch ?? { hue: 200, portrait: null, portraits: [] },
                      28
                    )} />
                    <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{c.name}</div>
                    <div style={{
                      width: 16, height: 16, borderRadius: 6, flexShrink: 0,
                      border: `1px solid ${c.returning ? ACCENT : 'var(--rule)'}`,
                      background: c.returning ? ACCENT : 'transparent'
                    }} />
                  </div>
                  <textarea
                    rows={2}
                    value={c.evolution || c.outcome}
                    placeholder="where the season leaves them…"
                    onChange={(e) => patch({
                      characters: patchCharacter(draft, i, { evolution: e.target.value })
                    })}
                    style={{ fontSize: 11.5, padding: '7px 9px' }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Cast / relationship / plot handoff review */}
        {(draft.characters.some((c) => c.returning && (c.sheetPatch || c.statePatch || c.knowledge))
          || (draft.relationshipUpdates?.length ?? 0) > 0
          || (draft.plotArc?.length ?? 0) > 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 30 }}>
            <Mono style={{ fontSize: 9 }}>handoff review · keep what Begin should apply</Mono>

            {draft.characters.filter((c) => c.returning).map((c) => {
              const i = draft.characters.findIndex((x) => x.characterId === c.characterId);
              if (i < 0) return null;
              const hasSheet = !!c.sheetPatch && Object.values(c.sheetPatch).some(Boolean);
              const hasState = !!c.statePatch && Object.values(c.statePatch).some(Boolean);
              const hasKnow = !!(c.knowledge?.nowKnows || c.knowledge?.clearMustNotKnow);
              if (!hasSheet && !hasState && !hasKnow) return null;
              return (
                <div key={c.characterId} className="craft-row" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-heading)', flex: 1 }}>{c.name}</div>
                    {hasSheet && (
                      <Chip
                        active={c.keepSheet !== false}
                        onClick={() => patch({
                          characters: patchCharacter(draft, i, { keepSheet: c.keepSheet === false })
                        })}
                      >
                        {c.keepSheet === false ? 'Sheet dropped' : 'Keep sheet'}
                      </Chip>
                    )}
                    {hasState && (
                      <Chip
                        active={c.keepState !== false}
                        onClick={() => patch({
                          characters: patchCharacter(draft, i, { keepState: c.keepState === false })
                        })}
                      >
                        {c.keepState === false ? 'State dropped' : 'Keep state'}
                      </Chip>
                    )}
                    {hasKnow && (
                      <Chip
                        active={c.keepKnowledge !== false}
                        onClick={() => patch({
                          characters: patchCharacter(draft, i, { keepKnowledge: c.keepKnowledge === false })
                        })}
                      >
                        {c.keepKnowledge === false ? 'Knowledge dropped' : 'Keep knowledge'}
                      </Chip>
                    )}
                  </div>

                  {hasState && c.keepState !== false && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                      {STATE_FIELDS.map((field) => (
                        <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Mono style={{ fontSize: 8, opacity: 0.55 }}>{field}</Mono>
                          <input
                            value={c.statePatch?.[field] ?? ''}
                            placeholder="—"
                            onChange={(e) => {
                              const statePatch: Partial<CharacterState> = {
                                ...(c.statePatch ?? {}),
                                [field]: e.target.value
                              };
                              patch({ characters: patchCharacter(draft, i, { statePatch }) });
                            }}
                            style={{ fontSize: 12.5, background: 'transparent' }}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {hasSheet && c.keepSheet !== false && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {SHEET_FIELDS.filter((f) => c.sheetPatch?.[f]).map((field) => (
                        <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Mono style={{ fontSize: 8, opacity: 0.55 }}>{field}</Mono>
                          <textarea
                            rows={field === 'summary' ? 2 : 1}
                            value={c.sheetPatch?.[field] ?? ''}
                            onChange={(e) => {
                              const sheetPatch = { ...(c.sheetPatch ?? {}), [field]: e.target.value };
                              patch({ characters: patchCharacter(draft, i, { sheetPatch }) });
                            }}
                            style={{ fontSize: 12.5, background: 'transparent' }}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {hasKnow && c.keepKnowledge !== false && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {c.knowledge?.nowKnows && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Mono style={{ fontSize: 8, opacity: 0.55 }}>now knows</Mono>
                          <input
                            value={c.knowledge.nowKnows}
                            onChange={(e) => patch({
                              characters: patchCharacter(draft, i, {
                                knowledge: { ...c.knowledge, nowKnows: e.target.value }
                              })
                            })}
                            style={{ fontSize: 12.5, background: 'transparent' }}
                          />
                        </label>
                      )}
                      {c.knowledge?.clearMustNotKnow && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <Mono style={{ fontSize: 8, opacity: 0.55 }}>clear from must-not-know</Mono>
                          <input
                            value={c.knowledge.clearMustNotKnow}
                            onChange={(e) => patch({
                              characters: patchCharacter(draft, i, {
                                knowledge: { ...c.knowledge, clearMustNotKnow: e.target.value }
                              })
                            })}
                            style={{ fontSize: 12.5, background: 'transparent' }}
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {(draft.relationshipUpdates?.length ?? 0) > 0 && (
              <div className="craft-row" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Mono style={{ fontSize: 9 }}>relationship shifts</Mono>
                {draft.relationshipUpdates!.map((r, i) => (
                  <div key={`${r.from}-${r.to}-${i}`} style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap',
                    opacity: r.keep === false ? 0.42 : 1,
                    padding: '8px 0',
                    borderBottom: '1px solid var(--rule)'
                  }}>
                    <div style={{ flex: 1, minWidth: 160, fontSize: 13, color: '#eceae6' }}>
                      <strong>{r.from}</strong>
                      <span style={{ opacity: 0.45 }}> → </span>
                      <strong>{r.to}</strong>
                      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                        {(r.kind || 'linked')}{r.note ? ` — ${r.note}` : ''}
                      </div>
                    </div>
                    <Chip
                      active={r.keep !== false}
                      onClick={() => patch({
                        relationshipUpdates: draft.relationshipUpdates!.map((x, j) =>
                          j === i ? { ...x, keep: x.keep === false } : x
                        )
                      })}
                    >
                      {r.keep === false ? 'Dropped' : 'Keep'}
                    </Chip>
                  </div>
                ))}
              </div>
            )}

            {(draft.plotArc?.length ?? 0) > 0 && (
              <div className="craft-row" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Mono style={{ fontSize: 9 }}>extra plot situations · Raise beats already seed targets</Mono>
                {raised > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', lineHeight: 1.45 }}>
                    {raised} piece{raised === 1 ? '' : 's'} will shape the next season.
                  </div>
                )}
                {draft.plotArc!.map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                    opacity: p.keep === false ? 0.42 : 1
                  }}>
                    <input
                      value={p.text}
                      onChange={(e) => patch({
                        plotArc: draft.plotArc!.map((x, j) => (j === i ? { ...x, text: e.target.value } : x))
                      })}
                      style={{ flex: 1, minWidth: 160, fontSize: 13, background: 'transparent' }}
                    />
                    <Chip
                      active={p.keep !== false}
                      onClick={() => patch({
                        plotArc: draft.plotArc!.map((x, j) =>
                          j === i ? { ...x, keep: x.keep === false } : x
                        )
                      })}
                    >
                      {p.keep === false ? 'Dropped' : 'Keep'}
                    </Chip>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* premise */}
        <div className="craft-row" style={{
          padding: narrow ? '18px 18px' : '24px 26px',
          display: 'flex', flexDirection: 'column', gap: 14
        }}>
          <div className="label">The premise season {season.number + 1} opens on</div>
          <textarea
            rows={3}
            className="serif"
            value={draft.premise}
            onChange={(e) => patch({ premise: e.target.value })}
            placeholder="Write it yourself, or have it drafted from your beat choices…"
            style={{ fontSize: narrow ? 17 : 21, lineHeight: 1.55, color: 'var(--ink-heading)', background: 'transparent' }}
          />
          {!narrow && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingTop: 6 }}>
              <button
                className="btn-primary" style={{ padding: '12px 22px', fontSize: 13.5, minHeight: 44 }}
                disabled={busy !== null || !draft.premise.trim()}
                onClick={beginSeason}
              >
                {busy === 'begin' ? 'Starting next season…' : `Begin season ${season.number + 1}`}
              </button>
              <button
                className="btn-ghost"
                disabled={busy !== null}
                onClick={redraftPremise}
              >
                {busy === 'premise' ? 'Drafting…' : draft.premise ? 'Redraft the premise' : 'Draft the premise'}
              </button>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)', marginLeft: 'auto' }}>
                {raised} raised · {dropped} dropped · {draft.beats.length} beats reviewed
              </div>
            </div>
          )}
          {busy === 'begin' && <Spinner label="writing the recap and applying cast handoff" />}
          {narrow && (
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)' }}>
              {raised} raised · {dropped} dropped · {draft.beats.length} beats reviewed
            </div>
          )}
        </div>
      </div>

      {/* Portrait sticky CTAs — always reachable above the tab bar */}
      {phone && (
        <div style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: tabBarInset(true),
          zIndex: 30,
          borderTop: '1px solid var(--rule)',
          background: 'transparent',
          
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          boxShadow: '0 -8px 24px rgba(0,0,0,0.06)'
        }}>
          <button
            className="btn-primary"
            style={{ width: '100%', minHeight: 44, fontSize: 14 }}
            disabled={busy !== null || !draft.premise.trim()}
            onClick={beginSeason}
          >
            {busy === 'begin' ? 'Starting next season…' : `Begin season ${season.number + 1}`}
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
