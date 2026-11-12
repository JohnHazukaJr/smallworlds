import { afterEach, describe, expect, it } from 'vitest';
import { storyAvatarHeight, useApp } from './app';

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

  it('opening a new world drops the previous one', () => {
    useApp.setState({ currentWorldId: 'world-a', screen: 'story' });
    useApp.getState().go('onboard');
    expect(useApp.getState().screen).toBe('onboard');
    expect(useApp.getState().currentWorldId).toBeNull();
  });
});

describe('storyAvatarHeight', () => {
  it('uses the chosen plate height on every screen', () => {
    expect(storyAvatarHeight(56)).toBe(56);
    expect(storyAvatarHeight(80)).toBe(80);
    expect(storyAvatarHeight(144)).toBe(144);
  });

  it('maps legacy S/M/L and clamps anything else onto the slider', () => {
    expect(storyAvatarHeight('S')).toBe(56);
    expect(storyAvatarHeight('M')).toBe(80);
    expect(storyAvatarHeight('L')).toBe(104);
    expect(storyAvatarHeight(20)).toBe(56);
    expect(storyAvatarHeight(400)).toBe(144);
    expect(storyAvatarHeight('nope')).toBe(80);
  });
});
