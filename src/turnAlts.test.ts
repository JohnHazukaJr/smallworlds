import { describe, expect, it } from 'vitest';
import type { Turn, TurnBeat } from './types';
import { ALT_CAP, addAltPatch, altPosition, editAltPatch, switchAltPatch } from './turnAlts';
import { cleanSuggestions, dueEventsLine, pickWorldMover, worldMoveCue } from './worldMove';
import { sceneTurnCue } from './ai/prompts';

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: 't', episodeId: 'e', worldId: 'w', role: 'narrator', mode: null, text: 'First.', createdAt: 1, ...over
});

describe('kept versions', () => {
  it('keeps the old text when a rewrite lands, and shows the new one', () => {
    const beats: TurnBeat[] = [{ role: 'narrator', text: 'Second.' }];
    const patch = addAltPatch(turn(), 'Second.', beats, 10);
    expect(patch.text).toBe('Second.');
    expect(patch.beats).toEqual(beats);
    expect(patch.alts?.map((a) => a.text)).toEqual(['First.', 'Second.']);
    expect(patch.altIndex).toBe(1);
    expect(altPosition(patch)).toEqual({ index: 1, count: 2 });
  });

  it('flips back, carrying that version\'s beats', () => {
    const oldBeats: TurnBeat[] = [{ role: 'narrator', text: 'First.' }];
    const t = turn({ beats: oldBeats });
    const next = { ...t, ...addAltPatch(t, 'Second.', undefined, 10) };
    const back = switchAltPatch(next, 0)!;
    expect(back.text).toBe('First.');
    expect(back.beats).toEqual(oldBeats);
    expect(back.altIndex).toBe(0);
    expect(switchAltPatch({ ...next, ...back }, 0)).toBeNull();
    expect(switchAltPatch(next, 5)).toBeNull();
  });

  it('caps how many versions it keeps', () => {
    let t = turn();
    for (let i = 0; i < ALT_CAP + 2; i++) t = { ...t, ...addAltPatch(t, `v${i}`, undefined, 10 + i) };
    expect(t.alts).toHaveLength(ALT_CAP);
    expect(t.alts?.[ALT_CAP - 1].text).toBe(`v${ALT_CAP + 1}`);
    expect(t.altIndex).toBe(ALT_CAP - 1);
  });

  it('keeps a hand edit in the showing version', () => {
    const t = { ...turn(), ...addAltPatch(turn(), 'Second.', undefined, 10) };
    const edited = editAltPatch(t, 'Second, edited.', 20)!;
    expect(edited.alts?.map((a) => a.text)).toEqual(['First.', 'Second, edited.']);
    expect(editAltPatch(turn(), 'x', 1)).toBeNull();
  });

  it('syncs an edited showing text before adding a version', () => {
    const t = { ...turn(), ...addAltPatch(turn(), 'Second.', undefined, 10), text: 'Second, by hand.' };
    const patch = addAltPatch(t, 'Third.', undefined, 30);
    expect(patch.alts?.map((a) => a.text)).toEqual(['First.', 'Second, by hand.', 'Third.']);
  });
});

describe('world moves', () => {
  const fixed = () => 0;

  it('prefers someone with a goal who has been quiet', () => {
    const mover = pickWorldMover([
      { id: 'a', name: 'Ada', silence: 0 },
      { id: 'b', name: 'Ben', goal: 'find the ledger', silence: 4 },
      { id: 'c', name: 'Cy', silence: Number.POSITIVE_INFINITY, importance: 'background' }
    ], fixed);
    expect(mover?.id).toBe('b');
    expect(pickWorldMover([], fixed)).toBeNull();
  });

  it('writes a cue for a mover, and for an empty room', () => {
    const cue = worldMoveCue({ mover: { name: 'Ben', goal: 'find the ledger' }, due: 'the harbour auction' });
    expect(cue).toContain('Ben acts on what they want (find the ledger)');
    expect(cue).toContain('the harbour auction');
    expect(cue).toContain("Do not write the player's response");
    expect(worldMoveCue({ mover: null })).toContain('Something in the world shifts on its own');
  });

  it('lists calendar events due today or tomorrow', () => {
    const ev = (title: string, storyDay: number) => ({ title, storyDay }) as never;
    expect(dueEventsLine([ev('Auction', 5), ev('Festival', 6), ev('Later', 9)], 5)).toBe('Auction; Festival');
  });

  it('replaces the plain continue cue', () => {
    const cue = sceneTurnCue({
      mode: 'continue', playerText: '', length: 'beat', speakers: [{ name: 'Ben' }],
      worldMove: 'Time moves without waiting for the player.'
    });
    expect(cue).toContain('Time moves without waiting for the player.');
    expect(cue).not.toContain('No new player line');
  });
});

describe('next-move ideas', () => {
  it('keeps three short, distinct strings', () => {
    expect(cleanSuggestions(['"Who sent you?"', 'Search the desk', '"who sent you?"', 7, 'ok', 'Run', 'Wait'])).toEqual([
      '"Who sent you?"', 'Search the desk', 'Run'
    ]);
    expect(cleanSuggestions('nope')).toEqual([]);
  });
});
