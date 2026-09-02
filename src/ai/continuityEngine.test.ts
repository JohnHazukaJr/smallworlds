import { describe, expect, it } from 'vitest';
import { textMatchScore } from './engine';
import {
  buildCharacterSystemPrompt,
  buildNarrationBeatMessages,
  buildNarratorSystemPrompt,
  compressOmittedTurns,
  directorSystemPrompt,
  DIRECTOR_FACT_CAP,
  DIRECTOR_THREAD_CAP,
  DIRECTOR_TRANSCRIPT_TURNS,
  directorUserPrompt,
  packTurnsDetailed,
  sceneLedgerSection,
  storyCachePrefix,
  buildCharacterSpeakMessages,
  buildGuestSystemPrompt,
  type PromptContext
} from './prompts';
import { inferContextWindowTokens, promptCharBudget } from './contextBudget';
import { AIError, isContextOverflowError, isEmptyModelResponse, isPromptPackRetryError } from './client';
import { DEFAULT_AI } from '../worldOps';
import type { CalendarEvent, Character, ContinuityFact, Episode, EpisodeGuest, Location, OpenThread, Season, Turn, World } from '../types';

const npc = (id: string, name: string, extras: Partial<Character> = {}): Character => ({
  id, worldId: 'w', name, role: 'registrar', age: '', appearance: '', mannerisms: '', summary: 'Keeps the books.',
  backstory: '', speechStyle: 'clipped', exampleLines: ['"Ledger says otherwise."'], traits: '', desires: '',
  fears: '', flaws: '', secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: 'Close the books', emotion: 'wary', location: 'harbour office', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0,
  ...extras
});

const world = (): World => ({
  id: 'w',
  title: 'Harbour',
  line: 'Fog and debts.',
  bible: 'A coastal city of ledgers.',
  hue: 200,
  visibility: 'private',
  ai: { ...DEFAULT_AI, narratorRules: ['Never describe the sea as wine-dark.'] },
  proseModel: null,
  utilityModel: null,
  activeSeasonId: 's',
  calendar: { currentDay: 12, system: '', episodeAdvanceDays: 1 },
  calendarEventPrefs: { enabled: true, aiSeedOnSeasonStart: false, defaultVisibility: 'title' },
  createdAt: 0,
  updatedAt: 0
});

const season = (): Season => ({
  id: 's',
  worldId: 'w',
  number: 1,
  title: '',
  premise: 'The forged ledger.',
  timeGap: null,
  bible: null,
  plotTargets: [{
    id: 'pt1',
    text: 'Recover the stolen harbour ledger before dawn',
    status: 'pending',
    source: 'manual'
  }],
  status: 'active',
  createdAt: 0,
  updatedAt: 0
});

const loc = (): Location => ({
  id: 'loc1', worldId: 'w', name: 'Harbour office', tagline: 'public desk', hue: 0,
  summary: 'A cramped registrar.', atmosphere: 'salt-rot wood and wet wool',
  features: '', history: 'LONG_HISTORY_SHOULD_DROP_ON_TIGHT', inhabitants: '', secrets: '',
  currentState: 'Crowded.', rules: ['No blades past the rail.'], customInstructions: '',
  createdAt: 0, updatedAt: 0
});

const episode = (): Episode => ({
  id: 'e', seasonId: 's', worldId: 'w', number: 2, title: '', location: 'Harbour office',
  locationId: 'loc1',
  castIds: ['c1'], guests: [], wrap: null, storyDay: 12, status: 'active', createdAt: 0, updatedAt: 0
});

const calEvent = (): CalendarEvent => ({
  id: 'cal1', worldId: 'w', seasonId: 's', title: 'Harbour Feast', summary: 'Lanterns on the quay.',
  kind: 'festival', scale: 'large', storyDay: 12, visibility: 'title', promptPolicy: 'hard',
  status: 'due', source: 'manual', createdAt: 1, updatedAt: 1
});

