import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { draftLocation, fleshOutLocation, seedBlankResidentLocations } from '../ai/engine';
import { PlacePhotoTools } from '../components/PlacePhotoTools';
import { PlaceRulesEditor, PlaceSettingFields } from '../components/PlaceSettingFields';
import { db, safeWrite } from '../db';
import { formatUserError } from '../errors';
import { placeTree, placeWhereLine, removePlace, renamePlace, setScenePlace } from '../places';
import { useApp } from '../store/app';
import type { Location } from '../types';
import { ConfirmBar, ErrorNote, Field, Mono, Spinner, editorsStacked, phoneChrome, useViewport } from '../ui/bits';
import { avatarStyle } from '../ui/theme';
import { emptyLocation } from '../worldOps';
import { shouldFlushAutosave } from '../ui/autosave';

/** Debounced autosave of a place draft back to the DB. A rename follows to chapters and residents. */
function useAutosave(draft: Location | null, onError: (msg: string) => void) {
  const timer = useRef<number>(undefined);
  const pending = useRef<Location | null>(null);
  const removed = useRef(new Set<string>());
  const first = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const flush = (d: Location) => {
    if (!shouldFlushAutosave(d.id, removed.current, true)) return;
    void safeWrite(async () => {
      if (!shouldFlushAutosave(d.id, removed.current, true)) return;
      const row = await db.locations.get(d.id);
      if (!shouldFlushAutosave(d.id, removed.current, !!row)) return;
      if (row && row.name !== d.name) await renamePlace(row, d.name);
      await db.locations.put({ ...d, updatedAt: Date.now() });
    }, (msg) => onErrorRef.current(msg));
  };
  useEffect(() => {
    if (!draft || removed.current.has(draft.id)) return;
    if (first.current) { first.current = false; return; }
    pending.current = draft;
    window.clearTimeout(timer.current);
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
  return {
    discard(id: string) {
      removed.current.add(id);
      if (pending.current?.id === id) {
        pending.current = null;
        window.clearTimeout(timer.current);
      }
    },
    release(id: string) {
      removed.current.delete(id);
    }
  };
}

const monoSmall = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)' } as const;

export function Locations() {
  const { band } = useViewport();
  const stacked = editorsStacked(band);
  const phone = phoneChrome(band);
  const narrow = stacked;
  const { currentWorldId, go, pendingLocationId, clearPendingLocation } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aiDesc, setAiDesc] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Location | null>(null);
  const [fleshBusy, setFleshBusy] = useState(false);
  const [fleshError, setFleshError] = useState('');
  const [undoSnapshot, setUndoSnapshot] = useState<Location | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [newResidentIds, setNewResidentIds] = useState<string[]>([]);
  const [newDismissed, setNewDismissed] = useState<string[]>([]);
  const dismissedByPlace = useRef(new Map<string, string[]>());

  const world = useLiveQuery(
    async () => {
      if (!currentWorldId) return null;
      return (await db.worlds.get(currentWorldId)) ?? null;
    },
    [currentWorldId]
  );
  const episode = useLiveQuery(
    async () => {
      if (!world?.activeSeasonId) return null;
      return (
        (await db.episodes.where('seasonId').equals(world.activeSeasonId).filter((e) => e.status === 'active').first())
        ?? (await db.episodes.where('seasonId').equals(world.activeSeasonId).first())
        ?? null
      );
    },
    [world?.id, world?.activeSeasonId]
  );
  const placeRows = useLiveQuery(
    async () => (world ? db.locations.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  );
  const places = placeRows ?? [];
  const castRows = useLiveQuery(
    async () => (world ? db.characters.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];
  const placeRefs = places.map((place) => ({ id: place.id, name: place.name }));
  const castChips = castRows.map((person) => ({
    id: person.id, name: person.name, aliases: person.aliases, hue: person.hue
  }));

  const selected = places.find((l) => l.id === selectedId)
    ?? (pendingLocationId ? places.find((l) => l.id === pendingLocationId) : undefined)
    ?? places.find((l) => l.id === episode?.locationId)
    ?? places[0];

  // Honor one-shot focus from the World editor or Story.
  useEffect(() => {
    if (!pendingLocationId) return;
    if (currentWorldId && world === undefined) return;
    if (!world) {
      clearPendingLocation();
      return;
    }
    if (placeRows === undefined) return;
    if (places.some((l) => l.id === pendingLocationId)) {
      setSelectedId(pendingLocationId);
    }
    clearPendingLocation();
  }, [pendingLocationId, currentWorldId, world, places, placeRows, clearPendingLocation]);

  // Sync draft when the selected place changes.
  useEffect(() => {
    if (selected && selected.id !== draft?.id) setDraft(selected);
    if (!selected) setDraft(null);
    setFleshError('');
    setUndoSnapshot(null);
    setConfirmRemove(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const { discard: discardAutosave, release: releaseAutosave } = useAutosave(draft, setError);

  const patch = (p: Partial<Location>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const goHere = (placeId: string | null) => {
    if (!episode) return;
    void safeWrite(() => setScenePlace(episode.id, placeId), setError);
  };

  const fleshOut = async () => {
    if (!draft) return;
    setFleshBusy(true);
    setFleshError('');
    try {
      const result = await fleshOutLocation(world ?? null, draft, {
        cast: castRows,
        places: placeRefs,
        selectedIds: draft.residentIds,
        dismissedIds: dismissedByPlace.current.get(draft.id) ?? []
      });
      setUndoSnapshot(draft);
      patch(result);
      await seedBlankResidentLocations(result.residentIds, (result.name || draft.name).trim());
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
    const l = emptyLocation(world.id, {
      name: 'New place',
      parentId: newParentId,
      residentIds: newResidentIds,
      ...fromAI,
      ...(newParentId ? { parentId: newParentId } : {})
    });
    await db.locations.add(l);
    // The first place of a chapter becomes where it happens. A chosen place is never replaced.
    if (episode && !episode.locationId) await setScenePlace(episode.id, l.id);
    setSelectedId(l.id);
    setCreating(false);
    setAiDesc('');
    setNewParentId(null);
    setNewResidentIds([]);
    setNewDismissed([]);
  };

  const aiDraft = async () => {
    if (!world || !aiDesc.trim()) return;
    setAiBusy(true);
    setError('');
    try {
      const parent = places.find((p) => p.id === newParentId);
      const brief = [aiDesc.trim(), parent && `It is inside ${parent.name.trim()}.`].filter(Boolean).join(' ');
      const result = await draftLocation(world, brief, {
        cast: castRows,
        places: placeRefs,
        selectedIds: newResidentIds,
        dismissedIds: newDismissed
      });
      await addLocation(result);
      await seedBlankResidentLocations(result.residentIds, (result.name || '').trim());
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setAiBusy(false);
    }
  };

  if (currentWorldId && world === undefined) {
    return <div style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }
  if (!world) {
    return (
      <div className="fade-in" style={{ padding: phone ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>Open a world to walk its places.</div>
        <div><button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button></div>
      </div>
    );
  }

  const d = draft;
  const rows = placeTree(places);
  const hiddenBy = (row: { place: Location }) => {
    let parentId = row.place.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      if (collapsed.has(parentId)) return true;
      seen.add(parentId);
      parentId = places.find((p) => p.id === parentId)?.parentId;
    }
    return false;
  };
  const visibleRows = stacked ? rows : rows.filter((row) => !hiddenBy(row));
  const toggleCollapsed = (id: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const isHere = (id: string) => episode?.locationId === id;
  const where = d ? placeWhereLine(d, places) : '';

  return (
    <div className="fade-in" style={{
      display: 'grid', flex: 1, height: '100%', minHeight: 0, overflow: 'hidden',
      gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : '280px minmax(0, 1fr)',
      gridTemplateRows: stacked ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)'
    }}>
      {/* place tree */}
      <div className="glass-clear" style={{
        borderRadius: 0,
        borderTop: 0, borderLeft: 0,
        borderRight: stacked ? 'none' : '1px solid var(--glass-rim)',
        borderBottom: stacked ? '1px solid var(--glass-rim)' : 'none',
        paddingTop: stacked ? 'calc(18px + env(safe-area-inset-top))' : 26,
        paddingRight: 16,
        paddingBottom: stacked ? 12 : 26,
        paddingLeft: 16,
        display: 'flex', flexDirection: stacked ? 'row' : 'column', gap: stacked ? 8 : 4,
        overflowX: stacked ? 'auto' : 'hidden',
        overflowY: stacked ? 'hidden' : 'auto',
        minWidth: 0,
        minHeight: 0,
        alignItems: stacked ? 'center' : undefined
      }}>
        {!narrow && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="seed-mark" />
              Places · {world.title}
            </div>
            <button className="btn-ghost" style={{ padding: '5px 11px', fontSize: 11 }} onClick={() => setCreating(true)}>+ new</button>
          </div>
        )}
        {narrow && (
          <button className="btn-ghost" style={{ padding: '5px 11px', fontSize: 11, flexShrink: 0 }} onClick={() => setCreating(true)}>+ new</button>
        )}
        {visibleRows.map(({ place: l, depth, hasChildren }) => {
          const active = selected?.id === l.id;
          const here = isHere(l.id);
          return (
            <div
              key={l.id}
              onClick={() => setSelectedId(l.id)}
              style={{
                display: 'flex', gap: stacked ? 7 : 8, alignItems: 'center',
                padding: stacked ? '6px 7px' : '7px 8px',
                paddingLeft: stacked ? 7 : 8 + depth * 16,
                borderRadius: 12, cursor: 'pointer',
                flexShrink: stacked ? 0 : 1,
                minWidth: 0,
                maxWidth: stacked ? 220 : undefined,
                background: active ? 'var(--rule)' : 'transparent',
                border: `1px solid ${active ? 'var(--glass-rim)' : 'transparent'}`
              }}
            >
              {!stacked && (
                <button
                  type="button"
                  aria-label={collapsed.has(l.id) ? `Show places inside ${l.name}` : `Hide places inside ${l.name}`}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) toggleCollapsed(l.id); }}
                  style={{
                    width: 14, border: 0, background: 'transparent', padding: 0, cursor: hasChildren ? 'pointer' : 'default',
                    color: 'var(--ink-muted)', fontSize: 10, visibility: hasChildren ? 'visible' : 'hidden'
                  }}
                >{collapsed.has(l.id) ? '▸' : '▾'}</button>
              )}
              <div style={{ ...avatarStyle(l.hue, stacked ? 28 : 30), flexShrink: 0, ...(l.portrait ? { backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}) }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: stacked ? 12.5 : 13.5, fontWeight: 600, color: 'var(--ink-heading)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {l.name || 'Unnamed place'}
                </div>
                {!narrow && here && <div style={{ ...monoSmall, color: 'var(--accent-strong)' }}>● the story is here</div>}
              </div>
              {episode && !here && (
                <button
                  type="button"
                  className="btn-quiet"
                  style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0, whiteSpace: 'nowrap' }}
                  title="Move this chapter's scene here"
                  onClick={(e) => { e.stopPropagation(); goHere(l.id); }}
                >Go here</button>
              )}
            </div>
          );
        })}
      </div>

      {/* editor */}
      <div style={{ padding: stacked ? '22px 18px 24px' : '34px 40px 40px', maxWidth: 1000, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {creating && (
          <div className="craft-row" style={{ padding: 20, marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-heading)' }}>New place</div>
              <button className="btn-quiet" onClick={() => setCreating(false)}>cancel</button>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-muted)' }}>
              Describe it in a sentence and the AI drafts the sheet for you to edit — or start blank.
            </div>
            <textarea
              rows={2} value={aiDesc} onChange={(e) => setAiDesc(e.target.value)}
              placeholder="e.g. The James house, a tall cold mansion where Ada James lives"
            />
            <PlaceSettingFields
              placeKey="new"
              cast={castChips}
              places={places}
              parentId={newParentId}
              residentIds={newResidentIds}
              dismissedIds={newDismissed}
              authorText={aiDesc}
              onParentId={setNewParentId}
              onResidentIds={setNewResidentIds}
              onDismissedIds={setNewDismissed}
            />
            {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn-primary" disabled={aiBusy || !aiDesc.trim()} onClick={() => void aiDraft()}>
                {aiBusy ? 'Drafting…' : 'Draft with AI'}
              </button>
              <button className="btn-ghost" onClick={() => void addLocation(aiDesc.trim() ? { summary: aiDesc.trim() } : undefined)}>Start blank</button>
              {aiBusy && <Spinner label="drafting the place" />}
            </div>
          </div>
        )}

        {!d && !creating && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
            <div className="serif" style={{ fontSize: 24, fontWeight: 300, color: 'var(--ink-heading)' }}>No places yet.</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-muted)' }}>
              Places can sit inside each other — a town, a street in it, a room in a house. The story follows you between them.
            </div>
            <div><button className="btn-primary" onClick={() => setCreating(true)}>Add the first place</button></div>
          </div>
        )}

        {d && (
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, width: narrow ? '100%' : 248 }}>
              <div style={{
                height: narrow ? 160 : 260, borderRadius: 16, border: '1px solid var(--rule)',
                display: 'flex', alignItems: 'flex-end', padding: 12,
                backgroundImage: d.portrait
                  ? `url(${d.portrait})`
                  : `linear-gradient(155deg, oklch(0.9 0.04 ${d.hue}), #f7f3ea)`,
                backgroundSize: 'cover', backgroundPosition: 'center'
              }}>
                {!d.portrait && <span style={{ ...monoSmall, padding: '5px 8px' }}>no photo yet</span>}
              </div>
              <PlacePhotoTools
                location={d}
                world={world ?? null}
                showPreview={false}
                onChange={async ({ portrait }) => {
                  await db.locations.update(d.id, { portrait, updatedAt: Date.now() });
                  patch({ portrait });
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Mono style={{ fontSize: 9 }}>story tint</Mono>
                  <input
                    type="range" min={0} max={359} value={d.hue}
                    aria-label="Story tint"
                    onChange={(e) => patch({ hue: Number(e.target.value) })}
                    style={{ padding: 0, height: 4 }}
                  />
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', lineHeight: 1.4 }}>The Story screen takes this colour while the scene is here.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}
                  disabled={fleshBusy} onClick={() => void fleshOut()}
                >{fleshBusy ? 'Working…' : 'Fill in with AI'}</button>
                {undoSnapshot && (
                  <button className="btn-quiet" style={{ fontSize: 11 }} onClick={undoFleshOut}>undo</button>
                )}
              </div>
              {fleshBusy && <Spinner label="filling in the sheet" />}
              {fleshError && <ErrorNote error={fleshError} onDismiss={() => setFleshError('')} />}
              {episode && (
                isHere(d.id) ? (
                  <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }} onClick={() => goHere(null)}>
                    ✓ The story is here — unset
                  </button>
                ) : (
                  <button className="btn-primary" style={{ alignSelf: 'flex-start', fontSize: 12, padding: '7px 14px' }} onClick={() => goHere(d.id)}>
                    Go here
                  </button>
                )
              )}
              <button
                className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                onClick={() => setConfirmRemove(true)}
              >remove from world</button>
              {confirmRemove && (
                <ConfirmBar
                  title={`Remove ${d.name || 'this place'} from the world?`}
                  body={places.some((p) => p.parentId === d.id)
                    ? 'Places inside it move up a level. This cannot be undone.'
                    : 'This cannot be undone.'}
                  confirmLabel="Remove"
                  onCancel={() => setConfirmRemove(false)}
                  onConfirm={() => {
                    setConfirmRemove(false);
                    const removed = d;
                    discardAutosave(removed.id);
                    void (async () => {
                      const saved = await safeWrite(async () => {
                        await removePlace(removed);
                        return true;
                      }, setError);
                      if (!saved) {
                        releaseAutosave(removed.id);
                        setDraft((cur) => (cur && cur.id === removed.id ? { ...cur } : cur));
                        return;
                      }
                      setSelectedId(null);
                    })();
                  }}
                />
              )}
              {error && !creating && <ErrorNote error={error} onDismiss={() => setError('')} />}
            </div>

            <div style={{ flex: 1, minWidth: narrow ? 0 : 320, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <input
                  value={d.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  onBlur={() => { void seedBlankResidentLocations(d.residentIds, d.name); }}
                  placeholder="Name"
                  aria-label="Place name"
                  className="serif"
                  style={{ fontWeight: 300, fontSize: narrow ? 28 : 38, color: 'var(--ink-heading)', lineHeight: 1.08, background: 'transparent', border: 0, padding: 0, borderRadius: 0, width: '100%' }}
                />
                <div style={{ ...monoSmall, fontSize: 11, marginTop: 6 }}>
                  {where ? `in ${where}` : 'top-level place'}
                </div>
              </div>

              <Field label="What it is" note="first impression and what is here">
                <textarea rows={4} value={d.summary} onChange={(e) => patch({ summary: e.target.value })}
                  className="serif" style={{ fontSize: 15.5, lineHeight: 1.7 }} />
              </Field>
              <Field label="Feel" note="sight, sound, smell, texture — what the writer leans on">
                <textarea rows={3} value={d.atmosphere} onChange={(e) => patch({ atmosphere: e.target.value })}
                  placeholder="Salt and diesel. Gulls that never quite stop. The boards give underfoot near the tide line." />
              </Field>
              <Field label="Right now" note="its condition at the moment — play keeps this up to date">
                <input value={d.currentState} onChange={(e) => patch({ currentState: e.target.value })}
                  placeholder="Shuttered for the storm; one lamp still lit." />
              </Field>
              <Field label="Who's usually here" note="regulars, staff, or a kind of crowd">
                <input value={d.inhabitants} onChange={(e) => patch({ inhabitants: e.target.value })}
                  placeholder="Dock clerks, a night watchman, gulls." />
              </Field>

              <PlaceSettingFields
                placeKey={d.id}
                placeId={d.id}
                cast={castChips}
                places={places}
                parentId={d.parentId}
                nearIds={d.nearIds ?? []}
                residentIds={d.residentIds ?? []}
                dismissedIds={dismissedByPlace.current.get(d.id) ?? []}
                authorText={[d.name, d.summary, d.inhabitants].join('\n')}
                onParentId={(parentId) => patch({ parentId })}
                onNearIds={(nearIds) => patch({ nearIds })}
                onResidentIds={(residentIds) => {
                  patch({ residentIds });
                  void seedBlankResidentLocations(residentIds, d.name);
                }}
                onDismissedIds={(ids) => { dismissedByPlace.current.set(d.id, ids); }}
              />

              <Field label="Rules" note="optional — laws or hazards that always hold here">
                <PlaceRulesEditor rules={d.rules} onRules={(rules) => patch({ rules })} />
              </Field>
              <Field label="Hidden" note="history and secrets — the writer knows them and reveals them only when the story earns it">
                <textarea rows={3} value={d.hidden ?? ''} onChange={(e) => patch({ hidden: e.target.value })}
                  placeholder="The cellar floods because someone bricked up the old drain on purpose." />
              </Field>
              <Field label="Notes for the AI" note="anything else to keep in mind while the scene is here">
                <textarea rows={3} value={d.customInstructions} onChange={(e) => patch({ customInstructions: e.target.value })}
                  placeholder="How the light changes by hour, a sound that always comes before trouble…" />
              </Field>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
