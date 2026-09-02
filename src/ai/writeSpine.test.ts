import { describe, expect, it } from 'vitest';
import {
  matchPlotTargets, mergeStateField, normalizeBeats, capSceneLedger, capSoftWrapExtract,
  dedupeSoftWrapExtract, directorFallbackNarrationBrief, softWrapAlreadyFiled, SCENE_LEDGER_CAP
} from './engine';
import {
  episodeContextPressure,
  episodeHistoryChars,
  HISTORY_CHAR_BUDGET,
  HISTORY_TAIL_CHAR_BUDGET,
  injectedSpeakBrief,
  injectedSpeakBriefForCharacter,
  packTurnsDetailed,
  pendingBeatLabel,
  selectDirectorFacts,
  selectDirectorThreads,
  selectFactsPinnedFirst,
  selectThreadsPinnedFirst
} from './prompts';
import { SPEAK_FORMAT_RULES } from './dialogueFormat';
import type { Character, ContinuityFact, EpisodeGuest, OpenThread, PlotTarget, Turn } from '../types';

const npc = (id: string, name: string): Character => ({
  id, worldId: 'w', name, role: '', age: '', appearance: '', mannerisms: '', summary: '',
  backstory: '', speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
  secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: '', emotion: '', location: '', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0
});

