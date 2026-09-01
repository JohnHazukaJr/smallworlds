import { describe, expect, it } from 'vitest';
import {
  isNearDuplicate,
  knowledgeFactLine,
  knowledgeStillNovel,
  LIVE_CANON_EPISODE_FACT_BUDGET,
  LIVE_CANON_FACT_CAP,
  liveCanonHasWork,
  novelLines,
  normalizeLiveCanonExtract,
  selectStaleFactTexts
} from './liveCanon';

const names = new Set(['ada', 'ben']);

describe('novelLines', () => {
  it('dedupes paraphrases against existing canon', () => {
    const existing = ['Ada still has the brass office key'];
    expect(novelLines(
      ['Ada still holds the brass office key', 'Ivo is owed twelve coins'],
      existing,
      5
    )).toEqual(['Ivo is owed twelve coins']);
  });

  it('dedupes within the proposed batch', () => {
    const out = novelLines(
      ['The lamp is smashed', 'The lamp is smashed on the floor', 'Rain on the glass'],
      [],
      5
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('The lamp is smashed');
  });

  it('caps the list', () => {
    const proposed = [
      'Ada holds the brass office key',
      'Ivo is owed twelve clipped coins',
      'The quay lock was forced overnight',
      'Rain started before the feast lanterns',
      'Ben saw Mira take the ledger',
      'The lamp chimney lies in shards'
    ];
    expect(novelLines(proposed, [], 5)).toHaveLength(5);
  });
});

describe('isNearDuplicate', () => {
  it('treats exact and contained lines as duplicates', () => {
    expect(isNearDuplicate('Ada has the key', ['Ada has the key'])).toBe(true);
    expect(isNearDuplicate(
      'Ada has the harbour office key',
      ['Ada has the harbour office key in her coat']
    )).toBe(true);
  });
});

describe('normalizeLiveCanonExtract', () => {
  it('ignores empty JSON', () => {
    const extract = normalizeLiveCanonExtract({}, {
      existingFacts: [],
      existingThreads: [],
      inSceneNames: names,
      episodeFactCount: 0
    });
    expect(extract).toEqual({ facts: [], threads: [], place: null, knowledge: [] });
    expect(liveCanonHasWork(extract)).toBe(false);
  });

  it('does not re-file wrap-filed facts or threads', () => {
    const extract = normalizeLiveCanonExtract({
      facts: ['Ada promised to return the ledger at dawn', 'The quay lock is forced'],
      threads: ['Who paid Ivo?']
    }, {
      existingFacts: ['Ada promised to return the ledger at dawn'],
      existingThreads: ['Who paid Ivo the harbour fee?'],
      inSceneNames: names,
      episodeFactCount: 1
    });
    expect(extract.facts).toEqual(['The quay lock is forced']);
    expect(extract.threads).toEqual([]);
  });

  it('caps episode fact budget', () => {
    const extract = normalizeLiveCanonExtract({
      facts: ['New fact about the stolen crate in the office']
    }, {
      existingFacts: [],
      existingThreads: [],
      inSceneNames: names,
      episodeFactCount: LIVE_CANON_EPISODE_FACT_BUDGET
    });
    expect(extract.facts).toEqual([]);
  });

  it('keeps at most LIVE_CANON_FACT_CAP new facts', () => {
    const facts = [
      'Ada holds the brass office key',
      'Ivo is owed twelve clipped coins',
      'The quay lock was forced overnight',
      'Rain started before the feast lanterns',
      'Ben saw Mira take the ledger',
      'The lamp chimney lies in shards',
      'Cora left her coat on the rail',
      'The tide took the dinghy'
    ];
    const extract = normalizeLiveCanonExtract({ facts }, {
      existingFacts: [],
      existingThreads: [],
      inSceneNames: names,
      episodeFactCount: 0
    });
    expect(extract.facts).toHaveLength(LIVE_CANON_FACT_CAP);
  });

  it('filters knowledge to in-scene names and skips duplicate know-lines', () => {
    const extract = normalizeLiveCanonExtract({
      knowledge: [
        { name: 'Ada', nowKnows: 'the ledger is forged' },
        { name: 'Mira', nowKnows: 'should drop — not in scene' },
        { name: 'Ben', nowKnows: 'the ledger is forged' }
      ]
    }, {
      existingFacts: ['Ada now knows: the ledger is forged'],
      existingThreads: [],
      inSceneNames: names,
      episodeFactCount: 1
    });
    expect(extract.knowledge).toEqual([{ name: 'Ben', nowKnows: 'the ledger is forged' }]);
  });

  it('files novel in-scene knowledge', () => {
    const extract = normalizeLiveCanonExtract({
      knowledge: [{ name: 'Ada', nowKnows: 'Ivo paid in clipped coin' }]
    }, {
      existingFacts: [],
      existingThreads: [],
      inSceneNames: names,
      episodeFactCount: 0
    });
    expect(extract.knowledge).toEqual([{ name: 'Ada', nowKnows: 'Ivo paid in clipped coin' }]);
    expect(knowledgeFactLine('Ada', 'Ivo paid in clipped coin')).toBe('Ada now knows: Ivo paid in clipped coin');
  });

  it('normalizes a place patch', () => {
    const extract = normalizeLiveCanonExtract({
      place: { name: 'Harbour office', currentState: '  The lamp is smashed.  ' }
    }, {
      existingFacts: [],
      existingThreads: [],
      inSceneNames: names,
      episodeFactCount: 0
    });
    expect(extract.place?.currentState).toBe('The lamp is smashed.');
    expect(liveCanonHasWork(extract)).toBe(true);
  });
});

describe('selectStaleFactTexts', () => {
  it('returns canonical existing wording for near-matches', () => {
    expect(selectStaleFactTexts(
      ['Ada still has the brass office key'],
      ['Ada still holds the brass office key', 'Ivo is owed twelve coins']
    )).toEqual(['Ada still holds the brass office key']);
  });

  it('drops proposals that are not on file', () => {
    expect(selectStaleFactTexts(['A dragon ate the quay'], ['Ada has the key still'])).toEqual([]);
  });
});

describe('knowledgeStillNovel', () => {
  it('is false when wrap already filed the know-line', () => {
    expect(knowledgeStillNovel(
      'Ada',
      'the ledger is forged',
      ['Ada now knows: the ledger is forged']
    )).toBe(false);
    expect(knowledgeStillNovel('Ada', 'the quay lock is forced', ['Ada now knows: the ledger is forged'])).toBe(true);
  });
});
