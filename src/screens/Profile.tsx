import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, exportWorld } from '../db';
import { useSettings } from '../store/settings';
import { Mono, useVw } from '../ui/bits';
import { avatarStyle, plateStyle, VIS } from '../ui/theme';
import type { Visibility } from '../types';

export function Profile() {
  const vw = useVw();
  const narrow = vw < 780;
  const s = useSettings();
  const [exporting, setExporting] = useState(false);

  const worlds = useLiveQuery(() => db.worlds.toArray(), []) ?? [];
  const stats = useLiveQuery(async () => {
    const [seasons, cast, turns] = await Promise.all([
      db.seasons.count(),
      db.characters.count(),
      db.turns.toArray()
    ]);
    const words = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
    return { seasons, cast, words };
  }, []);

  const exportAll = async () => {
    setExporting(true);
    try {
      const all = await Promise.all(worlds.map((w) => exportWorld(w.id)));
      const blob = new Blob([JSON.stringify({ format: 'small-worlds-backup', version: 1, worlds: all }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `small-worlds-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fade-in" style={{ padding: narrow ? '26px 18px 70px' : '42px 46px 70px', maxWidth: 1020 }}>
      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 34 }}>
        <div style={avatarStyle(60, 84, 'rgba(255,255,255,0.2)')} />
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: narrow ? 28 : 36, lineHeight: 1.1, color: '#f8f6f2' }}>Your shelf</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'rgba(236,234,230,0.58)', maxWidth: '58ch' }}>
            Everything here lives in this browser's storage on this device. Your keys, your worlds, your words —
            nothing is uploaded anywhere except the AI endpoint you configured. Move worlds between devices with
            export and import.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', borderTop: '1px solid rgba(255,255,255,0.08)', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '16px 0', marginBottom: 34 }}>
        {[
          ['worlds', String(worlds.length)],
          ['seasons', String(stats?.seasons ?? '—')],
          ['words written', stats ? `${Math.round(stats.words / 100) / 10}k` : '—'],
          ['cast created', String(stats?.cast ?? '—')]
        ].map(([k, v]) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="serif" style={{ fontSize: 24, color: '#f4f2ee' }}>{v}</div>
            <Mono style={{ fontSize: 9 }}>{k}</Mono>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 34 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#f6f4f0' }}>Your worlds</div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)' }}>
            sharing is a future feature — every world is private today
          </div>
        </div>
        {worlds.map((w) => (
          <div key={w.id} className="glass" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ ...plateStyle(w.hue, 46), width: 46, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', padding: 0 }} />
            <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div className="serif" style={{ fontSize: 17, color: '#f0eee9' }}>{w.title}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)' }}>{w.line.slice(0, 60)}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}
                onClick={async () => {
                  const data = await exportWorld(w.id);
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${w.title.toLowerCase().replace(/\s+/g, '-')}.smallworlds.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >Export</button>
            </div>
          </div>
        ))}
        {worlds.length === 0 && <div style={{ fontSize: 13, opacity: 0.5 }}>No worlds yet.</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 15 }}>
        <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <Mono style={{ fontSize: 9 }}>default for new worlds</Mono>
          {(Object.entries(VIS) as Array<[Visibility, typeof VIS[Visibility]]>).map(([id, v]) => {
            const active = s.defaultVisibility === id;
            return (
              <button key={id} onClick={() => s.setDefaultVisibility(id)} style={{
                textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 5,
                border: `1px solid rgba(255,255,255,${active ? '0.2' : '0.09'})`,
                background: active ? 'linear-gradient(150deg, rgba(224,165,95,0.13), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)',
                color: active ? '#f6f4f0' : 'rgba(236,234,230,0.62)',
                borderRadius: 13, padding: '13px 15px', cursor: 'pointer', backdropFilter: 'blur(14px)'
              }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{v.label}</div>
                <div style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.68 }}>{v.line}</div>
              </button>
            );
          })}
        </div>

        <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Mono style={{ fontSize: 9 }}>your data</Mono>
          {[
            ['All stories & cast', 'IndexedDB, this device'],
            ['API keys & preferences', 'localStorage, this device'],
            ['Used for model training', 'never — requests go straight to your provider'],
            ['Cloud sync', 'not yet — use export / import between devices']
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
              <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.6)' }}>{label}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'rgba(236,234,230,0.9)', textAlign: 'right' }}>{value}</div>
            </div>
          ))}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-ghost" disabled={exporting || worlds.length === 0} onClick={() => void exportAll()}>
              {exporting ? 'Exporting…' : 'Back up everything'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
