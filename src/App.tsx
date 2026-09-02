import { useEffect, useState } from 'react';
import { Rail, TabBar } from './components/Nav';
import { LockScreen } from './components/LockScreen';
import { useAuth } from './cloud/authStore';
import { useVault } from './security/vault';
import { hasStoragePressure, STORAGE_PRESSURE_EVENT } from './storage/quota';
import { useApp } from './store/app';
import { Mono, phoneChrome, tabBarInset, useViewport } from './ui/bits';
import { Library } from './screens/Library';
import { Story } from './screens/Story';
import { Cast } from './screens/Cast';
import { Locations } from './screens/Locations';
import { Sequel } from './screens/Sequel';
import { Profile } from './screens/Profile';
import { Settings } from './screens/Settings';
import { Onboard } from './screens/Onboard';

export default function App() {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  const layout = useApp((s) => s.layout);
  const currentWorldId = useApp((s) => s.currentWorldId);
  const { band, keyboardOpen } = useViewport();
  const phone = phoneChrome(band);
  const tabsVisible = phone && !keyboardOpen;
  const vaultLocked = useVault((v) => v.enabled && v.locked);
  const readMode = screen === 'story' && layout === 'read' && !!currentWorldId;
  const initAuth = useAuth((s) => s.init);
  const [storagePressure, setStoragePressure] = useState(() => hasStoragePressure());

  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  useEffect(() => {
    const refresh = () => setStoragePressure(hasStoragePressure());
    window.addEventListener(STORAGE_PRESSURE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(STORAGE_PRESSURE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  if (vaultLocked) return <LockScreen />;

  return (
    <div className="app-shell" style={{
      position: 'relative', background: 'var(--ink)',
      color: 'var(--paper)', overflowX: 'hidden',
      display: 'flex', flexDirection: 'column'
    }}>
      <div className="horizon-wash" style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0
      }} />

      {storagePressure && screen !== 'profile' && (
        <div style={{
          flexShrink: 0, position: 'relative', zIndex: 40,
          borderBottom: '1px solid var(--focus)',
          background: 'rgba(255, 255, 255, 0.05)', backdropFilter: 'blur(14px) saturate(140%)',
          padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap'
        }}>
          <Mono style={{ fontSize: 10, color: 'var(--accent-strong)' }}>Storage pressure</Mono>
          <div style={{ flex: 1, minWidth: 180, fontSize: 12.5, lineHeight: 1.45, color: 'rgba(230,233,235,0.8)' }}>
            This browser is low on space. Back up now — worlds or keys can fail to save.
          </div>
          <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => go('profile')}>
            Open Profile
          </button>
        </div>
      )}

      <div style={{
        position: 'relative', zIndex: 1, flex: 1, minHeight: 0,
        display: phone || readMode ? 'flex' : 'grid',
        flexDirection: phone || readMode ? 'column' : undefined,
        gridTemplateColumns: phone || readMode ? undefined : '226px minmax(0, 1fr)',
        paddingBottom: tabsVisible ? tabBarInset(true) : 0
      }}>
        {!phone && !readMode && <Rail />}
        <main style={{
          minWidth: 0, minHeight: 0, flex: 1, position: 'relative', zIndex: 1,
          display: 'flex', flexDirection: 'column', overflow: 'auto'
        }}>
          {screen === 'library' && <Library />}
          {screen === 'story' && <Story />}
          {screen === 'cast' && <Cast />}
          {screen === 'locations' && <Locations />}
          {screen === 'sequel' && <Sequel />}
          {screen === 'profile' && <Profile />}
          {screen === 'settings' && <Settings />}
          {screen === 'onboard' && <Onboard />}
        </main>
      </div>

      {tabsVisible && <TabBar />}
    </div>
  );
}
