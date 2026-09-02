import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { draftCharacter, fleshOutCharacter, fleshOutRelationships } from '../ai/engine';
import { RelationshipMap, type RelationshipMapMode } from '../components/RelationshipMap';
import { db, recordTombstones, safeWrite } from '../db';
import { formatUserError } from '../errors';
import {
  hasLink, inboundFor, KIND_PRESETS, normalizeRelationships, pruneRelationshipsToCast,
  removeLink, suggestInverseKind, trimRelationships, unlinkedOthers, upsertLink
} from '../relationships';
import { useApp } from '../store/app';
import type { Character, Relationship } from '../types';
import { Chip, ErrorNote, Field, Mono, Spinner, useVw } from '../ui/bits';
import { fileToPortraitImage } from '../ui/image';
import { avatarStyle, STRIPE, ACCENT, ACCENT_RGBA } from '../ui/theme';
import { characterPortraits, emptyCharacter, MAX_CHARACTER_PORTRAITS, portraitsPatch } from '../worldOps';

type Tab = 'persona' | 'voice' | 'psyche' | 'secrets' | 'relations' | 'anchors' | 'ai';
const TABS: Array<[Tab, string]> = [
  ['persona', 'Persona'], ['voice', 'Voice'], ['psyche', 'Psyche'], ['secrets', 'Secrets'],
  ['relations', 'Relations'], ['anchors', 'Anchors'], ['ai', 'AI notes']
];

/** Debounced autosave of a character draft back to the DB. */
function useAutosave(draft: Character | null, onError: (msg: string) => void) {
  const timer = useRef<number>(undefined);
  const pending = useRef<Character | null>(null);
  const first = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    if (!draft) return;
    if (first.current) { first.current = false; return; }
    pending.current = draft;
    window.clearTimeout(timer.current);
    const flush = (d: Character) => {
      void safeWrite(
        () => db.characters.put({ ...d, updatedAt: Date.now() }),
        (msg) => onErrorRef.current(msg)
      );
    };
    timer.current = window.setTimeout(() => {
      const d = pending.current;
      pending.current = null;
      if (d) flush(d);
    }, 500);
    return () => {
      window.clearTimeout(timer.current);
      const d = pending.current;
      pending.current = null;
      if (d) flush(d);
    };
  }, [draft]);
  useEffect(() => { first.current = true; }, [draft?.id]);
}

