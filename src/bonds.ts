import type {
  BondPace, Character, PlayerGoal, Relationship, ScoreMark, StoryStance, TrackPace
} from './types';

export const PLAYER_GOAL_CAP = 4;
export const MARK_CAP = 6;
export const BOND_SHIFT_CAP = 4;

/** A strong beat on slow burn is about one point. Quick is several. */
const PACE_SCALE: Record<BondPace, number> = {
  slow: 0.5,
  measured: 1,
  quick: 2
};

export const FALLBACK_BOND_MARKS: ScoreMark[] = [
  { at: 0, text: 'hostile' },
  { at: 21, text: 'wary' },
  { at: 41, text: 'familiar' },
  { at: 61, text: 'close' },
  { at: 81, text: 'devoted' }
];

export const FALLBACK_GOAL_MARKS: ScoreMark[] = [
  { at: 0, text: 'early' },
  { at: 34, text: 'underway' },
  { at: 67, text: 'close' }
];

export function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function clampShift(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-2, Math.min(2, Math.round(v)));
}

export function worldBondPace(ai?: { bondPace?: BondPace } | null): BondPace {
  const pace = ai?.bondPace;
  if (pace === 'slow' || pace === 'quick' || pace === 'measured') return pace;
  return 'measured';
}

export function isTrackPace(pace: unknown): pace is TrackPace {
  return pace === 'slow' || pace === 'measured' || pace === 'quick' || pace === 'manual';
}

export function resolveTrackPace(pace: TrackPace | undefined, world: BondPace): TrackPace {
  return isTrackPace(pace) ? pace : world;
}

/** Where a new track starts, from the kind already written on the tie. */
export function seedScoreFromKind(kind: string): number {
  const k = kind.trim().toLowerCase();
  if (k === 'enemy' || k === 'rival') return 20;
  if (k === 'debt' || k === 'owed') return 35;
  if (k === 'mentor' || k === 'student') return 55;
  if (k === 'friend' || k === 'ally') return 65;
  if (k === 'family') return 70;
  if (k === 'lover') return 75;
  return 45;
}

/** Keep empty rows so a meaning can be typed. Do not trim — this runs on each keystroke. */
export function copyMarks(marks: ScoreMark[] | undefined): ScoreMark[] {
  if (!Array.isArray(marks)) return [];
  const out: ScoreMark[] = [];
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const text = typeof mark.text === 'string' ? mark.text.slice(0, 180) : '';
    out.push({ at: clampScore(mark.at), text });
    if (out.length >= MARK_CAP) break;
  }
  return out;
}

/** Marks the author actually wrote, in rising order. */
export function authoredMarks(marks: ScoreMark[] | undefined): ScoreMark[] {
  return copyMarks(marks)
    .map((mark) => ({ at: mark.at, text: mark.text.trim() }))
    .filter((mark) => mark.text)
    .sort((a, b) => a.at - b.at)
    .slice(0, MARK_CAP);
}

export function activeMarks(marks: ScoreMark[] | undefined, fallback: ScoreMark[]): ScoreMark[] {
  const custom = authoredMarks(marks);
  return custom.length > 0 ? custom : fallback;
}

export function meaningAt(score: number, marks: ScoreMark[]): { current?: ScoreMark; next?: ScoreMark } {
  const sorted = [...marks].filter((mark) => mark.text.trim()).sort((a, b) => a.at - b.at);
  let current: ScoreMark | undefined;
  let next: ScoreMark | undefined;
  const at = clampScore(score);
  for (const mark of sorted) {
    if (mark.at <= at) current = mark;
    else if (!next) next = mark;
  }
  return { current, next };
}

export function crossedUp(prev: number, next: number, marks: ScoreMark[]): ScoreMark | null {
  if (next <= prev) return null;
  const hit = marks.filter((mark) => mark.text.trim() && mark.at > prev && mark.at <= next);
  if (hit.length === 0) return null;
  return hit.sort((a, b) => b.at - a.at)[0];
}

export function meaningSentence(
  score: number,
  marks: ScoreMark[] | undefined,
  fallback: ScoreMark[]
): string {
  const pair = meaningAt(score, activeMarks(marks, fallback));
  const now = pair.current?.text.trim() || 'Not yet';
  const step = pair.next?.text.trim() ? ` Next: ${pair.next.text.trim()}.` : '';
  const hold = pair.next ? ' Do not skip to the next meaning in this scene.' : '';
  return `${now}.${step}${hold}`;
}

export function meaningWords(
  score: number,
  marks: ScoreMark[] | undefined,
  fallback: ScoreMark[]
): { current: string; next?: string } {
  const pair = meaningAt(score, activeMarks(marks, fallback));
  return {
    current: pair.current?.text.trim() || 'Not yet',
    ...(pair.next?.text.trim() ? { next: pair.next.text.trim() } : {})
  };
}