function ctx(partial: Partial<PromptContext> = {}): PromptContext {
  const cast = [npc('c1', 'Ada')];
  return {
    world: world(),
    season: season(),
    episode: episode(),
    characters: cast,
    locations: [loc()],
    continuity: [],
    threads: [],
    turns: [],
    calendarEvents: [calEvent()],
    ...partial
  };
}

describe('textMatchScore', () => {
  it('scores paraphrases with shared content words', () => {
    expect(
      textMatchScore(
        'recover stolen harbour ledger',
        'Recover the stolen harbour ledger before dawn'
      )
    ).toBeGreaterThan(0.6);
  });

  it('rejects weak single-token overlap', () => {
    expect(textMatchScore('the fog', 'Recover the stolen harbour ledger before dawn')).toBe(0);
  });
});

describe('compressOmittedTurns', () => {
  it('keeps head, mid, and tail when digest is long', () => {
    const turns: Turn[] = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: 'narrator' as const,
      mode: null,
      text: `MARKER_${i}_` + 'x'.repeat(200),
      createdAt: i
    }));
    const digest = compressOmittedTurns(turns, []);
    expect(digest).toContain('MARKER_0_');
    expect(digest).toContain('MARKER_29_');
    expect(digest.split('…').length).toBeGreaterThanOrEqual(3);
    // Mid slice should survive (not only head/tail).
    expect(/MARKER_1[0-9]_/.test(digest)).toBe(true);
  });
});

