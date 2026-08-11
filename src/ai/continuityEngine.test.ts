import { describe, expect, it } from 'vitest';
import { textMatchScore } from './engine';
import {
  buildCharacterSystemPrompt,
  compressOmittedTurns,
  DIRECTOR_FACT_CAP,
  DIRECTOR_THREAD_CAP,
  DIRECTOR_TRANSCRIPT_TURNS,
  directorUserPrompt,
  type PromptContext
} from './prompts';
import { DEFAULT_AI } from '../worldOps';
import type { CalendarEvent, Character, Episode, Season, Turn, World } from '../types';

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
  ai: { ...DEFAULT_AI },
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

const episode = (): Episode => ({
  id: 'e', seasonId: 's', worldId: 'w', number: 2, title: '', location: 'Harbour office',
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
    locations: [],
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
  it('includes calendar texture and aimed situation pressure', () => {
    const prompt = buildCharacterSystemPrompt(ctx(), npc('c1', 'Ada'));
    expect(prompt).toMatch(/Situation pressure/i);
    expect(prompt).toMatch(/Harbour Feast/);
    expect(prompt).toMatch(/Aimed pressure/i);
    expect(prompt).toMatch(/harbour ledger/i);
    expect(prompt).toMatch(/Never prefix your reply with your name/i);
  });
});

describe('director prompt budgets', () => {
  it('exposes richer caps and recent transcript window', () => {
    expect(DIRECTOR_FACT_CAP).toBe(16);
    expect(DIRECTOR_THREAD_CAP).toBe(10);
    expect(DIRECTOR_TRANSCRIPT_TURNS).toBe(28);

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
});
