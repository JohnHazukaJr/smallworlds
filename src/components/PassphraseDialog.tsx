import { useEffect, useState } from 'react';
import { ErrorNote, Mono } from '../ui/bits';

export interface PassphraseDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** 'set' asks for the passphrase twice */
  mode: 'enter' | 'set';
  /** allow submitting with an empty passphrase (e.g. "export unencrypted") */
  allowEmpty?: boolean;
  emptyLabel?: string;
  submitLabel: string;
  busy?: boolean;
  error?: string;
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}

export function PassphraseDialog(p: PassphraseDialogProps) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (p.open) { setPass(''); setConfirm(''); setLocalError(''); }
  }, [p.open]);

  if (!p.open) return null;

  const submit = () => {
    if (p.mode === 'set' && pass && pass !== confirm) {
      setLocalError('Passphrases do not match.');
      return;
    }
    if (!pass && !p.allowEmpty) {
      setLocalError('Enter a passphrase.');
      return;
    }
    setLocalError('');
    p.onSubmit(pass);
  };

  const error = p.error || localError;

  return (
    <>
      <div onClick={p.onCancel} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(6,7,10,0.6)', backdropFilter: 'blur(4px)' }} />
      <div className="craft-row fade-in" style={{
        position: 'fixed', zIndex: 51, top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: 'min(420px, calc(100% - 32px))', maxWidth: 'calc(100% - 32px)', padding: '24px 24px 20px',
        display: 'flex', flexDirection: 'column', gap: 14
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 22, color: '#f6f4f0' }}>{p.title}</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.6)' }}>{p.description}</div>
        </div>
        <input
          type="password" autoFocus value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && p.mode === 'enter') submit(); }}
          placeholder="passphrase"
          disabled={p.busy}
        />
        {p.mode === 'set' && (
          <input
            type="password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="repeat the passphrase"
            disabled={p.busy}
          />
        )}
        {error && <ErrorNote error={error} />}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-primary" disabled={p.busy} onClick={submit}>
            {p.busy ? 'Working…' : p.submitLabel}
          </button>
          {p.allowEmpty && !pass && (
            <Mono style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'none' }}>
              {p.emptyLabel ?? 'leave blank to skip encryption'}
            </Mono>
          )}
          <button className="btn-quiet" style={{ marginLeft: 'auto' }} disabled={p.busy} onClick={p.onCancel}>cancel</button>
        </div>
      </div>
    </>
  );
}
