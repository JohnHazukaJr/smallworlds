import { useEffect, useState } from 'react';
import { Rail, TabBar } from './components/Nav';
import { LockScreen } from './components/LockScreen';
import { useAuth } from './cloud/authStore';
import { useVault } from './security/vault';
import { hasStoragePressure, STORAGE_PRESSURE_EVENT } from './storage/quota';
import { useApp } from './store/app';
import { Mono, useVw } from './ui/bits';
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
  const vw = useVw();
  const narrow = vw < 780;
  const vaultLocked = useVault((v) => v.enabled && v.locked);
  const readMode = screen === 'story' && layout === 'read';
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
      position: 'relative', background: '#08090c',
      color: '#eceae6', overflowX: 'hidden'
    }}>
      {!readMode && (
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
          background:
            'radial-gradient(900px 700px at 12% -5%, rgba(224,165,95,0.14), transparent 65%), radial-gradient(800px 620px at 88% 8%, rgba(120,150,200,0.12), transparent 62%), radial-gradient(900px 800px at 55% 110%, rgba(180,140,220,0.09), transparent 60%)',
          animation: 'wr-drift 34s ease-in-out infinite'
        }} />
      )}

      {storagePressure && screen !== 'profile' && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 40,
          borderBottom: '1px solid rgba(224,165,95,0.35)',
          background: 'rgba(40, 28, 16, 0.92)', backdropFilter: 'blur(16px)',
          padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap'
        }}>
          <Mono style={{ fontSize: 9, color: 'rgba(224,165,95,0.95)' }}>storage pressure</Mono>
          <div style={{ flex: 1, minWidth: 180, fontSize: 12.5, lineHeight: 1.45, color: 'rgba(236,234,230,0.8)' }}>
            This browser is low on space. Back up now — worlds or keys can fail to save.
          </div>
          <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => go('profile')}>
            Open Profile
          </button>
        </div>
      )}

      <div className="app-shell" style={{
        position: 'relative', zIndex: 1,
        display: narrow || readMode ? 'block' : 'grid',
        gridTemplateColumns: narrow || readMode ? undefined : '226px minmax(0, 1fr)',
        paddingBottom: narrow && !readMode ? 'calc(58px + env(safe-area-inset-bottom))' : 0
      }}>
        {!narrow && !readMode && <Rail />}
        <main style={{ minWidth: 0, position: 'relative', zIndex: 1 }}>
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

      {narrow && !readMode && <TabBar />}
    </div>
  );
}