describe('speak agent context frame', () => {
  it('includes calendar texture and aimed situation beats', () => {
    const prompt = buildCharacterSystemPrompt(ctx(), npc('c1', 'Ada'));
    expect(prompt).toMatch(/## Situation/i);
    expect(prompt).not.toMatch(/Aimed pressure/i);
    expect(prompt).toMatch(/Harbour Feast/);
    expect(prompt).toMatch(/Aimed beat/i);
    expect(prompt).toMatch(/harbour ledger/i);
    expect(prompt).toMatch(/Never prefix your reply with your name/i);
    expect(prompt).toMatch(/At most one question/i);
    expect(prompt).toMatch(/stop and wait/i);
    expect(prompt).toMatch(/take the answer as heard/i);
    expect(prompt).toMatch(/Story stance:/i);
    expect(prompt).not.toMatch(/## Plot targets/i);
  });

  it('uses hard established-facts continuity for speak agents', () => {
    const prompt = buildCharacterSystemPrompt(ctx({
      continuity: [{
        id: 'f1', worldId: 'w', seasonId: 's', episodeId: 'e',
        text: 'Ada still has the brass office key',
        source: 'auto', createdAt: 1
      }]
    }), npc('c1', 'Ada'));
    expect(prompt).toMatch(/## Continuity — established facts, never contradict these/);
    expect(prompt).toContain('Ada still has the brass office key');
    expect(prompt).not.toMatch(/plausibly know them/);
  });

  it('labels character history as [Name] not Name:', () => {
    const ada = npc('c1', 'Ada');
    const turns: Turn[] = [{
      id: 't1', episodeId: 'e', worldId: 'w', role: 'character', mode: null,
      characterId: 'c1', text: '*nods* "Ledger."', createdAt: 1
    }];
    const joined = buildCharacterSpeakMessages(turns, [ada], ada, 'press them', [])
      .map((m) => m.content)
      .join('\n');
    expect(joined).toMatch(/\[Ada\]/);
    expect(joined).not.toMatch(/(?:^|\n)Ada: /);
  });

  it('puts guest voice as a hard identity guide', () => {
    const guest: EpisodeGuest = { id: 'g1', name: 'Clerk', brief: 'tired', voice: 'dry harbour rasp' };
    const prompt = buildGuestSystemPrompt(
      ctx({ episode: { ...episode(), guests: [guest], activeGuestIds: ['g1'] } }),
      guest
    );
    expect(prompt).toMatch(/Voice guide — match this exactly/);
    expect(prompt).toMatch(/dry harbour rasp/);
  });
});

describe('director prompt budgets', () => {
  it('exposes richer caps and recent transcript window', () => {
    expect(DIRECTOR_FACT_CAP).toBe(16);
    expect(DIRECTOR_THREAD_CAP).toBe(10);
    expect(DIRECTOR_TRANSCRIPT_TURNS).toBe(8);

    const turns: Turn[] = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: i % 3 === 0 ? 'user' as const : 'narrator' as const,
      mode: i % 3 === 0 ? 'speak' as const : null,
      text: `Turn ${i} unique-token-${i}`,
      createdAt: i
    }));
    const user = directorUserPrompt(ctx({ turns }), 'speak', 'Hello?');
    expect(user).toMatch(/unique-token-39/);
    expect(user).toMatch(/Harbour Feast|Calendar due/i);
    // Oldest packed turns beyond the director window should not all appear.
    expect(user.includes('unique-token-0')).toBe(false);
  });

  it('packs director transcript under a tight totalCap', () => {
    const turns: Turn[] = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: 'narrator' as const,
      mode: null,
      text: `Turn ${i} unique-token-${i} ` + 'y'.repeat(800),
      createdAt: i
    }));
    const uncapped = directorUserPrompt(ctx({ turns }), 'speak', 'Hello?');
    const capped = directorUserPrompt(ctx({ turns }), 'speak', 'Hello?', { totalCap: 14_000 });
    expect(capped.length).toBeLessThan(uncapped.length);
    expect(capped).toMatch(/unique-token-39/);
  });

  it('reports turn-taking and in-room ties so the director can vary who answers', () => {
    const cast = [
      npc('c1', 'Ada'),
      npc('c2', 'Ben', {
        relationships: [{ targetId: 'c1', kind: 'rival', note: 'after the same ledger' }]
      })
    ];
    const turns: Turn[] = ['first', 'second'].map((text, i) => ({
      id: `t${i}`,
      episodeId: 'e',
      worldId: 'w',
      role: 'character' as const,
      mode: null,
      characterId: 'c1',
      text,
      createdAt: i
    }));
    const user = directorUserPrompt(
      ctx({ characters: cast, episode: { ...episode(), castIds: ['c1', 'c2'] }, turns }),
      'speak',
      'Ben, where were you?'
    );
    expect(user).toMatch(/Room dynamics/);
    expect(user).toMatch(/Last voice in the room: Ada\./);
    expect(user).toMatch(/Has not spoken this episode: Ben\./);
    expect(user).toMatch(/aimed at: Ben\./);
    expect(user).toMatch(/Ben → Ada: rival — after the same ledger/);
  });

  it('tells the director to register an answer to the last NPC question', () => {
    const turns: Turn[] = [
      {
        id: 't0', episodeId: 'e', worldId: 'w', role: 'character', mode: null,
        characterId: 'c1', text: '*looks up* "Where were you last night?"', createdAt: 0
      },
      {
        id: 't1', episodeId: 'e', worldId: 'w', role: 'user', mode: 'speak',
        text: 'At the quay.', createdAt: 1
      }
    ];
    const user = directorUserPrompt(ctx({ turns }), 'speak', 'At the quay.');
    expect(user).toMatch(/Ada asked a question/);
    expect(user).toMatch(/Take the answer as heard/i);
  });

  it('tells the speaking character the player already answered', () => {
    const ada = npc('c1', 'Ada');
    const turns: Turn[] = [
      {
        id: 't0', episodeId: 'e', worldId: 'w', role: 'character', mode: null,
        characterId: 'c1', text: '"Who paid Ivo?"', createdAt: 0
      },
      {
        id: 't1', episodeId: 'e', worldId: 'w', role: 'user', mode: 'speak',
        text: 'Marisol did.', createdAt: 1
      }
    ];
    const msgs = buildCharacterSpeakMessages(turns, [ada], ada, 'press them', []);
    const last = msgs.at(-1)?.content ?? '';
    expect(last).toMatch(/Ada asked a question/);
    expect(last).toMatch(/do not ask it again/i);
  });

  it('keeps the heard-answer cue after a later NPC speak beat', () => {
    const ada = npc('c1', 'Ada');
    const ben = npc('c2', 'Ben');
    const turns: Turn[] = [
      {
        id: 't0', episodeId: 'e', worldId: 'w', role: 'character', mode: null,
        characterId: 'c1', text: '"Who paid Ivo?"', createdAt: 0
      },
      {
        id: 't1', episodeId: 'e', worldId: 'w', role: 'user', mode: 'speak',
        text: 'Marisol did.', createdAt: 1
      },
      {
        id: 't2', episodeId: 'e', worldId: 'w', role: 'character', mode: null,
        characterId: 'c2', text: '"We already knew that."', createdAt: 2
      }
    ];
    const msgs = buildCharacterSpeakMessages(turns, [ada, ben], ada, 'press them', []);
    const last = msgs.at(-1)?.content ?? '';
    expect(last).toMatch(/Ada asked a question/);
    expect(last).toMatch(/do not ask it again/i);
  });

  it('omits the dynamics block when nobody is on stage', () => {
    const user = directorUserPrompt(
      ctx({ characters: [], episode: { ...episode(), castIds: [] } }),
      'steer',
      'Look around.'
    );
    expect(user).not.toMatch(/Room dynamics/);
    expect(user).not.toMatch(/Ties inside the room/);
  });

  it('puts continuity before the running summary so facts outrank glue', () => {
    const continuity: ContinuityFact[] = [{
      id: 'f1', worldId: 'w', seasonId: 's', episodeId: 'e',
      text: 'Ada still has the brass office key',
      source: 'auto', createdAt: 1
    }];
    const user = directorUserPrompt(
      ctx({
        continuity,
        episode: { ...episode(), runningSummary: 'A mushy recap that might forget the key.' }
      }),
      'speak',
      'Hello?'
    );
    const factAt = user.indexOf('Ada still has the brass office key');
    const glueAt = user.indexOf('A mushy recap that might forget the key.');
    expect(factAt).toBeGreaterThan(0);
    expect(glueAt).toBeGreaterThan(factAt);
    expect(user).toMatch(/outrank any running summary/);
  });

  it('includes compact plot targets for longform director', () => {
    const user = directorUserPrompt(ctx(), 'continue', '');
    expect(user).toMatch(/Plot targets/);
    expect(user).toMatch(/stolen harbour ledger/i);
  });

  it('skips compact plot targets for wander and sandbox director', () => {
    for (const stance of ['wander', 'sandbox'] as const) {
      const user = directorUserPrompt(
        ctx({ world: { ...world(), storyStance: stance } }),
        'continue',
        ''
      );
      expect(user).not.toMatch(/Plot targets/);
      expect(user).not.toMatch(/stolen harbour ledger/i);
    }
  });
});

