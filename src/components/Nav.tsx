import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useApp, type Screen } from '../store/app';
import { resolveModel, useSettings } from '../store/settings';
import { useSyncMeta } from '../sync/engine';
import { useVw } from '../ui/bits';

const ITEMS: Array<[string, string, Screen]> = [
  ['01', 'Worlds', 'library'],
  ['02', 'Story', 'story'],
  ['03', 'Cast', 'cast'],
  ['04', 'Settings', 'settings'],
  ['05', 'New world', 'onboard']
];

const TABS: Array<[string, Screen]> = [
  ['Worlds', 'library'],
  ['Story', 'story'],
  ['Cast', 'cast'],
  ['Settings', 'settings']
];

export function Rail() {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  const currentWorldId = useApp((s) => s.currentWorldId);
  const proseModel = useSettings((s) => s.proseModel);
  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const resolved = resolveModel(world?.proseModel ?? proseModel);
  const syncError = useSyncMeta((s) => s.error);

  return (
    <nav style={{
      borderRight: '1px solid rgba(255,255,255,0.08)', padding: '22px 15px',
      display: 'flex', flexDirection: 'column', gap: 26, position: 'sticky', top: 0, height: '100vh',
      background: 'rgba(12,14,16,0.55)', backdropFilter: 'blur(14px) saturate(110%)'
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4 }}>
        <div className="serif" style={{ fontSize: 24, fontWeight: 300, letterSpacing: '0.01em', color: '#f2f4f5', lineHeight: 1.1 }}>
          Small Worlds
        </div>
        <div className="label" style={{ fontSize: 12, lineHeight: 1.4 }}>
          nothing here you didn’t make
        </div>
        {syncError && (
          <button
            className="btn-quiet"
            style={{
              alignSelf: 'flex-start', marginTop: 6, fontSize: 10, padding: '4px 8px',
              color: 'rgba(240,180,160,0.95)', border: '1px solid rgba(220,110,90,0.35)'
            }}
            onClick={() => go('profile')}
            title={syncError}
          >
            Sync failed · open Profile
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {ITEMS.map(([num, label, key]) => (
          <button key={key} className={`nav-btn${screen === key ? ' active' : ''}`} onClick={() => go(key)}>
            <span className="mono meta" style={{ width: 18, opacity: 0.45 }}>{num}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="glass" style={{ borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="label">Engine</div>
          <div style={{ fontSize: 13, color: 'rgba(230,233,235,0.9)', wordBreak: 'break-all' }}>
            {resolved ? resolved.model : 'no model configured'}
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'rgba(230,233,235,0.4)' }}>
            {resolved ? resolved.provider.label + ' · your key' : 'set one in Settings'}
          </div>
        </div>
        {world && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 4 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8, flexShrink: 0,
              background: `linear-gradient(140deg, oklch(0.55 0.05 ${world.hue} / 0.7), rgba(255,255,255,0.06))`,
              border: '1px solid rgba(255,255,255,0.12)'
            }} />
            <div style={{ fontSize: 12, color: 'rgba(230,233,235,0.55)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {world.title}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}

export function TabBar() {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  const currentWorldId = useApp((s) => s.currentWorldId);
  return (
    <div className="tabbar">
      {TABS.map(([label, key]) => (
        <button
          key={key}
          className={screen === key ? 'active' : ''}
          disabled={key === 'cast' && !currentWorldId}
          onClick={() => {
            if (key === 'cast' && !currentWorldId) return;
            go(key);
          }}
        >
          <span style={{ fontSize: 14, fontFamily: 'Spectral, serif', textTransform: 'none', letterSpacing: 0 }}>
            {label === 'Worlds' ? '◈' : label === 'Story' ? '¶' : label === 'Cast' ? '◇' : '⚙'}
          </span>
          {label}
        </button>
      ))}
    </div>
  );
}
