import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { db, deleteWorld, exportWorld, importWorld, type WorldExport } from '../db';
import { seedStarterWorld } from '../data/seed';
import { useApp } from '../store/app';
import { Mono, useVw, ErrorNote } from '../ui/bits';
import { plateStyle, VIS } from '../ui/theme';

export function Library() {
  const vw = useVw();
  const narrow = vw < 780;
  const openWorld = useApp((s) => s.openWorld);
  const go = useApp((s) => s.go);
  const [error, setError] = useState('');
  const [seeding, setSeeding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const worlds = useLiveQuery(() => db.worlds.orderBy('updatedAt').reverse().toArray(), []);
  const stats = useLiveQuery(async () => {
    const out: Record<string, { seasons: number; episodes: number; cast: number; words: number }> = {};
    for (const w of await db.worlds.toArray()) {
      const [seasons, episodes, cast, turns] = await Promise.all([
        db.seasons.where('worldId').equals(w.id).count(),
        db.episodes.where('worldId').equals(w.id).count(),
        db.characters.where('worldId').equals(w.id).count(),
        db.turns.where('worldId').equals(w.id).toArray()
      ]);
      const words = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
      out[w.id] = { seasons, episodes, cast, words };
    }
    return out;
  }, []);

  const onSeed = async () => {
    setSeeding(true);
    try {
      const id = await seedStarterWorld();
      openWorld(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeeding(false);
    }
  };

  const onImportFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as WorldExport;
      const id = await importWorld(data);
      openWorld(id);
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onExport = async (worldId: string, title: string) => {
    const data = await exportWorld(worldId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'world'}.smallworlds.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fade-in" style={{ padding: narrow ? '26px 18px 60px' : '42px 46px 70px', maxWidth: 1260 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', marginBottom: 30 }}>
        <div>
          <Mono style={{ letterSpacing: '0.16em', marginBottom: 10 }}>nothing here you didn't make</Mono>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 34 : 44, lineHeight: 1.08, margin: 0, color: '#f8f6f2' }}>Worlds</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Import world</button>
          <input
            ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }}
          />
          <button className="btn-primary" onClick={() => go('onboard')}>New world</button>
        </div>
      </div>

      {error && <div style={{ marginBottom: 18 }}><ErrorNote error={error} onDismiss={() => setError('')} /></div>}

      {worlds && worlds.length === 0 && (
        <div className="glass" style={{ padding: narrow ? 22 : 34, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 26, color: '#f6f4f0' }}>Start from nothing — or almost nothing.</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'rgba(236,234,230,0.6)' }}>
            Create a world of your own, or open the starter world — a harbour city, a false name, a debt in the public
            record — to see how cast, continuity and seasons work. Everything in it is editable.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={() => go('onboard')}>Create my world</button>
            <button className="btn-ghost" disabled={seeding} onClick={() => void onSeed()}>
              {seeding ? 'Setting up…' : 'Open the starter world'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(272px, 1fr))', gap: 18 }}>
        {(worlds ?? []).map((w) => {
          const st = stats?.[w.id];
          return (
            <div
              key={w.id}
              className="hover-bright"
              onClick={() => openWorld(w.id)}
              style={{
                border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18, overflow: 'hidden',
                background: 'rgba(255,255,255,0.045)', backdropFilter: 'blur(20px) saturate(140%)',
                cursor: 'pointer', display: 'flex', flexDirection: 'column', boxShadow: '0 18px 40px rgba(0,0,0,0.35)'
              }}
            >
              <div style={plateStyle(w.hue, 138)}>
                <span style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em',
                  color: 'rgba(236,234,230,0.62)', background: 'rgba(8,9,12,0.5)', backdropFilter: 'blur(6px)',
                  padding: '5px 8px', borderRadius: 6
                }}>
                  {st ? `S${st.seasons} · E${st.episodes}` : '—'}
                </span>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 5, fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(236,234,230,0.5)',
                  background: 'rgba(8,9,12,0.5)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,255,255,0.1)',
                  padding: '4px 8px', borderRadius: 6
                }}>
                  {VIS[w.visibility].label}
                </span>
              </div>
              <div style={{ padding: '16px 17px 18px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                  <div className="serif" style={{ fontSize: 19, color: '#f4f2ee' }}>{w.title}</div>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'rgba(236,234,230,0.58)', flex: 1 }}>{w.line}</div>
                <div style={{
                  display: 'flex', gap: 14, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10,
                  color: 'rgba(236,234,230,0.38)', paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.07)',
                  alignItems: 'center'
                }}>
                  <span>{st ? `${st.cast} cast` : '…'}</span>
                  <span>{st ? `${Math.round(st.words / 100) / 10}k words` : ''}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button
                      className="btn-quiet" style={{ padding: '2px 4px', fontSize: 10 }}
                      onClick={(e) => { e.stopPropagation(); void onExport(w.id, w.title); }}
                    >export</button>
                    <button
                      className="btn-quiet" style={{ padding: '2px 4px', fontSize: 10 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${w.title}" and everything in it? This cannot be undone.`)) void deleteWorld(w.id);
                      }}
                    >delete</button>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
