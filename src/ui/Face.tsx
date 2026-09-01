import type { CSSProperties } from 'react';

/** Circular glass face for the story scroll — photo, or hue + initial. */
export function faceStyle(opts: {
  hue: number;
  size: number;
  portrait?: string | null;
}): CSSProperties {
  const { hue, size, portrait } = opts;
  const photo = (portrait ?? '').trim();
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    border: '1px solid rgba(255,255,255,0.28)',
    boxShadow:
      'inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 18px rgba(8,9,12,0.35)',
    background: photo
      ? `center / cover no-repeat url(${JSON.stringify(photo)})`
      : `radial-gradient(circle at 32% 28%, oklch(0.78 0.06 ${hue} / 0.55), oklch(0.38 0.05 ${hue}) 72%)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  };
}

export function Face({
  hue, size, portrait, name
}: {
  hue: number;
  size: number;
  portrait?: string | null;
  name?: string;
}) {
  const photo = (portrait ?? '').trim();
  const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className="face-glass"
      style={faceStyle({ hue, size, portrait })}
      aria-hidden
    >
      {!photo && (
        <span
          className="serif"
          style={{
            fontSize: Math.max(12, Math.round(size * 0.38)),
            fontWeight: 500,
            color: 'rgba(246,244,240,0.92)',
            textShadow: '0 1px 8px rgba(8,9,12,0.55)',
            lineHeight: 1
          }}
        >
          {initial}
        </span>
      )}
    </div>
  );
}
