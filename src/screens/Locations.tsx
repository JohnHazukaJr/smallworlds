import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { draftLocation, fleshOutLocation } from '../ai/engine';
import { db, recordTombstones, safeWrite } from '../db';
import { formatUserError } from '../errors';
import { useApp } from '../store/app';
import type { Location } from '../types';
import { ErrorNote, Field, Mono, Spinner, useVw } from '../ui/bits';
import { fileToPortraitImage } from '../ui/image';
import { avatarStyle, STRIPE } from '../ui/theme';
import { emptyLocation } from '../worldOps';

type Tab = 'overview' | 'atmosphere' | 'history' | 'rules' | 'ai';
const TABS: Array<[Tab, string]> = [
  ['overview', 'Overview'], ['atmosphere', 'Atmosphere'], ['history', 'History'],
  ['rules', 'Rules & secrets'], ['ai', 'AI notes']
];

/** Debounced autosave of a location draft back to the DB. */
function useAutosave(draft: Location | null, onError: (msg: string) => void) {
  const timer = useRef<number>(undefined);
  const first = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    if (!draft) return;
    if (first.current) { first.current = false; return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void safeWrite(
        () => db.locations.put({ ...draft, updatedAt: Date.now() }),
        (msg) => onErrorRef.current(msg)
      );
    }, 500);
    return () => window.clearTimeout(timer.current);
  }, [draft]);
  useEffect(() => { first.current = true; }, [draft?.id]);
}

