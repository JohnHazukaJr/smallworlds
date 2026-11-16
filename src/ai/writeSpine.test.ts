import { describe, expect, it } from 'vitest';
import {
  mergeStateField, mergeLiveRelationshipPatch, capSceneLedger, capSoftWrapExtract,
  dedupeSoftWrapExtract, softWrapAlreadyFiled, SCENE_LEDGER_CAP,
  endStoryWrite, isEmptyRosterProposal, tryBeginStoryWrite,
  rememberedExtract, chapterMemoryClearPatch,
  chapterCloseDigest
} from './engine';
import {
  episodeContextPressure,
  episodeHistoryChars,
  HISTORY_CHAR_BUDGET,
  HISTORY_TAIL_CHAR_BUDGET,
  HISTORY_TAIL_MAX_TURNS,
  SPEAK_HISTORY_TAIL_CHAR_BUDGET,
  SPEAK_HISTORY_TAIL_MAX_TURNS,
  chooseHistoryTail,
  omittedTurnsForNarratorTail,
  packTurnsDetailed,
  selectDirectorFacts,
  selectDirectorThreads,
  selectFactsPinnedFirst,
  selectThreadsPinnedFirst
} from './prompts';
import { filterCastDelta, namedNewcomer, openingFittingIds, rosterChangeNotice, stageSceneCast } from './sceneFit';
import { LIVE_MEMORY_TOOL } from './utilityCall';
import type { Character, CharacterImportance, ContinuityFact, OpenThread, Turn } from '../types';

const npc = (id: string, name: string): Character => ({
  id, worldId: 'w', name, role: '', age: '', appearance: '', mannerisms: '', summary: '',
  backstory: '', speechStyle: '', exampleLines: [], traits: '', desires: '', fears: '', flaws: '',
  secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: '', emotion: '', location: '', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0
});

