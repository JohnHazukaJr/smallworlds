import { describe, expect, it } from 'vitest';
import { createLimiter, runLimited } from './engine';

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

describe('createLimiter', () => {
  it('shares n slots across separate callers and keeps going after a failure', async () => {
    const slot = createLimiter(2);
    let live = 0;
    let peak = 0;
    const job = (ms: number, fail = false) => slot(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, ms));
      live--;
      if (fail) throw new Error('boom');
      return ms;
    });
    const a = job(20);
    const b = job(5, true).catch(() => 'failed');
    const c = Promise.all([job(10), job(15)]);
    expect(await Promise.all([a, b, c])).toEqual([20, 'failed', [10, 15]]);
    expect(peak).toBe(2);
  });
});
