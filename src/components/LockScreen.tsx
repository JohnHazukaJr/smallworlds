import { useState } from 'react';
import { useVault } from '../security/vault';
import { ErrorNote, Mono } from '../ui/bits';

export function LockScreen() {
  const vault = useVault();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const unlock = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setError('');
    const ok = await vault.unlock(pass);
    setBusy(false);
    if (!ok) {
      setError('Wrong passphrase.');
      setPass('');
    }
  };

  return (
    <div style={{
      position: 'relative', minHeight: '100vh', background: '#08090c', color: '#eceae6',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }}>
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        background:
          'radial-gradient(900px 700px at 12% -5%, rgba(224,165,95,0.14), transparent 65%), radial-gradient(800px 620px at 88% 8%, rgba(120,150,200,0.12), transparent 62%)',
        animation: 'wr-drift 34s ease-in-out infinite'
      }} />
      <div className="glass fade-in" style={{ position: 'relative', width: 400, maxWidth: '100%', padding: '30px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="serif" style={{ fontSize: 24, letterSpacing: '0.02em', color: '#f6f4f0' }}>
            Small Worlds
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.14em', opacity: 0.5, paddingLeft: 6 }}>AI</span>
          </div>
          <Mono>locked · your keys are encrypted on this device</Mono>
        </div>
        <input
          type="password"
          autoFocus
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void unlock(); }}
          placeholder="passphrase"
          disabled={busy}
        />
        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        <button className="btn-primary" disabled={busy || !pass} onClick={() => void unlock()}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(236,234,230,0.45)' }}>
          Your stories are on this device and unaffected by the lock. The passphrase only protects your API keys —
          it was never sent anywhere and cannot be recovered.
        </div>
        <button
          className="btn-quiet"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            if (confirm('Forgot your passphrase? This deletes the encrypted API keys (you will need to re-enter them). Stories and characters are kept.')) {
              vault.reset();
            }
          }}
        >
          I forgot my passphrase
        </button>
      </div>
    </div>
  );
}