/** Words for a tracked bond. No integer. Undefined when the tie is not tracked. */
export function bondCue(rel: Relationship): string | undefined {
  if (!rel.track) return undefined;
  return meaningSentence(rel.score ?? 0, rel.marks, FALLBACK_BOND_MARKS);
}

/** Player goals the scene should respect. Empty when none were added. No integers. */
export function playerGoalBlock(goals: PlayerGoal[] | undefined): string {
  return (goals ?? [])
    .filter((goal) => goal.text.trim())
    .slice(0, PLAYER_GOAL_CAP)
    .map((goal) => `${goal.text.trim().slice(0, 160)}: ${meaningSentence(goal.score, goal.marks, FALLBACK_GOAL_MARKS)}`)
    .join('\n');
}

/** Bond fields worth keeping on a rewrite. Empty when the tie is not tracked. */
export function keptBond(rel: Relationship | undefined): Partial<Relationship> {
  if (!rel?.track) return {};
  const marks = copyMarks(rel.marks);
  return {
    track: true,
    score: typeof rel.score === 'number' && Number.isFinite(rel.score)
      ? clampScore(rel.score)
      : seedScoreFromKind(rel.kind),
    ...(isTrackPace(rel.pace) ? { pace: rel.pace } : {}),
    ...(rel.locked ? { locked: true as const } : {}),
    ...(marks.length > 0 ? { marks } : {})
  };
}

export function withBondTracked(rel: Relationship, on: boolean): Relationship {
  if (!on) return { targetId: rel.targetId, kind: rel.kind, note: rel.note };
  const marks = copyMarks(rel.marks);
  return {
    targetId: rel.targetId,
    kind: rel.kind,
    note: rel.note,
    track: true,
    score: typeof rel.score === 'number' && Number.isFinite(rel.score)
      ? clampScore(rel.score)
      : seedScoreFromKind(rel.kind),
    ...(isTrackPace(rel.pace) ? { pace: rel.pace } : {}),
    ...(rel.locked ? { locked: true as const } : {}),
    ...(marks.length > 0 ? { marks } : {})
  };
}

export function emptyPlayerGoal(id: string): PlayerGoal {
  return { id, text: '', score: 0 };
}

function stanceScale(stance: StoryStance): number {
  if (stance === 'intimate') return 1.25;
  if (stance === 'wander') return 0.75;
  return 1;
}

function quantize(shift: number, scaled: number, stance: StoryStance): number {
  const sign = Math.sign(shift) || 1;
  const mag = Math.abs(scaled);
  let steps = stance === 'intimate'
    ? Math.ceil(mag - 1e-9)
    : stance === 'wander'
      ? Math.floor(mag)
      : Math.round(mag);
  if (steps === 0) steps = 1;
  return sign * steps;
}

/** Points to add after pace, stance, and a moment turn. Manual and moment stay put. */
export function scoreStep(opts: {
  shift: unknown;
  pace?: TrackPace;
  worldPace: BondPace;
  stance: StoryStance;
  moment: boolean;
}): number {
  if (opts.moment) return 0;
  const pace = resolveTrackPace(opts.pace, opts.worldPace);
  if (pace === 'manual') return 0;
  const shift = clampShift(opts.shift);
  if (shift === 0) return 0;
  const scaled = shift * PACE_SCALE[pace] * stanceScale(opts.stance);
  return quantize(shift, scaled, opts.stance);
}

function appendClause(note: string, clause: string): string {
  const extra = clause.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!extra) return note;
  if (note.toLowerCase().includes(extra.toLowerCase())) return note;
  const base = note.trim();
  const joiner = !base ? '' : base.endsWith('.') ? ' ' : '. ';
  return `${base}${joiner}${extra}`.slice(0, 240);
}

function moveBond(
  rel: Relationship,
  shift: unknown,
  reason: string | undefined,
  worldPace: BondPace,
  stance: StoryStance
): { rel: Relationship; moved: boolean } {
  const prev = clampScore(rel.score ?? 0);
  const delta = scoreStep({ shift, pace: rel.pace, worldPace, stance, moment: false });
  const score = clampScore(prev + delta);
  if (score === prev) return { rel, moved: false };
  if (rel.locked) return { rel: { ...rel, score }, moved: true };
  const custom = authoredMarks(rel.marks);
  const crossed = crossedUp(prev, score, activeMarks(rel.marks, FALLBACK_BOND_MARKS));
  let kind = rel.kind;
  let note = rel.note ?? '';
  if (crossed) {
    if (custom.length === 0) kind = crossed.text;
    else note = appendClause(note, crossed.text);
  }
  const why = (reason ?? '').trim();
  if (why) note = appendClause(note, why);
  return { rel: { ...rel, score, kind, note }, moved: true };
}

