import { describe, expect, it } from 'vitest';
import { runLimited } from './engine';

describe('runLimited', () => {
  it('keeps at most n tasks in flight and returns results in order', async () => {
    let live = 0;
    let peak = 0;
    const out = await runLimited([30, 10, 20, 5, 15], 2, async (ms, i) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, ms));
      live--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('stops starting new work after a failure and rethrows it', async () => {
    const started: number[] = [];
    await expect(runLimited([1, 2, 3, 4], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});
