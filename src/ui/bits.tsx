import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ACCENT } from './theme';

export function useVw(): number {
  const [vw, setVw] = useState(typeof window !== 'undefined' ? window.innerWidth : 1440);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vw;
}

export function Mono({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="mono" style={style}>{children}</div>;
}

export function Chip({
  active, onClick, children, accent = ACCENT, disabled
}: {
  active?: boolean; onClick?: () => void; children: ReactNode; accent?: string; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${active ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.11)'}`,
        background: active ? accent : 'rgba(255,255,255,0.05)',
        color: active ? '#181307' : 'rgba(236,234,230,0.62)',
        borderRadius: 9,
        padding: '7px 13px',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        backdropFilter: 'blur(14px)',
        opacity: disabled ? 0.5 : 1
      }}
    >
      {children}
    </button>
  );
}

export function Toggle({ on, onClick, accent = ACCENT }: { on: boolean; onClick: () => void; accent?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 46, height: 26, borderRadius: 14, flexShrink: 0,
        border: `1px solid rgba(255,255,255,${on ? '0.2' : '0.12'})`,
        background: on ? accent : 'rgba(255,255,255,0.06)',
        cursor: 'pointer', padding: 3, display: 'flex',
        justifyContent: on ? 'flex-end' : 'flex-start', transition: 'all 0.2s ease'
      }}
    >
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: on ? '#1a1409' : 'rgba(236,234,230,0.5)' }} />
    </button>
  );
}

export function Bar({ pct, color = ACCENT }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
    </div>
  );
}

export function Field({
  label, note, children
}: { label: string; note?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(236,234,230,0.9)' }}>{label}</div>
        {note && <div className="mono" style={{ letterSpacing: '0.08em', textTransform: 'none' }}>{note}</div>}
      </div>
      {children}
    </div>
  );
}

export function Spinner({ label, accent = ACCENT }: { label: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.7 }}>
      <div style={{
        width: 5, height: 5, borderRadius: '50%', background: accent,
        boxShadow: `12px 0 0 ${accent}80, 24px 0 0 ${accent}40`,
        animation: 'wr-pulse 1.2s ease-in-out infinite'
      }} />
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, marginLeft: 28 }}>{label}</span>
    </div>
  );
}

export function ErrorNote({ error, onDismiss }: { error: string; onDismiss?: () => void }) {
  return (
    <div style={{
      border: '1px solid rgba(220,110,90,0.4)', borderRadius: 12, padding: '11px 14px',
      background: 'rgba(220,110,90,0.09)', display: 'flex', gap: 12, alignItems: 'flex-start'
    }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(240,200,190,0.95)', flex: 1, wordBreak: 'break-word' }}>{error}</div>
      {onDismiss && (
        <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 14 }} onClick={onDismiss}>×</button>
      )}
    </div>
  );
}

/** Right-side sheet on desktop, bottom sheet on mobile. */
export function Sheet({
  open, onClose, children, narrow, width = 440
}: { open: boolean; onClose: () => void; children: ReactNode; narrow: boolean; width?: number }) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(6,7,10,0.55)', backdropFilter: 'blur(4px)' }}
      />
      <aside style={{
        position: 'fixed', zIndex: 51,
        ...(narrow
          ? { left: 0, right: 0, bottom: 0, top: '8vh', borderTop: '1px solid rgba(255,255,255,0.12)', borderRadius: '18px 18px 0 0', animation: 'wr-slide-up 0.25s ease both' }
          : { top: 0, right: 0, bottom: 0, width, borderLeft: '1px solid rgba(255,255,255,0.12)', animation: 'wr-fade 0.25s ease both' }),
        display: 'flex', flexDirection: 'column', gap: 16,
        padding: narrow ? '18px 16px calc(16px + env(safe-area-inset-bottom))' : '22px 22px 20px',
        background: 'rgba(14,16,20,0.86)', backdropFilter: 'blur(30px) saturate(150%)',
        boxShadow: '-30px 0 80px rgba(0,0,0,0.5)', overflow: 'auto'
      }}>
        {children}
      </aside>
    </>
  );
}
