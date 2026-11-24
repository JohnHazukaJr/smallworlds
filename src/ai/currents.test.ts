import { describe, expect, it } from 'vitest';
import type { PlotTarget, World } from '../types';
import {
  applyCurrentMoves, cleanCurrents, currentsLiveRules, currentsOn, currentsPrompt, currentsSystem,
  currentsWriterSection, liveCurrents, stanceGuide, timeOfYearLine, withCurrents
} from './currents';
import { gregorianWeekday, isEarthCalendar, partsForDay, startDatePatch, worldCalendar, formatStoryDate } from '../worldOps';

let n = 0;
const makeId = () => `id${++n}`;
const author: PlotTarget = { id: 'm1', text: 'Find who forged the page', status: 'pending', source: 'manual' };
const cur = (id: string, text: string, patch: Partial<PlotTarget> = {}): PlotTarget =>
  ({ id, text, status: 'pending', source: 'outline', ...patch });

describe('cleanCurrents', () => {
  it('keeps real lines, known names only (never the player), capped', () => {
    const out = cleanCurrents({
      currents: [
        { text: 'Brannoc is paying the night watch to forget the grain ship.', kind: 'agenda', who: ['brannoc hale', 'Rowan', 'Nobody'], could: ['A watchman talks', 'It works'] },
        { text: 'Brannoc is paying the night watch to forget the grain ship.' },
        { text: 'too short' },
        { text: 'The midwinter tide festival is two days off and the quay is filling with stalls.', kind: 'nonsense' },
        { text: 'A third current that falls past the cap of two.' }
      ]
    }, { names: ['Brannoc Hale', 'Rowan'], playerName: 'Rowan', cap: 2, makeId });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: 'outline', status: 'pending', kind: 'agenda', who: ['Brannoc Hale'], could: ['A watchman talks', 'It works'] });
    expect(out[1].kind).toBeUndefined();
  });

  it('returns nothing for junk', () => {
    expect(cleanCurrents(null, { names: [], playerName: '', cap: 5, makeId })).toEqual([]);
    expect(cleanCurrents({ currents: 'x' }, { names: [], playerName: '', cap: 5, makeId })).toEqual([]);
  });
});

describe('withCurrents', () => {
  it('keeps the author’s targets and settled currents, replaces pending currents', () => {
    const old = [author, cur('c1', 'Old pending current that the redraft replaces'), cur('c2', 'Settled current', { status: 'hit' })];
    const fresh = [cur('c3', 'A brand new current drafted from the chapter')];
    expect(withCurrents(old, fresh).map((t) => t.id)).toEqual(['m1', 'c2', 'c3']);
  });
});

describe('applyCurrentMoves', () => {
  const targets = [author, cur('c1', 'Ada is burning the draft copies'), cur('c2', 'The quay rumour is spreading')];
  const live = liveCurrents(targets);

  it('resolves, fades, bends, and stirs by number, leaving the author’s target alone', () => {
    const next = applyCurrentMoves(targets, live, [
      { n: 1, status: 'bent', note: 'Rowan caught her at the stove', now: 'Ada must explain the ashes in her stove to Rowan' },
      { n: 2, status: 'faded', note: 'the rumour died when the ship sailed' }
    ])!;
    expect(next[0]).toBe(author);
    expect(next[1]).toMatchObject({ text: 'Ada must explain the ashes in her stove to Rowan', status: 'pending', note: 'Rowan caught her at the stove' });
    expect(next[2]).toMatchObject({ status: 'dropped' });
    expect(applyCurrentMoves(targets, live, [{ n: 1, status: 'resolved' }])![1].status).toBe('hit');
  });

  it('ignores unknown numbers, bad statuses, repeats, and no-op rows', () => {
    expect(applyCurrentMoves(targets, live, [{ n: 9, status: 'resolved' }, { n: 1, status: 'exploded' }])).toBeNull();
    expect(applyCurrentMoves(targets, live, [{ n: 1, status: 'stirred' }])).toBeNull();
    expect(applyCurrentMoves(targets, live, undefined)).toBeNull();
    const twice = applyCurrentMoves(targets, live, [{ n: 1, status: 'resolved' }, { n: 1, status: 'faded' }])!;
    expect(twice[1].status).toBe('hit');
  });
});

