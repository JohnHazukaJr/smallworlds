import { describe, expect, it } from 'vitest';
import {
  ambiguousResidentNote,
  applyPlaceDraft,
  mentionedResidents,
  resolveResidents,
  reuseArea,
  type PlaceCastPerson,
  type PlaceDraftSheet
} from './placeDraft';

const ada: PlaceCastPerson = { id: 'ada', name: 'Ada James' };
const james: PlaceCastPerson = { id: 'james', name: 'James' };
const jonah: PlaceCastPerson = { id: 'jonah', name: 'Jonah Hale' };
const school = { name: 'the school' };

const blank = (): PlaceDraftSheet => ({
  name: '',
  tagline: '',
  summary: '',
  atmosphere: '',
  features: '',
  history: '',
  inhabitants: '',
  rules: [],
  secrets: '',
  currentState: ''
});

describe('place residents', () => {
  it('lets ada james house name Ada James and not a separate James', () => {
    const cast = [ada, james, jonah];
    expect(mentionedResidents('this is ada james house', cast).map((person) => person.id)).toEqual(['ada']);
    expect(mentionedResidents("Ada James's house", cast).map((person) => person.id)).toEqual(['ada']);
  });

  it('does not treat James Mansion as the person James', () => {
    const cast = [ada, james];
    const text = 'James Mansion in Briar Park, home of Ada James, about 15 minutes from the school';
    expect(mentionedResidents(text, cast).map((person) => person.id)).toEqual(['ada']);
  });

  it('selects neither Ada when the short name is shared', () => {
    const one: PlaceCastPerson = { id: '1', name: 'Ada' };
    const two: PlaceCastPerson = { id: '2', name: 'Ada' };
    expect(resolveResidents({ authorText: "Ada's house", cast: [one, two] })).toEqual([]);
    expect(ambiguousResidentNote("Ada's house", [one, two])).toMatch(/Two people are named Ada/);
  });
});

describe('place area and nearby', () => {
  it('reuses Briar Park from Briar Park neighborhood', () => {
    expect(reuseArea('Briar Park neighborhood', ['Briar Park'])).toBe('Briar Park');
  });

  it('keeps Ada James, Briar Park, and the school, and drops invented people and places', () => {
    const author = 'James Mansion in Briar Park, home of Ada James, about 15 minutes from the school';
    const applied = applyPlaceDraft(blank(), {
      name: 'James Mansion',
      area: 'Oak Hill',
      near: 'about 15 minutes from Rivermarket',
      summary: 'Jonah Hale lives in the west wing. Her sister Lena visits on Sundays. The house stands in Briar Park.',
      inhabitants: 'Jonah Hale and Lena',
      residentNames: ['Jonah Hale', 'Lena', 'Ada James'],
      rules: ['Lena may not enter.']
    }, {
      authorText: author,
      cast: [ada, james, jonah],
      allowed: resolveResidents({ authorText: author, cast: [ada, james, jonah] }),
      areas: ['Briar Park'],
      places: [school]
    });

    expect(applied.residentIds).toEqual(['ada']);
    expect(applied.area).toBe('Briar Park');
    expect((applied.near ?? '').toLowerCase()).toContain('the school');
    expect(applied.near).not.toMatch(/Rivermarket/);
    expect(applied.inhabitants).toMatch(/Home of Ada James/);
    expect(applied.inhabitants).not.toMatch(/Jonah/);
    expect(applied.inhabitants).not.toMatch(/Lena/);
    expect(applied.summary).not.toMatch(/Jonah/);
    expect(applied.summary).not.toMatch(/Lena/);
    expect(applied.summary).toMatch(/Briar Park/);
    expect(applied.rules.join(' ')).not.toMatch(/Lena/);
  });
});

describe('resident location seeds', () => {
  it('fills a blank current location and leaves one that is already set', async () => {
    const { residentLocationSeeds } = await import('./placeDraft');
    expect(residentLocationSeeds([
      { id: 'ada', state: { location: '' } },
      { id: 'jonah', state: { location: 'the school' } }
    ], ['ada', 'jonah'], 'James Mansion')).toEqual([
      { id: 'ada', location: 'James Mansion' }
    ]);
  });
});
