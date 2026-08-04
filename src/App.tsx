import { Rail, TabBar } from './components/Nav';
import { LockScreen } from './components/LockScreen';
import { useVault } from './security/vault';
import { useApp } from './store/app';
import { useVw } from './ui/bits';
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
  const layout = useApp((s) => s.layout);
  const vw = useVw();
  const narrow = vw < 780;
  const vaultLocked = useVault((v) => v.enabled && v.locked);
  const readMode = screen === 'story' && layout === 'read';

  if (vaultLocked) return <LockScreen />;

  return (
    <div style={{
      position: 'relative', minHeight: '100vh', background: '#08090c',
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

      <div style={{
        position: 'relative', zIndex: 1, minHeight: '100vh',
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