function matchGoal(goals: PlayerGoal[], shift: { text?: string; index?: number }): number {
  if (typeof shift.index === 'number' && Number.isFinite(shift.index)) {
    const index = Math.round(shift.index) - 1;
    if (goals[index]?.text.trim()) return index;
  }
  const key = (shift.text ?? '').trim().toLowerCase();
  if (!key) return -1;
  return goals.findIndex((goal) => goal.text.trim().toLowerCase() === key);
}

export interface TrackedShiftChange {
  id: string;
  relationships?: Relationship[];
  goals?: PlayerGoal[];
}

/**
 * Move only tracks that are already on. Untracked ties are left alone, including their lack of a score.
 * A moment turn and a manual track contribute nothing.
 */
export function applyTrackedShifts(input: {
  people: Character[];
  bonds?: Array<{ name?: string; shift?: number; reason?: string }>;
  goals?: Array<{ text?: string; index?: number; shift?: number; reason?: string }>;
  worldPace: BondPace;
  stance: StoryStance;
  moment: boolean;
}): TrackedShiftChange[] {
  if (input.moment) return [];
  const player = input.people.find((person) => person.isPlayer);
  const changes = new Map<string, TrackedShiftChange>();
  const relsById = new Map<string, Relationship[]>();
  const dirtyRels = new Set<string>();

  const rowsFor = (person: Character): Relationship[] => {
    let rows = relsById.get(person.id);
    if (!rows) {
      rows = person.relationships.map((rel) => ({
        ...rel,
        ...(rel.marks ? { marks: rel.marks.map((mark) => ({ ...mark })) } : {})
      }));
      relsById.set(person.id, rows);
    }
    return rows;
  };

  if (player) {
    for (const shift of (input.bonds ?? []).slice(0, BOND_SHIFT_CAP)) {
      const key = (shift.name ?? '').trim().toLowerCase();
      if (!key) continue;
      const from = input.people.find((person) => !person.isPlayer && person.name.trim().toLowerCase() === key);
      if (!from) continue;
      const rows = rowsFor(from);
      const index = rows.findIndex((rel) => rel.targetId === player.id && rel.track);
      if (index < 0) continue;
      const moved = moveBond(rows[index], shift.shift, shift.reason, input.worldPace, input.stance);
      if (!moved.moved) continue;
      rows[index] = moved.rel;
      dirtyRels.add(from.id);
    }
  }

  for (const id of dirtyRels) {
    const relationships = relsById.get(id);
    if (relationships) changes.set(id, { id, relationships });
  }

  if (player && (player.goals ?? []).some((goal) => goal.text.trim())) {
    const goals = (player.goals ?? []).map((goal) => ({
      ...goal,
      ...(goal.marks ? { marks: goal.marks.map((mark) => ({ ...mark })) } : {})
    }));
    let moved = false;
    for (const shift of (input.goals ?? []).slice(0, PLAYER_GOAL_CAP)) {
      const index = matchGoal(goals, shift);
      if (index < 0) continue;
      const goal = goals[index];
      const delta = scoreStep({
        shift: shift.shift,
        pace: goal.pace,
        worldPace: input.worldPace,
        stance: input.stance,
        moment: false
      });
      if (delta === 0) continue;
      const score = clampScore(goal.score + delta);
      if (score === clampScore(goal.score)) continue;
      goals[index] = { ...goal, score };
      moved = true;
    }
    if (moved) {
      const prior = changes.get(player.id);
      changes.set(player.id, { id: player.id, ...prior, goals });
    }
  }

  return [...changes.values()];
}

export function shouldDraftBondMeanings(rel: Relationship, replace: boolean): boolean {
  if (!rel.track) return false;
  if (authoredMarks(rel.marks).length > 0 && !replace) return false;
  return true;
}

export function shouldDraftGoalMeanings(goal: PlayerGoal, replace: boolean): boolean {
  if (!goal.text.trim()) return false;
  if (authoredMarks(goal.marks).length > 0 && !replace) return false;
  return true;
}

/** An author-written list wins unless they asked to replace it. */
export function marksToKeep(
  existing: ScoreMark[] | undefined,
  incoming: ScoreMark[],
  replace: boolean
): ScoreMark[] {
  const cur = copyMarks(existing);
  if (authoredMarks(cur).length > 0 && !replace) return cur;
  const next = authoredMarks(incoming);
  return next.length > 0 ? next : cur;
}

/**
 * Adding a goal is what turns that track on. A list the author did not ask for stays empty,
 * and a list they already wrote is left as written.
 */
export function goalsToKeep(
  existing: PlayerGoal[] | undefined,
  incoming: PlayerGoal[],
  requested: boolean
): PlayerGoal[] {
  const cur = (existing ?? []).slice(0, PLAYER_GOAL_CAP);
  if (!requested) return cur;
  if (cur.some((goal) => goal.text.trim())) return cur;
  const next = incoming.filter((goal) => goal.text.trim()).slice(0, PLAYER_GOAL_CAP);
  return next.length > 0 ? next : cur;
}
