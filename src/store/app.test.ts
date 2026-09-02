import { afterEach, describe, expect, it } from 'vitest';
import { useApp } from './app';

describe('closeWorldIf', () => {
  afterEach(() => {
    useApp.setState({ currentWorldId: null });
  });

  it('clears the pointer when the deleted id is the open world', () => {
    useApp.setState({ currentWorldId: 'world-a' });
    useApp.getState().closeWorldIf('world-a');
    expect(useApp.getState().currentWorldId).toBeNull();
  });

  it('leaves a different open world selected', () => {
    useApp.setState({ currentWorldId: 'world-a' });
    useApp.getState().closeWorldIf('world-b');
    expect(useApp.getState().currentWorldId).toBe('world-a');
  });

  it('closeWorld always drops the pointer', () => {
    useApp.setState({ currentWorldId: 'world-a' });
    useApp.getState().closeWorld();
    expect(useApp.getState().currentWorldId).toBeNull();
  });
});
