import type { CSSProperties } from 'react';
import type { Character } from '../types';
import { hasLink } from '../relationships';
import { useVw } from '../ui/bits';
import { avatarStyle } from '../ui/theme';
import { characterPortraits } from '../worldOps';

export type RelationshipMapMode = 'map' | 'web';

interface Props {
  mode: RelationshipMapMode;
  subject: Character;
  cast: Character[];
  narrow: boolean;
  onSelectCharacter: (id: string) => void;
  /** Focus the outbound editor card for this target (Map mode). */
  onFocusEdge?: (targetId: string) => void;
}

interface NodePos {
  id: string;
  x: number;
  y: number;
  c: Character;
}

function portraitFill(c: Character, size: number): CSSProperties {
  const portrait = characterPortraits(c)[0];
  return {
    ...avatarStyle(c.hue, size, 'rgba(255,255,255,0.22)'),
    ...(portrait
      ? { backgroundImage: `url(${portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : {})
  };
}

function ringPositions(
  people: Character[],
  cx: number,
  cy: number,
  radius: number
): NodePos[] {
  const n = people.length;
  if (n === 0) return [];
  return people.map((c, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return {
      id: c.id,
      c,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    };
  });
}

/** Split a large cast across an inner + outer ring so labels stay readable. */
function dualRingPositions(
  people: Character[],
  cx: number,
  cy: number,
  innerR: number,
  outerR: number
): NodePos[] {
  if (people.length <= 10) return ringPositions(people, cx, cy, outerR);
  const mid = Math.ceil(people.length / 2);
  return [
    ...ringPositions(people.slice(0, mid), cx, cy, outerR),
    ...ringPositions(people.slice(mid), cx, cy, innerR)
  ];
}

function midLabel(x1: number, y1: number, x2: number, y2: number) {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function EdgeLabel({
  x, y, text, muted, compact
}: {
  x: number; y: number; text: string; muted?: boolean; compact?: boolean;
}) {
  const label = text.slice(0, compact ? 10 : 18);
  const charW = compact ? 5.5 : 3.2;
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={x - label.length * charW - 4}
        y={y - 9}
        width={label.length * charW * 2 + 8}
        height={18}
        rx={5}
        fill="rgba(10,12,16,0.88)"
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fill={muted ? 'rgba(236,234,230,0.45)' : 'rgba(236,234,230,0.8)'}
        fontSize={compact ? 10 : 9}
        fontFamily="'IBM Plex Mono', monospace"
        letterSpacing="0.04em"
      >
        {label}
      </text>
    </g>
  );
}

function HtmlNode({
  pos, size, hitPad, selected, onClick, nameBelow
}: {
  pos: NodePos;
  size: number;
  hitPad: number;
  selected?: boolean;
  onClick: () => void;
  nameBelow?: boolean;
}) {
  const box = size + hitPad * 2;
  return (
    <foreignObject
      x={pos.x - box / 2}
      y={pos.y - box / 2}
      width={box}
      height={nameBelow ? box + 16 : box}
      style={{ overflow: 'visible', cursor: 'pointer' }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        title={pos.c.name || 'unnamed'}
        style={{
          width: box,
          height: box,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          WebkitTapHighlightColor: 'transparent'
        }}
      >
        <div style={{
          ...portraitFill(pos.c, size),
          boxSizing: 'border-box',
          outline: selected ? '2px solid oklch(0.85 0.1 62)' : undefined,
          outlineOffset: 2,
          boxShadow: selected ? '0 0 0 4px rgba(224,165,95,0.25)' : undefined
        }} />
      </div>
      {nameBelow && (
        <div style={{
          marginTop: -4,
          textAlign: 'center',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.04em',
          color: 'rgba(236,234,230,0.7)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: box + 20,
          pointerEvents: 'none'
        }}>
          {(pos.c.name || '?').slice(0, 10)}
        </div>
      )}
    </foreignObject>
  );
}

export function RelationshipMap({
  mode, subject, cast, narrow, onSelectCharacter, onFocusEdge
}: Props) {
  const vw = useVw();
  const others = cast.filter((c) => c.id !== subject.id);
  // Phone: fill width, larger faces for fat-finger taps; never exceed the viewport.
  const size = Math.min(narrow ? 340 : 380, Math.max(240, vw - 48));
  const cx = size / 2;
  const cy = size / 2;
  const nodeSize = narrow ? 44 : 40;
  const centerSize = narrow ? 56 : 56;
  const hitPad = narrow ? 10 : 4;
  const showNames = narrow;
  const dense = (mode === 'web' ? cast.length : others.length) > 8;
  const showEdgeLabels = !narrow || !dense;

  if (mode === 'web') {
    const nodes = dualRingPositions(
      cast,
      cx, cy,
      size * (narrow ? 0.26 : 0.28),
      size * (narrow ? 0.38 : 0.4)
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: Array<{
      from: NodePos; to: NodePos; kind: string; key: string;
    }> = [];
    for (const from of cast) {
      for (const rel of from.relationships) {
        const a = byId.get(from.id);
        const b = byId.get(rel.targetId);
        if (!a || !b) continue;
        edges.push({ from: a, to: b, kind: rel.kind || 'linked', key: `${from.id}->${rel.targetId}` });
      }
    }

    return (
      <div className="glass" style={{ borderRadius: 16, padding: narrow ? 8 : 10, overflow: 'hidden' }}>
        <svg
          width="100%"
          viewBox={`0 0 ${size} ${size}`}
          style={{ display: 'block', maxHeight: narrow ? 360 : 400, touchAction: 'manipulation' }}
        >
          <defs>
            <marker id="rel-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="rgba(224,165,95,0.7)" />
            </marker>
          </defs>
          {edges.map((e) => {
            const mid = midLabel(e.from.x, e.from.y, e.to.x, e.to.y);
            return (
              <g key={e.key}>
                <line
                  x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}
                  stroke="rgba(224,165,95,0.45)" strokeWidth={narrow ? 2 : 1.5}
                  markerEnd="url(#rel-arrow)"
                />
                {showEdgeLabels && (
                  <EdgeLabel x={mid.x} y={mid.y} text={e.kind} compact={narrow} />
                )}
              </g>
            );
          })}
          {nodes.map((n) => (
            <HtmlNode
              key={n.id}
              pos={n}
              size={nodeSize}
              hitPad={hitPad}
              selected={n.id === subject.id}
              nameBelow={showNames}
              onClick={() => onSelectCharacter(n.id)}
            />
          ))}
        </svg>
        <div style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.08em',
          textTransform: 'uppercase', opacity: 0.45, textAlign: 'center', paddingTop: 6,
          lineHeight: 1.4
        }}>
          cast web · tap a face · {edges.length} link{edges.length === 1 ? '' : 's'}
          {dense && narrow ? ' · kinds in the list below' : ''}
        </div>
      </div>
    );
  }

  // Selected-centric map
  const ring = dualRingPositions(
    others, cx, cy,
    size * (narrow ? 0.24 : 0.26),
    size * (narrow ? 0.36 : 0.38)
  );
  const byId = new Map(ring.map((n) => [n.id, n]));
  const center: NodePos = { id: subject.id, c: subject, x: cx, y: cy };

  type EdgeDraw = {
    key: string;
    x1: number; y1: number; x2: number; y2: number;
    kind: string;
    dashed: boolean;
    targetId?: string;
  };
  const edges: EdgeDraw[] = [];

  for (const rel of subject.relationships) {
    const to = byId.get(rel.targetId);
    if (!to) continue;
    edges.push({
      key: `out-${rel.targetId}`,
      x1: center.x, y1: center.y, x2: to.x, y2: to.y,
      kind: rel.kind || 'linked',
      dashed: false,
      targetId: rel.targetId
    });
  }
  for (const other of others) {
    for (const rel of other.relationships) {
      if (rel.targetId !== subject.id) continue;
      if (hasLink(subject.relationships, other.id)) continue;
      const from = byId.get(other.id);
      if (!from) continue;
      edges.push({
        key: `in-${other.id}`,
        x1: from.x, y1: from.y, x2: center.x, y2: center.y,
        kind: rel.kind || 'linked',
        dashed: true
      });
    }
  }

  return (
    <div className="glass" style={{ borderRadius: 16, padding: narrow ? 8 : 10, overflow: 'hidden' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block', maxHeight: narrow ? 360 : 400, touchAction: 'manipulation' }}
      >
        <defs>
          <marker id="rel-arrow-map" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(224,165,95,0.75)" />
          </marker>
        </defs>
        {edges.map((e) => {
          const mid = midLabel(e.x1, e.y1, e.x2, e.y2);
          return (
            <g
              key={e.key}
              style={{ cursor: e.targetId && onFocusEdge ? 'pointer' : 'default' }}
              onClick={() => { if (e.targetId) onFocusEdge?.(e.targetId); }}
            >
              <line
                x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                stroke={e.dashed ? 'rgba(160,175,200,0.45)' : 'rgba(224,165,95,0.55)'}
                strokeWidth={e.dashed ? (narrow ? 1.75 : 1.25) : (narrow ? 2.25 : 1.75)}
                strokeDasharray={e.dashed ? '5 4' : undefined}
                markerEnd={e.dashed ? undefined : 'url(#rel-arrow-map)'}
              />
              {e.targetId && (
                <line
                  x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="transparent" strokeWidth={narrow ? 22 : 14}
                />
              )}
              {showEdgeLabels && (
                <EdgeLabel x={mid.x} y={mid.y} text={e.kind} muted={e.dashed} compact={narrow} />
              )}
            </g>
          );
        })}
        <HtmlNode
          pos={center}
          size={centerSize}
          hitPad={hitPad}
          selected
          nameBelow={showNames}
          onClick={() => onSelectCharacter(subject.id)}
        />
        {ring.map((n) => (
          <HtmlNode
            key={n.id}
            pos={n}
            size={nodeSize}
            hitPad={hitPad}
            nameBelow={showNames}
            onClick={() => onSelectCharacter(n.id)}
          />
        ))}
      </svg>
      <div style={{
        fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.08em',
        textTransform: 'uppercase', opacity: 0.45, textAlign: 'center', paddingTop: 6,
        lineHeight: 1.4, paddingLeft: 8, paddingRight: 8
      }}>
        solid = outbound · dashed = inbound only
        {dense && narrow ? ' · tap a face or edit below' : ' · tap edge to edit'}
      </div>
    </div>
  );
}
