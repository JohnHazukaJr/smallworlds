import { describe, expect, it } from 'vitest';
import type { Episode, Season, Turn, World } from '../types';
import { AIError } from './client';
import { enqueuePostTurn, regenerateBeat, waitForPostTurn, writeTurn } from './engine';

const world = {
  id: 'w',
  proseModel: { providerId: 'missing-provider', model: 'none' }
} as World;
const season = { id: 's' } as Season;
const episode = { id: 'e' } as Episode;

/** The summary's timeout must resolve. The reply then fails for its own reason. */
async function expectNotTheSummaryTimeout(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    throw new Error('expected the reply to fail closed');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg).toMatch(/writing model/i);
    expect(msg.toLowerCase()).not.toMatch(/timed out|timeout/);
  }
}

describe('running summary timeout', () => {
  it('does not reject the following reply or rewrite', async () => {
    enqueuePostTurn(async () => {
      throw new AIError('Utility model timed out after 45s.');
    });
    await expectNotTheSummaryTimeout(() => writeTurn({
      world,
      season,
      episode,
      mode: 'play',
      input: 'Hello',
      length: 'beat',
      onDelta: () => {}
    }));

    enqueuePostTurn(async () => {
      throw new AIError('Utility model timed out after 45s.');
    });
    await expectNotTheSummaryTimeout(() => regenerateBeat({
      world,
      season,
      episode,
      turn: { id: 't', role: 'narrator', text: 'Rain.' } as Turn,
      length: 'beat',
      onDelta: () => {}
    }));

    await expect(waitForPostTurn()).resolves.toBeUndefined();
  });
});
