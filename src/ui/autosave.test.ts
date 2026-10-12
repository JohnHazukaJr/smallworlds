import { describe, expect, it } from 'vitest';
import { shouldFlushAutosave } from './autosave';

describe('shouldFlushAutosave', () => {
  it('does not put a row that was just removed', () => {
    expect(shouldFlushAutosave('cast-1', new Set(['cast-1']), true)).toBe(false);
  });

  it('does not put a row that is already gone', () => {
    expect(shouldFlushAutosave('cast-1', new Set(), false)).toBe(false);
  });

  it('puts a live row that is still being edited', () => {
    expect(shouldFlushAutosave('cast-1', new Set(), true)).toBe(true);
  });
});
