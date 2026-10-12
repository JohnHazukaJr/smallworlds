import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useApp, type Screen } from '../store/app';
import { resolveModel, useSettings } from '../store/settings';
import { useSyncMeta } from '../sync/engine';
import { TAB_LABEL_MIN, useViewport } from '../ui/bits';

const ITEMS: Array<[string, string, Screen]> = [
  ['01', 'Worlds', 'library'],
  ['02', 'Book', 'story'],
  ['03', 'People', 'cast'],
  ['04', 'Places', 'locations'],
  ['05', 'Settings', 'settings'],
  ['06', 'Profile', 'profile'],
  ['07', 'New world', 'onboard']
];

const TABS: Array<[string, Screen]> = [
  ['Worlds', 'library'],
  ['Book', 'story'],
  ['People', 'cast'],
  ['Places', 'locations'],
  ['Settings', 'settings'],
  ['Profile', 'profile']
];

const TAB_GLYPHS: Partial<Record<Screen, string>> = {
  library: '◈',
  story: '¶',
  cast: '◇',
  locations: '⌂',
  settings: '⚙',
  profile: '◎'
};

export function Rail() {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  const currentWorldId = useApp((s) => s.currentWorldId);
  const proseModel = useSettings((s) => s.proseModel);
  const world = useLiveQuery(
    async () => {
      if (!currentWorldId) return null;
      return (await db.worlds.get(currentWorldId)) ?? null;
    },
    [currentWorldId]
  );
  const resolved = resolveModel(world?.proseModel ?? proseModel);
  const syncError = useSyncMeta((s) => s.error);

  return (
    <nav style={{
      borderRight: '1px solid var(--rule)', padding: '28px 16px',
      display: 'flex', flexDirection: 'column', gap: 28, position: 'sticky', top: 0, height: '100%',
      minHeight: 0, overflow: 'auto',
      background: 'var(--ink)'
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 6, paddingRight: 4 }}>
        <div className="serif" style={{ fontSize: 28, fontWeight: 500, letterSpacing: '0.01em', color: 'var(--ink-heading)', lineHeight: 1.05 }}>
          Small Worlds
        </div>
        <div className="label" style={{ fontSize: 12, lineHeight: 1.45, maxWidth: '18ch' }}>
          Make a world. Live in it.
        </div>
        {syncError && (
          <button
            className="btn-quiet"
            style={{
              alignSelf: 'flex-start', marginTop: 6, fontSize: 10, padding: '4px 8px',
              color: 'oklch(0.4 0.12 25)', border: '1px solid oklch(0.4 0.1 25)'
            }}
            onClick={() => go('profile')}
            title={syncError}
          >
            Sync failed · open Profile
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {ITEMS.map(([num, label, key]) => {
          const needsWorld = key === 'story' || key === 'cast' || key === 'locations';
          const blocked = needsWorld && !currentWorldId;
          return (
            <button
              key={key}
              className={`nav-btn${screen === key ? ' active' : ''}`}
              disabled={blocked}
              onClick={() => {
                if (blocked) return;
                go(key);
              }}
            >
              <span className="mono meta" style={{ width: 18, opacity: 0.4 }}>{num}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="craft-row" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="label">Instrument</div>
          <div style={{ fontSize: 13, color: 'var(--paper)', wordBreak: 'break-all' }}>
            {resolved ? resolved.model : 'no model configured'}
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            {resolved ? resolved.provider.label + ' · your key' : 'set one in Settings'}
          </div>
        </div>
        {world && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 4 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 4, flexShrink: 0,
              background: `linear-gradient(140deg, oklch(0.72 0.06 ${world.hue}), oklch(0.9 0.03 ${world.hue}))`,
              border: '1px solid var(--rule)'
            }} />
            <div className="serif" style={{ fontSize: 14, color: 'var(--ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
  const { width } = useViewport();
  const showLabels = width >= TAB_LABEL_MIN;
  return (
    <div className={`tabbar${showLabels ? '' : ' glyphs-only'}`}>
      {TABS.map(([label, key]) => {
        const needsWorld = key === 'story' || key === 'cast' || key === 'locations';
        const blocked = needsWorld && !currentWorldId;
        return (
          <button
            key={key}
            className={screen === key ? 'active' : ''}
            disabled={blocked}
            aria-label={label}
            onClick={() => {
              if (blocked) return;
              go(key);
            }}
          >
            <span style={{ fontSize: showLabels ? 14 : 16, fontFamily: 'Spectral, serif', textTransform: 'none', letterSpacing: 0 }}>
              {TAB_GLYPHS[key] ?? '⚙'}
            </span>
            {showLabels ? label : null}
          </button>
        );
      })}
    </div>
  );
}
