import { useState } from 'react';
import {
  DELIVERY_TONE_GROUPS,
  isDeliveryTone,
  type DeliveryTone
} from '../ai/deliveryTone';
import { Chip } from '../ui/bits';

const RECENT_KEY = 'sw-delivery-recent';
const TIP_KEY = 'sw-delivery-tip-seen';
const RECENT_CAP = 7;

function readRecent(): DeliveryTone[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string')
      .filter(isDeliveryTone)
      .slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

function writeRecent(tones: DeliveryTone[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(tones));
  } catch {
    /* ignore */
  }
}

const LABEL_STYLE = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  opacity: 0.45
};

/**
 * Tone tag for a speak/act turn.
 * Collapsed it offers "plain" plus the tones this player actually reaches for;
 * the full set stays one tap away, grouped by family so it stays scannable.
 */
export function DeliveryPicker({
  value,
  onChange
}: {
  value: DeliveryTone | null;
  onChange: (tone: DeliveryTone | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<DeliveryTone[]>(readRecent);
  const [tipSeen, setTipSeen] = useState(() => {
    try {
      return localStorage.getItem(TIP_KEY) === '1';
    } catch {
      return true;
    }
  });

  const pick = (tone: DeliveryTone) => {
    if (value === tone) {
      onChange(null);
      return;
    }
    onChange(tone);
    setRecent((cur) => {
      const next = [tone, ...cur.filter((t) => t !== tone)].slice(0, RECENT_CAP);
      writeRecent(next);
      return next;
    });
    setOpen(false);
  };

  // Keep the active tone visible in the collapsed row even if it fell off recents.
  const quick = value && !recent.includes(value) ? [value, ...recent] : recent;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={LABEL_STYLE}>delivery</span>
        <button
          className="btn-quiet"
          style={{ padding: 0, fontSize: 11 }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'less' : 'all tones'}
        </button>
      </div>

      {!tipSeen && (
        <div style={{ fontSize: 12, lineHeight: 1.45, color: 'rgba(236,234,230,0.55)' }}>
          Optional tone for how you speak or act — sarcastic, pleading, deadpan. Tap again to clear.
          <button
            className="btn-quiet"
            style={{ marginLeft: 8, fontSize: 11 }}
            onClick={() => {
              setTipSeen(true);
              try { localStorage.setItem(TIP_KEY, '1'); } catch { /* ignore */ }
            }}
          >
            got it
          </button>
        </div>
      )}

      {!open && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip active={value === null} onClick={() => onChange(null)}>plain</Chip>
          {quick.map((tone) => (
            <Chip key={tone} active={value === tone} onClick={() => pick(tone)}>
              {tone}
            </Chip>
          ))}
          {quick.length === 0 && (
            <span style={{ fontSize: 12, color: 'rgba(236,234,230,0.4)', alignSelf: 'center' }}>
              pick a tone from all tones
            </span>
          )}
        </div>
      )}

      {open && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 12,
          maxHeight: 260, overflowY: 'auto',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
          padding: '12px 12px 14px', background: 'rgba(255,255,255,0.03)'
        }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Chip active={value === null} onClick={() => { onChange(null); setOpen(false); }}>
              plain
            </Chip>
          </div>
          {DELIVERY_TONE_GROUPS.map((group) => (
            <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ ...LABEL_STYLE, fontSize: 9, opacity: 0.4 }}>{group.label}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {group.tones.map((tone) => (
                  <Chip key={tone} active={value === tone} onClick={() => pick(tone)}>
                    {tone}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
