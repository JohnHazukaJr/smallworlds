import { describe, expect, it } from 'vitest';
import {
  dragProgress,
  leafAngle,
  leafEdge,
  leafMotion,
  leafSettles,
  packPages,
  replyTurn,
  sliceToFit,
  writingLineText
} from './bookPage';

describe('leaf gestures', () => {
  it('commits a drag past the point of no return and lets a short one fall back', () => {
    expect(leafSettles(0.34)).toBe('commit');
    expect(leafSettles(0.8)).toBe('commit');
    expect(leafSettles(-0.5)).toBe('commit');
    expect(leafSettles(0.33)).toBe('cancel');
    expect(leafSettles(0)).toBe('cancel');
  });

  it('starts a turn only from the margin', () => {
    expect(leafEdge(10, 800)).toBe('back');
    expect(leafEdge(790, 800)).toBe('forward');
    expect(leafEdge(120, 800)).toBe(null);
    expect(leafEdge(400, 800)).toBe(null);
    expect(leafEdge(0, 0)).toBe(null);
  });

  it('follows the finger in the direction of the turn', () => {
    expect(dragProgress('forward', -400, 800)).toBeCloseTo(0.5);
    expect(dragProgress('back', 400, 800)).toBeCloseTo(0.5);
    expect(dragProgress('forward', 40, 800)).toBe(0);
    expect(leafAngle('forward', 0.5)).toBeCloseTo(-90);
    expect(leafAngle('back', 1)).toBeCloseTo(0);
    expect(leafAngle('back', 0)).toBeCloseTo(-180);
  });
});

describe('packPages', () => {
  it('keeps pieces together until the page is full', () => {
    expect(packPages([
      { key: 'a', height: 40 },
      { key: 'b', height: 40 },
      { key: 'c', height: 30 }
    ], 100)).toEqual([['a', 'b'], ['c']]);
  });

  it('gives a block taller than the page a page of its own', () => {
    expect(packPages([
      { key: 'a', height: 40 },
      { key: 'tall', height: 240 },
      { key: 'b', height: 40 }
    ], 100)).toEqual([['a'], ['tall'], ['b']]);
  });

  it('returns a single empty page when there is nothing to flow', () => {
    expect(packPages([], 100)).toEqual([[]]);
  });
});

describe('sliceToFit', () => {
  const byLength = (sample: string) => sample.length * 10;

  it('keeps a short block whole', () => {
    expect(sliceToFit('a short line', 200, byLength)).toEqual(['a short line']);
  });

  it('breaks a tall block on words and keeps the words', () => {
    const parts = sliceToFit('one two three four', 80, byLength);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('one two three four');
    for (const part of parts) expect(byLength(part)).toBeLessThanOrEqual(80);
  });

  it('keeps one long token even when it is taller than the page', () => {
    expect(sliceToFit('supercalifragilistic', 20, byLength)).toEqual(['supercalifragilistic']);
  });
});

describe('replyTurn', () => {
  it('turns once onto the next page when a finished reply needs one', () => {
    expect(replyTurn({ followedEnd: true, pagesAtStart: 3, pagesNow: 5 })).toBe(3);
  });

  it('stays put when the reader left the end, or the reply fit', () => {
    expect(replyTurn({ followedEnd: false, pagesAtStart: 3, pagesNow: 5 })).toBeNull();
    expect(replyTurn({ followedEnd: true, pagesAtStart: 3, pagesNow: 3 })).toBeNull();
  });

  it('cuts the leaf when motion is reduced and turns otherwise', () => {
    expect(leafMotion(true)).toBe('cut');
    expect(leafMotion(false)).toBe('animate');
  });
});

describe('writingLineText', () => {
  it('shows Writing… through the quiet gap, then the real phase', () => {
    expect(writingLineText(true, false, '')).toBe('Writing…');
    expect(writingLineText(true, false, '  finishing line… ')).toBe('finishing line…');
  });

  it('steps aside once prose is on the page, and when nothing is generating', () => {
    expect(writingLineText(true, true, 'Writing…')).toBeNull();
    expect(writingLineText(false, false, 'Writing…')).toBeNull();
  });
});
