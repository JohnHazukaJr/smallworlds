/**
 * Fixed scenes for the NPC eval. Each one seeds a small world, plays one move
 * through the real writeTurn, and says what a good reply must and must not do.
 *
 * The cast is shared so the judge sees the same people across scenes, and so
 * each person's voice is distinct enough that a blur between them shows.
 */

import type { CharacterImportance, TurnLength } from '../types';

export interface EvalPerson {
  /** Stable key used by scenarios and graders. */
  key: string;
  name: string;
  role: string;
  aliases?: string[];
  importance?: CharacterImportance;
  hue: number;
  age: string;
  summary: string;
  speechStyle: string;
  exampleLines: string[];
  traits: string;
  desires: string;
  fears: string;
  secrets?: string;
  mustNotKnow?: string;
  anchors?: string[];
  emotion?: string;
  goal?: string;
  /** Things they lived through, from their side. */
  memories?: Array<{ text: string; feeling?: string; salience: 1 | 2 | 3 }>;
  /** How they stand toward the player. */
  towardPlayer?: { kind: string; note: string };
}

export interface EvalGuest {
  key: string;
  name: string;
  brief: string;
  voice?: string;
}

export interface EvalLine {
  /** 'player' for the player's own move. */
  who: 'player' | 'narrator' | string;
  text: string;
}

export interface EvalScenario {
  id: string;
  title: string;
  /** The failure this scene is built to catch. */
  probes: string;
  /** Keys of cast in the room. Everyone else in CAST exists but is elsewhere. */
  present: string[];
  guests?: EvalGuest[];
  /** Earlier lines in this chapter, oldest first. */
  history: EvalLine[];
  move: {
    /** What the player types, exactly as in the Write box. */
    input: string;
    /** Direct (author instruction) instead of a player move. */
    direct?: boolean;
    /** Continue with no input. */
    continue?: boolean;
    /** Addressed to this cast or guest key, as the "To" picker would. */
    to?: string;
    length?: TurnLength;
  };
  expect: {
    /** This person must speak at least one quoted line. */
    replier?: string;
    /** These people must not have any credited line. */
    silent?: string[];
    /** At least one NPC line in quotes. */
    spoken?: boolean;
    /**
     * Phrases that must not appear. `who` limits the check to that person's lines;
     * omitted means anywhere in the reply.
     */
    forbidden?: Array<{ who?: string; phrases: string[]; why: string }>;
  };
  /** What the judge should weigh most for this scene. */
  judgeFocus: string;
}

export const EVAL_WORLD = {
  title: 'Saltmere',
  line: 'A fog harbour where every debt is written down.',
  bible: [
    'Saltmere is a cold harbour town under near-permanent fog. The Registry records every cargo, debt, and death;',
    'a forged entry is a hanging offence. The tide bell rings each hour. Lamps burn whale oil and smell of it.',
    'Technology: sail, ledgers, oil lamps, no firearms. People are wary of strangers and talk in half-sentences.'
  ].join(' '),
  premise: 'A ledger page has been forged, and someone in the Registry knows who did it.',
  place: {
    name: 'The Long Room',
    summary: 'The Registry’s records hall: tall shelves of ledgers, one long table, a stove that never quite warms it.',
    atmosphere: 'Lamp-smoke under the beams, tide sound through the floor, the dry smell of old paper.'
  },
  player: {
    name: 'Rowan',
    summary: 'A newly hired clerk at the Registry, quietly investigating the forged page.'
  }
};

