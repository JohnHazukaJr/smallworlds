import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { AppError, classifyError } from '../errors';
import { ACCENT, ACCENT_RGBA } from './theme';

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
        border: `1px solid ${active ? ACCENT_RGBA.a55 : 'rgba(255,255,255,0.12)'}`,
        background: active ? ACCENT_RGBA.a14 : 'transparent',
        color: active ? '#e8f2f4' : 'rgba(230,233,235,0.62)',
        borderRadius: 4,
        padding: '8px 12px',
        minHeight: 36,
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        boxShadow: active ? `inset 0 -2px 0 ${accent}` : 'none',
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
        width: 44, height: 24, borderRadius: 4, flexShrink: 0,
        border: `1px solid rgba(255,255,255,${on ? '0.22' : '0.12'})`,
        background: on ? accent : 'rgba(255,255,255,0.05)',
        cursor: 'pointer', padding: 3, display: 'flex',
        justifyContent: on ? 'flex-end' : 'flex-start', transition: 'all 0.2s ease'
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: 2,
        background: on ? '#0a1416' : 'rgba(230,233,235,0.55)'
      }} />
    </button>
  );
}

export function Bar({ pct, color = ACCENT }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 1 }} />
    </div>
  );
}

export function Field({
  label, note, children
}: { label: string; note?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(230,233,235,0.9)' }}>{label}</div>
        {note && <div className="label">{note}</div>}
      </div>
      {children}
    </div>
  );
}

export function Spinner({ label, accent = ACCENT }: { label: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.75 }}>
      <div style={{
        width: 4, height: 4, borderRadius: 1, background: accent,
        boxShadow: `10px 0 0 ${accent}99, 20px 0 0 ${accent}44`,
        animation: 'wr-pulse 1.2s ease-in-out infinite'
      }} />
      <span className="label" style={{ marginLeft: 24, color: 'rgba(230,233,235,0.65)' }}>{label}</span>
    </div>
  );
}

export function ErrorNote({
  error, onDismiss, tone = 'error'
}: {
  error: string | AppError;
  onDismiss?: () => void;
  tone?: 'error' | 'warn';
}) {
  const [openDetail, setOpenDetail] = useState(false);
  const message = typeof error === 'string' ? error : error.userMessage;
  const detail = typeof error === 'string'
    ? null
    : (error.detail && error.detail !== error.userMessage ? error.detail : null);
  const warn = tone === 'warn';
  return (
    <div style={{
      border: warn ? `1px solid ${ACCENT_RGBA.a45}` : '1px solid rgba(200,100,90,0.4)',
      borderRadius: 6, padding: '11px 14px',
      background: warn ? ACCENT_RGBA.a08 : 'rgba(200,100,90,0.08)',
      display: 'flex', gap: 12, alignItems: 'flex-start'
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, lineHeight: 1.55, wordBreak: 'break-word',
          color: warn ? 'rgba(200,230,235,0.95)' : 'rgba(240,200,190,0.95)'
        }}>
          {message}
        </div>
        {detail && (
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn-quiet"
              style={{ padding: 0, fontSize: 11, opacity: 0.75 }}
              onClick={() => setOpenDetail((v) => !v)}
            >
              {openDetail ? 'Hide details' : 'Details'}
            </button>
            {openDetail && (
              <div style={{
                marginTop: 6, fontSize: 11, lineHeight: 1.45, opacity: 0.7,
                wordBreak: 'break-word', fontFamily: "'IBM Plex Mono', monospace"
              }}>
                {detail}
              </div>
            )}
          </div>
        )}
      </div>
      {onDismiss && (
        <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 14 }} onClick={onDismiss}>×</button>
      )}
    </div>
  );
}

/** Convenience: classify then render. */
export function ClassifiedErrorNote({
  error, onDismiss, tone
}: {
  error: unknown;
  onDismiss?: () => void;
  tone?: 'error' | 'warn';
}) {
  return <ErrorNote error={classifyError(error)} onDismiss={onDismiss} tone={tone} />;
}

/**
 * Right-side sheet on desktop, bottom sheet on mobile.
 * Pass `footer` to pin actions above the safe area while the body scrolls
 * (critical for portrait iPhone wrap flows).
 */
export function Sheet({
  open, onClose, children, footer, narrow, width = 440
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  narrow: boolean;
  width?: number;
}) {
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
          ? { left: 0, right: 0, bottom: 0, top: '8vh', borderTop: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px 10px 0 0', animation: 'wr-slide-up 0.25s ease both' }
          : { top: 0, right: 0, bottom: 0, width, borderLeft: '1px solid rgba(255,255,255,0.12)', animation: 'wr-fade 0.25s ease both' }),
        display: 'flex', flexDirection: 'column', gap: 0,
        padding: 0,
        background: 'rgba(12,14,16,0.96)', backdropFilter: 'blur(14px) saturate(110%)',
        boxShadow: '-12px 0 32px rgba(0,0,0,0.4)',
        overflow: 'hidden',
        minHeight: 0
      }}>
        <div style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 16,
          padding: narrow ? '18px 16px 12px' : '22px 22px 16px'
        }}>
          {children}
        </div>
        {footer != null && (
          <div style={{
            flexShrink: 0,
            borderTop: '1px solid rgba(255,255,255,0.1)',
            padding: narrow
              ? '12px 16px calc(12px + env(safe-area-inset-bottom))'
              : '14px 22px 18px',
            background: 'rgba(10,12,14,0.98)',
            display: 'flex', flexDirection: 'column', gap: 10
          }}>
            {footer}
          </div>
        )}
      </aside>
    </>
  );
}
