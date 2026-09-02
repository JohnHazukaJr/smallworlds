export type ViewportBand = 'compact' | 'regular' | 'wide';

/** iPhone / Fold cover. */
export const COMPACT_MAX = 599;
/** Fold inner / small tablet. Wide (rail) starts at 960. */
export const REGULAR_MAX = 959;
/** Hide tab labels below this width so six items fit on a cover screen. */
export const TAB_LABEL_MIN = 360;
/** Tab bar content height, not including safe-area. */
export const TAB_BAR_HEIGHT = 58;
/** Write-header extras need this much vertical room (Fold 8 inner landscape is ~616). */
export const TALL_CHROME_MIN = 700;
export const KEYBOARD_COVER_PX = 40;

export function bandForWidth(width: number): ViewportBand {
  if (width < 600) return 'compact';
  if (width < 960) return 'regular';
  return 'wide';
}

/** Bottom tabs, no 226px rail. */
export function phoneChrome(band: ViewportBand): boolean {
  return band !== 'wide';
}

/** Cast / Places / Onboard stack the list above the editor. */
export function editorsStacked(band: ViewportBand): boolean {
  return band === 'compact';
}

/** Bottom sheet instead of a right-side panel. */
export function sheetsFromBottom(band: ViewportBand): boolean {
  return band === 'compact';
}

/** Direct / End episode / mood chips overflow — use a More sheet. */
export function shortStoryChrome(band: ViewportBand, height: number): boolean {
  return band === 'compact' || height < TALL_CHROME_MIN;
}

export function tabBarInset(visible: boolean): string {
  return visible ? `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))` : '0px';
}

export function measureViewport(win: {
  innerWidth: number;
  innerHeight: number;
  visualViewport?: { height: number; offsetTop: number } | null;
}): {
  width: number;
  height: number;
  band: ViewportBand;
  keyboardOffset: number;
  keyboardOpen: boolean;
} {
  const width = win.innerWidth;
  const height = win.innerHeight;
  const vv = win.visualViewport;
  const covered = vv ? Math.max(0, height - vv.height - vv.offsetTop) : 0;
  const keyboardOffset = covered > KEYBOARD_COVER_PX ? covered : 0;
  return {
    width,
    height,
    band: bandForWidth(width),
    keyboardOffset,
    keyboardOpen: keyboardOffset > 0
  };
}
