import { useEffect, useState } from 'react';
import { formatUserError } from '../errors';
import { useVault, VaultCorruptError } from '../security/vault';
import { ErrorNote, Mono } from '../ui/bits';

const FAIL_KEY = 'sw-unlock-fails';
const UNTIL_KEY = 'sw-unlock-until';

function readBackoff(): { fails: number; until: number } {
  const fails = Number(sessionStorage.getItem(FAIL_KEY) ?? 0);
  const until = Number(sessionStorage.getItem(UNTIL_KEY) ?? 0);
  return {
    fails: Number.isFinite(fails) ? fails : 0,
    until: Number.isFinite(until) ? until : 0
  };
}

function noteFailure(): number {
  const fails = readBackoff().fails + 1;
  const wait = Math.min(30_000, 1000 * 2 ** (fails - 1));
  sessionStorage.setItem(FAIL_KEY, String(fails));
  sessionStorage.setItem(UNTIL_KEY, String(Date.now() + wait));
  return wait;
}

function clearBackoff(): void {
  sessionStorage.removeItem(FAIL_KEY);
  sessionStorage.removeItem(UNTIL_KEY);
}

export function LockScreen() {
  const vault = useVault();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [until, setUntil] = useState(() => readBackoff().until);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until <= Date.now()) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [until]);

  const waitLeft = Math.max(0, until - now);

  const unlock = async () => {
    if (!pass || busy || waitLeft > 0) return;
    setBusy(true);
    setError('');
    try {
      const ok = await vault.unlock(pass);
      if (!ok) {
        const wait = noteFailure();
        setUntil(Date.now() + wait);
        setNow(Date.now());
        setError('Wrong passphrase.');
        setPass('');
      } else {
        clearBackoff();
      }
    } catch (e) {
      setError(
        e instanceof VaultCorruptError
          ? 'Vault unreadable — restore a backup from Profile, or reset below. Sealed worlds stay unreadable until that backup is restored.'
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
          <Mono style={{ marginTop: 6 }}>locked · stories and keys encrypted</Mono>
        </div>
        <input
          type="password"
          autoFocus
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void unlock(); }}
          placeholder="passphrase"
          disabled={busy || waitLeft > 0}
        />
        {waitLeft > 0 && (
          <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.7)' }}>
            Try again in {Math.ceil(waitLeft / 1000)}s.
          </div>
        )}
        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        <button className="btn-primary" disabled={busy || !pass || waitLeft > 0} onClick={() => void unlock()}>
          {busy ? 'Unlocking…' : waitLeft > 0 ? 'Locked out' : 'Unlock'}
        </button>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(236,234,230,0.45)' }}>
          The lock encrypts stories and API keys on this device (AES-256-GCM) and hides the app.
          The passphrase was never sent anywhere and cannot be recovered. Resetting it deletes the story key,
          so sealed worlds on this device stay unreadable until you restore a backup.
        </div>
        <button
          className="btn-quiet"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            if (confirm('Forgot your passphrase? This deletes the story key and the encrypted API keys on this device. Sealed worlds on this device become unreadable until you restore a backup. This cannot be undone.')) {
              clearBackoff();
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
