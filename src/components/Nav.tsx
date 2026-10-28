import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useApp, type Screen } from '../store/app';
import { resolveModel, useSettings } from '../store/settings';
import { useSyncMeta } from '../sync/engine';
import { TAB_LABEL_MIN, useViewport } from '../ui/bits';

const ITEMS: Array<[string, Screen]> = [
  ['Worlds', 'library'],
  ['Write', 'story'],
  ['Characters', 'cast'],
  ['Places', 'locations'],
  ['Settings', 'settings'],
  ['Profile', 'profile'],
  ['New world', 'onboard']
];

const TABS: Array<[string, Screen]> = [
  ['Worlds', 'library'],
  ['Write', 'story'],
  ['Characters', 'cast'],
  ['Places', 'locations'],
  ['Settings', 'settings'],
  ['Profile', 'profile']
];

const OPEN_WORLD_FIRST = 'Open a world first.';

function navBlock(key: Screen, currentWorldId: string | null): boolean {
  return (key === 'story' || key === 'cast' || key === 'locations') && !currentWorldId;
}


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
        {ITEMS.map(([label, key]) => {
          const blocked = navBlock(key, currentWorldId);
          const reason = blocked ? OPEN_WORLD_FIRST : undefined;
          return (
            <span key={key} title={reason} style={{ display: 'block' }}>
              <button
                className={`nav-btn${screen === key ? ' active' : ''}`}
                disabled={blocked}
                aria-disabled={blocked || undefined}
                aria-current={screen === key ? 'page' : undefined}
                title={reason}
                onClick={() => {
                  if (blocked) return;
                  go(key);
                }}
              >
                <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
              </button>
            </span>
          );
        })}
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="craft-row" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="label">Current model</div>
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
              background: '#e4e4e7',
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
        const blocked = navBlock(key, currentWorldId);
        const reason = blocked ? OPEN_WORLD_FIRST : undefined;
        return (
          <span key={key} className="tabbar-slot" title={reason}>
            <button
              className={screen === key ? 'active' : ''}
              disabled={blocked}
              aria-disabled={blocked || undefined}
              aria-current={screen === key ? 'page' : undefined}
              aria-label={blocked ? `${label}. ${OPEN_WORLD_FIRST}` : label}
              title={reason}
              onClick={() => {
                if (blocked) return;
                go(key);
              }}
            >
              <span>{label}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