describe('beat-scoped character layers', () => {
  const fat = (id: string, name: string): Character => npc(id, name, {
    appearance: `${name} appearance mark`,
    mannerisms: `${name} mannerism tic`,
    backstory: `${name} UNIQUE_BACKSTORY never for narrator`,
    exampleLines: [`"${name} UNIQUE_EXAMPLE"`],
    desires: `${name} UNIQUE_DESIRE`,
    fears: `${name} UNIQUE_FEAR`,
    secrets: `${name} UNIQUE_SECRET`,
    speechStyle: `${name} drawl`,
    anchors: [`${name} never kneels`],
    state: { goal: `${name} UNIQUE_GOAL`, emotion: 'wary', location: 'office', condition: '' }
  });

  it('gives narrator presence for the room and psyche only for focus', () => {
    const names = ['Ada', 'Ben', 'Cora', 'Dax', 'Eve', 'Fay'] as const;
    const characters = names.map((n, i) => fat(`c${i + 1}`, n));
    const prompt = buildNarratorSystemPrompt(
      ctx({
        characters,
        episode: { ...episode(), castIds: characters.map((c) => c.id) }
      }),
      { focusIds: ['c1'] }
    );
    for (const n of names) {
      expect(prompt).toContain(`${n} appearance mark`);
      expect(prompt).toContain(`${n} mannerism tic`);
      expect(prompt).not.toContain(`${n} UNIQUE_BACKSTORY`);
      expect(prompt).not.toContain(`${n} UNIQUE_EXAMPLE`);
    }
    expect(prompt).toContain('Ada UNIQUE_DESIRE');
    expect(prompt).not.toContain('Ben UNIQUE_DESIRE');
    expect(prompt).toContain('Ada UNIQUE_GOAL');
    expect(prompt).toContain('Ben UNIQUE_GOAL');
    expect(prompt).toContain('Never describe the sea as wine-dark.');
    expect(prompt).toContain('salt-rot wood and wet wool');
    expect(prompt).toContain('Against generic prose');
    expect(prompt).toMatch(/named mannerism|physical tic/i);
  });

  it('gives speak agent voice for self and presence for others', () => {
    const ada = fat('c1', 'Ada');
    const ben = fat('c2', 'Ben');
    const prompt = buildCharacterSystemPrompt(
      ctx({
        characters: [ada, ben],
        episode: { ...episode(), castIds: ['c1', 'c2'] }
      }),
      ada
    );
    expect(prompt).toContain('Ada UNIQUE_EXAMPLE');
    expect(prompt).toContain('Ada UNIQUE_BACKSTORY');
    expect(prompt).toContain('Ben appearance mark');
    expect(prompt).not.toContain('Ben UNIQUE_EXAMPLE');
    expect(prompt).not.toContain('Ben UNIQUE_BACKSTORY');
    expect(prompt).toContain('Against generic prose');
  });

  it('holds the narrator to details the prose already established', () => {
    const prompt = buildNarratorSystemPrompt(
      ctx({
        episode: {
          ...episode(),
          sceneLedger: ['Rain has not let up on the office glass', 'The desk lamp is broken']
        }
      }),
      { focusIds: ['c1'] }
    );
    expect(prompt).toMatch(/Already true in this room/);
    expect(prompt).toContain('The desk lamp is broken');
    expect(prompt).toMatch(/Do not re-introduce them as if new/);
  });

  it('shares the established details with speak agents', () => {
    const prompt = buildCharacterSystemPrompt(
      ctx({ episode: { ...episode(), sceneLedger: ['The desk lamp is broken'] } }),
      npc('c1', 'Ada')
    );
    expect(prompt).toContain('The desk lamp is broken');
  });

  it('omits the ledger section when nothing is established', () => {
    expect(buildNarratorSystemPrompt(ctx(), { focusIds: ['c1'] }))
      .not.toMatch(/Already true in this room/);
    expect(sceneLedgerSection({ ...episode(), sceneLedger: [] })).toBeNull();
    expect(sceneLedgerSection({ ...episode(), sceneLedger: ['  '] })).toBeNull();
  });

  it('trims the ledger on a tight pack', () => {
    const sceneLedger = ['one', 'two', 'three', 'four', 'five', 'six'];
    const section = sceneLedgerSection({ ...episode(), sceneLedger }, 4) ?? '';
    expect(section).toContain('- four');
    expect(section).not.toContain('- five');
  });

  it('keeps atmosphere and rules on a tight pack', () => {
    const prompt = buildNarratorSystemPrompt(ctx(), { pack: 'tight', focusIds: ['c1'] });
    expect(prompt).toContain('salt-rot wood and wet wool');
    expect(prompt).toContain('No blades past the rail.');
    expect(prompt).toContain('Never describe the sea as wine-dark.');
    expect(prompt).not.toContain('LONG_HISTORY_SHOULD_DROP_ON_TIGHT');
  });

  it('treats the running summary as glue that continuity outranks', () => {
    const continuity: ContinuityFact[] = [{
      id: 'f1', worldId: 'w', seasonId: 's', episodeId: 'e',
      text: 'Ada still has the brass office key',
      source: 'auto', createdAt: 1
    }];
    const threads: OpenThread[] = [{
      id: 'th1', worldId: 'w', seasonId: 's', text: 'Who paid Ivo?',
      openedLabel: 'opened S1 · E2', status: 'open', createdAt: 1
    }];
    const prompt = buildNarratorSystemPrompt(
      ctx({
        continuity,
        threads,
        episode: {
          ...episode(),
          runningSummary: 'A mushy recap that might forget the key.',
          sceneLedger: ['Rain on the glass']
        }
      }),
      { pack: 'tight', focusIds: ['c1'] }
    );
    const factAt = prompt.indexOf('Ada still has the brass office key');
    const glueAt = prompt.indexOf('A mushy recap that might forget the key.');
    expect(factAt).toBeGreaterThan(0);
    expect(glueAt).toBeGreaterThan(factAt);
    expect(prompt).toMatch(/Glue only/i);
    expect(prompt).toContain('Rain on the glass');
  });
});

