import {
  useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type PointerEvent as ReactPointerEvent
} from 'react';
import {
  dragProgress, leafAngle, leafEdge, leafMotion, leafSettles, leafShadow, packPages, replyTurn, sliceToFit
} from './bookPage';

export type BookPiece = {
  key: string;
  node: ReactNode;
  /** Plain text, set when this piece may break across pages. */
  text?: string;
  renderSlice?: (slice: string) => ReactNode;
};

const PAD = { top: 26, right: 28, bottom: 32, left: 36 };
const TURN_MS = 680;

type Leaf = {
  dir: 'forward' | 'back';
  progress: number;
  animate: boolean;
};

type Laid = {
  pages: string[][];
  slices: Record<string, string>;
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return reduced;
}

function baseKey(key: string): string {
  const mark = key.lastIndexOf('::');
  return mark === -1 ? key : key.slice(0, mark);
}

/**
 * One paper page. The leaf turns on the left spine and follows the finger.
 * Reduced motion cuts straight to the destination page.
 */
export function BookStage({
  episodeId, reveal, streaming, fontPx, signature, pieces, tail
}: {
  episodeId: string;
  /** Bumps when a reply finishes cleanly. One forward turn if the reader is at the end. */
  reveal: number;
  /** True from the moment a reply starts until it settles. */
  streaming: boolean;
  fontPx: number;
  signature: string;
  pieces: BookPiece[];
  tail?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;
  const sheetRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const leafRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pageRef = useRef(0);
  const countRef = useRef(1);
  const laidCount = useRef(0);
  const episodeRef = useRef<string | null>(null);
  const lastReveal = useRef(reveal);
  const streamingRef = useRef(false);
  const armCount = useRef<number | null>(null);
  const pendingPage = useRef<number | null>(null);
  const animGen = useRef(0);
  const dragRef = useRef<{
    edge: 'back' | 'forward';
    startX: number;
    width: number;
    moved: boolean;
  } | null>(null);

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [laid, setLaid] = useState<Laid>({ pages: [[]], slices: {} });
  const [page, setPage] = useState(0);
  const [leaf, setLeaf] = useState<Leaf | null>(null);
  pageRef.current = page;

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const apply = () => setBox({ w: sheet.clientWidth, h: sheet.clientHeight });
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = measureRef.current;
    const probe = probeRef.current;
    const limit = box.h - PAD.top - PAD.bottom;
    const width = box.w - PAD.left - PAD.right;
    if (!host || !probe || limit < 80 || width < 80) return;
    host.style.width = `${width}px`;
    probe.style.width = `${width}px`;
    probe.style.fontSize = `${fontPx}px`;

    const measure = (sample: string) => {
      probe.textContent = sample;
      return probe.offsetHeight + 8;
    };

    const flat: { key: string; height: number }[] = [];
    const slices: Record<string, string> = {};
    const nodes = host.querySelectorAll<HTMLElement>('[data-book-piece]');
    nodes.forEach((node) => {
      const key = node.dataset.bookPiece;
      if (!key) return;
      const piece = piecesRef.current.find((item) => item.key === key);
      const height = node.offsetHeight;
      if (!piece?.text || !piece.renderSlice || height <= limit) {
        flat.push({ key, height: Math.max(height, 1) });
        return;
      }
      const parts = sliceToFit(piece.text, limit, measure);
      if (parts.length <= 1) {
        flat.push({ key, height: Math.max(height, 1) });
        return;
      }
      parts.forEach((part, index) => {
        const sliceKey = `${key}::${index}`;
        slices[sliceKey] = part;
        flat.push({ key: sliceKey, height: Math.max(measure(part), 1) });
      });
    });

    const pages = packPages(flat, limit);
    const count = Math.max(1, pages.length);
    countRef.current = count;
    setLaid({ pages, slices });
    if (pendingPage.current) {
      laidCount.current = count;
      return;
    }

    const episodeChanged = episodeRef.current !== episodeId;
    const revealChanged = lastReveal.current !== reveal;
    episodeRef.current = episodeId;
    if (revealChanged) lastReveal.current = reveal;
    const before = laidCount.current;
    laidCount.current = count;

    const streamingStarted = streaming && !streamingRef.current;
    if (episodeChanged || before === 0) {
      follow.current = true;
      pendingPage.current = null;
      armCount.current = streaming ? count : null;
      streamingRef.current = streaming;
      setLeaf(null);
      setPage(count - 1);
      return;
    }
    if (streamingStarted) armCount.current = before > 0 ? before : count;
    streamingRef.current = streaming;

    if (revealChanged) {
      const dest = replyTurn({
        followedEnd: follow.current,
        pagesAtStart: armCount.current ?? count,
        pagesNow: count
      });
      armCount.current = null;
      if (dest != null) {
        const from = Math.max(0, dest - 1);
        if (leafMotion(reduced) === 'cut') {
          follow.current = dest >= count - 1;
          setLeaf(null);
          setPage(dest);
          return;
        }
        pendingPage.current = dest;
        setPage(from);
        setLeaf({ dir: 'forward', progress: 0, animate: false });
        const gen = ++animGen.current;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (animGen.current !== gen) return;
            setLeaf({ dir: 'forward', progress: 1, animate: true });
          });
        });
        return;
      }
    }
    if (!streaming) armCount.current = null;

    if (follow.current && !pendingPage.current) setPage(count - 1);
  }, [box.w, box.h, signature, fontPx, episodeId, reveal, reduced, streaming]);

  useEffect(() => {
    const leafEl = leafRef.current;
    if (!leafEl || !leaf?.animate) return;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      const dest = pendingPage.current;
      pendingPage.current = null;
      setLeaf(null);
      if (dest == null) return;
      const count = countRef.current;
      const next = Math.max(0, Math.min(count - 1, dest));
      follow.current = next >= count - 1;
      setPage(next);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.propertyName !== 'transform') return;
      done();
    };
    leafEl.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(done, TURN_MS + 80);
    return () => {
      leafEl.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  }, [leaf]);

  const count = Math.max(1, laid.pages.length);
  const safePage = Math.max(0, Math.min(count - 1, page));
  const turning = leaf != null && leaf.progress > 0;
  const underIndex = leaf?.dir === 'back'
    ? safePage
    : Math.min(count - 1, safePage + 1);
  const frontIndex = leaf?.dir === 'back'
    ? Math.max(0, safePage - 1)
    : safePage;

  const pieceMap = new Map(pieces.map((piece) => [piece.key, piece]));

  const renderKeys = (keys: string[]) => keys.map((key) => {
    const slice = laid.slices[key];
    const piece = pieceMap.get(slice === undefined ? key : baseKey(key));
    if (!piece) return null;
    const body = slice !== undefined && piece.renderSlice ? piece.renderSlice(slice) : piece.node;
    return <div key={key}>{body}</div>;
  });

  const pageBody = (index: number, showTail: boolean) => (
    <div className="book-prose">
      {renderKeys(laid.pages[index] ?? [])}
      {showTail && index === count - 1 ? tail : null}
    </div>
  );

  const go = (dest: number, dir: 'forward' | 'back') => {
    const countNow = countRef.current;
    const next = Math.max(0, Math.min(countNow - 1, dest));
    if (next === pageRef.current && !leaf) return;
    if (leafMotion(reduced) === 'cut') {
      follow.current = next >= countNow - 1;
      pendingPage.current = null;
      setLeaf(null);
      setPage(next);
      return;
    }
    pendingPage.current = next;
    const gen = ++animGen.current;
    setLeaf((current) => {
      if (current && current.dir === dir && current.progress > 0) {
        return { dir, progress: 1, animate: true };
      }
      return { dir, progress: 0, animate: false };
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (animGen.current !== gen) return;
        setLeaf({ dir, progress: 1, animate: true });
      });
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (leaf?.animate) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, textarea, input, select')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = leafEdge(event.clientX - rect.left, rect.width);
    if (!edge) return;
    if (edge === 'back' && safePage <= 0) return;
    if (edge === 'forward' && safePage >= count - 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { edge, startX: event.clientX, width: rect.width, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    if (Math.abs(dx) > 8) drag.moved = true;
    setLeaf({
      dir: drag.edge,
      progress: dragProgress(drag.edge, dx, drag.width),
      animate: false
    });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const current = leaf;
    const progress = current && current.dir === drag.edge ? current.progress : 0;
    const dest = drag.edge === 'forward' ? pageRef.current + 1 : pageRef.current - 1;
    if (!drag.moved || leafSettles(progress) === 'commit') {
      go(dest, drag.edge);
      return;
    }
    pendingPage.current = null;
    if (leafMotion(reduced) === 'cut') {
      setLeaf(null);
      return;
    }
    setLeaf({ dir: drag.edge, progress: 0, animate: true });
  };

  const angle = leaf ? leafAngle(leaf.dir, leaf.progress) : 0;
  const shadow = leaf ? leafShadow(leaf.progress) : 0;

  return (
    <div className="book-stage" data-book-stage>
      <div
        ref={sheetRef}
        className={`book-sheet${turning ? ' is-turning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {underIndex !== frontIndex && (
          <div className="book-under">
            {pageBody(underIndex, true)}
          </div>
        )}
        <div
          className="book-cast"
          style={{ opacity: shadow }}
          aria-hidden
        />
        <div
          ref={leafRef}
          className={`book-leaf${leaf?.animate ? ' is-animating' : ''}`}
          style={{ transform: `rotateY(${angle}deg)` }}
        >
          <div className="book-face book-face-front">
            {pageBody(frontIndex, underIndex === frontIndex)}
          </div>
          <div className="book-face book-face-back" aria-hidden />
        </div>
        <div className="book-spine" aria-hidden />
      </div>
      <div className="book-folio serif">
        <button
          type="button"
          className="book-turn"
          aria-label="Previous page"
          disabled={safePage <= 0}
          onClick={() => go(safePage - 1, 'back')}
        >
          Previous
        </button>
        <span aria-live="polite">{safePage + 1} / {count}</span>
        <button
          type="button"
          className="book-turn"
          aria-label="Next page"
          disabled={safePage >= count - 1}
          onClick={() => go(safePage + 1, 'forward')}
        >
          Next
        </button>
      </div>
      <div ref={measureRef} className="book-measure" aria-hidden>
        {pieces.map((piece) => (
          <div key={piece.key} data-book-piece={piece.key}>{piece.node}</div>
        ))}
        <div ref={probeRef} className="book-probe serif" />
      </div>
    </div>
  );
}
