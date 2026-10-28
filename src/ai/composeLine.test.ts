import { describe, expect, it } from 'vitest';
import { composeOutgoingLine, summaryClearPatch } from './composeLine';

describe('composeOutgoingLine', () => {
  it('stores a Direct line as steer without a speech mood', () => {
    expect(composeOutgoingLine({
      direct: true,
      asCharacterId: 'ivo',
      sceneHasOthers: true,
      tone: 'sarcastic',
      text: '  The cartwright leaves.  '
    })).toEqual({
      mode: 'steer',
      text: 'The cartwright leaves.',
      asCharacterId: null
    });
  });

  it('stores a sarcastic player line with the tone tag', () => {
    expect(composeOutgoingLine({
      direct: false,
      asCharacterId: null,
      sceneHasOthers: true,
      tone: 'sarcastic',
      text: 'Then write it again.'
    })).toEqual({
      mode: 'play',
      text: '[sarcastic] Then write it again.',
      asCharacterId: null
    });
  });

  it('keeps a plain line untagged, and acts alone when nobody else is here', () => {
    expect(composeOutgoingLine({
      direct: false,
      asCharacterId: null,
      sceneHasOthers: false,
      tone: null,
      text: 'I set the cup down.'
    }).mode).toBe('act');
    expect(composeOutgoingLine({
      direct: false,
      asCharacterId: 'marisol',
      sceneHasOthers: true,
      tone: null,
      text: 'She stamps the page.'
    })).toMatchObject({ mode: 'act', text: 'She stamps the page.', asCharacterId: 'marisol' });
  });
});

describe('summaryClearPatch', () => {
  it('clears a summary after an edit', () => {
    expect(summaryClearPatch('The cartwright still held the cup.')).toEqual({
      runningSummary: null,
      runningSummaryAtChars: 0,
      liveStateAtChars: 0,
      liveCanonAtChars: 0
    });
  });

  it('leaves an episode with no summary alone', () => {
    expect(summaryClearPatch(null)).toBeNull();
    expect(summaryClearPatch('   ')).toBeNull();
    expect(summaryClearPatch(undefined)).toBeNull();
  });
});