export const CAST: EvalPerson[] = [
  {
    key: 'ada',
    name: 'Ada Vey',
    role: 'chief registrar',
    aliases: ['Ada', 'Registrar'],
    importance: 'lead',
    hue: 200,
    age: '46',
    summary: 'Runs the Registry with total precision. Trusts paper more than people.',
    speechStyle: 'Clipped. Short declaratives, no small talk, never swears. Answers questions with questions when cornered.',
    exampleLines: ['Read it again.', 'Ink dries. Excuses don’t.', 'Who signed for it?'],
    traits: 'exacting, private, proud, dry',
    desires: 'To keep the Registry beyond reproach.',
    fears: 'That the forgery came from inside her own office.',
    secrets: 'She signed the forged page herself, under pressure from the Harbour Council, to cover a lost cargo of grain.',
    anchors: ['Never raises her voice.', 'Never admits a mistake out loud in front of others.'],
    emotion: 'guarded',
    goal: 'Find out how much Rowan has seen.',
    memories: [
      { text: 'Caught Rowan alone in the sealed archive after hours', feeling: 'alarmed', salience: 3 }
    ],
    towardPlayer: { kind: 'employer', note: 'Hired Rowan two weeks ago; now regrets it.' }
  },
  {
    key: 'brannoc',
    name: 'Brannoc Hale',
    role: 'dockmaster',
    aliases: ['Brannoc', 'Dockmaster'],
    importance: 'regular',
    hue: 30,
    age: '58',
    summary: 'Loud, warm, and much sharper than he lets on. Has run the docks for thirty years.',
    speechStyle: 'Big and loose. Long rambling sentences, sea-slang ("aye", "by the tide"), jokes when nervous, calls people "lad" or "lass".',
    exampleLines: [
      'Aye, and if the fog had teeth we’d all be supper, lad.',
      'By the tide, you’ve a face like a wet Tuesday.',
      'Ask me no ledgers and I’ll tell you no lies.'
    ],
    traits: 'jovial, evasive, loyal, shrewd',
    desires: 'To keep his dockhands out of trouble.',
    fears: 'Being blamed for the missing grain.',
    secrets: 'He watched the grain ship unload at night and said nothing.',
    emotion: 'jumpy under the jokes',
    goal: 'Steer talk away from the grain ship.',
    towardPlayer: { kind: 'acquaintance', note: 'Likes Rowan; drinks with them sometimes.' }
  },
  {
    key: 'ilse',
    name: 'Sister Ilse',
    role: 'tide chaplain',
    aliases: ['Ilse', 'Sister'],
    importance: 'regular',
    hue: 280,
    age: '63',
    summary: 'Keeps the drowned-book of the dead. Gentle, formal, unshockable.',
    speechStyle: 'Soft and formal. Full sentences, old-fashioned phrasing ("I should think", "child"), never uses contractions.',
    exampleLines: [
      'The sea keeps its own ledger, child. We merely copy it.',
      'I should think the truth will keep until morning.',
      'Sit. You have been walking in circles since the bell.'
    ],
    traits: 'patient, perceptive, merciful, stubborn',
    desires: 'That the dead are recorded truly.',
    fears: 'That a lie in the drowned-book will damn a family.',
    mustNotKnow: 'Ilse does not know that Ada Vey signed the forged page. She believes Ada is blameless.',
    emotion: 'calm',
    goal: 'Comfort whoever needs it.',
    towardPlayer: { kind: 'confidante', note: 'Rowan confides in her.' }
  },
  {
    key: 'corin',
    name: 'Corin Marsh',
    role: 'harbour councillor',
    aliases: ['Corin', 'Councillor'],
    importance: 'occasional',
    hue: 120,
    age: '39',
    summary: 'Ambitious councillor who pressured Ada into the forgery. Smooth and dangerous.',
    speechStyle: 'Silky, flattering, always a veiled threat underneath.',
    exampleLines: ['What a diligent clerk you are. Diligence can be so tiring.'],
    traits: 'charming, ruthless, vain',
    desires: 'A seat at the head of the Council.',
    fears: 'The forgery being traced to him.',
    emotion: 'composed',
    goal: 'Stay well away from the Registry this week.'
  }
];

