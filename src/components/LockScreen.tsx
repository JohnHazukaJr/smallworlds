import { useState } from 'react';
import { formatUserError } from '../errors';
import { useVault, VaultCorruptError } from '../security/vault';
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
    try {
      const ok = await vault.unlock(pass);
      if (!ok) {
        setError('Wrong passphrase.');
        setPass('');
      }
    } catch (e) {
      setError(
        e instanceof VaultCorruptError
          ? 'Vault unreadable — restore a backup from Profile, or reset below (stories are kept).'
          : formatUserError(e)
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'relative', minHeight: '100vh', background: 'var(--ink)', color: 'var(--paper)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }}>
      <div className="horizon-wash" style={{
        position: 'fixed', inset: 0, pointerEvents: 'none'
      }} />
      <div className="craft-row fade-in" style={{ position: 'relative', width: 400, maxWidth: '100%', padding: '30px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="serif" style={{ fontSize: 26, letterSpacing: '0.01em', color: '#f2f4f5', fontWeight: 300 }}>
            Small Worlds
          </div>
          <div className="label">Make a world. Live in it.</div>
          <Mono style={{ marginTop: 6 }}>locked · API keys encrypted · stories stay in IndexedDB</Mono>
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
          The lock encrypts your API keys and hides the app UI. Story text stays readable in this browser&apos;s
          IndexedDB — it is not encrypted by the passphrase. Protect the device (OS encryption) if that matters.
          The passphrase was never sent anywhere and cannot be recovered. Resetting it wipes keys on this device
          unless you have a device backup.
        </div>
        <button
          className="btn-quiet"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            if (confirm('Forgot your passphrase? This deletes the encrypted API keys on this device. Restore them from a device backup (Profile → Restore) or re-enter them in Settings. Stories stay.')) {
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