export function Locations() {
  const vw = useVw();
  const narrow = vw < 1000;
  const { currentWorldId, go, pendingLocationId, clearPendingLocation } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [aiDesc, setAiDesc] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Location | null>(null);
  const [fleshBusy, setFleshBusy] = useState(false);
  const [fleshError, setFleshError] = useState('');
  const [undoSnapshot, setUndoSnapshot] = useState<Location | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [portraitBusy, setPortraitBusy] = useState(false);
  const [portraitError, setPortraitError] = useState('');

  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const places = useLiveQuery(
    async () => (world ? db.locations.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];

  const selected = places.find((l) => l.id === selectedId)
    ?? (pendingLocationId ? places.find((l) => l.id === pendingLocationId) : undefined)
    ?? places[0];

  // Honor one-shot focus from World editor / Director.
  useEffect(() => {
    if (!pendingLocationId || places.length === 0) return;
    if (places.some((l) => l.id === pendingLocationId)) {
      setSelectedId(pendingLocationId);
      clearPendingLocation();
    }
  }, [pendingLocationId, places, clearPendingLocation]);

  // Sync draft when the selected location changes.
  useEffect(() => {
    if (selected && selected.id !== draft?.id) setDraft(selected);
    if (!selected) setDraft(null);
    setFleshError('');
    setUndoSnapshot(null);
    setPortraitError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useAutosave(draft, setError);

  const patch = (p: Partial<Location>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const onPortraitFile = async (file: File) => {
    if (!draft) return;
    setPortraitBusy(true);
    setPortraitError('');
    try {
      const portrait = await fileToPortraitImage(file);
      await db.locations.update(draft.id, { portrait, updatedAt: Date.now() });
      patch({ portrait });
    } catch (e) {
      setPortraitError(formatUserError(e));
    } finally {
      setPortraitBusy(false);
    }
  };

  const removePortrait = async () => {
    if (!draft) return;
    await db.locations.update(draft.id, { portrait: null, updatedAt: Date.now() });
    patch({ portrait: null });
  };

  const fleshOut = async () => {
    if (!draft) return;
    setFleshBusy(true);
    setFleshError('');
    try {
      const result = await fleshOutLocation(world ?? null, draft);
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

  const addLocation = async (fromAI?: Partial<Location>) => {
    if (!world) return;
    const l = emptyLocation(world.id, { name: 'New location', ...fromAI });
    await db.locations.add(l);
    setSelectedId(l.id);
    setCreating(false);
    setAiDesc('');
  };

  const aiDraft = async () => {
    if (!world || !aiDesc.trim()) return;
    setAiBusy(true);
    setError('');
    try {
      const result = await draftLocation(world, aiDesc.trim());
      await addLocation(result);
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
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: '#f8f6f2' }}>Open a world to see its locations.</div>
        <div><button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button></div>
      </div>
    );
  }

  const d = draft;

  return (
    <div className="fade-in" style={{ display: 'grid', minHeight: '100vh', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '264px minmax(0, 1fr)' }}>
      {/* location list */}
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
            <Mono style={{ letterSpacing: '0.16em' }}>locations · {world.title.toLowerCase()}</Mono>
            <button className="btn-ghost" style={{ padding: '5px 11px', fontSize: 11 }} onClick={() => setCreating(true)}>+ new</button>
          </div>
        )}
        {narrow && (
          <button className="btn-ghost" style={{ padding: '5px 11px', fontSize: 11, flexShrink: 0 }} onClick={() => setCreating(true)}>+ new</button>
        )}
        {places.map((l) => {
          const active = selected?.id === l.id;
          return (
            <div key={l.id} onClick={() => { setSelectedId(l.id); setTab('overview'); }} style={{
              display: 'flex', gap: 10, alignItems: 'center', padding: 9, borderRadius: 13, cursor: 'pointer',
              flexShrink: 0,
              background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: `1px solid ${active ? 'rgba(255,255,255,0.14)' : 'transparent'}`,
              backdropFilter: active ? 'blur(18px)' : undefined
            }}>
              <div style={{ ...avatarStyle(l.hue, 34), ...(l.portrait ? { backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}) }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9', whiteSpace: 'nowrap' }}>{l.name || 'unnamed'}</div>
                {!narrow && (
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.42)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.tagline || 'no tagline yet'}
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
          <div className="glass-hot" style={{ padding: 20, marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f6f4f0' }}>New location</div>
              <button className="btn-quiet" onClick={() => setCreating(false)}>cancel</button>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.6)' }}>
              Describe it in a sentence and the utility model drafts a full sheet you can edit — or start blank.
            </div>
            <textarea
              rows={2} value={aiDesc} onChange={(e) => setAiDesc(e.target.value)}
              placeholder="e.g. A harbour registry where every debt in the city is written under a false name"
            />
            {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn-primary" disabled={aiBusy || !aiDesc.trim()} onClick={() => void aiDraft()}>
                {aiBusy ? 'Drafting…' : 'Draft with AI'}
              </button>
              <button className="btn-ghost" onClick={() => void addLocation()}>Start blank</button>
              {aiBusy && <Spinner label="the utility model is writing the sheet" />}
            </div>
          </div>
        )}

        {!d && !creating && (
          <div style={{ opacity: 0.6 }}>
            <div className="serif" style={{ fontSize: 24, fontWeight: 300 }}>No locations yet.</div>
            <button className="btn-primary" style={{ marginTop: 14 }} onClick={() => setCreating(true)}>Create the first location</button>
          </div>
        )}

        {d && (
          <>
            <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 32 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11, width: narrow ? '100%' : 258 }}>
                <div style={{
                  height: narrow ? 160 : 306, borderRadius: 16, border: '1px solid rgba(255,255,255,0.12)',
                  display: 'flex', alignItems: 'flex-end', padding: 12,
                  backgroundImage: d.portrait
                    ? `url(${d.portrait})`
                    : `linear-gradient(155deg, oklch(0.5 0.06 ${d.hue} / 0.7), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`,
                  backgroundSize: 'cover', backgroundPosition: 'center'
                }}>
                  {!d.portrait && (
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.62)', background: 'rgba(8,9,12,0.5)', backdropFilter: 'blur(6px)', padding: '5px 8px', borderRadius: 6 }}>
                      location plate · no photo yet
                    </span>
                  )}
                </div>
                <input
                  ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPortraitFile(f); e.target.value = ''; }}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }} disabled={portraitBusy} onClick={() => fileRef.current?.click()}>
                    {portraitBusy ? 'Uploading…' : d.portrait ? 'Change photo' : 'Upload photo'}
                  </button>
                  {d.portrait && <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => void removePortrait()}>remove photo</button>}
                </div>
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
                <button
                  className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                  onClick={async () => {
                    if (confirm(`Remove ${d.name || 'this location'} from the world?`)) {
                      await recordTombstones([{ table: 'locations', id: d.id, worldId: d.worldId, payload: d }]);
                      await db.locations.delete(d.id);
                      setSelectedId(null);
                    }
                  }}
                >remove from world</button>
              </div>

              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <Mono style={{ letterSpacing: '0.16em', marginBottom: 8 }}>location</Mono>
                  <input
                    value={d.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name"
                    className="serif"
                    style={{ fontFamily: 'Spectral, serif', fontWeight: 300, fontSize: narrow ? 28 : 38, color: '#f8f6f2', lineHeight: 1.08, background: 'transparent', border: 0, padding: 0, borderRadius: 0 }}
                  />
                  <input
                    value={d.tagline} onChange={(e) => patch({ tagline: e.target.value })}
                    placeholder="tagline · e.g. harbour district · public square"
                    style={{ fontSize: 13.5, color: 'rgba(236,234,230,0.7)', marginTop: 8, background: 'transparent', border: 0, padding: 0, borderRadius: 0 }}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 11 }}>
                  {([
                    ['current state', d.currentState, (v: string) => patch({ currentState: v })],
                    ['typically found here', d.inhabitants, (v: string) => patch({ inhabitants: v })]
                  ] as Array<[string, string, (v: string) => void]>).map(([k, v, set]) => (
                    <div key={k} className="glass" style={{ borderRadius: 13, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <Mono style={{ fontSize: 9, letterSpacing: '0.12em' }}>{k}</Mono>
                      <input
                        value={v} onChange={(e) => set(e.target.value)} placeholder="—"
                        style={{ fontSize: 13, background: 'transparent', border: 0, padding: 0, borderRadius: 0, color: 'rgba(236,234,230,0.92)' }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 24, flexWrap: 'wrap', overflowX: 'auto' }}>
              {TABS.map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{
                  border: 0, background: 'transparent',
                  color: tab === id ? '#f8f6f2' : 'rgba(236,234,230,0.45)',
                  borderBottom: `2px solid ${tab === id ? 'oklch(0.85 0.1 62)' : 'transparent'}`,
                  padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap'
                }}>{label}</button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {tab === 'overview' && (
                <>
                  <Field label="What it is" note="prose, not bullet points — this is the core of the sheet">
                    <textarea rows={4} value={d.summary} onChange={(e) => patch({ summary: e.target.value })}
                      className="serif" style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.7 }} />
                  </Field>
                  <Field label="Notable features" note="landmarks, rooms, or geography within it">
                    <textarea rows={3} value={d.features} onChange={(e) => patch({ features: e.target.value })} />
                  </Field>
                </>
              )}

              {tab === 'atmosphere' && (
                <Field label="Atmosphere" note="sensory detail the narrator leans on — sight, sound, smell, feel">
                  <textarea rows={4} value={d.atmosphere} onChange={(e) => patch({ atmosphere: e.target.value })}
                    placeholder="Salt and diesel. Gulls that never quite stop. The boards give underfoot near the tide line." />
                </Field>
              )}

              {tab === 'history' && (
                <Field label="History" note="informs behaviour; the narrator reveals it only in earned fragments">
                  <textarea rows={5} value={d.history} onChange={(e) => patch({ history: e.target.value })}
                    placeholder="How it came to be, what happened here, what it cost." />
                </Field>
              )}

              {tab === 'rules' && (
                <>
                  <div className="glass-hot" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'oklch(0.85 0.1 62)' }} />
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#f6f4f0' }}>Hard rules</div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)', marginLeft: 'auto' }}>
                        hazards & laws, never broken
                      </div>
                    </div>
                    <textarea
                      rows={4}
                      value={d.rules.join('\n')}
                      onChange={(e) => patch({ rules: e.target.value.split('\n') })}
                      onBlur={() => patch({
                        rules: d.rules.map((l) => l.trim()).filter(Boolean)
                      })}
                      placeholder={'The causeway floods at high tide — no crossing after the bell.\nNo weapons are drawn inside the registry, on pain of forfeiture.'}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {d.rules.filter((r) => r.trim()).map((r, i) => (
                        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5, color: 'rgba(236,234,230,0.9)' }}>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'oklch(0.85 0.1 62)', paddingTop: 3 }}>
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <span>{r}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Field label="Secrets hidden here" note="may surface in play; never announced outright">
                    <textarea rows={3} value={d.secrets} onChange={(e) => patch({ secrets: e.target.value })} />
                  </Field>
                </>
              )}

              {tab === 'ai' && (
                <Field label="Custom AI instructions" note="verbatim when this location is the current scene">
                  <textarea
                    rows={5} value={d.customInstructions}
                    onChange={(e) => patch({ customInstructions: e.target.value })}
                    placeholder="Anything the structured fields don't cover: how the light changes by hour, a sound that always precedes trouble, who really controls this place…"
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