describe('normalizeBeats', () => {
  const cast = [npc('c1', 'Ada'), npc('c2', 'Ben')];
  const guests: EpisodeGuest[] = [{ id: 'g1', name: 'Clerk', brief: 'tired', voice: '' }];

  it('keeps narration and speak under caps', () => {
    const beats = normalizeBeats(
      {
        beats: [
          { type: 'narration', brief: 'Rain on glass.' },
          { type: 'speak', characterId: 'Ada', brief: 'greet coldly' },
          { type: 'speak', characterId: 'missing', brief: 'skip me' },
          { type: 'speak', guestId: 'g1', brief: 'interrupt' },
          { type: 'narration', brief: '' },
          { type: 'narration', brief: 'Door opens.' }
        ]
      },
      cast,
      guests,
      new Map(),
      'continue',
      '',
      'episode'
    );
    expect(beats.map((b) => b.type)).toEqual(['narration', 'speak', 'speak', 'narration']);
    expect(beats[1]).toMatchObject({ type: 'speak', characterId: 'c1' });
    expect(beats[2]).toMatchObject({ type: 'speak', guestId: 'g1' });
  });

  it('injects a speak reply when player spoke and plan has none', () => {
    const beats = normalizeBeats(
      { beats: [{ type: 'narration', brief: 'She stares.' }] },
      cast,
      guests,
      new Map(),
      'speak',
      'Hello?'
    );
    expect(beats.some((b) => b.type === 'speak')).toBe(true);
    expect(beats[0].type).toBe('speak');
    if (beats[0].type === 'speak' && 'characterId' in beats[0]) {
      expect(beats[0].brief).toMatch(/Answer the player's last move as Ada/i);
      expect(beats[0].brief).not.toBe("Answer the player's last move; stay in character.");
    }
  });

  it('injects a speak reply when player used play (speak+act)', () => {
    const beats = normalizeBeats(
      { beats: [{ type: 'narration', brief: 'She stares.' }] },
      cast,
      guests,
      new Map(),
      'play',
      '*leans in* "Hello?"'
    );
    expect(beats.some((b) => b.type === 'speak')).toBe(true);
    expect(beats[0].type).toBe('speak');
  });

  it('caps Short reply size to at most one speak and two total', () => {
    const beats = normalizeBeats(
      {
        beats: [
          { type: 'narration', brief: 'Rain.' },
          { type: 'speak', characterId: 'Ada', brief: 'a' },
          { type: 'speak', characterId: 'Ben', brief: 'b' },
          { type: 'narration', brief: 'More.' }
        ]
      },
      cast,
      guests,
      new Map(),
      'continue',
      '',
      'beat'
    );
    expect(beats.length).toBeLessThanOrEqual(2);
    expect(beats.filter((b) => b.type === 'speak').length).toBeLessThanOrEqual(1);
  });

  it('honours preferred speaker when injecting a reply', () => {
    const beats = normalizeBeats(
      { beats: [{ type: 'narration', brief: 'Silence.' }] },
      cast,
      guests,
      new Map(),
      'speak',
      'Hey',
      'scene',
      { characterId: 'c2' }
    );
    expect(beats[0]).toMatchObject({ type: 'speak', characterId: 'c2' });
  });

  it('hard-pins preferred speaker and drops other speak beats', () => {
    const beats = normalizeBeats(
      {
        beats: [
          { type: 'speak', characterId: 'Ada', brief: 'not her' },
          { type: 'speak', characterId: 'Ben', brief: 'him' },
          { type: 'narration', brief: 'Rain.' }
        ]
      },
      cast,
      guests,
      new Map(),
      'speak',
      'Hello',
      'episode',
      { characterId: 'c2' }
    );
    const speak = beats.filter((b) => b.type === 'speak');
    expect(speak).toHaveLength(1);
    expect(speak[0]).toMatchObject({ type: 'speak', characterId: 'c2' });
    expect(beats.some((b) => b.type === 'narration')).toBe(true);
  });

  it('injects the NPC who has been quiet rather than the first cast card', () => {
    const spoke = (i: number): Turn => ({
      id: `t${i}`, episodeId: 'e', worldId: 'w', role: 'character' as const, mode: null,
      characterId: 'c1', text: 'Ada again.', createdAt: i
    });
    const beats = normalizeBeats(
      { beats: [{ type: 'narration', brief: 'She stares.' }] },
      cast,
      guests,
      new Map(),
      'speak',
      'Well?',
      'scene',
      undefined,
      [spoke(1), spoke(2), spoke(3)]
    );
    expect(beats[0]).toMatchObject({ type: 'speak', characterId: 'c2' });
    if (beats[0].type === 'speak') {
      expect(beats[0].brief).toMatch(/have not spoken yet/i);
    }
  });

  it('still routes to the NPC the player addressed by name', () => {
    const spoke: Turn = {
      id: 't1', episodeId: 'e', worldId: 'w', role: 'character', mode: null,
      characterId: 'c1', text: 'Ada holds the floor.', createdAt: 1
    };
    const beats = normalizeBeats(
      { beats: [{ type: 'narration', brief: 'She stares.' }] },
      cast,
      guests,
      new Map(),
      'speak',
      'Ada, answer me.',
      'scene',
      undefined,
      [spoke]
    );
    expect(beats[0]).toMatchObject({ type: 'speak', characterId: 'c1' });
    if (beats[0].type === 'speak') {
      expect(beats[0].brief).toMatch(/speaking straight at you/i);
    }
  });
});

describe('capSceneLedger', () => {
  it('trims, de-duplicates, and caps the tracked details', () => {
    const ledger = capSceneLedger([
      '  Rain on the office glass  ',
      'rain on the office glass',
      ...Array.from({ length: 10 }, (_, i) => `detail ${i}`)
    ]);
    expect(ledger).not.toBeNull();
    expect(ledger).toHaveLength(SCENE_LEDGER_CAP);
    expect(ledger![0]).toBe('Rain on the office glass');
    expect(ledger!.filter((d) => /rain on the office glass/i.test(d))).toHaveLength(1);
  });

  it('returns null for unusable output so the prior ledger survives', () => {
    expect(capSceneLedger(undefined)).toBeNull();
    expect(capSceneLedger('rain')).toBeNull();
    expect(capSceneLedger([])).toBeNull();
    expect(capSceneLedger(['  ', 42])).toBeNull();
  });
});

describe('mergeStateField', () => {
  it('keeps the prior value when the tracker omits or blanks a field', () => {
    expect(mergeStateField(undefined, 'wary')).toBe('wary');
    expect(mergeStateField('   ', 'wary')).toBe('wary');
  });

  it('clears a mood or injury the tracker marks as finished', () => {
    expect(mergeStateField('none', 'furious')).toBe('');
    expect(mergeStateField('resolved.', 'bleeding')).toBe('');
    expect(mergeStateField('-', 'limping')).toBe('');
  });

  it('takes a real new value', () => {
    expect(mergeStateField('calm', 'furious')).toBe('calm');
  });
});

describe('packTurnsDetailed / pressure', () => {
  const mk = (n: number, size: number): Turn[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, episodeId: 'e', worldId: 'w', role: 'narrator' as const, mode: null,
      text: 'x'.repeat(size), createdAt: i
    }));

  it('keeps newest turns under budget', () => {
    const turns = mk(40, 3000);
    const { kept, omitted } = packTurnsDetailed(turns);
    expect(kept.length).toBeGreaterThan(0);
    expect(omitted.length).toBeGreaterThan(0);
    expect(kept.at(-1)?.id).toBe(turns.at(-1)?.id);
    expect(episodeHistoryChars(kept)).toBeLessThanOrEqual(HISTORY_TAIL_CHAR_BUDGET + 3000);
  });

  it('drops the 20k history floor when the system frame ate the window', () => {
    const turns = mk(20, 3000);
    const { kept } = packTurnsDetailed(turns, 90_000, 100_000);
    expect(episodeHistoryChars(kept)).toBeLessThan(20_000);
    expect(kept.length).toBeGreaterThanOrEqual(4);
    expect(kept.at(-1)?.id).toBe(turns.at(-1)?.id);
  });

  it('escalates pressure near budget', () => {
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.2)).toBe('ok');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.4)).toBe('warm');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.6)).toBe('warn');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.8)).toBe('escalate');
  });
});

