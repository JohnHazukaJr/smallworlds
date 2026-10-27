/**
 * The thin endpaper at the head of the page. Not a room behind the type.
 * Auto uses a chapter picture, then the place, then only the stain.
 */

export const SCROLL_BACKDROPS = ['auto', 'scene', 'location', 'climate', 'off'] as const;
export type ScrollBackdrop = (typeof SCROLL_BACKDROPS)[number];

export const SCROLL_BACKDROP_LABEL: Record<ScrollBackdrop, string> = {
  auto: 'Auto',
  scene: 'Chapter picture',
  location: 'Place',
  climate: 'Stain',
  off: 'Plain page'
};

export function normalizeScrollBackdrop(raw: unknown): ScrollBackdrop {
  return SCROLL_BACKDROPS.includes(raw as ScrollBackdrop) ? (raw as ScrollBackdrop) : 'auto';
}

export function resolveScrollBackdrop(opts: {
  mode: ScrollBackdrop;
  episodeImage?: string | null;
  locationPortrait?: string | null;
}): { kind: 'image' | 'climate' | 'off'; src?: string } {
  const episode = (opts.episodeImage ?? '').trim();
  const place = (opts.locationPortrait ?? '').trim();
  if (opts.mode === 'off') return { kind: 'off' };
  if (opts.mode === 'climate') return { kind: 'climate' };
  if (opts.mode === 'scene') {
    return episode ? { kind: 'image', src: episode } : { kind: 'climate' };
  }
  if (opts.mode === 'location') {
    return place ? { kind: 'image', src: place } : { kind: 'climate' };
  }
  if (episode) return { kind: 'image', src: episode };
  if (place) return { kind: 'image', src: place };
  return { kind: 'climate' };
}
