import { describe, expect, it } from 'vitest';
import { syncSide } from './lww';

describe('syncSide', () => {
  it('pulls a remote row that is newer and does not push the older local copy', () => {
    expect(syncSide(10, 20)).toBe('pull');
  });

  it('pushes a local row that is newer than the server', () => {
    expect(syncSide(20, 10)).toBe('push');
  });

  it('leaves equal timestamps alone', () => {
    expect(syncSide(10, 10)).toBe('skip');
  });

  it('pushes a local-only row and pulls a remote-only row', () => {
    expect(syncSide(10, null)).toBe('push');
    expect(syncSide(null, 20)).toBe('pull');
    expect(syncSide(null, null)).toBe('skip');
  });
});
