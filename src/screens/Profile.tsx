import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { PassphraseDialog } from '../components/PassphraseDialog';
import { useAuth } from '../cloud/authStore';
import { isCloudConfigured } from '../cloud/supabase';
import { db, exportWorld, importAnyFile, isEncryptedExport, type EncryptedExport } from '../db';
import { useVault } from '../security/vault';
import { useSettings } from '../store/settings';
import {
  clearStoragePressure, estimateStorage, hasStoragePressure, type StorageReport
} from '../storage/quota';
import {
  decryptDeviceExport, deviceHasSecrets, encryptDeviceExport, exportDevice
} from '../sync/serialize';
import { pullEncryptedSecrets, pushEncryptedSecrets, syncNow, useSyncMeta } from '../sync/engine';
import { ErrorNote, Mono, useVw } from '../ui/bits';
import { avatarStyle, plateStyle, VIS } from '../ui/theme';
import type { Visibility } from '../types';

function download(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Profile() {
  const vw = useVw();
  const narrow = vw < 780;
  const s = useSettings();
  const vaultEnabled = useVault((v) => v.enabled);
  const [exporting, setExporting] = useState(false);
  const [backupDialog, setBackupDialog] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<EncryptedExport | null>(null);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    void estimateStorage().then(setStorage);
  }, [worlds.length]);

  const exportDeviceBackup = async (passphrase: string) => {
    setExporting(true);
    setError('');
    try {
      const device = await exportDevice();
      const date = new Date().toISOString().slice(0, 10);
      if (deviceHasSecrets(device) && !passphrase) {
        throw new Error('This backup includes API keys — enter a passphrase to encrypt it.');
      }
      if (passphrase) {
        download(await encryptDeviceExport(device, passphrase), `small-worlds-device-${date}.enc.json`);
      } else {
        download(device, `small-worlds-device-${date}.json`);
      }
      clearStoragePressure();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const finishRestore = async (data: unknown) => {
    const ids = await importAnyFile(data);
    clearStoragePressure();
    setError(`Restored ${ids.length} world${ids.length === 1 ? '' : 's'}. Unlock if the vault was restored.`);
  };

  const onRestoreFile = async (file: File) => {
    setRestoreBusy(true);
    setError('');
    try {
      const data = JSON.parse(await file.text());
      if (isEncryptedExport(data)) {
        setPendingRestore(data);
        return;
      }
      await finishRestore(data);
    } catch (e) {
      setError(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRestoreBusy(false);
    }
  };

  const storageWarn = storage?.warn || hasStoragePressure();

  return (
    <div className="fade-in" style={{ padding: narrow ? '26px 18px 70px' : '42px 46px 70px', maxWidth: 1020 }}>
      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 34 }}>
        <div style={avatarStyle(60, 84, 'rgba(255,255,255,0.2)')} />
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: narrow ? 28 : 36, lineHeight: 1.1, color: '#f8f6f2' }}>Your shelf</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'rgba(236,234,230,0.58)', maxWidth: '58ch' }}>
            Worlds live in this browser first. Back up the whole device (stories + settings + encrypted keys), or sign in
            to sync across machines. AI keys never leave your device unencrypted.
          </div>
        </div>
      </div>

      {error && <div style={{ marginBottom: 18 }}><ErrorNote error={error} onDismiss={() => setError('')} /></div>}

      {storageWarn && (
        <div className="glass" style={{
          padding: '14px 16px', marginBottom: 22, borderColor: 'rgba(224,165,95,0.35)',
          display: 'flex', flexDirection: 'column', gap: 8
        }}>
          <Mono style={{ fontSize: 9, color: 'rgba(224,165,95,0.9)' }}>storage pressure</Mono>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: 'rgba(236,234,230,0.75)' }}>
            This browser is running low on space{storage ? ` (${storage.label})` : ''}. Export a device backup now —
            if storage fills up, worlds or keys can fail to save.
          </div>
          <button className="btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setBackupDialog(true)}>
            Back up this device
          </button>
        </div>
      )}

      <AccountSection onError={setError} />

      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', borderTop: '1px solid rgba(255,255,255,0.08)', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '16px 0', marginBottom: 34 }}>
        {[
          ['worlds', String(worlds.length)],
          ['seasons', String(stats?.seasons ?? '—')],
          ['words written', stats ? `${Math.round(stats.words / 100) / 10}k` : '—'],
          ['cast created', String(stats?.cast ?? '—')],
          ['storage', storage?.label ?? '—']
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
            ['API keys', vaultEnabled ? 'encrypted at rest (AES-256, your passphrase)' : 'localStorage — add a passphrase in Settings'],
            ['Used for model training', 'never — requests go straight to your provider'],
            ['Cloud sync', isCloudConfigured() ? 'optional — sign in above' : 'configure VITE_SUPABASE_* to enable']
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
              <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.6)' }}>{label}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: 'rgba(236,234,230,0.9)', textAlign: 'right' }}>{value}</div>
            </div>
          ))}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-primary" disabled={exporting} onClick={() => setBackupDialog(true)}>
              {exporting ? 'Exporting…' : 'Back up this device'}
            </button>
            <button className="btn-ghost" disabled={restoreBusy} onClick={() => fileRef.current?.click()}>
              {restoreBusy ? 'Restoring…' : 'Restore device'}
            </button>
            <input
              ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onRestoreFile(f); e.target.value = ''; }}
            />
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.4)' }}>
            Device backup includes worlds, settings, and the encrypted key vault. Prefer a passphrase whenever keys are present.
          </div>
        </div>
      </div>

      <PassphraseDialog
        open={backupDialog}
        title="Back up this device"
        description="Encrypts worlds, settings, and API keys (AES-256). Required when keys are present. Leave blank only for a worlds+settings JSON with no secrets."
        mode="set"
        allowEmpty
        emptyLabel="blank = plain JSON (only if no keys)"
        submitLabel="Download backup"
        busy={exporting}
        onCancel={() => setBackupDialog(false)}
        onSubmit={(pass) => {
          void exportDeviceBackup(pass).finally(() => setBackupDialog(false));
        }}
      />

      <PassphraseDialog
        open={!!pendingRestore}
        title="Unlock backup"
        description="Enter the passphrase used when this device backup was encrypted."
        mode="enter"
        submitLabel="Restore"
        busy={restoreBusy}
        onCancel={() => setPendingRestore(null)}
        onSubmit={(pass) => {
          if (!pendingRestore) return;
          setRestoreBusy(true);
          void decryptDeviceExport(pendingRestore, pass)
            .then((data) => finishRestore(data))
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => {
              setRestoreBusy(false);
              setPendingRestore(null);
            });
        }}
      />
    </div>
  );
}

