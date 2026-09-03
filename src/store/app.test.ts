import { afterEach, describe, expect, it } from 'vitest';
import { COMPACT_AVATAR_MAX, storyAvatarHeight, useApp } from './app';

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

describe('storyAvatarHeight', () => {
  it('uses the full plate height off compact', () => {
    expect(storyAvatarHeight('S', false)).toBe(56);
    expect(storyAvatarHeight('M', false)).toBe(80);
    expect(storyAvatarHeight('L', false)).toBe(104);
  });

  it('caps height on compact so prose still has room', () => {
    expect(storyAvatarHeight('S', true)).toBe(56);
    expect(storyAvatarHeight('M', true)).toBe(COMPACT_AVATAR_MAX);
    expect(storyAvatarHeight('L', true)).toBe(COMPACT_AVATAR_MAX);
  });
});
