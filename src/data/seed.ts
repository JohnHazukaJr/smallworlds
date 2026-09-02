import { db, uid } from '../db';
import { emptyCharacter, emptyLocation } from '../worldOps';
import { DEFAULT_AI } from '../worldOps';
import type { Character, World } from '../types';

/**
 * The Registrar — the demo world from the design prototype, as real, editable records.
 * Optional starter content so the app isn't empty on first run.
 */
export async function seedStarterWorld(): Promise<string> {
  const now = Date.now();
  const worldId = uid();
  const seasonId = uid();
  const episodeId = uid();

  const world: World = {
    id: worldId,
    title: 'The Registrar',
    line: 'A port where every debt is public record, and yours is written under a false name.',
    bible:
      'A harbour city where the customs house keeps the debt ledger, and the ledger is public record: every debt, every default, every name, readable by anyone who can climb the customs house steps. Reputation is currency; a recorded debt outlives its repayment. The city runs on tide-time and guild-time, and the two do not agree. The guild collects what the ledger records, and the guild does not forgive — it trades. Above the customs house is the long room, where deals too delicate for the floor are made across a lamplit table. You arrived two years ago under a name that is not yours, and the debt recorded against that name is real even if the name is not. The pressure that will not wait: someone has begun asking the registrar about handwriting.',
    hue: 40,
    visibility: 'private',
    ai: { ...DEFAULT_AI },
    storyStance: 'longform',
    proseModel: null,
    utilityModel: null,
    imageModel: null,
    activeSeasonId: seasonId,
    calendar: { currentDay: 1, system: 'Tide-time and guild-time — the harbour keeps both, and they do not agree.', weekdays: undefined, dayOneWeekday: 0, episodeAdvanceDays: 1 },
    createdAt: now,
    updatedAt: now
  };

  const player = emptyCharacter(worldId, {
    name: 'you',
    role: 'protagonist · second person',
    hue: 60,
    isPlayer: true,
    summary: 'Living in the harbour under a false name, with a real debt recorded against it. Steady hands, an honest face, and a signature that has started to attract attention.',
    state: { goal: 'keep the false name from unravelling', emotion: 'watchful', location: 'the long room', condition: 'in over your head' }
  });

  const marisol = emptyCharacter(worldId, {
    name: 'Marisol Vey',
    role: 'harbour registrar · reluctant ally',
    hue: 26,
    age: 'Late thirties. Tired in a competent way.',
    appearance: 'Ink-stained fingers, a coat too good for her salary, eyes that finish your sentences before you do.',
    summary: 'Registrar of the harbour customs house for eleven years. Keeps the debt ledger, which means she knows more about this city than anyone who lives well in it. She is not a good person or a bad one; she is a person with a job she is unwilling to do badly.',
    speechStyle: 'Clipped. Rarely finishes a thought aloud if a look will do it. Uses your name when she is being serious and does not use it otherwise.',
    exampleLines: [
      'Then write it again, and put your own name on it.',
      'The ledger doesn\u2019t care what I believe.',
      'You have until the tide turns. After that it\u2019s ink.'
    ],
    traits: 'Precise, unhurried, quietly territorial about the ledger.',
    desires: 'The harbour to stay boring.',
    fears: 'Being made complicit in something she cannot undo.',
    flaws: 'Mistakes silence for neutrality. Waits too long to choose a side.',
    secrets: 'She saw the false signature in chapter 12 and chose silence. She has not decided what that makes her.',
    mustNotKnow: 'That Ivo took guild money to cover the debt — she must not learn this until the story reveals it.',
    anchors: [
      'Never lies in writing. Will omit, will refuse, will not falsify.',
      'Does not warm to you quickly. Trust moves one notch per episode at most.',
      'Will not be the one to name what is between you.',
      'If cornered, she goes procedural — the ledger, the forms, the rules.'
    ],
    state: { goal: 'decide what her silence makes her', emotion: 'careful', location: 'the tide stairs, then the doorway of the long room', condition: 'compromised by what she knows' }
  });

  const ivo = emptyCharacter(worldId, {
    name: 'Ivo Tarrant',
    role: 'brother · owes the guild',
    hue: 210,
    age: 'Early thirties, looks younger when he lies.',
    appearance: 'Dock-worker\u2019s shoulders, a gambler\u2019s hands, your mother\u2019s smile.',
    summary: 'Your brother, who followed you to the harbour and found his own trouble. Took guild money to cover your debt without telling you the terms. Loves you in the way that creates problems.',
    speechStyle: 'Fast, warm, deflects with jokes. Goes quiet when the truth gets close.',
    exampleLines: ['It\u2019s handled. Don\u2019t ask how it\u2019s handled.', 'You always did the signing. I just did the believing.'],
    traits: 'Loyal, impulsive, allergic to being pitied.',
    desires: 'To be the one who saves you, for once.',
    fears: 'That you\u2019ll find out the terms before he can fix them.',
    flaws: 'Doubles down. Confesses only when it\u2019s too late to help.',
    secrets: 'The guild\u2019s terms: interest paid in favours, and the first favour has already been asked.',
    mustNotKnow: '',
    anchors: [
      'Never asks you for help directly. He hints, he jokes, he never asks.',
      'Will not betray you — but will endanger you trying to protect you.'
    ],
    state: { goal: 'pay off the favour before you learn of it', emotion: 'cornered but hiding it', location: 'the low quarter', condition: 'in debt to the guild' }
  });

  const cartwright = emptyCharacter(worldId, {
    name: 'The Cartwright',
    role: 'unknown · speaks in trades',
    hue: 280,
    age: 'Unplaceable. Has looked fifty for twenty years, the dockhands say.',
    appearance: 'Unhurried. Dresses like a clerk, sits like a judge. Never touches what he is poured.',
    summary: 'Nobody knows what he moves or for whom. He appears when a debt matures into an opportunity, and he has never once been recorded in the ledger — which, in this city, is the most frightening fact about him.',
    speechStyle: 'Never threatens. Trades. Every sentence has a price in it somewhere, and he never repeats an offer.',
    exampleLines: ['You write a steady hand. Steadier than the name deserves.', 'I don\u2019t collect debts. I collect moments like this one.'],
    traits: 'Patient, exact, unreadable.',
    desires: 'Unknown — and the story is better while it stays unknown.',
    fears: 'Unknown.',
    flaws: 'His patience looks infinite but is not; being refused twice interests him, being refused three times does not.',
    secrets: 'What the second trade is actually for.',
    mustNotKnow: '',
    anchors: [
      'Trades, never threatens. If a line sounds like a threat, rewrite it as an offer.',
      'Never touches food or drink he is offered.',
      'Never repeats an offer. Refused once, the price changes.'
    ],
    state: { goal: 'close the second trade', emotion: 'entertained', location: 'the long room, across the table', condition: 'holding the manifest' }
  });

  const emine = emptyCharacter(worldId, {
    name: 'Emine',
    role: 'child of the low quarter',
    hue: 140,
    age: 'Eleven, maybe twelve. Nobody has asked her.',
    appearance: 'Quick, small, always carrying something that isn\u2019t hers.',
    summary: 'Runs messages and watches everything. The low quarter\u2019s memory. She saw you at the tide stairs the night the cargo came in, and she has told no one — yet.',
    speechStyle: 'Direct in the way only children are. Asks the question adults are avoiding.',
    exampleLines: ['You looked different when you thought no one was watching.', 'I don\u2019t tell. I trade. Marisol taught me that.'],
    traits: 'Observant, transactional, secretly lonely.',
    desires: 'To matter to someone the way messages matter.',
    fears: 'Being sent away from the harbour.',
    flaws: 'Trusts patterns more than people.',
    secrets: 'What she saw at the tide stairs.',
    mustNotKnow: '',
    anchors: ['Never volunteers information free. Everything is a trade, even kindness.'],
    state: { goal: 'figure out what her tide-stairs secret is worth', emotion: 'curious', location: 'off-page — the low quarter', condition: 'watching' }
  });

  const characters: Character[] = [player, marisol, ivo, cartwright, emine];

  const longRoom = emptyLocation(worldId, {
    id: uid(),
    name: 'The long room',
    tagline: 'above the customs house · lamplit · one door',
    hue: 32,
    summary:
      'A private deal room above the customs house floor. Tide sound comes up through the boards; lamp-smoke gathers along the ceiling beams and stays there. Conversations here have the shape of something overheard.',
    atmosphere: 'Lamp oil, salt damp, and the low grind of the harbour through the floor.',
    features: 'One long table, one door, a window that does not open onto the quay.',
    history: 'Built when the guild decided some debts were too delicate for the ledger floor.',
    inhabitants: 'Whoever holds the current trade — clerks do not enter unbidden.',
    rules: [
      'Nothing spoken here is recorded in the public ledger unless someone carries it downstairs.',
      'The Cartwright never touches food or drink he is offered.',
      'One door — no second exit for a clean escape.'
    ],
    secrets: 'A false-bottom drawer under the near end of the table has held more than one unsigned page.',
    currentState: 'The Cartwright has arranged the manifest so the false signature faces you.'
  });

  await db.transaction('rw',
    [db.worlds, db.seasons, db.episodes, db.turns, db.characters, db.locations, db.continuity, db.threads],
    async () => {
      await db.worlds.add(world);
      await db.seasons.add({
        id: seasonId, worldId, number: 1, title: '',
        premise: 'The Cartwright has asked for a meeting in the long room, and he has arranged the manifest pages so the false signature faces you. Marisol is on the tide stairs outside. Whatever is said in the next hour becomes ink.',
        timeGap: null, bible: null, status: 'active', createdAt: now
      });
      await db.locations.add(longRoom);
      await db.episodes.add({
        id: episodeId, seasonId, worldId, number: 1, title: 'The long room',
        location: 'The long room, above the customs house. Lamplit, tide-loud, one door.',
        locationId: longRoom.id,
        castIds: [player.id, marisol.id, cartwright.id],
        storyDay: 1, storyDayEnd: null, dateNote: null,
        status: 'active', createdAt: now
      });
      await db.characters.bulkAdd(characters);
      await db.turns.add({
        id: uid(), episodeId, worldId, role: 'narrator', mode: null,
        text:
          'The long room keeps its own weather. Lamp-smoke gathers along the ceiling beams and stays there, and the tide sound comes up through the floor rather than the windows, so that every conversation held here has the shape of something overheard.\n\nThe Cartwright has not touched the cup you poured. That is the first thing you notice. The second is that he has arranged the manifest pages so the false signature faces you.\n\nThe Cartwright: "You write a steady hand. Steadier than the name deserves."\n\nYou could tell him the truth. You could tell him a better lie. Marisol is on the tide stairs outside and will hear either one, because the long room keeps its own weather and gives nothing back.',
        createdAt: now
      });
      await db.continuity.bulkAdd([
        { id: uid(), worldId, seasonId, episodeId, text: 'Your name on the manifest is false and Marisol knows.', source: 'manual', createdAt: now },
        { id: uid(), worldId, seasonId, episodeId, text: 'Ivo\u2019s guild debt is unspoken between you.', source: 'manual', createdAt: now },
        { id: uid(), worldId, seasonId, episodeId, text: 'The Cartwright trades, never threatens.', source: 'manual', createdAt: now }
      ]);
      await db.threads.bulkAdd([
        { id: uid(), worldId, seasonId, text: 'The Cartwright\u2019s trade is on the table, unanswered.', openedLabel: 'opened S1 · E1', status: 'open', createdAt: now },
        { id: uid(), worldId, seasonId, text: 'Ivo has not told you the terms of the guild money.', openedLabel: 'opened S1 · E1', status: 'open', createdAt: now },
        { id: uid(), worldId, seasonId, text: 'Emine saw you at the tide stairs.', openedLabel: 'opened S1 · E1', status: 'open', createdAt: now }
      ]);
    });

  return worldId;
}
