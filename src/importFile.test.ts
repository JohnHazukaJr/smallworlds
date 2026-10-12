import { describe, expect, it } from 'vitest';
import { replaceImportMessage, worldIdsInImport } from './importFile';

describe('worldIdsInImport', () => {
  it('reads ids from a world, a backup, and a device bundle', () => {
    expect(worldIdsInImport({ format: 'small-worlds-world', world: { id: 'w1' } })).toEqual(['w1']);
    expect(worldIdsInImport({
      format: 'small-worlds-backup',
      worlds: [{ world: { id: 'a' } }, { world: { id: 'b' } }]
    })).toEqual(['a', 'b']);
    expect(worldIdsInImport({
      format: 'small-worlds-device',
      worlds: [{ world: { id: 'd' } }]
    })).toEqual(['d']);
    expect(worldIdsInImport({ format: 'other' })).toEqual([]);
  });
});

describe('replaceImportMessage', () => {
  it('stays quiet when nothing already exists', () => {
    expect(replaceImportMessage([])).toBeNull();
  });

  it('names the world that would be replaced', () => {
    expect(replaceImportMessage(['Harbor'])).toContain('Harbor');
    expect(replaceImportMessage(['Harbor', 'Mill'])).toContain('Harbor');
    expect(replaceImportMessage(['Harbor', 'Mill'])).toContain('Mill');
  });
});
