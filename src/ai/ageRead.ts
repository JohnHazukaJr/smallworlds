/**
 * Read a character's free-text age line for the image safety gate.
 *
 * The rule is asymmetric on purpose:
 *  - A stated age under 18 (digits or words, "under 18", "turning 18",
 *    "17th birthday", "late teens", "looks 15") always reads as a minor,
 *    whatever else the line says.
 *  - A stated adult age (18+, "thirties", "twenty-five", "1,200 years") reads
 *    as an adult. Then words about other people ("mother of a teen") or the
 *    past ("was a child when…") no longer count against them.
 *  - With no stated age, a child word about the character still reads as a minor.
 *
 * Numbers that are not ages are ignored: heights (5'10, 180 cm), weights,
 * ordinals (2nd daughter), times, calendar years (born 1990, 2008), counts
 * ("mother of 3", "2 kids"), and spans ("ten years younger", "3 years ago").
 */

export interface AgeReading {
  /** Reads as under 18. Blocks sexual prompts and forces a clothed picture. */
  minor: boolean;
  /** States an adult age outright: a number, a decade, or a plain adult word. */
  adult: boolean;
  /**
   * No age is stated and the only signal is a teen word ("a teen", "late teens",
   * "schoolgirl"). 18 and 19 are teens too, so stating an age of 18+ settles it.
   */
  unclear?: boolean;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
const MINOR_ORDINAL_WORDS = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)\s+(birthday|year of (her|his|their) life|summer|winter|spring|autumn|year)\b/;

