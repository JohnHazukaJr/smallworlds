import {
  useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type PointerEvent as ReactPointerEvent
} from 'react';
import {
  dragProgress, flickSettles, heldOpenPiece, leafAngle, leafEdge, leafMotion, leafShadow,
  packPages, pageHolding, pageTurnPending, readingEnd, rememberOpenPiece, replyTurn, sliceToFit
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
  /** Pages whose measured copy is taller than the sheet. */
  scroll: number[];
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
  const sliceHostRef = useRef<HTMLDivElement>(null);
  const leafRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pageRef = useRef(0);
  const countRef = useRef(1);
  const laidCount = useRef(0);
  const episodeRef = useRef<string | null>(null);
  const shortArmed = useRef<string | null>(null);
  const lastReveal = useRef(reveal);
  const streamingRef = useRef(false);
  const armCount = useRef<number | null>(null);
  const pendingPage = useRef<number | null>(null);
  const animGen = useRef(0);
  const endRef = useRef(0);
  const dragRef = useRef<{
    edge: 'back' | 'forward';
    startX: number;
    startY: number;
    width: number;
    pointerId: number;
    horizontal: boolean;
  } | null>(null);

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [laid, setLaid] = useState<Laid>({ pages: [[]], slices: {}, scroll: [] });
  const laidRef = useRef(laid);
  laidRef.current = laid;
  const [page, setPage] = useState(0);
  const [leaf, setLeaf] = useState<Leaf | null>(null);
  const [scrollFlow, setScrollFlow] = useState(false);
  pageRef.current = page;

  const storyKey = (key: string) => {
    const piece = piecesRef.current.find((item) => item.key === baseKey(key));
    return !!piece?.text;
  };

  const openPieceKey = () => {
    const keys = laidRef.current.pages[pageRef.current] ?? [];
    const key = keys.find((item) => storyKey(item)) ?? keys[0];
    return key ? baseKey(key) : null;
  };

  useLayoutEffect(() => {
    return () => {
      rememberOpenPiece(episodeId, follow.current ? null : openPieceKey());
    };
  }, [episodeId]);

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
    if (!host || !probe || limit < 80 || width < 80) {
      const keys = piecesRef.current.map((piece) => piece.key);
      countRef.current = 1;
      endRef.current = 0;
      setScrollFlow(true);
      setLaid((current) => {
        const row = current.pages[0] ?? [];
        const same = current.pages.length === 1
          && row.length === keys.length
          && row.every((key, index) => key === keys[index])
          && Object.keys(current.slices).length === 0
          && current.scroll.length === 0;
        return same ? current : { pages: [keys], slices: {}, scroll: [] };
      });
      if (!pageTurnPending(pendingPage.current) && shortArmed.current !== episodeId) {
        shortArmed.current = episodeId;
        follow.current = heldOpenPiece(episodeId) == null;
        pendingPage.current = null;
        setLeaf(null);
        setPage(0);
      }
      return;
    }
    setScrollFlow(false);
    host.style.width = `${width}px`;
    probe.style.width = `${width}px`;
    probe.style.fontSize = `${fontPx}px`;
    const sliceHost = sliceHostRef.current;
    if (sliceHost) sliceHost.style.width = `${width}px`;

    const measurePlain = (sample: string) => {
      probe.textContent = sample;
      return probe.offsetHeight + 8;
    };
    const measureSlice = (node: HTMLElement, sample: string) => {
      if (!sliceHost) return measurePlain(sample);
      sliceHost.replaceChildren();
      const clone = node.cloneNode(true) as HTMLElement;
      sliceHost.appendChild(clone);
      const copies = clone.querySelectorAll<HTMLElement>('[data-book-copy]');
      if (copies.length === 0) {
        const prose = clone.querySelector('p');
        if (prose) prose.textContent = sample;
      } else {
        copies.forEach((copy, index) => {
          if (index === 0) {
            copy.textContent = sample;
            return;
          }
          const para = copy.closest('p');
          if (para instanceof HTMLElement) para.style.display = 'none';
        });
      }
      return Math.max(clone.offsetHeight, 1);
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
      const measure = (sample: string) => measureSlice(node, sample);
      const parts = sliceToFit(piece.text, limit, measure);
      if (parts.length <= 1) {
        flat.push({ key, height: Math.max(height, measure(parts[0] ?? piece.text), 1) });
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
    const end = readingEnd(pages, storyKey);
    const heightOf = new Map(flat.map((item) => [item.key, item.height]));
    const scroll: number[] = [];
    pages.forEach((keys, index) => {
      const used = keys.reduce((sum, key) => sum + (heightOf.get(key) ?? 0), 0);
      if (used > limit + 1) scroll.push(index);
    });
    countRef.current = count;
    endRef.current = end;
    setLaid({ pages, slices, scroll });
    if (pageTurnPending(pendingPage.current)) {
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
      const held = heldOpenPiece(episodeId);
      const restored = held ? pageHolding(pages, held) : -1;
      const land = restored >= 0 ? restored : end;
      follow.current = land === end;
      if (follow.current) rememberOpenPiece(episodeId, null);
      pendingPage.current = null;
      armCount.current = streaming ? count : null;
      streamingRef.current = streaming;
      setLeaf(null);
      setPage(land);
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
        const land = dest;
        follow.current = land === end;
        if (leafMotion(reduced) === 'cut' || land === pageRef.current) {
          pendingPage.current = null;
          setLeaf(null);
          setPage(land);
          return;
        }
        const from = Math.max(0, land - 1);
        pendingPage.current = land;
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

    const parked = armCount.current;
    if (
      streaming
      && follow.current
      && parked != null
      && count > parked
      && !pageTurnPending(pendingPage.current)
    ) {
      const land = Math.min(count - 1, parked);
      follow.current = land === end;
      if (pageRef.current !== land) {
        pendingPage.current = null;
        setLeaf(null);
        setPage(land);
      }
    }
  }, [box.w, box.h, signature, fontPx, episodeId, reveal, reduced, streaming]);

  const commitTurn = () => {
    const dest = pendingPage.current;
    pendingPage.current = null;
    if (dest == null) {
      setLeaf(null);
      return;
    }
    const next = Math.max(0, Math.min(countRef.current - 1, dest));
    follow.current = next === endRef.current;
    if (follow.current && episodeRef.current) rememberOpenPiece(episodeRef.current, null);
    setLeaf(null);
    setPage(next);
  };
  const commitRef = useRef(commitTurn);
  commitRef.current = commitTurn;

  useEffect(() => {
    const leafEl = leafRef.current;
    if (!leafEl || !leaf?.animate) return;
    const onEnd = (event: TransitionEvent) => {
      if (event.propertyName !== 'transform') return;
      commitRef.current();
    };
    leafEl.addEventListener('transitionend', onEnd);
    return () => leafEl.removeEventListener('transitionend', onEnd);
  }, [leaf]);

  const columnPin = useRef(0);
  useLayoutEffect(() => {
    if (!scrollFlow || !follow.current) return;
    const prose = sheetRef.current?.querySelector('.book-prose.is-scroll');
    if (!(prose instanceof HTMLElement)) return;
    columnPin.current += 1;
    prose.scrollTop = prose.scrollHeight;
    const release = () => {
      columnPin.current = Math.max(0, columnPin.current - 1);
      if (columnPin.current > 0) return;
      const gap = prose.scrollHeight - prose.scrollTop - prose.clientHeight;
      follow.current = gap < 48;
    };
    let settled = false;
    const frame = requestAnimationFrame(() => {
      settled = true;
      release();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (!settled) release();
    };
  }, [scrollFlow, laid, signature]);

  useEffect(() => {
    if (!scrollFlow) return;
    const prose = sheetRef.current?.querySelector('.book-prose.is-scroll');
    if (!(prose instanceof HTMLElement)) return;
    const onScroll = () => {
      const gap = prose.scrollHeight - prose.scrollTop - prose.clientHeight;
      if (columnPin.current > 0) {
        if (gap >= 48) follow.current = false;
        return;
      }
      follow.current = gap < 48;
    };
    prose.addEventListener('scroll', onScroll, { passive: true });
    return () => prose.removeEventListener('scroll', onScroll);
  }, [scrollFlow, laid, signature]);

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
  const endIndex = readingEnd(laid.pages, (key) => !!pieceMap.get(baseKey(key))?.text);

  const renderKeys = (keys: string[]) => keys.map((key) => {
    const slice = laid.slices[key];
    const piece = pieceMap.get(slice === undefined ? key : baseKey(key));
    if (!piece) return null;
    const body = slice !== undefined && piece.renderSlice ? piece.renderSlice(slice) : piece.node;
    return <div key={key}>{body}</div>;
  });

  const pageScrolls = (index: number) => scrollFlow || laid.scroll.includes(index);
  const pageBody = (index: number, showTail: boolean) => (
    <div className={`book-prose${pageScrolls(index) ? ' is-scroll' : ''}`}>
      {renderKeys(laid.pages[index] ?? [])}
      {showTail && (index === count - 1 || index === endIndex) ? tail : null}
    </div>
  );

  const go = (dest: number, dir: 'forward' | 'back', from = 0) => {
    if (pageTurnPending(pendingPage.current)) return;
    const countNow = countRef.current;
    const next = Math.max(0, Math.min(countNow - 1, dest));
    if (next === pageRef.current && !leaf) return;
    const settleFollow = () => {
      follow.current = next === endRef.current;
      if (follow.current) rememberOpenPiece(episodeId, null);
    };
    if (leafMotion(reduced) === 'cut' || from >= 1) {
      settleFollow();
      pendingPage.current = null;
      setLeaf(null);
      setPage(next);
      return;
    }
    pendingPage.current = next;
    const gen = ++animGen.current;
    const start = from > 0 ? from : 0;
    setLeaf({ dir, progress: start, animate: false });
    window.setTimeout(() => {
      if (animGen.current !== gen) return;
      commitRef.current();
    }, TURN_MS + 120);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (animGen.current !== gen) return;
        setLeaf({ dir, progress: 1, animate: true });
      });
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pageTurnPending(pendingPage.current) || leaf?.animate) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, textarea, input, select')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = leafEdge(event.clientX - rect.left, rect.width);
    if (!edge) return;
    if (edge === 'back' && safePage <= 0) return;
    if (edge === 'forward' && safePage >= count - 1) return;
    dragRef.current = {
      edge,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      pointerId: event.pointerId,
      horizontal: false
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.horizontal) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        dragRef.current = null;
        return;
      }
      if (!(Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy))) return;
      drag.horizontal = true;
      try {
        event.currentTarget.setPointerCapture(drag.pointerId);
      } catch {
        // The release still carries the finger's last position.
      }
    }
    setLeaf({
      dir: drag.edge,
      progress: dragProgress(drag.edge, dx, drag.width),
      animate: false
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.horizontal) return;
    const dx = event.clientX - drag.startX;
    const dest = drag.edge === 'forward' ? pageRef.current + 1 : pageRef.current - 1;
    if (flickSettles(drag.edge, dx, drag.width, true) === 'commit') {
      go(dest, drag.edge, dragProgress(drag.edge, dx, drag.width));
      return;
    }
    pendingPage.current = null;
    setLeaf(null);
  };

  const angle = leaf ? leafAngle(leaf.dir, leaf.progress) : 0;
  const shadow = leaf ? leafShadow(leaf.progress) : 0;

  return (
    <div className="book-stage" data-book-stage>
      <div
        ref={sheetRef}
        className={`book-sheet${turning ? ' is-turning' : ''}${scrollFlow ? ' is-scroll' : ''}${!scrollFlow && pageScrolls(safePage) ? ' is-page-scroll' : ''}`}
        onPointerDown={scrollFlow ? undefined : onPointerDown}
        onPointerMove={scrollFlow ? undefined : onPointerMove}
        onPointerUp={scrollFlow ? undefined : onPointerUp}
        onPointerCancel={scrollFlow ? undefined : onPointerUp}
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
          <div className="book-face book-face-back" aria-hidden>
            {pageBody(underIndex, false)}
          </div>
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
        <div ref={sliceHostRef} className="book-slice-host" />
      </div>
    </div>
  );
}