describe('matchPlotTargets', () => {
  const targets: PlotTarget[] = [
    { id: 'a', text: 'Find the key', status: 'pending', source: 'manual' },
    { id: 'b', text: 'Confront Mira', status: 'pending', source: 'manual' },
    { id: 'c', text: 'Old debt', status: 'hit', source: 'manual' },
    { id: 'd', text: 'Recover the stolen harbour ledger before dawn', status: 'pending', source: 'manual' }
  ];

  it('matches exact and loose contains', () => {
    const hits = matchPlotTargets(targets, ['find the key', 'confront mira about the past']);
    expect(hits.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('matches paraphrases via token overlap', () => {
    const hits = matchPlotTargets(targets, ['recover stolen harbour ledger']);
    expect(hits.map((t) => t.id)).toEqual(['d']);
  });

  it('ignores already-hit targets', () => {
    expect(matchPlotTargets(targets, ['Old debt'])).toEqual([]);
  });
});

describe('selectDirectorFacts / Threads pin', () => {
  it('includes pinned facts before soft cap picks', () => {
    const facts: ContinuityFact[] = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`, worldId: 'w', seasonId: 's', episodeId: 'e',
      text: `Fact ${i}`, source: 'manual' as const,
      pinned: i === 19,
      createdAt: i, updatedAt: i
    }));
    const selected = selectDirectorFacts(facts, ['e']);
    expect(selected.some((f) => f.id === 'f19')).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(16);
  });

  it('includes pinned threads before soft cap picks', () => {
    const threads: OpenThread[] = Array.from({ length: 16 }, (_, i) => ({
      id: `t${i}`, worldId: 'w', seasonId: 's',
      text: `Thread ${i}`, openedLabel: 'S1 · E1', status: 'open' as const,
      pinned: i === 0,
      createdAt: i, updatedAt: i
    }));
    const selected = selectDirectorThreads(threads, ['E1']);
    expect(selected[0]?.id === 't0' || selected.some((t) => t.id === 't0')).toBe(true);
    expect(selected.every((t) => t.status === 'open')).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(10);
  });

  it('agent fact selection honors pins at narrator cap', () => {
    const facts: ContinuityFact[] = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`, worldId: 'w', seasonId: 's', episodeId: 'e',
      text: `Fact ${i}`, source: 'manual' as const,
      pinned: i === 27,
      createdAt: i, updatedAt: i
    }));
    const selected = selectFactsPinnedFirst(facts, ['e'], 24);
    expect(selected.some((f) => f.id === 'f27')).toBe(true);
    expect(selected.length).toBeLessThanOrEqual(24);
  });

  it('agent thread selection honors pins', () => {
    const threads: OpenThread[] = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`, worldId: 'w', seasonId: 's',
      text: `Thread ${i}`, openedLabel: 'S1 · E2', status: 'open' as const,
      pinned: i === 15,
      createdAt: i, updatedAt: i
    }));
    const selected = selectThreadsPinnedFirst(threads, ['E2'], 12);
    expect(selected.some((t) => t.id === 't15')).toBe(true);
  });
});

describe('directorFallbackNarrationBrief', () => {
  it('names the player move, location, and an on-stage want', () => {
    const brief = directorFallbackNarrationBrief({
      mode: 'speak',
      playerText: 'Where is the ledger?',
      location: 'Harbour office',
      inScene: [npc('c1', 'Ada')]
    });
    expect(brief).toContain('Where is the ledger?');
    expect(brief).toContain('Harbour office');
    expect(brief).toContain('Ada');
    expect(brief).toMatch(/sensory job/i);
  });
});

describe('capSoftWrapExtract', () => {
  it('keeps in-scene facts and drops off-scene updates', () => {
    const capped = capSoftWrapExtract({
      facts: ['The ledger is forged.', 'Ada bought a bun.', 'x', 'y', 'z', 'a', 'b', 'too many'],
      threads: ['Who paid Ivo?', 't2', 't3', 't4', 't5'],
      characterUpdates: [
        { name: 'Ada', goal: 'Hide the books', emotion: 'tight' },
        { name: 'Offstage Mira', goal: 'should drop' }
      ]
    }, new Set(['ada']));
    expect(capped.facts).toHaveLength(6);
    expect(capped.facts[0]).toBe('The ledger is forged.');
    expect(capped.threads).toHaveLength(4);
    expect(capped.characterUpdates).toEqual([
      { name: 'Ada', goal: 'Hide the books', emotion: 'tight', location: undefined, condition: undefined }
    ]);
    expect(capped.place).toBeNull();
  });

  it('keeps a scene place patch on skip wrap', () => {
    const capped = capSoftWrapExtract({
      facts: [],
      threads: [],
      characterUpdates: [],
      place: { name: 'Harbour office', currentState: '  The lamp is smashed.  ' }
    }, new Set(['ada']));
    expect(capped.place).toEqual({
      name: 'Harbour office',
      currentState: 'The lamp is smashed.',
      atmosphere: undefined
    });
  });
});

describe('dedupeSoftWrapExtract', () => {
  it('does not re-file facts and threads already on file from play', () => {
    const capped = capSoftWrapExtract({
      facts: ['Ada still has the brass office key', 'The quay lock is forced'],
      threads: ['Who paid Ivo?', 'What happened to the lamp?'],
      characterUpdates: []
    }, new Set(['ada']));
    const deduped = dedupeSoftWrapExtract(
      capped,
      ['Ada still holds the brass office key'],
      ['Who paid Ivo the harbour fee?']
    );
    expect(deduped.facts).toEqual(['The quay lock is forced']);
    expect(deduped.threads).toEqual(['What happened to the lamp?']);
  });
});

describe('injectedSpeakBrief', () => {
  it('carries voice, mood, want, and a mannerism tic', () => {
    const brief = injectedSpeakBrief({
      name: 'Ada',
      speechStyle: 'Clipped harbour clerk cadence',
      mannerisms: 'Taps the ledger twice. Never sits fully.',
      emotion: 'tight',
      goal: 'Hide the forged entry',
      anchor: 'Never lies in writing'
    });
    expect(brief).toContain('Ada');
    expect(brief).toMatch(/voice:.*Clipped harbour/i);
    expect(brief).toMatch(/mood:.*tight/i);
    expect(brief).toMatch(/pushing:.*Hide the forged/i);
    expect(brief).toMatch(/one tic:.*Taps the ledger/i);
    expect(brief).toMatch(/hold:.*Never lies/i);
    expect(brief).toMatch(/do not soften/i);
  });

  it('includes character live state via helper', () => {
    const ada = npc('c1', 'Ada');
    ada.speechStyle = 'Dry';
    ada.state = { goal: 'Keep the books', emotion: 'cold', location: 'Quay', condition: '' };
    ada.anchors = ['Never smiles for free'];
    expect(injectedSpeakBriefForCharacter(ada)).toMatch(/Keep the books/);
    expect(injectedSpeakBriefForCharacter(ada)).toMatch(/Never smiles/);
  });
});

describe('SPEAK_FORMAT_RULES immersion', () => {
  it('does not train a shy-dimples default register', () => {
    expect(SPEAK_FORMAT_RULES).not.toMatch(/dimples/i);
    expect(SPEAK_FORMAT_RULES).not.toMatch(/smiled shyly/i);
    expect(SPEAK_FORMAT_RULES).toMatch(/ledger/i);
  });
});

describe('softWrapAlreadyFiled', () => {
  it('is true only when a recap is already on the episode', () => {
    expect(softWrapAlreadyFiled({ wrap: null })).toBe(false);
    expect(softWrapAlreadyFiled({ wrap: { recap: '', beats: [], guestEffects: [] } })).toBe(false);
    expect(softWrapAlreadyFiled({
      wrap: { recap: 'Previously on.', beats: [], guestEffects: [] }
    })).toBe(true);
  });
});

describe('pendingBeatLabel', () => {
  const cast = [npc('c1', 'Ada')];
  const guests: EpisodeGuest[] = [{ id: 'g1', name: 'Clerk', brief: 'tired', voice: '' }];

  it('uses the narration brief and resolves speak names', () => {
    expect(pendingBeatLabel({ type: 'narration', brief: 'Rain on glass.' }, cast, guests))
      .toBe('Rain on glass.');
    expect(pendingBeatLabel({ type: 'speak', characterId: 'c1', brief: 'greet coldly' }, cast, guests))
      .toBe('Ada: greet coldly');
    expect(pendingBeatLabel({ type: 'speak', guestId: 'g1', brief: 'interrupt' }, cast, guests))
      .toBe('Clerk: interrupt');
  });

  it('falls back when ids are missing and clips the final label', () => {
    expect(pendingBeatLabel({ type: 'speak', characterId: 'gone', brief: 'hello' }, cast, guests))
      .toBe('Someone: hello');
    expect(pendingBeatLabel({ type: 'speak', guestId: 'gone', brief: 'hello' }, cast, guests))
      .toBe('Someone: hello');
    const long = 'x'.repeat(90);
    const narration = pendingBeatLabel({ type: 'narration', brief: long }, cast, guests);
    expect(narration.endsWith('…')).toBe(true);
    expect(narration.length).toBe(80);
    const speak = pendingBeatLabel(
      { type: 'speak', characterId: 'c1', brief: 'y'.repeat(90) },
      cast,
      guests
    );
    expect(speak.startsWith('Ada:')).toBe(true);
    expect(speak.endsWith('…')).toBe(true);
    expect(speak.length).toBe(80);
  });
});