describe('mergeLiveRelationshipPatch', () => {
  it('merges kind and note, then no-ops when unchanged', () => {
    const ada = npc('c1', 'Ada');
    const ben = npc('c2', 'Ben');
    const first = mergeLiveRelationshipPatch(ada, ben, { kind: 'rival', note: 'after the ledger' }, ['c1', 'c2']);
    expect(first).toEqual([{ targetId: 'c2', kind: 'rival', note: 'after the ledger' }]);
    ada.relationships = first!;
    expect(mergeLiveRelationshipPatch(ada, ben, { kind: 'rival', note: 'after the ledger' }, ['c1', 'c2'])).toBeNull();
  });

  it('keeps a tie to someone who is not in the room', () => {
    const ada = npc('c1', 'Ada');
    const ben = npc('c2', 'Ben');
    ada.relationships = [{ targetId: 'c3', kind: 'family', note: 'sister' }];
    const next = mergeLiveRelationshipPatch(
      ada,
      ben,
      { kind: 'rival', note: 'after the ledger' },
      ['c1', 'c2', 'c3']
    );
    expect(next).toEqual([
      { targetId: 'c3', kind: 'family', note: 'sister' },
      { targetId: 'c2', kind: 'rival', note: 'after the ledger' }
    ]);
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

  it('keeps at most one turn when the system frame fills the window', () => {
    const turns = mk(20, 3000);
    const { kept } = packTurnsDetailed(turns, 100_000, 100_000);
    expect(kept.length).toBeLessThanOrEqual(1);
    expect(kept.at(-1)?.id).toBe(turns.at(-1)?.id);
  });

  it('scales verbatim tails with the model window', () => {
    expect(chooseHistoryTail('some-local-chat', 'narrator')).toEqual({
      charBudget: HISTORY_TAIL_CHAR_BUDGET,
      maxTurns: HISTORY_TAIL_MAX_TURNS
    });
    expect(chooseHistoryTail('some-local-chat', 'speak')).toEqual(
      chooseHistoryTail('some-local-chat', 'narrator')
    );
    expect(chooseHistoryTail('claude-haiku-4-5', 'narrator')).toEqual({
      charBudget: 32_000,
      maxTurns: 32
    });
    expect(chooseHistoryTail('gpt-4o', 'speak')).toEqual(chooseHistoryTail('gpt-4o', 'narrator'));
    expect(chooseHistoryTail('my-model-64k', 'narrator')).toEqual({
      charBudget: 24_000,
      maxTurns: 24
    });
    expect(chooseHistoryTail('claude-sonnet-4', 'director').maxTurns).toBe(12);
    expect(chooseHistoryTail('unknown-chat', 'director').maxTurns).toBe(8);
  });

  it('omits running-summary source turns with the narrator tail', () => {
    const turns = mk(40, 800);
    const small = omittedTurnsForNarratorTail(turns, 'some-local-chat');
    const large = omittedTurnsForNarratorTail(turns, 'claude-haiku-4-5');
    expect(small.length).toBe(turns.length - HISTORY_TAIL_MAX_TURNS);
    expect(large.length).toBe(turns.length - 32);
    expect(large.length).toBeLessThan(small.length);
    expect(small.at(-1)?.id).not.toBe(turns.at(-1)?.id);
    expect(omittedTurnsForNarratorTail(turns, 'some-local-chat', 200_000).length).toBe(large.length);
  });

  it('caps speak history tighter than narrator', () => {
    const turns = mk(20, 600);
    const { kept } = packTurnsDetailed(turns, 0, 110_000, {
      charBudget: SPEAK_HISTORY_TAIL_CHAR_BUDGET,
      maxTurns: SPEAK_HISTORY_TAIL_MAX_TURNS
    });
    expect(kept.length).toBeLessThanOrEqual(SPEAK_HISTORY_TAIL_MAX_TURNS);
    expect(episodeHistoryChars(kept)).toBeLessThanOrEqual(SPEAK_HISTORY_TAIL_CHAR_BUDGET + 600);
    expect(kept.at(-1)?.id).toBe(turns.at(-1)?.id);
  });

  it('escalates pressure near budget', () => {
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.2)).toBe('ok');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.4)).toBe('warm');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.6)).toBe('warn');
    expect(episodeContextPressure(HISTORY_CHAR_BUDGET * 0.8)).toBe('escalate');
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

  it('keeps a fact that matches the player line ahead of a newer unrelated fact', () => {
    const facts: ContinuityFact[] = [
      {
        id: 'key', worldId: 'w', seasonId: 's', episodeId: 'e',
        text: 'The brass key is under the pier', source: 'manual',
        pinned: false, createdAt: 1, updatedAt: 1
      },
      {
        id: 'weather', worldId: 'w', seasonId: 's', episodeId: 'e',
        text: 'Weather was mild on the hill', source: 'manual',
        pinned: false, createdAt: 80, updatedAt: 80
      }
    ];
    const selected = selectFactsPinnedFirst(facts, ['e'], 1, 'Where is the brass key');
    expect(selected.map((f) => f.id)).toEqual(['key']);
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

describe('LIVE_MEMORY_TOOL', () => {
  it('accepts live state and canon keys in one schema', () => {
    const props = LIVE_MEMORY_TOOL.parameters.properties as Record<string, unknown>;
    expect(LIVE_MEMORY_TOOL.name).toBe('update_live_memory');
    for (const key of ['updates', 'scene', 'ties', 'facts', 'threads', 'place', 'knowledge']) {
      expect(props[key]).toBeTruthy();
    }
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

describe('chapterCloseDigest', () => {
  it('keeps the last turns after a long chapter', () => {
    const turns: Turn[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: 'narrator',
      mode: null,
      text: `Beat ${i}.`,
      createdAt: i
    }));
    turns[7] = { ...turns[7], text: 'The lamp finally goes out.' };
    const digest = chapterCloseDigest(turns, []);
    expect(digest).toContain('End of the chapter');
    expect(digest).toContain('The lamp finally goes out.');
    expect(digest.indexOf('The lamp finally goes out.')).toBeGreaterThan(digest.indexOf('End of the chapter'));
  });
});

describe('isEmptyRosterProposal', () => {
  it('flags an empty roster when counts were requested', () => {
    expect(isEmptyRosterProposal({ characters: [], locations: [] }, { characters: 4, locations: 3 })).toBe(true);
    expect(isEmptyRosterProposal(
      { characters: [{ description: 'A registrar with a wet stamp.' }], locations: [] },
      { characters: 4, locations: 3 }
    )).toBe(false);
    expect(isEmptyRosterProposal({ characters: [], locations: [] }, { characters: 0, locations: 0 })).toBe(false);
  });
});

describe('chapterMemoryClearPatch', () => {
  it('always clears summary watermarks, pending plan, and scene ledger', () => {
    expect(chapterMemoryClearPatch()).toEqual({
      runningSummary: null,
      runningSummaryAtChars: 0,
      liveStateAtChars: 0,
      liveCanonAtChars: 0,
      pendingPlan: null,
      sceneLedger: []
    });
  });
});

describe('rememberedExtract', () => {
  it('keeps the room air of a moment and drops durable canon', () => {
    const extract = rememberedExtract({
      facts: ['Ada took the key'],
      threads: ['Who paid Ivo?'],
      knowledge: [{ name: 'Ada', nowKnows: 'the debt' }],
      place: { name: 'Harbour office', currentState: 'The lamp is broken', atmosphere: 'wet wool' }
    }, false);
    expect(extract.facts).toEqual([]);
    expect(extract.threads).toEqual([]);
    expect(extract.knowledge).toEqual([]);
    expect(extract.place).toEqual({ name: 'Harbour office', atmosphere: 'wet wool' });
  });
});

describe('story write lock', () => {
  it('refuses a second write until the first releases', () => {
    const first = tryBeginStoryWrite();
    expect(first).not.toBeNull();
    expect(tryBeginStoryWrite()).toBeNull();
    endStoryWrite(first);
    const second = tryBeginStoryWrite();
    expect(second).not.toBeNull();
    endStoryWrite(second);
  });
});

describe('stageSceneCast', () => {
  const person = (
    id: string,
    name: string,
    patch: Partial<{ role: string; age: string; location: string; aliases: string[]; importance: CharacterImportance }>
  ) => {
    const c = npc(id, name);
    c.role = patch.role ?? '';
    c.age = patch.age ?? '';
    c.aliases = patch.aliases;
    c.importance = patch.importance;
    c.state = { ...c.state, location: patch.location ?? '' };
    return c;
  };

  const teacher = person('t', 'Mara', { role: 'history teacher', age: 'forties', location: 'the high school' });
  const student = person('s', 'Pip', { role: 'student', age: 'sixteen', location: 'the high school' });
  const merchant = person('m', 'Otto', { role: 'cloth merchant', age: 'late thirties', location: 'the market' });
  const ada = person('a', 'Ada', { role: 'harbour registrar', location: 'the harbour' });
  const ben = person('b', 'Ben', { role: 'manor clerk', location: 'the manor' });
  const keeper = person('k', 'Ned', { role: 'innkeeper', location: 'the inn' });
  const player = npc('p', 'you');
  player.isPlayer = true;

  it('stages the teacher in a class and leaves the adult merchant out', () => {
    const scene = stageSceneCast({
      castIds: ['p'],
      characters: [player, teacher, student, merchant],
      placeName: 'Room 12',
      inhabitants: 'the teacher and the students',
      playerText: 'I sit down.',
      placeChanged: true
    });
    expect(scene.castIds).toContain('t');
    expect(scene.castIds).toContain('s');
    expect(scene.castIds).not.toContain('m');
  });

  it('lets the merchant in only when the line brings them', () => {
    const scene = stageSceneCast({
      castIds: ['p'],
      characters: [player, teacher, merchant],
      placeName: 'Room 12',
      inhabitants: 'the teacher and the students',
      playerText: 'I take Otto to class.',
      placeChanged: true
    });
    expect(scene.castIds).toContain('m');
    expect(scene.castIds).toContain('t');
  });

  it('stages Ada at the harbour office without her name in the line', () => {
    const scene = stageSceneCast({
      castIds: ['p'],
      characters: [player, ada, ben],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: true
    });
    expect(scene.castIds).toContain('a');
    expect(scene.castIds).not.toContain('b');
  });

  it('keeps company in an open inn and does not take them into class', () => {
    const inn = stageSceneCast({
      castIds: ['p', 'm'],
      characters: [player, merchant, keeper],
      placeName: 'The inn',
      inhabitants: 'the keeper and whoever walks in',
      playerText: 'We go to the inn.',
      placeChanged: true
    });
    expect(inn.castIds).toContain('m');
    expect(inn.castIds).not.toContain('k');

    const room = stageSceneCast({
      castIds: ['p', 'm'],
      characters: [player, merchant, teacher],
      placeName: 'Room 12',
      inhabitants: 'the teacher and the students',
      playerText: 'I go to class.',
      placeChanged: true
    });
    expect(room.castIds).not.toContain('m');
    expect(room.castIds).toContain('t');
  });

  it('rejects an enter for someone who does not fit', () => {
    const delta = filterCastDelta({
      delta: { enter: ['m', 't'] },
      playerText: 'I sit down.',
      characters: [player, teacher, merchant],
      castIds: ['p'],
      placeName: 'Room 12',
      inhabitants: 'the teacher and the students'
    });
    expect(delta?.enter).toEqual(['t']);
  });

  it('leaves a fitting background out until the line names them', () => {
    const gus = person('g', 'Gus', { role: 'dockhand', location: 'the harbour', importance: 'background' });
    const quiet = stageSceneCast({
      castIds: ['p'],
      characters: [player, ada, gus],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: true
    });
    expect(quiet.castIds).toContain('a');
    expect(quiet.castIds).not.toContain('g');
    expect(quiet.alsoFits.map((c) => c.id)).not.toContain('g');

    const named = stageSceneCast({
      castIds: ['p'],
      characters: [player, ada, gus],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I ask Gus about the tide.',
      placeChanged: true
    });
    expect(named.castIds).toContain('g');
  });

  it('keeps an occasional off the card and on the also-fits list', () => {
    const nia = person('n', 'Nia', { role: 'assistant registrar', location: 'the harbour', importance: 'occasional' });
    const scene = stageSceneCast({
      castIds: ['p'],
      characters: [player, ada, nia],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: true
    });
    expect(scene.castIds).toContain('a');
    expect(scene.castIds).not.toContain('n');
    expect(scene.alsoFits.map((c) => c.id)).toContain('n');
  });

  it('drops an occasional when the place changes and keeps them when it does not', () => {
    const nia = person('n', 'Nia', { role: 'tide clerk', location: 'the harbour', importance: 'occasional' });
    const stayed = stageSceneCast({
      castIds: ['p', 'n'],
      characters: [player, ada, nia],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: false
    });
    expect(stayed.castIds).toContain('n');

    const moved = stageSceneCast({
      castIds: ['p', 'n'],
      characters: [player, ada, nia],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: true
    });
    expect(moved.castIds).not.toContain('n');
    expect(moved.alsoFits.map((c) => c.id)).not.toContain('n');
  });

  it('does not pull someone in just because their location string matches', () => {
    const rex = person('x', 'Rex', { role: 'sailor', location: 'Harbour office', importance: 'lead' });
    const scene = stageSceneCast({
      castIds: ['p'],
      characters: [player, rex],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: true
    });
    expect(scene.castIds).not.toContain('x');
  });

  it('does not pull a fitting regular into a room you are already in', () => {
    const adaHere = person('a2', 'Ada', { role: 'registrar', importance: 'lead' });
    const ben = person('b2', 'Ben', { role: 'registrar', importance: 'regular' });
    const scene = stageSceneCast({
      castIds: ['p', 'a2'],
      characters: [player, adaHere, ben],
      placeName: 'Harbour office',
      inhabitants: 'the registrar',
      playerText: 'I look around.',
      placeChanged: false
    });
    expect(scene.castIds).toEqual(['p', 'a2']);
    expect(scene.changes).toEqual([]);
  });

  it('keeps leads when more role-matching regulars fit than the room can hold', () => {
    const regulars = Array.from({ length: 6 }, (_, i) =>
      person(`r${i}`, `Reg${i}`, { role: 'clerk', importance: 'regular' })
    );
    const leads = [
      person('l0', 'Lark', { role: 'clerk', importance: 'lead' }),
      person('l1', 'Ivo', { role: 'clerk', importance: 'lead' })
    ];
    const scene = stageSceneCast({
      castIds: ['p'],
      characters: [player, ...regulars, ...leads],
      placeName: 'Harbour office',
      inhabitants: 'the clerks',
      playerText: 'I look around.',
      placeChanged: true
    });
    expect(scene.castIds).toEqual(['p', 'l0', 'l1', 'r0', 'r1', 'r2', 'r3']);
    expect(scene.alsoFits.map((c) => c.id)).toEqual(['r4', 'r5']);
  });

  it('says why someone entered or left', () => {
    expect(rosterChangeNotice([
      { id: 't', name: 'Mara', action: 'enter', reason: 'place' },
      { id: 'm', name: 'Otto', action: 'enter', reason: 'named' },
      { id: 'b', name: 'Ben', action: 'leave', reason: 'place' }
    ])).toBe(
      'Mara is here — this place holds them. Otto is here — you named them. Ben left — this place does not hold them.'
    );
    expect(namedNewcomer('I met Lila at the door.', ['Otto', 'Mara'])).toBe('Lila');
    expect(namedNewcomer('I met Otto at the door.', ['Otto'])).toBeNull();
  });

  it('rejects a background enter unless the line brings them', () => {
    const gus = person('g', 'Gus', { role: 'dockhand', location: 'Room 12', importance: 'background' });
    const blocked = filterCastDelta({
      delta: { enter: ['g', 't'] },
      playerText: 'I sit down.',
      characters: [player, teacher, gus],
      castIds: ['p'],
      placeName: 'Room 12',
      inhabitants: 'the teacher and the students'
    });
    expect(blocked?.enter).toEqual(['t']);

    const brought = filterCastDelta({
      delta: { enter: ['g'] },
      playerText: 'I ask Gus about the tide.',
      characters: [player, gus],
      castIds: ['p'],
      placeName: 'Harbour office',
      inhabitants: 'the registrar'
    });
    expect(brought?.enter).toEqual(['g']);
  });

  it('still lets an occasional enter when they fit the place', () => {
    const nia = person('n', 'Nia', { location: 'Room 12', importance: 'occasional' });
    const delta = filterCastDelta({
      delta: { enter: ['n'] },
      playerText: 'I sit down.',
      characters: [player, nia],
      castIds: ['p'],
      placeName: 'Room 12',
      inhabitants: 'the teacher and the students'
    });
    expect(delta?.enter).toEqual(['n']);
  });
});

describe('openingFittingIds', () => {
  const weighted = (id: string, name: string, importance: CharacterImportance) => {
    const c = npc(id, name);
    c.importance = importance;
    return c;
  };

  it('opens on leads before regulars and skips background', () => {
    const ids = openingFittingIds([
      weighted('g', 'Gus', 'background'),
      weighted('r', 'Rin', 'regular'),
      weighted('l', 'Lark', 'lead'),
      weighted('o', 'Nia', 'occasional')
    ]);
    expect(ids).toEqual(['l', 'r']);
  });

  it('uses occasionals when nobody more central fits', () => {
    expect(openingFittingIds([
      weighted('g', 'Gus', 'background'),
      weighted('o', 'Nia', 'occasional')
    ])).toEqual(['o']);
  });
});

