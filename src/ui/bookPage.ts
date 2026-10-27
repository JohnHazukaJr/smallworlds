/** Drag past this fraction of the page width and the leaf finishes the turn. */
export const LEAF_COMMIT = 0.34;
/** Margin, in pixels, that starts a turn. The type stays free to tap and select. */
export const LEAF_GUTTER = 48;

export function leafSettles(progress: number): 'commit' | 'cancel' {
  return Math.abs(progress) >= LEAF_COMMIT ? 'commit' : 'cancel';
}

export function leafEdge(x: number, width: number): 'back' | 'forward' | null {
  if (!(width > 0)) return null;
  const gutter = Math.min(LEAF_GUTTER, width * 0.18);
  if (x <= gutter) return 'back';
  if (x >= width - gutter) return 'forward';
  return null;
}

/** 0 is flat. Forward closes toward -180. Back opens from -180 toward flat. */
export function leafAngle(dir: 'forward' | 'back', progress: number): number {
  const p = clamp01(progress);
  if (dir === 'forward') return -180 * p;
  return -180 + 180 * p;
}

/** Reduced motion cuts straight to the page. Otherwise the leaf turns. */
export function leafMotion(reducedMotion: boolean): 'animate' | 'cut' {
  return reducedMotion ? 'cut' : 'animate';
}

/**
 * Destination page after a reply that finished cleanly.
 * Null when the reader left the end, or the reply fit on the pages already open.
 * The index is the first new page, so the leaf turns once.
 */
export function replyTurn(opts: {
  followedEnd: boolean;
  pagesAtStart: number;
  pagesNow: number;
}): number | null {
  if (!opts.followedEnd) return null;
  if (!(opts.pagesNow > opts.pagesAtStart) || opts.pagesAtStart < 1) return null;
  return Math.min(opts.pagesNow - 1, opts.pagesAtStart);
}

/** Shade across the page underneath, strongest when the leaf is halfway. */
export function leafShadow(progress: number): number {
  const p = clamp01(progress);
  return Math.sin(p * Math.PI) * 0.5;
}

export function dragProgress(edge: 'back' | 'forward', dx: number, width: number): number {
  if (!(width > 0)) return 0;
  if (edge === 'forward') return clamp01(-dx / width);
  return clamp01(dx / width);
}

export type FlowPiece = { key: string; height: number };

/** Pack measured pieces onto pages. A piece taller than the page sits alone. */
export function packPages(pieces: FlowPiece[], pageHeight: number): string[][] {
  const limit = Math.max(1, pageHeight);
  const pages: string[][] = [];
  let current: string[] = [];
  let used = 0;
  const flush = () => {
    if (!current.length) return;
    pages.push(current);
    current = [];
    used = 0;
  };
  for (const piece of pieces) {
    const height = Math.max(0, piece.height);
    if (current.length && used + height > limit) flush();
    current.push(piece.key);
    used += height;
    if (height > limit) flush();
  }
  flush();
  return pages.length ? pages : [[]];
}

/**
 * Break text on whitespace so each slice measures within the page.
 * A single token taller than the page is kept whole.
 */
export function sliceToFit(
  text: string,
  pageHeight: number,
  measure: (sample: string) => number
): string[] {
  if (!text) return [];
  if (!(pageHeight > 0) || measure(text) <= pageHeight) return [text];
  const parts = text.split(/(\s+)/);
  const slices: string[] = [];
  let current = '';
  const push = (value: string) => {
    if (value) slices.push(value);
  };
  for (const part of parts) {
    if (!part) continue;
    if (!current) {
      current = part;
      continue;
    }
    const next = current + part;
    if (measure(next) <= pageHeight) {
      current = next;
      continue;
    }
    push(current);
    current = /^\s+$/.test(part) ? '' : part.replace(/^\s+/, '');
  }
  push(current);
  return slices.length ? slices : [text];
}

/** The quiet line on the page. Hidden once words are actually arriving. */
export function writingLineText(active: boolean, hasProse: boolean, label: string): string | null {
  if (!active || hasProse) return null;
  const text = label.trim();
  return text || 'Writing…';
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
