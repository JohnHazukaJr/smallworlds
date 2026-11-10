/** A turn a chapter picture can sit beside. */
export type PictureAnchorTurn = {
  id: string;
  episodeId: string;
  createdAt: number;
};

export type PlacedChapterPictures<T> = {
  /** Pictures before the first visible turn. Empty while earlier turns are hidden. */
  leading: T[];
  /** Pictures to paint immediately before this visible turn. */
  before: Map<string, T[]>;
  /** Pictures to paint immediately after this visible turn. */
  after: Map<string, T[]>;
};

function pushAt<T>(map: Map<string, T[]>, key: string, item: T) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/**
 * Slot each chapter picture after the latest line of its chapter that was
 * already written, then keep only the pictures whose line is still on the page.
 * The window counts turns. A picture does not take a slot of its own.
 */
export function placeChapterPictures<T extends { id: string; createdAt: number }>(opts: {
  turns: readonly PictureAnchorTurn[];
  episodeOrder: readonly string[];
  pictures: readonly { episodeId: string; picture: T }[];
  windowSize: number;
}): PlacedChapterPictures<T> {
  const turns = opts.turns;
  const windowSize = Math.max(0, opts.windowSize);
  const hiddenCount = Math.max(0, turns.length - windowSize);
  const visible = turns.slice(hiddenCount);
  const visibleIds = new Set(visible.map((turn) => turn.id));
  const firstVisibleId = visible[0]?.id ?? null;

  const byEpisode = new Map<string, PictureAnchorTurn[]>();
  for (const turn of turns) {
    const list = byEpisode.get(turn.episodeId);
    if (list) list.push(turn);
    else byEpisode.set(turn.episodeId, [turn]);
  }

  const order = opts.episodeOrder.length > 0
    ? opts.episodeOrder
    : [...new Set(turns.map((turn) => turn.episodeId))];
  const rank = new Map(order.map((id, index) => [id, index]));

  const pictures = [...opts.pictures].sort((a, b) => {
    const ao = rank.get(a.episodeId) ?? order.length;
    const bo = rank.get(b.episodeId) ?? order.length;
    if (ao !== bo) return ao - bo;
    return a.picture.createdAt - b.picture.createdAt || (a.picture.id < b.picture.id ? -1 : a.picture.id > b.picture.id ? 1 : 0);
  });

  const leading: T[] = [];
  const before = new Map<string, T[]>();
  const after = new Map<string, T[]>();

  const slotOf = (episodeId: string, createdAt: number):
    | { kind: 'leading' }
    | { kind: 'before'; turnId: string }
    | { kind: 'after'; turnId: string } => {
    const episodeTurns = byEpisode.get(episodeId) ?? [];
    let anchor: PictureAnchorTurn | null = null;
    for (const turn of episodeTurns) {
      if (turn.createdAt <= createdAt) anchor = turn;
    }
    if (anchor) return { kind: 'after', turnId: anchor.id };
    if (episodeTurns[0]) return { kind: 'before', turnId: episodeTurns[0].id };

    const index = rank.get(episodeId) ?? order.length;
    for (let i = index - 1; i >= 0; i--) {
      const prior = byEpisode.get(order[i]);
      const last = prior?.[prior.length - 1];
      if (last) return { kind: 'after', turnId: last.id };
    }
    return { kind: 'leading' };
  };

  for (const item of pictures) {
    const slot = slotOf(item.episodeId, item.picture.createdAt);
    if (slot.kind === 'after') {
      if (visibleIds.has(slot.turnId)) pushAt(after, slot.turnId, item.picture);
      continue;
    }
    if (slot.kind === 'leading') {
      if (hiddenCount === 0) leading.push(item.picture);
      continue;
    }
    if (!visibleIds.has(slot.turnId)) continue;
    if (slot.turnId === firstVisibleId) {
      if (hiddenCount === 0) leading.push(item.picture);
      continue;
    }
    pushAt(before, slot.turnId, item.picture);
  }

  return { leading, before, after };
}