function AccountSection({ onError }: { onError: (msg: string) => void }) {
  const auth = useAuth();
  const sync = useSyncMeta();
  const [tab, setTab] = useState<'phone' | 'email' | 'google'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretsPass, setSecretsPass] = useState('');
  const [totp, setTotp] = useState<{ qr: string; secret: string; factorId: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');

  if (!auth.configured) {
    return (
      <div className="glass" style={{ padding: 20, marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>account · cloud sync</Mono>
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.65)' }}>
          Cloud sync is off. Copy <code style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>.env.example</code> to
          <code style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}> .env.local</code>, add your Supabase URL and anon key,
          run <code style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>supabase/migrations/001_initial.sql</code>,
          then restart the dev server. Phone SMS needs Twilio (paid); email and Google are free-tier friendly; TOTP MFA is optional.
        </div>
      </div>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!auth.user) {
    return (
      <div className="glass" style={{ padding: 20, marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Mono style={{ fontSize: 9 }}>sign in · equal options</Mono>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'rgba(236,234,230,0.6)' }}>
          Phone, email, or Google — pick whichever you prefer. None is required to play locally.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['email', 'phone', 'google'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'btn-primary' : 'btn-ghost'}
              style={{ fontSize: 11, padding: '6px 12px', textTransform: 'capitalize' }}
              onClick={() => setTab(t)}
            >{t}</button>
          ))}
        </div>

        {tab === 'email' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-primary" disabled={busy || !email || !password} onClick={() => void run(() => auth.signInWithEmail(email, password))}>
                Sign in
              </button>
              <button className="btn-ghost" disabled={busy || !email || !password} onClick={() => void run(() => auth.signUpWithEmail(email, password))}>
                Create account
              </button>
            </div>
          </div>
        )}

        {tab === 'phone' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="tel" placeholder="+1…" value={phone} onChange={(e) => setPhone(e.target.value)} />
            {!otpSent ? (
              <button className="btn-primary" disabled={busy || !phone} onClick={() => void run(async () => {
                await auth.signInWithPhone(phone);
                setOtpSent(true);
              })}>Send code</button>
            ) : (
              <>
                <input placeholder="SMS code" value={otp} onChange={(e) => setOtp(e.target.value)} />
                <button className="btn-primary" disabled={busy || !otp} onClick={() => void run(() => auth.verifyPhoneOtp(phone, otp))}>
                  Verify
                </button>
              </>
            )}
            <div style={{ fontSize: 11, color: 'rgba(236,234,230,0.4)' }}>SMS is billed via Twilio on your Supabase project.</div>
          </div>
        )}

        {tab === 'google' && (
          <button className="btn-primary" disabled={busy} onClick={() => void run(() => auth.signInWithGoogle())}>
            Continue with Google
          </button>
        )}
      </div>
    );
  }

  const last = sync.lastSyncedAt
    ? new Date(sync.lastSyncedAt).toLocaleString()
    : 'never';

  return (
    <div className="glass" style={{ padding: 20, marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Mono style={{ fontSize: 9 }}>signed in</Mono>
        <button className="btn-quiet" style={{ fontSize: 11 }} disabled={busy} onClick={() => void run(() => auth.signOut())}>Sign out</button>
      </div>
      <div style={{ fontSize: 13.5, color: 'rgba(236,234,230,0.85)' }}>
        {auth.user.email || auth.user.phone || auth.user.id.slice(0, 8)}
      </div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.45)' }}>
        last synced · {last}
        {sync.lastResult ? ` · ${sync.lastResult}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn-primary"
          disabled={busy || sync.busy}
          onClick={() => void run(async () => { await syncNow(); })}
        >
          {sync.busy ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>encrypted API keys (E2E)</Mono>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.55)' }}>
          Separate from your account password. Encrypts provider keys so the server only stores ciphertext.
        </div>
        <input
          type="password"
          placeholder="secrets passphrase"
          value={secretsPass}
          onChange={(e) => setSecretsPass(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn-ghost" disabled={busy || !secretsPass} onClick={() => void run(() => pushEncryptedSecrets(secretsPass))}>
            Upload keys
          </button>
          <button className="btn-ghost" disabled={busy || !secretsPass} onClick={() => void run(async () => {
            const n = await pullEncryptedSecrets(secretsPass);
            onError(`Restored ${n} key${n === 1 ? '' : 's'} into memory.`);
          })}>
            Download keys
          </button>
        </div>
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>optional TOTP MFA</Mono>
        {auth.factors.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.65)' }}>
              {auth.factors.length} authenticator factor{auth.factors.length > 1 ? 's' : ''} enrolled.
            </div>
            {auth.factors.map((f) => (
              <button key={f.id} className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                onClick={() => void run(() => auth.unenrollFactor(f.id))}>
                Remove {f.friendly_name || 'factor'}
              </button>
            ))}
          </div>
        ) : !totp ? (
          <button className="btn-ghost" disabled={busy} onClick={() => void run(async () => {
            setTotp(await auth.enrollTotp());
          })}>Enroll authenticator</button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: 'rgba(236,234,230,0.55)' }}>Scan with your authenticator, then enter a code.</div>
            <img src={totp.qr} alt="TOTP QR" style={{ width: 160, height: 160, borderRadius: 8, background: '#fff' }} />
            <Mono style={{ fontSize: 10 }}>{totp.secret}</Mono>
            <input placeholder="6-digit code" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
            <button className="btn-primary" disabled={busy || totpCode.length < 6} onClick={() => void run(async () => {
              await auth.challengeTotp(totp.factorId, totpCode);
              setTotp(null);
              setTotpCode('');
            })}>Confirm MFA</button>
          </div>
        )}
      </div>
    </div>
  );
}