describe('context window heuristics', () => {
  it('defaults unknown models to 32k', () => {
    expect(inferContextWindowTokens('some-local-chat')).toBe(32_768);
  });

  it('recognizes gemini, claude, and suffix windows', () => {
    expect(inferContextWindowTokens('gemini-2.5-flash')).toBe(1_048_576);
    expect(inferContextWindowTokens('claude-haiku-4-5')).toBe(200_000);
    expect(inferContextWindowTokens('my-model-8k')).toBe(8 * 1024);
  });

  it('does not shrink output maxTokens into the prompt budget math below the floor', () => {
    expect(promptCharBudget('unknown', 1100)).toBeGreaterThanOrEqual(12_000);
  });
});

describe('isContextOverflowError', () => {
  it('detects common provider overflow copy', () => {
    expect(isContextOverflowError(new Error('context_length_exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('This model\'s maximum context length is 8192'))).toBe(true);
    expect(isContextOverflowError(new Error('prompt is too long'))).toBe(true);
    expect(isContextOverflowError(new Error('input tokens exceed the limit'))).toBe(true);
    expect(isContextOverflowError(new Error('max prompt size exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('HTTP 413'))).toBe(true);
    expect(isContextOverflowError(new AIError('payload too large', 413))).toBe(true);
    expect(isContextOverflowError(new Error('rate limited'))).toBe(false);
  });

  it('retries a tight pack on empty model replies', () => {
    const empty = new AIError('The model returned an empty response (stop: stop).');
    expect(isEmptyModelResponse(empty)).toBe(true);
    expect(isPromptPackRetryError(empty)).toBe(true);
    expect(isPromptPackRetryError(new Error('rate limited'))).toBe(false);
  });
});

describe('narration brief contract', () => {
  it('asks the director for named bodies and one sensory job', () => {
    const sys = directorSystemPrompt('speak', true, 'scene');
    expect(sys).toMatch(/who moves/i);
    expect(sys).toMatch(/sensory job/i);
    expect(sys).toMatch(/never a weather catalogue/i);
    expect(sys).toMatch(/want or friction/i);
    expect(sys).toMatch(/room is not a queue/i);
    expect(sys).toMatch(/End the plan on an opening/i);
    expect(sys).not.toMatch(/End the plan on tension/i);
    expect(sys).toMatch(/take that answer as heard/i);
    expect(sys).toMatch(/same question/i);
    expect(sys).toMatch(/last speak in the plan/i);
    expect(sys).toMatch(/unanswered question/i);
  });

  it('steers wander stance away from a plot clock', () => {
    const sys = directorSystemPrompt('speak', true, 'scene', 'wander');
    expect(sys).toMatch(/Story stance: wander/i);
    expect(sys).not.toMatch(/End the plan on tension/i);
    const prompt = buildNarratorSystemPrompt(ctx({ world: { ...world(), storyStance: 'wander' } }));
    expect(prompt).toMatch(/Story stance: wander/i);
    expect(prompt).not.toMatch(/End every response on tension/i);
  });

  it('tells the narrator not to recap and to use named bodies', () => {
    const msgs = buildNarrationBeatMessages([], [], 'Ada crosses to the desk.', 'scene');
    const last = msgs.at(-1)?.content ?? '';
    expect(last).toMatch(/named bodies/i);
    expect(last).toMatch(/do not recap/i);
    expect(last).toContain('Ada crosses to the desk.');
  });
});

describe('token-efficient packing', () => {
  const manyTurns = (): Turn[] => Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, episodeId: 'e', worldId: 'w',
    role: 'narrator' as const, mode: null,
    text: `Beat ${i} unique-token-${i} ${'x'.repeat(80)}`,
    createdAt: i
  }));

  it('never ships a running summary and an omitted digest together', () => {
    const history = manyTurns();
    const withSummary = buildNarrationBeatMessages(
      history, [npc('c1', 'Ada')], 'Look around.', 'scene', [],
      { ...episode(), runningSummary: 'A mushy recap of the same early beats.' },
      0, { totalCap: 12_000 }
    );
    const blob = withSummary.map((m) => m.content).join('\n');
    expect(blob).not.toMatch(/Compressed earlier beats/);
    expect(blob).not.toMatch(/A mushy recap of the same early beats/);

    const withoutSummary = buildNarrationBeatMessages(
      history, [npc('c1', 'Ada')], 'Look around.', 'scene', [],
      { ...episode(), runningSummary: null },
      0, { totalCap: 12_000 }
    );
    expect(withoutSummary.map((m) => m.content).join('\n')).toMatch(/Compressed earlier beats/);
  });

  it('keeps omitted-turn digest unless skipOmittedDigest is set', () => {
    const history = manyTurns();
    const ep = { ...episode(), runningSummary: null };
    const skipped = buildNarrationBeatMessages(
      history, [npc('c1', 'Ada')], 'Look around.', 'scene', [], ep, 0,
      { totalCap: 12_000, skipOmittedDigest: true }
    );
    expect(skipped.map((m) => m.content).join('\n')).not.toMatch(/Compressed earlier beats/);
  });

  it('keeps the cached prefix stable when only turns change', () => {
    const a = storyCachePrefix(ctx({ turns: manyTurns().slice(0, 4) }));
    const b = storyCachePrefix(ctx({ turns: manyTurns() }));
    expect(a).toBe(b);
  });

  it('shares the same prefix bytes across narrator and speak in one Write', () => {
    const frame = ctx({ turns: manyTurns().slice(0, 4) });
    const prefix = storyCachePrefix(frame);
    expect(buildNarratorSystemPrompt(frame).startsWith(prefix)).toBe(true);
    expect(buildCharacterSystemPrompt(frame, npc('c1', 'Ada')).startsWith(prefix)).toBe(true);
  });

  it('sends a smaller director payload than the narrator frame', () => {
    const frame = ctx({ turns: manyTurns().slice(0, 20) });
    expect(directorUserPrompt(frame, 'speak', 'Hello?').length)
      .toBeLessThan(buildNarratorSystemPrompt(frame).length);
  });

  it('caps the verbatim tail well below the wrap-nudge budget', () => {
    const { kept } = packTurnsDetailed(manyTurns());
    expect(kept.length).toBeLessThanOrEqual(16);
    expect(kept.at(-1)?.id).toBe('t39');
  });
});
