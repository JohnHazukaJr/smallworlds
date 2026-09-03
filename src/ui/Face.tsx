import type { CSSProperties } from 'react';

/** Width as a fraction of height for a 3:4 photographic plate. */
export const FACE_PLATE_RATIO = 0.78;

export function facePlateSize(height: number, hasPhoto: boolean): { width: number; height: number } {
  if (!hasPhoto) return { width: height, height };
  return { width: Math.max(22, Math.round(height * FACE_PLATE_RATIO)), height };
}

function hueRim(hue: number, alpha: number): string {
  return `oklch(0.72 0.08 ${hue} / ${alpha})`;
}

/** Story face — 3:4 plate when a photo exists, circular hue+initial otherwise. Size is height. */
export function faceStyle(opts: {
  hue: number;
  size: number;
  portrait?: string | null;
  glow?: boolean;
}): CSSProperties {
  const { hue, size, portrait, glow } = opts;
  const photo = (portrait ?? '').trim();
  const { width, height } = facePlateSize(size, !!photo);
  const room = '0 12px 28px rgba(8,9,12,0.5)';
  const glowShadow = glow
    ? `0 0 0 1px ${hueRim(hue, 0.55)}, 0 10px 32px ${hueRim(hue, 0.42)}, ${room}`
    : room;
  return {
    width,
    height,
    borderRadius: photo ? 11 : '50%',
    flexShrink: 0,
    border: `1px solid ${photo ? hueRim(hue, 0.42) : 'rgba(255,255,255,0.28)'}`,
    boxShadow: photo
      ? `inset 0 1px 0 rgba(255,255,255,0.2), ${glowShadow}`
      : `inset 0 1px 0 rgba(255,255,255,0.28), ${glow ? glowShadow : '0 6px 18px rgba(8,9,12,0.35)'}`,
    background: photo
      ? `center / cover no-repeat url(${JSON.stringify(photo)})`
      : `radial-gradient(circle at 32% 28%, oklch(0.78 0.06 ${hue} / 0.55), oklch(0.38 0.05 ${hue}) 72%)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative'
  };
}

export function Face({
  hue, size, portrait, name, glow
}: {
  hue: number;
  size: number;
  portrait?: string | null;
  name?: string;
  glow?: boolean;
}) {
  const photo = (portrait ?? '').trim();
  const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className={`face-glass${photo ? ' face-plate' : ''}`}
      style={faceStyle({ hue, size, portrait, glow })}
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