export const SCENARIOS: EvalScenario[] = [
  {
    id: 'address-by-name',
    title: 'The quiet one is asked by name',
    probes: 'The person named answers, not the loudest or last speaker.',
    present: ['ada', 'brannoc'],
    history: [
      { who: 'player', text: 'I set the cargo manifest on the table.' },
      { who: 'brannoc', text: '"Ha! Paper again. By the tide, lad, you’ll bury us all in paper."' }
    ],
    move: { input: 'Ada, who signed this page?', length: 'beat' },
    expect: { replier: 'ada', spoken: true },
    judgeFocus: 'Ada answers in her clipped voice. Brannoc does not take over the answer.'
  },
  {
    id: 'address-loose',
    title: 'Spoken to without a comma',
    probes: 'A name at the end of a question with no comma still gets that person’s spoken answer, not narration or silence.',
    present: ['ada', 'brannoc'],
    history: [
      { who: 'narrator', text: 'The stove ticks. Brannoc is warming his hands; Ada is reading.' }
    ],
    move: { input: 'Did you see who took the ledger last night Brannoc?', length: 'beat' },
    expect: { replier: 'brannoc', spoken: true },
    judgeFocus: 'Brannoc answers out loud, in his own voice. The reply is not only narration of what he does.'
  },
  {
    id: 'address-by-role',
    title: 'Addressed by role, not name',
    probes: 'A role word only one person owns ("Dockmaster") routes the reply to them.',
    present: ['ada', 'brannoc'],
    history: [
      { who: 'ada', text: '"Sit down, Rowan."' }
    ],
    move: { input: 'Dockmaster, were you on the quay the night the grain ship came in?', length: 'beat' },
    expect: { replier: 'brannoc', spoken: true },
    judgeFocus: 'Brannoc answers, evasive and joking, in sea-slang. Ada does not answer for him.'
  },
  {
    id: 'secret-pressed',
    title: 'A secret under direct pressure',
    probes: 'A character keeps a secret they would keep, even when asked point blank.',
    present: ['ada'],
    history: [
      { who: 'player', text: 'I lay the forged page in front of her.' },
      { who: 'narrator', text: 'The lamp gutters. Ada does not look at the page.' }
    ],
    move: { input: '"I know this is your hand, Ada. Tell me why."', length: 'beat' },
    expect: {
      replier: 'ada',
      spoken: true,
      forbidden: [{
        who: 'ada',
        phrases: ['I signed it', 'I forged', 'the Council made me', 'Corin made me', 'lost cargo', 'the grain was lost'],
        why: 'Ada never admits a mistake out loud and would not confess on the first push.'
      }]
    },
    judgeFocus: 'Ada stays in character: deflects, questions back, maybe a crack of fear, but does not confess.'
  },
  {
    id: 'knowledge-wall',
    title: 'Someone who must not know',
    probes: 'A character never speaks knowledge they are walled off from.',
    present: ['ilse'],
    history: [
      { who: 'player', text: 'I sit beside Sister Ilse at the stove.' }
    ],
    move: { input: '"Sister, do you think the Registrar could ever forge a page?"', length: 'beat' },
    expect: {
      replier: 'ilse',
      spoken: true,
      forbidden: [{
        who: 'ilse',
        phrases: ['she signed', 'Ada signed', 'she forged', 'Ada forged', 'the Council pressed', 'Corin'],
        why: 'Ilse does not know Ada signed the page and believes she is blameless.'
      }]
    },
    judgeFocus: 'Ilse defends Ada sincerely, with no hint she knows the truth. Formal speech with no contractions.'
  },
  {
    id: 'offstage-silent',
    title: 'Asking about someone who is not here',
    probes: 'A person who is elsewhere does not walk in and speak just because they were named.',
    present: ['brannoc'],
    history: [
      { who: 'brannoc', text: '"Another cold one. Fog’s thick enough to chew."' }
    ],
    move: { input: '"What do you make of Councillor Corin Marsh?"', length: 'beat' },
    expect: { replier: 'brannoc', silent: ['corin', 'ada', 'ilse'], spoken: true },
    judgeFocus: 'Brannoc talks about Corin; Corin does not appear or speak.'
  },
  {
    id: 'walk-on',
    title: 'A walk-on addressed directly',
    probes: 'A one-chapter guest answers when spoken to, under their own name.',
    present: ['brannoc'],
    guests: [{
      key: 'netter',
      name: 'Old Wenna',
      brief: 'A net-mender who sits by the stove every night and sees everything.',
      voice: 'Cracked, few words, laughs at her own jokes.'
    }],
    history: [
      { who: 'narrator', text: 'Old Wenna works a net by the stove, needle clicking.' }
    ],
    move: { input: '"Wenna, did you see anyone at the Registry door last night?"', to: 'netter', length: 'beat' },
    expect: { replier: 'netter', spoken: true },
    judgeFocus: 'Wenna answers in her own cracked few-word voice. Brannoc does not speak for her.'
  },
  {
    id: 'voice-contrast',
    title: 'Two voices, one question',
    probes: 'Two very different speakers stay distinct in the same reply.',
    present: ['brannoc', 'ilse'],
    history: [
      { who: 'player', text: 'I put the drowned-book and the cargo ledger side by side.' }
    ],
    move: { input: '"The names don’t match. What do you both make of it?"', length: 'scene' },
    expect: { spoken: true },
    judgeFocus: 'If both speak, Brannoc is loud and slangy and Ilse is formal with no contractions. Their lines are not interchangeable.'
  },
  {
    id: 'player-agency',
    title: 'The player’s hands, not the player’s heart',
    probes: 'The narrator does not write the player’s words, decisions, or feelings for them.',
    present: ['ada'],
    history: [
      { who: 'ada', text: '"You were in the sealed archive. Explain."' }
    ],
    move: { input: 'I hold her gaze and say nothing.', length: 'beat' },
    expect: {},
    judgeFocus: 'The reply shows Ada reacting to silence. It never puts words in Rowan’s mouth or tells Rowan what they feel or decide.'
  },
  {
    id: 'memory-callback',
    title: 'What she remembers',
    probes: 'A strong memory shapes how a character treats the player.',
    present: ['ada'],
    history: [
      { who: 'narrator', text: 'Morning. Ada is already at the long table when Rowan comes in.' }
    ],
    move: { input: '"Do you trust me, Registrar?"', length: 'beat' },
    expect: { replier: 'ada', spoken: true },
    judgeFocus: 'Ada’s answer is coloured by having caught Rowan in the sealed archive. Distrust shows, in her clipped way.'
  },
  {
    id: 'direct-exit',
    title: 'An author instruction is followed',
    probes: 'Direct (author) instructions are carried out in the scene, not echoed as dialogue.',
    present: ['ada', 'brannoc'],
    history: [
      { who: 'brannoc', text: '"Well, I’ll not stand here while you two glare at each other."' }
    ],
    move: { input: 'Brannoc makes an excuse and leaves for the docks, clearly rattled.', direct: true, length: 'beat' },
    expect: {
      forbidden: [{ phrases: ['Brannoc makes an excuse and leaves'], why: 'The instruction should be shown, not pasted.' }]
    },
    judgeFocus: 'Brannoc leaves with a joking excuse that does not hide his nerves. The instruction text is not copied verbatim.'
  },
  {
    id: 'continue-scene',
    title: 'Continue with no input',
    probes: 'With no move from the player, the scene moves on without speaking for the player.',
    present: ['ada', 'ilse'],
    history: [
      { who: 'ilse', text: '"The bell has gone twice. I should think it is late enough for honesty."' },
      { who: 'ada', text: '"Is it."' }
    ],
    move: { input: '', continue: true, length: 'beat' },
    expect: {},
    judgeFocus: 'The scene advances with Ada and Ilse acting on their own wants. Rowan is not given lines or choices.'
  }
];

export function personByKey(key: string): EvalPerson | undefined {
  return CAST.find((p) => p.key === key);
}
