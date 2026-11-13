import { describe, expect, it } from 'vitest';
import { DEFAULT_AI } from '../worldOps';
import type { Character, Episode, Location, Season, World } from '../types';
import { buildSceneReply, type PromptContext } from './prompts';
import { splitSceneReply, type SceneSpeaker } from './sceneReply';

const npc = (id: string, name: string): Character => ({
  id, worldId: 'w', name, role: 'registrar', age: '', appearance: '', mannerisms: '', summary: 'Keeps the books.',
  backstory: '', speechStyle: 'clipped', exampleLines: ['"Ledger says otherwise."'], traits: '', desires: '',
  fears: '', flaws: '', secrets: '', mustNotKnow: '', anchors: [], relationships: [],
  state: { goal: 'Close the books', emotion: 'wary', location: 'harbour office', condition: '' },
  customInstructions: '', hue: 0, isPlayer: false, selfTag: false, createdAt: 0, updatedAt: 0
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
  plotTargets: [],
  status: 'active',
  createdAt: 0,
  updatedAt: 0
});

const loc = (): Location => ({
  id: 'loc1', worldId: 'w', name: 'Harbour office', tagline: 'public desk', hue: 0,
  summary: 'A cramped registrar.', atmosphere: 'salt-rot wood and wet wool',
  features: '', history: '', inhabitants: 'the registrar', secrets: '',
  currentState: 'Quiet.', rules: [], customInstructions: '',
  createdAt: 0, updatedAt: 0
});

const episode = (): Episode => ({
  id: 'e', seasonId: 's', worldId: 'w', number: 2, title: '', location: 'Harbour office',
  locationId: 'loc1',
  castIds: ['c1', 'c2'], guests: [], wrap: null, storyDay: 12, status: 'active', createdAt: 0, updatedAt: 0
});

function ctx(): PromptContext {
  return {
    world: world(),
    season: season(),
    episode: episode(),
    characters: [npc('c1', 'Ada'), npc('c2', 'Ben')],
    locations: [loc()],
    continuity: [],
    threads: [],
    turns: []
  };
}

const mara: SceneSpeaker = { id: 'mara', name: 'Mara', kind: 'cast' };

describe('buildSceneReply', () => {
  it('puts the allowed speaker and the player line at the end, with no director call', () => {
    const built = buildSceneReply({
      ctx: ctx(),
      mode: 'speak',
      playerText: 'Where is the ledger?',
      length: 'beat',
      speakers: [{
        id: 'c1',
        name: 'Ada',
        kind: 'cast',
        role: 'registrar',
        voice: 'clipped',
        want: 'Close the books',
        example: 'Ledger says otherwise.',
        mustNotKnow: 'who forged it'
      }],
      present: [
        { name: 'Ada', role: 'registrar' },
        { name: 'Ben', role: 'clerk' }
      ]
    });
    const last = built.messages[built.messages.length - 1];
    expect(last?.role).toBe('user');
    const cue = last?.content ?? '';
    expect(cue).toContain('Only Ada may speak');
    expect(cue).toContain('Where is the ledger?');
    expect(cue.lastIndexOf('Where is the ledger?')).toBeGreaterThan(cue.indexOf('Only Ada'));
    expect(built.system).toContain('## Here');
    expect(built.system).toContain('Also here, and they do not get a line: Ben (clerk).');
    expect(built.system.indexOf('## Here')).toBeLessThan(built.system.length);
    const blob = `${built.system}\n${built.messages.map((m) => m.content).join('\n')}`;
    expect(blob).not.toMatch(/plan_turn|castDelta/);
  });
});

describe('splitSceneReply', () => {
  it('gives a named quote to that person and leaves an unnamed mutter in the narration', () => {
    const named = splitSceneReply(
      'Rain on the glass. Mara looked up. "You\'re late," Mara said.',
      [mara]
    );
    expect(named.some((piece) =>
      piece.role === 'character' && piece.speakerId === 'mara' && piece.text.includes("You're late")
    )).toBe(true);

    const unnamed = splitSceneReply('Someone muttered "maybe."', [mara]);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]?.role).toBe('narrator');
    expect(unnamed[0]?.text).toContain('maybe');
  });
});
