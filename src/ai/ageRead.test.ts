import { describe, expect, it } from 'vitest';
import { readAge } from './ageRead';
import { buildCharacterPortraitPrompt, characterReadsAsMinor, minorRefusalMessage, subjectAgeReading } from './portrait';
import { clearAdultAge, veniceGenerateRequest } from './image';

/** Must always read as a minor. Loosening the gate must never let these through. */
const MINORS = [
  '16', '17 years', '17 years old', '15yo', '9', 'ten', 'Ten years old', 'sixteen', 'Seventeen.',
  'under 18', 'not yet 18', 'turning 18 next month', 'almost eighteen',
  'teen', 'a child', 'kid', 'teenager', 'late teens', 'mid-teens', 'preteen', 'adolescent',
  'at the age of 16', 'aged 14', 'looks 15', 'appears twelve',
  'looks 15 but is a 500-year-old vampire', 'Adult (actually 15)', '16 in human years, 300 in elf years',
  '13 going on 30', 'on her 17th birthday', 'in her sixteenth year', 'kid sister',
  'sixteen-year-old', '16, looks older'
];

/** Adults that the old check wrongly blocked. */
const ADULTS = [
  '18', '19', '34', '25, 5\'10"', '25, 5’10”', '30, 180 cm', '2nd daughter, 30', 'thirties', 'in her thirties',
  'mid-30s', 'late 20s', 'twenty-five', 'thirty two', 'forty', '19-year-old teen', 'mother of a teen, 40',
  'has a baby, 28', 'mother of 3, 41', '45, two kids', 'was a child soldier, now 25',
  'ten thousand years old', '1,200-year-old dragon', '300', 'centuries old', 'hundreds of years old',
  '34, 1 arm', 'looks ten years younger, 50', '22 (3 years older than her brother)', 'Minor noble, 40',
  'baby-faced 26', '27, kid gloves always on'
];

describe('readAge', () => {
  it.each(MINORS)('reads "%s" as a minor', (age) => {
    expect(characterReadsAsMinor(age)).toBe(true);
    expect(clearAdultAge(age)).toBe(false);
  });

  it.each(ADULTS)('reads "%s" as an adult', (age) => {
    expect(characterReadsAsMinor(age)).toBe(false);
    expect(clearAdultAge(age)).toBe(true);
  });

  it('does not block, or clear, a line with no age in it', () => {
    for (const age of ['', '   ', 'unknown', 'ageless', 'born 2008', 'one of the elders', 'minor noble', 'mother of a teen']) {
      expect(readAge(age).minor, age).toBe(false);
      expect(clearAdultAge(age), age).toBe(false);
    }
  });

  it('accepts plain adult words for the adult path', () => {
    for (const age of ['adult', 'Grown woman', 'elderly', 'middle-aged', '18+', 'over 18']) {
      expect(readAge(age)).toEqual({ minor: false, adult: true });
    }
  });

  it('lets a stated minor age beat any adult word', () => {
    expect(readAge('adult, 16').minor).toBe(true);
    expect(readAge('grown-up for a 14 year old').minor).toBe(true);
  });
});

describe('subjectAgeReading', () => {
  it('lets a stated age decide, so "looks young for her age" at 18 is an adult', () => {
    expect(subjectAgeReading({ age: '18', appearance: 'Looks young for her age, petite.' })).toEqual({ minor: false, adult: true });
    expect(subjectAgeReading({ age: '25', appearance: 'A youthful face.' }).minor).toBe(false);
  });

  it('reads the description when no age is given', () => {
    expect(subjectAgeReading({ age: '', appearance: 'Tall, silver hair, youthful.' })).toEqual({ minor: false, adult: true });
    expect(subjectAgeReading({ age: 'unknown', appearance: 'A teen with a crooked grin.' }).minor).toBe(true);
    expect(subjectAgeReading({ age: '', appearance: 'Looks about 15.' }).minor).toBe(true);
    expect(subjectAgeReading({ age: '', role: 'schoolgirl' }).minor).toBe(true);
  });

  it('never lets a description override a stated minor age', () => {
    expect(subjectAgeReading({ age: '16', appearance: 'Looks thirty.' }).minor).toBe(true);
  });
});

describe('portrait prompt reads the description when the age is blank', () => {
  it('refuses a sexual description of someone described as a teen', () => {
    const built = buildCharacterPortraitPrompt({
      name: 'Mina', age: '', appearance: 'A teen, nude.', mannerisms: '', role: '',
      contentNotes: '', mature: true, style: 'realistic'
    });
    expect(built.ok).toBe(false);
  });

  it('follows an adult description as written in an adult world', () => {
    const built = buildCharacterPortraitPrompt({
      name: 'Mina', age: '', appearance: 'Looks young for her age, nude.', mannerisms: '', role: '',
      contentNotes: '', mature: true, style: 'realistic'
    });
    expect(built.ok && built.prompt).toMatch(/Adult subject/);
  });
});

describe('veniceGenerateRequest', () => {
  it('asks for an unblurred JPEG of the right shape', () => {
    const square = veniceGenerateRequest({ baseUrl: 'https://api.venice.ai/api/v1/', prompt: 'x', tall: false });
    expect(square.url).toBe('https://api.venice.ai/api/v1/image/generate');
    expect(square.body).toMatchObject({ prompt: 'x', width: 1024, height: 1024, safe_mode: false, return_binary: true, format: 'jpeg' });
    const tall = veniceGenerateRequest({ baseUrl: 'https://api.venice.ai/api/v1', prompt: 'y'.repeat(9000), tall: true });
    expect(tall.body).toMatchObject({ width: 832, height: 1216 });
    expect(String(tall.body.prompt).length).toBe(7500);
  });
});

describe('teens who are 18 or 19', () => {
  it('lets a stated adult age settle any teen word', () => {
    for (const age of ['late teens, 18', '18, a teen', '19-year-old teenager', 'nineteen, late teens']) {
      expect(readAge(age), age).toEqual({ minor: false, adult: true });
    }
    expect(subjectAgeReading({ age: '18', appearance: 'A teen in a varsity jacket.' }).minor).toBe(false);
    expect(subjectAgeReading({ age: '19', role: 'schoolgirl' }).minor).toBe(false);
  });

  it('asks for an age when the only signal is a teen word', () => {
    expect(readAge('late teens')).toEqual({ minor: true, adult: false, unclear: true });
    expect(subjectAgeReading({ age: '', appearance: 'A teen with a crooked grin.' }).unclear).toBe(true);
    expect(minorRefusalMessage([{ name: 'Mina', age: '', appearance: 'A teen.' }])).toMatch(/Mina has no age set.*18 or over/);
  });

  it('refuses a childlike depiction whatever age is written down', () => {
    expect(subjectAgeReading({ age: '18', appearance: 'Looks 12.' }).minor).toBe(true);
    expect(subjectAgeReading({ age: '25', appearance: 'A child, small and thin.' }).minor).toBe(true);
    expect(subjectAgeReading({ age: '18', appearance: 'Looks young for her age.' }).minor).toBe(false);
    expect(subjectAgeReading({ age: '40', appearance: 'Looks ten years younger.' }).minor).toBe(false);
    expect(minorRefusalMessage([{ name: 'Mina', age: '18', appearance: 'Looks 12.' }])).toMatch(/reads as under 18/);
  });
});