export function Cast() {
  const vw = useVw();
  const narrow = vw < 1000;
  const { currentWorldId, go, pendingCharacterId, clearPendingCharacter } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('persona');
  const [aiDesc, setAiDesc] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Character | null>(null);
  const [fleshBusy, setFleshBusy] = useState(false);
  const [fleshError, setFleshError] = useState('');
  const [undoSnapshot, setUndoSnapshot] = useState<Character | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [portraitBusy, setPortraitBusy] = useState(false);
  const [portraitError, setPortraitError] = useState('');

  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const cast = useLiveQuery(
    async () => (world ? db.characters.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];

  const selected = cast.find((c) => c.id === selectedId)
    ?? (pendingCharacterId ? cast.find((c) => c.id === pendingCharacterId) : undefined)
    ?? cast.find((c) => !c.isPlayer)
    ?? cast[0];

  // Honor one-shot focus from World editor / other screens.
  useEffect(() => {
    if (!pendingCharacterId || cast.length === 0) return;
    if (cast.some((c) => c.id === pendingCharacterId)) {
      setSelectedId(pendingCharacterId);
      clearPendingCharacter();
    }
  }, [pendingCharacterId, cast, clearPendingCharacter]);

  // Sync draft when the selected character changes.
  useEffect(() => {
    if (selected && selected.id !== draft?.id) setDraft(selected);
    if (!selected) setDraft(null);
    setFleshError('');
    setUndoSnapshot(null);
    setPortraitError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useAutosave(draft, setError);

  const patch = (p: Partial<Character>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const onPortraitFile = async (file: File) => {
    if (!draft) return;
    const current = characterPortraits(draft);
    if (current.length >= MAX_CHARACTER_PORTRAITS) {
      setPortraitError(`Up to ${MAX_CHARACTER_PORTRAITS} photos per character.`);
      return;
    }
    setPortraitBusy(true);
    setPortraitError('');
    try {
      const url = await fileToPortraitImage(file);
      const next = portraitsPatch([...current, url]);
      await db.characters.update(draft.id, { ...next, updatedAt: Date.now() });
      patch(next);
    } catch (e) {
      setPortraitError(formatUserError(e));
    } finally {
      setPortraitBusy(false);
    }
  };

  const removePortraitAt = async (index: number) => {
    if (!draft) return;
    const current = characterPortraits(draft);
    const next = portraitsPatch(current.filter((_, i) => i !== index));
    await db.characters.update(draft.id, { ...next, updatedAt: Date.now() });
    patch(next);
  };

  const setPrimaryPortrait = async (index: number) => {
    if (!draft || index <= 0) return;
    const current = characterPortraits(draft);
    if (index >= current.length) return;
    const reordered = [current[index], ...current.filter((_, i) => i !== index)];
    const next = portraitsPatch(reordered);
    await db.characters.update(draft.id, { ...next, updatedAt: Date.now() });
    patch(next);
  };

  const toggleSelfTag = async () => {
    if (!draft) return;
    const next = !draft.selfTag;
    if (next) {
      const others = cast.filter((c) => c.id !== draft.id && c.selfTag);
      await Promise.all(others.map((c) => db.characters.update(c.id, { selfTag: false, updatedAt: Date.now() })));
    }
    await db.characters.update(draft.id, { selfTag: next, updatedAt: Date.now() });
    patch({ selfTag: next });
  };

  const fleshOut = async () => {
    if (!draft) return;
    setFleshBusy(true);
    setFleshError('');
    try {
      const result = await fleshOutCharacter(world ?? null, draft, cast);
      setUndoSnapshot(draft);
      patch(result);
    } catch (e) {
      setFleshError(formatUserError(e));
    } finally {
      setFleshBusy(false);
    }
  };

  const undoFleshOut = () => {
    if (undoSnapshot) setDraft(undoSnapshot);
    setUndoSnapshot(null);
  };

  const addCharacter = async (fromAI?: Partial<Character>) => {
    if (!world) return;
    const c = emptyCharacter(world.id, { name: 'New character', ...fromAI });
    await db.characters.add(c);
    setSelectedId(c.id);
    setCreating(false);
    setAiDesc('');
  };

  const aiDraft = async () => {
    if (!world || !aiDesc.trim()) return;
    setAiBusy(true);
    setError('');
    try {
      const result = await draftCharacter(world, aiDesc.trim());
      await addCharacter(result);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setAiBusy(false);
    }
  };

  if (!world) {
    return (
      <div className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: '#f8f6f2' }}>Open a world to meet its inhabitants.</div>
        <div><button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button></div>
      </div>
    );
  }

  const d = draft;

  return (
    <div className="fade-in" style={{ display: 'grid', minHeight: '100vh', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '264px minmax(0, 1fr)' }}>
      {/* cast list */}
      <div style={{
        borderRight: narrow ? 'none' : '1px solid rgba(255,255,255,0.07)',
        borderBottom: narrow ? '1px solid rgba(255,255,255,0.07)' : 'none',
        padding: narrow ? '18px 16px 12px' : '26px 16px',
        paddingTop: narrow ? 'calc(18px + env(safe-area-inset-top))' : 26,
        display: 'flex', flexDirection: narrow ? 'row' : 'column', gap: narrow ? 8 : 16,
        background: 'rgba(255,255,255,0.02)', overflowX: narrow ? 'auto' : undefined,
        alignItems: narrow ? 'center' : undefined
      }}>
        {!narrow && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="seed-mark" />
              Inhabitants · {world.title}
            </div>
            <button className="btn-ghost" style={{ padding: '5px 11px', fontSize: 11 }} onClick={() => setCreating(true)}>+ new</button>
          </div>
        )}
        {narrow && (
          <button className="btn-ghost" style={{ padding: '5px 11px', fontSize: 11, flexShrink: 0 }} onClick={() => setCreating(true)}>+ new</button>
        )}
        {cast.map((c) => {
          const active = selected?.id === c.id;
          return (
            <div key={c.id} onClick={() => { setSelectedId(c.id); setTab('persona'); }} style={{
              display: 'flex', gap: 10, alignItems: 'center', padding: 9, borderRadius: 13, cursor: 'pointer',
              flexShrink: 0,
              background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: `1px solid ${active ? 'rgba(255,255,255,0.14)' : 'transparent'}`,
              backdropFilter: active ? 'blur(18px)' : undefined
            }}>
              {(() => {
                const face = characterPortraits(c)[0];
                return (
                  <div style={{
                    ...avatarStyle(c.hue, 34),
                    ...(face ? { backgroundImage: `url(${face})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {})
                  }} />
                );
              })()}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9', whiteSpace: 'nowrap' }}>
                  {c.name || 'unnamed'}{c.selfTag ? ' · me' : ''}
                </div>
                {!narrow && (
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.42)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.role || (c.isPlayer ? 'protagonist' : 'no role yet')}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* editor */}
      <div style={{ padding: narrow ? '22px 18px 60px' : '34px 40px 60px', maxWidth: 1000 }}>
        {creating && (
          <div className="craft-row" style={{ padding: 20, marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f6f4f0' }}>New character</div>
              <button className="btn-quiet" onClick={() => setCreating(false)}>cancel</button>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.6)' }}>
              Describe them in a sentence and the utility model drafts a full sheet you can edit — or start blank.
            </div>
            <textarea
              rows={2} value={aiDesc} onChange={(e) => setAiDesc(e.target.value)}
              placeholder="e.g. A lighthouse keeper who has been reporting a ship that no one else can see"
            />
            {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn-primary" disabled={aiBusy || !aiDesc.trim()} onClick={() => void aiDraft()}>
                {aiBusy ? 'Drafting…' : 'Draft with AI'}
              </button>
              <button className="btn-ghost" onClick={() => void addCharacter()}>Start blank</button>
              {aiBusy && <Spinner label="the utility model is writing the sheet" />}
            </div>
          </div>
        )}

        {!d && !creating && (
          <div style={{ opacity: 0.6 }}>
            <div className="serif" style={{ fontSize: 24, fontWeight: 300 }}>No cast yet.</div>
            <button className="btn-primary" style={{ marginTop: 14 }} onClick={() => setCreating(true)}>Create the first character</button>
          </div>
        )}

        {d && (
          <>
            <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 32 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11, width: narrow ? '100%' : 258 }}>
                {(() => {
                  const gallery = characterPortraits(d);
                  const primary = gallery[0] ?? null;
                  return (
                    <>
                      <div style={{
                        height: narrow ? 160 : 306, borderRadius: 16, border: '1px solid rgba(255,255,255,0.12)',
                        display: 'flex', alignItems: 'flex-end', padding: 12, position: 'relative', overflow: 'hidden',
                        backgroundImage: primary
                          ? `url(${primary})`
                          : `linear-gradient(155deg, oklch(0.5 0.06 ${d.hue} / 0.7), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`,
                        backgroundSize: 'cover', backgroundPosition: 'center'
                      }}>
                        {!primary && (
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.62)', background: 'rgba(8,9,12,0.5)', backdropFilter: 'blur(6px)', padding: '5px 8px', borderRadius: 6 }}>
                            portrait plate · no photo yet
                          </span>
                        )}
                        {d.selfTag && (
                          <span style={{
                            position: 'absolute', top: 10, right: 10, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5,
                            letterSpacing: '0.06em', color: '#0a1416', background: ACCENT, padding: '4px 8px', borderRadius: 4
                          }}>this is me</span>
                        )}
                      </div>
                      {gallery.length > 0 && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {gallery.map((url, i) => (
                            <div key={`${i}-${url.slice(0, 24)}`} style={{ position: 'relative' }}>
                              <button
                                type="button"
                                title={i === 0 ? 'Primary face' : 'Make primary'}
                                onClick={() => void setPrimaryPortrait(i)}
                                style={{
                                  width: 52, height: 52, borderRadius: 10, padding: 0, cursor: 'pointer',
                                  border: i === 0 ? `2px solid ${ACCENT}` : '1px solid rgba(255,255,255,0.16)',
                                  backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center'
                                }}
                              />
                              <button
                                type="button"
                                className="btn-quiet"
                                title="Remove photo"
                                onClick={() => void removePortraitAt(i)}
                                style={{
                                  position: 'absolute', top: -6, right: -6, width: 18, height: 18, padding: 0,
                                  borderRadius: '50%', fontSize: 10, lineHeight: '18px',
                                  background: 'rgba(8,9,12,0.85)', border: '1px solid rgba(255,255,255,0.2)'
                                }}
                              >×</button>
                            </div>
                          ))}
                        </div>
                      )}
                      <input
                        ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPortraitFile(f); e.target.value = ''; }}
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 11, padding: '6px 12px' }}
                          disabled={portraitBusy || gallery.length >= MAX_CHARACTER_PORTRAITS}
                          onClick={() => fileRef.current?.click()}
                        >
                          {portraitBusy ? 'Uploading…' : gallery.length ? 'Add photo' : 'Upload photo'}
                        </button>
                        {gallery.length > 0 && (
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.45 }}>
                            {gallery.length}/{MAX_CHARACTER_PORTRAITS} · tap a thumb to set primary
                          </span>
                        )}
                      </div>
                    </>
                  );
                })()}
                {portraitError && <ErrorNote error={portraitError} onDismiss={() => setPortraitError('')} />}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Mono style={{ fontSize: 9 }}>plate hue</Mono>
                  <input
                    type="range" min={0} max={359} value={d.hue}
                    onChange={(e) => patch({ hue: Number(e.target.value) })}
                    style={{ padding: 0, height: 4 }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button
                      className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}
                      disabled={fleshBusy} onClick={() => void fleshOut()}
                    >{fleshBusy ? 'Working…' : '✦ Flesh out with AI'}</button>
                    {undoSnapshot && (
                      <button className="btn-quiet" style={{ fontSize: 11 }} onClick={undoFleshOut}>undo</button>
                    )}
                  </div>
                  {fleshBusy && <Spinner label="the utility model is fleshing out the sheet" />}
                  {fleshError && <ErrorNote error={fleshError} onDismiss={() => setFleshError('')} />}
                </div>
                {!d.isPlayer && (
                  <button
                    className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                    onClick={() => void toggleSelfTag()}
                  >{d.selfTag ? '✓ tagged as me — untag' : 'tag as "this is me"'}</button>
                )}
                {!d.isPlayer && (
                  <button
                    className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                    onClick={async () => {
                      if (confirm(`Remove ${d.name || 'this character'} from the world?`)) {
                        await recordTombstones([{ table: 'characters', id: d.id, worldId: d.worldId, payload: d }]);
                        const remaining = cast.filter((c) => c.id !== d.id);
                        const pruned = pruneRelationshipsToCast(remaining);
                        await db.transaction('rw', db.characters, async () => {
                          await db.characters.delete(d.id);
                          for (const c of pruned) {
                            const before = remaining.find((x) => x.id === c.id);
                            if (!before) continue;
                            if (JSON.stringify(before.relationships) !== JSON.stringify(c.relationships)) {
                              await db.characters.update(c.id, {
                                relationships: c.relationships,
                                updatedAt: Date.now()
                              });
                            }
                          }
                        });
                        setSelectedId(null);
                      }
                    }}
                  >remove from world</button>
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <Mono style={{ letterSpacing: '0.16em', marginBottom: 8 }}>{d.isPlayer ? 'the player' : 'character'}</Mono>
                  <input
                    value={d.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name"
                    className="serif"
                    style={{ fontFamily: 'Spectral, serif', fontWeight: 300, fontSize: narrow ? 28 : 38, color: '#f8f6f2', lineHeight: 1.08, background: 'transparent', border: 0, padding: 0, borderRadius: 0 }}
                  />
                  <input
                    value={d.role} onChange={(e) => patch({ role: e.target.value })}
                    placeholder="role · relation to the protagonist"
                    style={{ fontSize: 13.5, color: 'rgba(236,234,230,0.7)', marginTop: 8, background: 'transparent', border: 0, padding: 0, borderRadius: 0 }}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 11 }}>
                  {([
                    ['current goal', d.state.goal, (v: string) => patch({ state: { ...d.state, goal: v } })],
                    ['emotional state', d.state.emotion, (v: string) => patch({ state: { ...d.state, emotion: v } })],
                    ['location', d.state.location, (v: string) => patch({ state: { ...d.state, location: v } })],
                    ['condition', d.state.condition, (v: string) => patch({ state: { ...d.state, condition: v } })]
                  ] as Array<[string, string, (v: string) => void]>).map(([k, v, set]) => (
                    <div key={k} className="craft-row" style={{ borderRadius: 4, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <Mono style={{ fontSize: 9, letterSpacing: '0.12em' }}>{k}</Mono>
                      <input
                        value={v} onChange={(e) => set(e.target.value)} placeholder="—"
                        style={{ fontSize: 13, background: 'transparent', border: 0, padding: 0, borderRadius: 0, color: 'rgba(236,234,230,0.92)' }}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.5, color: 'rgba(236,234,230,0.5)' }}>
                  Live state updates lightly mid-episode and fully at wrap. Voice, anchors, and psyche stay who they are.
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 24, flexWrap: 'wrap', overflowX: 'auto' }}>
              {TABS.map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{
                  border: 0, background: 'transparent',
                  color: tab === id ? '#f8f6f2' : 'rgba(236,234,230,0.45)',
                  borderBottom: `2px solid ${tab === id ? ACCENT : 'transparent'}`,
                  padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap'
                }}>{label}</button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {tab === 'persona' && (
                <>
                  <Field label="Who they are" note="prose, not bullet points — this is the core of the sheet">
                    <textarea rows={4} value={d.summary} onChange={(e) => patch({ summary: e.target.value })}
                      className="serif" style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.7 }} />
                  </Field>
                  <Field label="Age / read"><input value={d.age} onChange={(e) => patch({ age: e.target.value })} placeholder="Late thirties. Tired in a competent way." /></Field>
                  <Field label="Appearance" note="identity the narrator keeps consistent">
                    <textarea rows={2} value={d.appearance} onChange={(e) => patch({ appearance: e.target.value })} />
                  </Field>
                  <Field label="Mannerisms" note="recurring physical habits the narrator weaves in — never all at once">
                    <textarea rows={2} value={d.mannerisms ?? ''} onChange={(e) => patch({ mannerisms: e.target.value })}
                      placeholder="Cracks her knuckles one at a time when stalling. Never sits with her back to a door." />
                  </Field>
                  <Field label="Backstory" note="informs behaviour; the narrator reveals it only in earned fragments">
                    <textarea rows={4} value={d.backstory ?? ''} onChange={(e) => patch({ backstory: e.target.value })}
                      placeholder="Where they come from, what it cost, and what they had to become to survive it." />
                  </Field>
                </>
              )}

              {tab === 'voice' && (
                <>
                  <Field label="How they speak" note="stable identity — cadence stays even as goals and mood shift">
                    <textarea rows={3} value={d.speechStyle} onChange={(e) => patch({ speechStyle: e.target.value })}
                      placeholder="Clipped. Rarely finishes a thought aloud if a look will do it." />
                  </Field>
                  <Field label="Example lines" note="2–4 sample lines in their voice — one per line; models imitate rhythm, not copy">
                    <textarea
                      rows={4}
                      value={d.exampleLines.join('\n')}
                      onChange={(e) => patch({ exampleLines: e.target.value.split('\n') })}
                      onBlur={() => patch({
                        exampleLines: d.exampleLines.map((l) => l.trim()).filter(Boolean)
                      })}
                      placeholder={'Then write it again, and put your own name on it.\nThe ledger doesn\u2019t care what I believe.'}
                    />
                  </Field>
                </>
              )}

              {tab === 'psyche' && (
                <>
                  <Field label="Traits"><textarea rows={2} value={d.traits} onChange={(e) => patch({ traits: e.target.value })} placeholder="Precise, unhurried, quietly territorial." /></Field>
                  <Field label="Desires" note="what they pursue — this is what makes them proactive">
                    <textarea rows={2} value={d.desires} onChange={(e) => patch({ desires: e.target.value })} />
                  </Field>
                  <Field label="Fears"><textarea rows={2} value={d.fears} onChange={(e) => patch({ fears: e.target.value })} /></Field>
                  <Field label="Flaws" note="believable contradiction beats likability">
                    <textarea rows={2} value={d.flaws} onChange={(e) => patch({ flaws: e.target.value })} />
                  </Field>
                </>
              )}

              {tab === 'secrets' && (
                <>
                  <Field label="Secrets they carry" note="they may act on these; they never announce them">
                    <textarea rows={3} value={d.secrets} onChange={(e) => patch({ secrets: e.target.value })} />
                  </Field>
                  <div className="craft-row" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f6f4f0' }}>Must not know yet</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.6)' }}>
                      Plot knowledge this character is walled off from. The narrator will never let them learn,
                      reference, or act on any of it until you remove it from this box.
                    </div>
                    <textarea rows={3} value={d.mustNotKnow} onChange={(e) => patch({ mustNotKnow: e.target.value })}
                      placeholder="e.g. That Ivo took guild money to cover the debt." />
                  </div>
                </>
              )}

              {tab === 'relations' && (
                <RelationsEditor
                  character={d}
                  cast={cast}
                  narrow={narrow}
                  onChange={(relationships) => {
                    const ids = cast.map((c) => c.id);
                    patch({ relationships: normalizeRelationships(relationships, ids, d.id) });
                  }}
                  onSelectCharacter={(id) => setSelectedId(id)}
                  onFleshOut={async () => {
                    setFleshBusy(true);
                    setFleshError('');
                    try {
                      const next = await fleshOutRelationships(world ?? null, d, cast);
                      setUndoSnapshot(draft);
                      const ids = cast.map((c) => c.id);
                      patch({ relationships: normalizeRelationships(next, ids, d.id) });
                    } catch (e) {
                      setFleshError(formatUserError(e));
                    } finally {
                      setFleshBusy(false);
                    }
                  }}
                  fleshBusy={fleshBusy}
                />
              )}

              {tab === 'anchors' && (
                <div className="craft-row" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT }} />
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f6f4f0' }}>Behaviour anchors</div>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)', marginLeft: 'auto' }}>
                      what keeps them human
                    </div>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.65, color: 'rgba(236,234,230,0.6)' }}>
                    Hard rules, rendered as a non-negotiable block when this character is in scene (narrator / speak).
                    One per line.
                  </div>
                  <textarea
                    rows={5}
                    value={d.anchors.join('\n')}
                    onChange={(e) => patch({ anchors: e.target.value.split('\n') })}
                    onBlur={() => patch({
                      anchors: d.anchors.map((l) => l.trim()).filter(Boolean)
                    })}
                    placeholder={'Never lies in writing. Will omit, will refuse, will not falsify.\nDoes not warm to you quickly. Trust moves one notch per episode at most.'}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {d.anchors.filter((a) => a.trim()).map((a, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5, color: 'rgba(236,234,230,0.9)' }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: ACCENT, paddingTop: 3 }}>
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span>{a}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tab === 'ai' && (
                <Field label="Custom AI instructions" note="verbatim when this character is in scene (narrator / speak)">
                  <textarea
                    rows={5} value={d.customInstructions}
                    onChange={(e) => patch({ customInstructions: e.target.value })}
                    placeholder="Anything the structured fields don't cover: how they fight, what they do when bored, a verbal tic, a rule for how they treat strangers…"
                  />
                </Field>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RelationsEditor({
  character, cast, narrow, onChange, onSelectCharacter, onFleshOut, fleshBusy
}: {
  character: Character;
  cast: Character[];
  narrow: boolean;
  onChange: (r: Relationship[]) => void;
  onSelectCharacter: (id: string) => void;
  onFleshOut: () => Promise<void>;
  fleshBusy: boolean;
}) {
  const [mode, setMode] = useState<RelationshipMapMode | 'list'>('map');
  const [focusTargetId, setFocusTargetId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const others = cast.filter((c) => c.id !== character.id);
  const available = unlinkedOthers(character, cast);
  const inbound = inboundFor(character.id, cast);

  useEffect(() => {
    if (!focusTargetId) return;
    const el = cardRefs.current[focusTargetId];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusTargetId, character.relationships]);

  const setRels = (rels: Relationship[]) => onChange(rels);

  const updateByTarget = (targetId: string, p: Partial<Relationship>) => {
    const cur = character.relationships.find((r) => r.targetId === targetId);
    if (!cur) return;
    setRels(upsertLink(character.relationships, { ...cur, ...p, targetId }));
  };

  const add = () => {
    if (available.length === 0) return;
    setRels(upsertLink(character.relationships, {
      targetId: available[0].id, kind: 'ally', note: ''
    }));
    setFocusTargetId(available[0].id);
  };

  const addReverseOnThem = async (target: Character, fromRel: Relationship) => {
    if (hasLink(target.relationships, character.id)) {
      setNotice(`${target.name || 'They'} already link back.`);
      return;
    }
    const ids = cast.map((c) => c.id);
    const next = normalizeRelationships(
      upsertLink(target.relationships, {
        targetId: character.id,
        kind: suggestInverseKind(fromRel.kind),
        note: fromRel.note
      }),
      ids,
      target.id
    );
    await db.characters.update(target.id, { relationships: next, updatedAt: Date.now() });
    setNotice(`Added reverse on ${target.name || 'them'}.`);
  };

  const addReverseHere = (from: Character, theirRel: Relationship) => {
    if (hasLink(character.relationships, from.id)) return;
    setRels(upsertLink(character.relationships, {
      targetId: from.id,
      kind: suggestInverseKind(theirRel.kind),
      note: theirRel.note
    }));
    setFocusTargetId(from.id);
    setNotice(`Added outbound link to ${from.name || 'them'}.`);
  };

  const showMap = mode === 'map' || mode === 'web';
  // On phone, keep the editor under Map/Web so every feature stays reachable without mode juggling.
  const showEditor = mode === 'list' || mode === 'map' || narrow;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16,
      paddingBottom: narrow ? 'calc(72px + env(safe-area-inset-bottom))' : 0
    }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.6)' }}>
        Outbound links from <strong style={{ color: 'rgba(236,234,230,0.85)', fontWeight: 600 }}>{character.name || 'this character'}</strong>.
        Map shows the web; dashed edges are inbound-only. The cast card named “you” is the story protagonist — not you the author.
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        ...(narrow ? {
          position: 'sticky' as const,
          top: 0,
          zIndex: 5,
          margin: '0 -4px',
          padding: '8px 4px 10px',
          background: 'rgba(255,255,255,0.045)',
          backdropFilter: 'blur(14px) saturate(140%)',
          borderBottom: '1px solid rgba(255,255,255,0.08)'
        } : {})
      }}>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
          {([
            ['map', 'Map'] as const,
            ['web', 'Web'] as const,
            ['list', 'List'] as const
          ]).map(([id, label]) => (
            <Chip key={id} active={mode === id} onClick={() => setMode(id)}>{label}</Chip>
          ))}
        </div>
        <button
          className="btn-ghost"
          style={{ width: narrow ? '100%' : undefined, alignSelf: narrow ? 'stretch' : 'flex-start', fontSize: 12, minHeight: 44 }}
          disabled={fleshBusy || others.length === 0}
          onClick={() => void onFleshOut()}
        >
          {fleshBusy ? 'Fleshing relationships…' : 'Flesh out relationships'}
        </button>
      </div>

      {notice && (
        <div style={{
          fontSize: 12.5, color: 'rgba(200,230,235,0.95)',
          border: `1px solid ${ACCENT_RGBA.a35}`, borderRadius: 6, padding: '10px 12px',
          background: ACCENT_RGBA.a08, display: 'flex', gap: 10
        }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button className="btn-quiet" style={{ fontSize: 12, minHeight: 40 }} onClick={() => setNotice('')}>×</button>
        </div>
      )}

      {showMap && others.length > 0 && (
        <RelationshipMap
          mode={mode === 'web' ? 'web' : 'map'}
          subject={character}
          cast={cast}
          narrow={narrow}
          onSelectCharacter={(id) => {
            if (id === character.id) return;
            onSelectCharacter(id);
          }}
          onFocusEdge={(targetId) => {
            setMode('map');
            setFocusTargetId(targetId);
          }}
        />
      )}

      {others.length === 0 && (
        <div style={{ fontSize: 12.5, opacity: 0.5 }}>Add another cast member to map relationships.</div>
      )}

      {showEditor && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Mono style={{ fontSize: 9 }}>outbound from {character.name || 'subject'}</Mono>
          {character.relationships.map((r) => {
            const target = cast.find((c) => c.id === r.targetId);
            const kindIsPreset = KIND_PRESETS.includes(r.kind as typeof KIND_PRESETS[number]);
            const hot = focusTargetId === r.targetId;
            return (
              <div
                key={r.targetId}
                ref={(el) => { cardRefs.current[r.targetId] = el; }}
                className="craft-row"
                style={{
                  padding: narrow ? 14 : 14, display: 'flex', flexDirection: 'column', gap: 10,
                  border: hot ? `1px solid ${ACCENT_RGBA.a45}` : undefined
                }}
              >
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select
                    value={r.targetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      if (nextId === r.targetId) return;
                      if (hasLink(character.relationships, nextId)) return;
                      setRels(
                        upsertLink(
                          removeLink(character.relationships, r.targetId),
                          { ...r, targetId: nextId }
                        )
                      );
                      setFocusTargetId(nextId);
                    }}
                    style={{ width: narrow ? '100%' : 'auto', minWidth: 140, minHeight: 44 }}
                  >
                    {target && <option value={target.id}>{target.name || 'unnamed'}</option>}
                    {available.map((c) => (
                      <option key={c.id} value={c.id}>{c.name || 'unnamed'}</option>
                    ))}
                  </select>
                  <button
                    className="btn-quiet"
                    style={{ marginLeft: narrow ? 0 : 'auto', fontSize: 12, minHeight: 44 }}
                    onClick={() => setRels(removeLink(character.relationships, r.targetId))}
                  >remove</button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {KIND_PRESETS.map((k) => (
                    <Chip key={k} active={r.kind === k} onClick={() => updateByTarget(r.targetId, { kind: k })}>
                      {k}
                    </Chip>
                  ))}
                  <Chip
                    active={!kindIsPreset}
                    onClick={() => {
                      if (kindIsPreset) updateByTarget(r.targetId, { kind: 'linked' });
                    }}
                  >custom</Chip>
                </div>
                {!kindIsPreset && (
                  <input
                    value={r.kind}
                    onChange={(e) => updateByTarget(r.targetId, { kind: e.target.value })}
                    onBlur={() => setRels(trimRelationships(character.relationships))}
                    placeholder="custom kind…"
                    style={{ width: '100%', maxWidth: narrow ? '100%' : 220, minHeight: 44 }}
                  />
                )}
                <input
                  value={r.note}
                  onChange={(e) => updateByTarget(r.targetId, { note: e.target.value })}
                  onBlur={() => setRels(trimRelationships(character.relationships))}
                  placeholder="the history between them, one line"
                  style={{ minHeight: 44 }}
                />
                {target && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn-quiet" style={{ fontSize: 12, minHeight: 44 }} onClick={() => onSelectCharacter(target.id)}>
                      Open {target.name || 'them'}
                    </button>
                    {!hasLink(target.relationships, character.id) ? (
                      <button
                        className="btn-quiet"
                        style={{ fontSize: 12, minHeight: 44 }}
                        onClick={() => void addReverseOnThem(target, r)}
                      >
                        Add reverse on them
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, opacity: 0.45, alignSelf: 'center' }}>they link back</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {available.length > 0 ? (
            <div><Chip onClick={add}>+ add relationship</Chip></div>
          ) : character.relationships.length > 0 ? (
            <div style={{ fontSize: 12, opacity: 0.45 }}>Linked to everyone in the cast.</div>
          ) : null}
        </div>
      )}

      {!narrow && mode === 'web' && character.relationships.length > 0 && (
        <button className="btn-quiet" style={{ fontSize: 12, alignSelf: 'flex-start' }} onClick={() => setMode('list')}>
          Edit outbound list
        </button>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>linked from · inbound</Mono>
        {inbound.length === 0 && (
          <div style={{ fontSize: 12.5, opacity: 0.45 }}>No one links here yet.</div>
        )}
        {inbound.map(({ from, rel }) => (
          <div key={from.id} className="craft-row" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#f0eee9' }}>
              <strong>{from.name || 'unnamed'}</strong>
              <span style={{ opacity: 0.55 }}> · {rel.kind}</span>
            </div>
            {rel.note && (
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.6)' }}>{rel.note}</div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-quiet" style={{ fontSize: 12, minHeight: 44 }} onClick={() => onSelectCharacter(from.id)}>
                Open
              </button>
              {!hasLink(character.relationships, from.id) && (
                <button className="btn-quiet" style={{ fontSize: 12, minHeight: 44 }} onClick={() => addReverseHere(from, rel)}>
                  Add reverse here
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
