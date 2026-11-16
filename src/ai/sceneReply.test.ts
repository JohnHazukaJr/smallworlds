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
  it('names who should answer, cards the room, and keeps the player line last', () => {
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
    expect(cue).toContain('Ada answers in their own voice');
    expect(cue).toContain('Anyone else already here may speak');
    expect(cue).toContain('Where is the ledger?');
    expect(cue.lastIndexOf('Where is the ledger?')).toBeGreaterThan(cue.indexOf('Ada answers'));
    expect(cue).not.toContain('Only Ada may speak');
    expect(built.system).toContain('## Here');
    expect(built.system).toContain('### Ada');
    expect(built.system).toContain('Also here, and they may speak if the moment needs them: Ben (clerk).');
    expect(built.system).not.toContain('do not get a line');
    const blob = `${built.system}\n${built.messages.map((m) => m.content).join('\n')}`;
    expect(blob).not.toMatch(/plan_turn|castDelta/);
  });

  it('cards the rest of the room and still names only the answerer', () => {
    const built = buildSceneReply({
      ctx: ctx(),
      mode: 'speak',
      playerText: 'Where is the ledger?',
      length: 'scene',
      speakers: [
        {
          id: 'c1', name: 'Ada', kind: 'cast', role: 'registrar', voice: 'clipped'
        },
        {
          id: 'c2', name: 'Ben', kind: 'cast', role: 'clerk', voice: 'quiet'
        }
      ],
      answerers: [{ name: 'Ada' }],
      present: [
        { name: 'Ada', role: 'registrar' },
        { name: 'Ben', role: 'clerk' }
      ]
    });
    const cue = built.messages[built.messages.length - 1]?.content ?? '';
    expect(cue).toContain('Ada answers in their own voice');
    expect(cue).toContain('Anyone else already here may speak');
    expect(cue).not.toContain('Only Ada');
    expect(cue).not.toContain('do not get a line');
    expect(built.system).toContain('### Ada');
    expect(built.system).toContain('### Ben');
    expect(built.system.indexOf('### Ada')).toBeLessThan(built.system.indexOf('### Ben'));
    expect(built.system).not.toContain('do not get a line');
  });
});

const ada: SceneSpeaker = { id: 'ada', name: 'Ada', kind: 'cast', role: 'registrar' };
const ben: SceneSpeaker = { id: 'ben', name: 'Ben', kind: 'cast', role: 'clerk' };

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

  it('credits the speech tag, not the nearest other name', () => {
    const introduced = splitSceneReply('Ada said, "The books are closed."', [ada, ben]);
    expect(introduced).toContainEqual(expect.objectContaining({
      role: 'character', speakerId: 'ada', kind: 'cast'
    }));

    const after = splitSceneReply('Ada watched Ben leave. "Fine," she said.', [ada, ben]);
    expect(after.find((piece) => piece.role === 'character')?.speakerId).toBe('ada');

    const closed = splitSceneReply('Ada watched Ben leave. "Fine," Ben said.', [ada, ben]);
    expect(closed.find((piece) => piece.role === 'character')?.speakerId).toBe('ben');

    const afterAPeriod = splitSceneReply('Ada said nothing. "Fine," Ben said.', [ada, ben]);
    expect(afterAPeriod.find((piece) => piece.role === 'character')?.speakerId).toBe('ben');
  });

  it('credits a role only that person owns', () => {
    const unique = splitSceneReply(
      'The registrar set the stamp down. "Closed," the registrar said.',
      [ada, ben]
    );
    expect(unique.find((piece) => piece.role === 'character')?.speakerId).toBe('ada');

    const shared = splitSceneReply(
      '"Closed," the registrar said.',
      [ada, { id: 'cal', name: 'Cal', kind: 'cast', role: 'registrar' }]
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]?.role).toBe('narrator');
  });

  it('takes a screenplay line that names someone here', () => {
    const quoted = splitSceneReply('The lamp ticks.\nAda: "Closed."', [ada, ben]);
    expect(quoted.map((piece) => piece.role)).toEqual(['narrator', 'character']);
    expect(quoted[0]?.text).toContain('lamp');
    expect(quoted[0]?.text).not.toMatch(/Ada/);
    expect(quoted[1]).toMatchObject({ speakerId: 'ada', text: '"Closed."' });

    const bare = splitSceneReply('Ada: Closed.', [ada]);
    expect(bare).toEqual([expect.objectContaining({
      role: 'character', speakerId: 'ada', text: '"Closed."'
    })]);
  });

  it('leaves an unnamed quote in the narration, even when only one person is here', () => {
    const hers = splitSceneReply('The stamp came down. "Closed."', [ada]);
    expect(hers.every((piece) => piece.role === 'narrator')).toBe(true);
    expect(hers.map((piece) => piece.text).join(' ')).toContain('Closed');

    const namedOther = splitSceneReply('Ben said, "I heard you."', [ada, ben]);
    expect(namedOther.find((piece) => piece.role === 'character')?.speakerId).toBe('ben');

    const mutter = splitSceneReply('Someone muttered "maybe."', [ada]);
    expect(mutter).toHaveLength(1);
    expect(mutter[0]?.role).toBe('narrator');
    expect(mutter[0]?.text).toContain('maybe');

    const stranger = splitSceneReply('Bob said, "Leave."', [ada]);
    expect(stranger.every((piece) => piece.role === 'narrator')).toBe(true);

    const unnamed = splitSceneReply('The stamp came down. "Closed."', [ada, ben]);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]?.role).toBe('narrator');
    expect(unnamed[0]?.text).toContain('Closed');
  });

  it('keeps an open quote in the narration and credits an alias or a guest', () => {
    const open = splitSceneReply('Ada said, "Clos', [ada]);
    expect(open).toHaveLength(1);
    expect(open[0]?.role).toBe('narrator');

    const red: SceneSpeaker = { id: 'ada', name: 'Ada', kind: 'cast', aliases: ['Red'] };
    const alias = splitSceneReply('"Evening," Red said.', [red]);
    expect(alias.find((piece) => piece.role === 'character')).toMatchObject({
      speakerId: 'ada', kind: 'cast'
    });

    const guest: SceneSpeaker = { id: 'g1', name: 'Ned', kind: 'guest' };
    const walkOn = splitSceneReply('Ned said, "Just passing."', [ada, guest]);
    expect(walkOn.find((piece) => piece.role === 'character')).toMatchObject({
      speakerId: 'g1', kind: 'guest'
    });
  });
});