const DECADE_WORDS = /\b(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/;
const VERY_OLD = /\b(hundreds?|thousands?|centuries|millennia)\s+(of\s+)?years\b|\bcenturies[- ]old\b|\bageless immortal\b/;
const BIG_AFTER = /^[\s-]*(hundred|thousand|million|billion)\b/;

/** After a number: a span of time, not their age. */
const SPAN_AFTER = /^[\s-]*(years?|yrs?|months?|weeks?|days?)?[\s-]*(younger|older|ago|later|earlier|before|after|apart|senior|junior|into|of (service|marriage|exile|war|study|training))\b/;
/** After a number: it measures something else. */
const MEASURE_AFTER = /^\s*(?:'|’|"|”|ft\b|feet\b|foot\b|inch(es)?\b|cm\b|mm\b|meters?\b|metres?\b|kg\b|kilos?\b|lbs?\b|pounds?\b|stone\b|%)/;
/** After a number: a count of people or things. */
const COUNT_AFTER = /^\s*(kids?|children|sons?|daughters?|siblings?|brothers?|sisters?|grandchildren|wives|husbands|times|of (them|us)|people|men|women|scars?|tattoos?|rings?|piercings?|eyes?|arms?|legs?|hands?|ears?|fingers?|toes?|horns?|wings?|tails?|heads?)\b/;
/** Before a small number: a count or an index, not their age. */
const COUNT_BEFORE = /(mother of|father of|parent of|#|no\.|number|room|floor|level|rank|tier|gen|generation|season|chapter|book|volume|vol\.|class of|lost)\s*$/;
/** Before a 4-digit number: a calendar year. */
const YEAR_BEFORE = /(born|since|in|year|circa|c\.|ad|bc|class of|from)\s*$/;

const ADULT_WORDS = /\b(adult|grown|grown-up|grownup|elderly|middle[- ]aged|old (man|woman|lady)|retired|ancient|immortal|of age|over\s*-?\s*18|18\s*\+)/;
const MINOR_WORDS = /\b(child|children|kid|kids|toddler|infant|baby|babies|teen|teens|teenage|teenaged|teenager|teenagers|minor|minors|underage|under-age|preteen|pre-teen|tween|adolescent|schoolgirl|schoolboy|juvenile|youngling)\b/g;
/** Before a child word: it is about someone else, or their past. */
const RELATION_BEFORE = /\b(of|with|has|have|had|her|his|their|our|its|raising|raised|carrying|carries|expecting|mother|father|parent|nanny|teacher|tutor|guardian|was|were|as|since|when|once|former|ex|lost|adopted|pregnant)\s+((an?|two|three|the|some|young|little|small|her|his|their|own)\s+)*$/;
/** After a child word: it is about someone else. */
const RELATION_AFTER = /^\s*(of\b|'s\b|’s\b|at home|in tow)/;
/** Child words used as plain adjectives about an adult: "minor noble", "baby-faced", "kid gloves". */
const ADJECTIVE_AFTER: Record<string, RegExp> = {
  minor: /^\s*(noble|nobility|god|goddess|deity|lord|lady|official|character|role|house|league|player|demon|spirit|celebrity|royal|royalty|mage|clerk|scandal|injur)/,
  minors: /^\s*(in (the )?(guild|house))/,
  baby: /^[\s-]*(face|faced|blue|pink|fat|doll)/,
  kid: /^\s*(gloves|leather|boots)/
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2') // 1,200 → 1200
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Found {
  value: number;
  /** Hundreds or thousands of years: very old, never a child. */
  big?: boolean;
}

function digitAges(s: string): Found[] {
  const out: Found[] = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) {
    const raw = m[0];
    const at = m.index ?? 0;
    if (/[\d'’.]/.test(s.charAt(at - 1))) continue; // the 10 in 5'10, or a decimal tail
    if (raw.includes('.')) continue; // 1.8 m, 5.5 ft
    const value = Number(raw);
    const after = s.slice(at + raw.length);
    const before = s.slice(Math.max(0, at - 24), at);

    if (/^s\b/.test(after)) { // "30s", "mid-20s"
      if (value >= 20) out.push({ value });
      continue;
    }
    if (/^\s*(st|nd|rd|th)\b/.test(after)) {
      // Ordinals are indexes ("2nd daughter") unless they count their own years.
      if (/^\s*(st|nd|rd|th)\s+(birthday|year|summer|winter|spring|autumn)\b/.test(after)) out.push({ value });
      continue;
    }
    if (/^\s*:\s*\d/.test(after)) continue; // a time
    if (MEASURE_AFTER.test(after)) continue;
    if (SPAN_AFTER.test(after)) continue;
    if (COUNT_AFTER.test(after)) continue;
    const saysYears = /^\s*-?\s*(years?|yrs?|y\/?o)\b/.test(after);
    if (value >= 1000) {
      if (YEAR_BEFORE.test(before)) continue;
      if (value >= 1900 && value <= 2100 && !saysYears) continue; // 2008 is a birth year, not an age
      out.push({ value, big: true });
      continue;
    }
    if (value < 18 && COUNT_BEFORE.test(before)) continue;
    out.push({ value, big: value >= 100 });
  }
  return out;
}

function wordAges(s: string): Found[] {
  const out: Found[] = [];
  const tokens = [...s.matchAll(/[a-z]+/g)];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i][0];
    let value: number | undefined;
    let used = 1;
    if (w in TENS) {
      value = TENS[w];
      const next = tokens[i + 1]?.[0];
      if (next && next in UNITS && UNITS[next] > 0 && UNITS[next] < 10) {
        value += UNITS[next];
        used = 2;
      }
    } else if (w in UNITS) {
      value = UNITS[w];
    }
    if (value === undefined) continue;
    const start = tokens[i].index ?? 0;
    const last = tokens[i + used - 1];
    const after = s.slice((last.index ?? 0) + last[0].length);
    const before = s.slice(Math.max(0, start - 24), start);
    i += used - 1;
    if (BIG_AFTER.test(after)) {
      out.push({ value: 1000, big: true });
      continue;
    }
    if (SPAN_AFTER.test(after) || COUNT_AFTER.test(after)) continue;
    if (value < 18 && COUNT_BEFORE.test(before)) continue;
    // A small number word ("one of the elders", "two scars") is an age only when it says so or stands alone.
    const saysYears = /^\s*-?\s*(years?|yrs?|y\/?o)\b/.test(after);
    const alone = tokens.length === used;
    const looks = /\b(looks?|appears?|aged|age|age of|is|just|only|barely)\s*$/.test(before);
    if (value < 13 && !saysYears && !alone && !looks) continue;
    out.push({ value });
  }
  return out;
}

/** Child words about this character, not someone they know or who they once were. */
function selfMinorWords(s: string): boolean {
  for (const m of s.matchAll(MINOR_WORDS)) {
    const at = m.index ?? 0;
    const before = s.slice(Math.max(0, at - 40), at);
    const after = s.slice(at + m[0].length);
    if (RELATION_BEFORE.test(before)) continue;
    if (RELATION_AFTER.test(after)) continue;
    if (ADJECTIVE_AFTER[m[0]]?.test(after)) continue;
    return true;
  }
  return false;
}

export function readAge(age: string): AgeReading {
  const s = normalize(age);
  if (!s) return { minor: false, adult: false };
  const minor = { minor: true, adult: false };

  // Stated minor ages win over everything else.
  if (/\b(under|below|not yet|younger than|less than)\s*-?\s*(18|eighteen)\b/.test(s)) return minor;
  if (/\b(turning|turns|almost|nearly|soon to be|about to turn|not quite)\s+(18|eighteen)\b/.test(s)) return minor;
  if (/\b(early|mid)[- ]?teens\b/.test(s)) return minor;
  if (MINOR_ORDINAL_WORDS.test(s)) return minor;
  const ages = [...digitAges(s), ...wordAges(s)];
  if (ages.some((a) => !a.big && a.value < 18)) return minor;

  // A stated adult age settles it: "late teens, 18" and "19-year-old teen" are adults.
  if (ages.some((a) => a.big || a.value >= 18) || DECADE_WORDS.test(s) || VERY_OLD.test(s)) {
    return { minor: false, adult: true };
  }
  if (readsAsChild(s)) return minor;
  // "late teens" or "a teen" with no age could be 18 or 19. Treated as under 18
  // until an age is stated, and flagged so the message can say how to fix it.
  if (/\blate[- ]?teens\b/.test(s) || selfMinorWords(s)) return { minor: true, adult: false, unclear: true };
  return { minor: false, adult: ADULT_WORDS.test(s) };
}

/** Words that describe a child outright, not a teenager who may be 18 or 19. */
const CHILD_WORDS = /\b(child|children|kid|kids|toddler|infant|preteen|pre-teen|prepubescent|pre-pubescent|tween|childlike|child-like|little (girl|boy)|grade[- ]schooler|elementary school(er)?)\b/g;
const SPELLED_UNDER_18 = new Set(Object.entries(UNITS).filter(([, v]) => v >= 1 && v < 18).map(([w]) => w));

/**
 * True when a description depicts a child: an apparent age under 18 ("looks 15",
 * "the body of a 12-year-old") or a child word about this person ("a child",
 * "childlike", "little girl"). Teen words and "looks young" are not enough.
 * This holds even when an adult age is stated elsewhere.
 */
export function readsAsChild(text: string): boolean {
  const s = normalize(text);
  if (!s) return false;
  for (const m of s.matchAll(/\b(looks?|looking|appears?|appearing|passes for|could pass (?:for|as)|body of|built like|resembles)\s+((?:about|around|maybe|like|barely|only|no more than|an?)\s+)*([a-z]+|\d+)/g)) {
    const word = m[3];
    if (/^\d+$/.test(word)) {
      const value = Number(word);
      const after = s.slice((m.index ?? 0) + m[0].length);
      if (value >= 1 && value < 18 && !/^\s*(years? (younger|older))/.test(after)) return true;
    } else if (SPELLED_UNDER_18.has(word)) {
      const after = s.slice((m.index ?? 0) + m[0].length);
      if (!/^\s*(years? (younger|older))/.test(after)) return true;
    }
  }
  for (const m of s.matchAll(CHILD_WORDS)) {
    const at = m.index ?? 0;
    const before = s.slice(Math.max(0, at - 40), at);
    const after = s.slice(at + m[0].length);
    // "a child's body", "a kid's face": their own body described as a child's.
    if (/^\s*['’]s\s+(body|face|frame|figure|build|proportions|features|physique|stature|height|size)\b/.test(after)) return true;
    if (RELATION_BEFORE.test(before)) continue;
    if (RELATION_AFTER.test(after)) continue;
    if (ADJECTIVE_AFTER[m[0]]?.test(after)) continue;
    return true;
  }
  return false;
}