describe('what the writer sees', () => {
  it('lists live currents with the guardrails, and never the "could" directions', () => {
    const section = currentsWriterSection([
      author,
      cur('c1', 'Ada is burning the draft copies', { who: ['Ada Vey'], note: 'smoke seen', could: ['Rowan smells smoke'] }),
      cur('c2', 'Settled one', { status: 'hit' })
    ])!;
    expect(section).toContain('pressures, not a script');
    expect(section).toContain('Never steer the player toward one');
    expect(section).toContain('- Ada is burning the draft copies (Ada Vey) — lately: smoke seen');
    expect(section).not.toContain('Rowan smells smoke');
    expect(section).not.toContain('Settled one');
    expect(section).not.toContain('Find who forged the page');
    expect(currentsWriterSection([author])).toBeNull();
  });

  it('tells the live pass that being ignored is not fading', () => {
    expect(currentsLiveRules([cur('c1', 'x')])).toContain('never mark it faded for being ignored');
    expect(currentsLiveRules([])).toBe('');
  });
});

describe('drafting prompt', () => {
  it('fits the stance and forbids planning for the player', () => {
    expect(stanceGuide('wander').max).toBe(3);
    expect(currentsSystem('wander')).toContain('No ticking clocks');
    expect(currentsSystem('longform')).toContain('never a plan for the player');
  });

  it('carries the date, events, people, and earlier currents', () => {
    const text = currentsPrompt({
      world: { title: 'Saltmere', bible: 'Fog.' }, stance: 'longform',
      today: 'Tuesday, 24 November, Year 1', timeOfYear: timeOfYearLine('November', 10, 12, ''),
      dueEvents: [{ title: 'Tide festival', summary: 'Lanterns on the water', storyDay: 3 }], todayDay: 1,
      premise: 'A forged page.', authorTargets: ['Find who forged the page'],
      earlierCurrents: [cur('c1', 'Ada is burning the copies', { note: 'smoke seen' })],
      priorRecap: '', meanwhile: '- Brannoc: Paid the watch.', chapterSoFar: 'Rowan arrived.', threads: [],
      people: [], presentIds: [], playerName: 'Rowan'
    });
    expect(text).toContain('November is month 11 of 12.');
    expect(text).toContain('Tide festival (in 2 days): Lanterns on the water');
    expect(text).toContain('Ada is burning the copies (lately: smoke seen)');
    expect(text).toContain('do not repeat');
    expect(text).toContain('Meanwhile, off-screen');
  });

  it('is on unless the world turns it off', () => {
    const ai = {} as World['ai'];
    expect(currentsOn({ ai })).toBe(true);
    expect(currentsOn({ ai: { ...ai, chapterCurrents: false } })).toBe(false);
  });
});

describe('start date', () => {
  it('works out real weekdays', () => {
    expect(gregorianWeekday(2026, 10, 24)).toBe(1); // Tuesday
    expect(gregorianWeekday(1999, 11, 31)).toBe(4); // Friday
    expect(gregorianWeekday(1, 0, 1)).toBe(0); // Monday, 1 Jan 1 (proleptic Gregorian)
  });

  it('makes story day 1 the chosen date, with the real weekday on an Earth calendar', () => {
    const base = worldCalendar(null);
    expect(isEarthCalendar(base)).toBe(true);
    const patch = startDatePatch(base, { year: 1888, monthIndex: 9, dayOfMonth: 31 });
    const cal = worldCalendar({ calendar: { currentDay: 1, system: '', ...patch } } as World);
    expect(formatStoryDate(cal, 1)).toBe('Wednesday, 31 October, Year 1888 · day 1');
    expect(partsForDay(cal, 2)).toMatchObject({ monthName: 'November', dayOfMonth: 1, weekday: 'Thursday' });
  });

  it('keeps a chosen weekday on a custom calendar and clamps the day', () => {
    const custom = worldCalendar({
      calendar: { currentDay: 1, system: '', months: ['Thaw', 'Bloom'], monthLengths: [20, 20], weekdays: ['Oneday', 'Twoday', 'Threeday'] }
    } as World);
    expect(isEarthCalendar(custom)).toBe(false);
    expect(startDatePatch(custom, { year: 40, monthIndex: 1, dayOfMonth: 99, weekdayIndex: 2 }))
      .toEqual({ yearOne: 40, dayOneMonth: 1, dayOneDate: 20, dayOneWeekday: 2 });
  });
});
