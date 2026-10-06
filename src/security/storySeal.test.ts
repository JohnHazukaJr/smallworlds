import { describe, expect, it } from 'vitest';
import { generateAesKey } from './crypto';
import { isSealedRecord, openRecord, sealRecord } from './storySeal';

describe('story seal', () => {
  it('keeps index columns and hides the rest', async () => {
    const { key } = await generateAesKey();
    const row = {
      id: 'w1',
      worldId: 'w1',
      seasonId: 's1',
      episodeId: 'e1',
      updatedAt: 5,
      createdAt: 1,
      number: 2,
      storyDay: 3,
      title: 'Harbor',
      prose: 'a secret sentence'
    };
    const sealed = await sealRecord(row, key);
    expect(sealed.id).toBe('w1');
    expect(sealed.worldId).toBe('w1');
    expect(sealed.seasonId).toBe('s1');
    expect(sealed.episodeId).toBe('e1');
    expect(sealed.updatedAt).toBe(5);
    expect(sealed.createdAt).toBe(1);
    expect(sealed.number).toBe(2);
    expect(sealed.storyDay).toBe(3);
    expect(sealed.title).toBeUndefined();
    expect(JSON.stringify(sealed)).not.toContain('Harbor');
    expect(JSON.stringify(sealed)).not.toContain('a secret sentence');
    expect(isSealedRecord(sealed)).toBe(true);

    const opened = await openRecord(sealed, key);
    expect(opened.title).toBe('Harbor');
    expect(opened.prose).toBe('a secret sentence');
    expect(opened.id).toBe('w1');
    expect(opened.number).toBe(2);
  });

  it('rejects tampered ciphertext', async () => {
    const { key } = await generateAesKey();
    const sealed = await sealRecord({ id: 'w1', title: 'Harbor' }, key);
    const ct = sealed._seal as { iv: string; ct: string };
    ct.ct = `${ct.ct.slice(0, -4)}AAAA`;
    await expect(openRecord(sealed, key)).rejects.toBeTruthy();
  });
});
