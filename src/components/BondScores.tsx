import { useEffect, useRef, useState } from 'react';
import {
  activeMarks, clampScore, copyMarks, emptyPlayerGoal, FALLBACK_BOND_MARKS, FALLBACK_GOAL_MARKS,
  meaningAt, PLAYER_GOAL_CAP, worldBondPace
} from '../bonds';
import { uid } from '../db';
import { formatUserError } from '../errors';
import type { BondPace, Character, PlayerGoal, Relationship, ScoreMark, TrackPace } from '../types';
import { Chip, Field, Mono, Toggle } from '../ui/bits';

const TRACK_PACES: Array<{ id: 'world' | TrackPace; label: string }> = [
  { id: 'world', label: 'World' },
  { id: 'slow', label: 'Slow burn' },
  { id: 'measured', label: 'Measured' },
  { id: 'quick', label: 'Quick' },
  { id: 'manual', label: 'Manual' }
];

const WORLD_PACES: Array<{ id: BondPace; label: string }> = [
  { id: 'slow', label: 'Slow burn' },
  { id: 'measured', label: 'Measured' },
  { id: 'quick', label: 'Quick' }
];

export function WorldBondPaceChips({
  value, onChange
}: {
  value: BondPace | undefined;
  onChange: (pace: BondPace) => void;
}) {
  const current = worldBondPace({ bondPace: value });
  return (
    <Field label="Bond progression" note="How fast a tracked bond or goal moves. Each one can pick its own.">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {WORLD_PACES.map((pace) => (
          <Chip key={pace.id} active={current === pace.id} onClick={() => onChange(pace.id)}>{pace.label}</Chip>
        ))}
      </div>
    </Field>
  );
}

export function TrackPaceChips({
  pace, onChange
}: {
  pace: TrackPace | undefined;
  onChange: (pace: TrackPace | undefined) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {TRACK_PACES.map((choice) => (
        <Chip
          key={choice.id}
          active={choice.id === 'world' ? !pace : pace === choice.id}
          onClick={() => onChange(choice.id === 'world' ? undefined : choice.id)}
        >{choice.label}</Chip>
      ))}
    </div>
  );
}

function MeaningEditor({
  marks, score, fallback, onChange
}: {
  marks: ScoreMark[] | undefined;
  score: number;
  fallback: ScoreMark[];
  onChange: (marks: ScoreMark[]) => void;
}) {
  const custom = copyMarks(marks);
  const usingFallback = activeMarks(custom, fallback) === fallback || (
    custom.every((mark) => !mark.text.trim()) && custom.length === 0
  );
  const shown = custom.some((mark) => mark.text.trim()) || custom.length > 0 ? custom : fallback;
  const readingFallback = !custom.some((mark) => mark.text.trim()) && custom.length === 0;
  const { current } = meaningAt(score, activeMarks(custom, fallback));
  const commit = (next: ScoreMark[]) => onChange(copyMarks(next));
  const baseRows = () => (readingFallback ? fallback.map((mark) => ({ ...mark })) : custom.map((mark) => ({ ...mark })));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {shown.map((mark, index) => {
        const ink = !!current && mark.at === current.at && mark.text.trim() === current.text.trim();
        return (
          <div key={`${mark.at}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              max={100}
              aria-label="Points where this becomes true"
              value={mark.at}
              onChange={(e) => {
                const base = baseRows();
                base[index] = { ...base[index], at: clampScore(e.target.value) };
                commit(base);
              }}
              style={{ width: 72, color: ink ? 'var(--ink-heading)' : 'var(--ink-muted)' }}
            />
            <input
              aria-label="What these points mean"
              value={mark.text}
              onChange={(e) => {
                const base = baseRows();
                base[index] = { ...base[index], text: e.target.value };
                commit(base);
              }}
              placeholder="what this score means"
              style={{ flex: 1, color: ink ? 'var(--ink-heading)' : 'var(--ink-muted)' }}
            />
            <button
              type="button"
              className="btn-quiet"
              style={{ fontSize: 12, minHeight: 36 }}
              onClick={() => commit(baseRows().filter((_, row) => row !== index))}
            >×</button>
          </div>
        );
      })}
      {shown.length < 6 && (
        <button
          type="button"
          className="btn-quiet"
          style={{ alignSelf: 'flex-start', fontSize: 12, minHeight: 36 }}
          onClick={() => {
            const base = readingFallback ? fallback.map((mark) => ({ ...mark })) : custom;
            if (base.length >= 6) return;
            const last = base[base.length - 1]?.at ?? 0;
            commit([...base, { at: Math.min(100, last + 20), text: '' }]);
          }}
        >Add a meaning</button>
      )}
      {usingFallback && readingFallback && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>These stand in until you write your own.</div>
      )}
    </div>
  );
}

export function BondTrackBlock({
  rel, onChange, canDraft, onDraft
}: {
  rel: Relationship;
  onChange: (next: Relationship) => void;
  canDraft?: boolean;
  onDraft?: (replace: boolean) => Promise<ScoreMark[]>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const relRef = useRef(rel);
  relRef.current = rel;
  const hasMarks = (rel.marks ?? []).some((mark) => mark.text.trim());
  const score = clampScore(rel.score ?? 0);

  const draft = async () => {
    if (!onDraft) return;
    setBusy(true);
    setError('');
    try {
      const marks = await onDraft(hasMarks);
      const current = relRef.current;
      if (!current.track) return;
      if (!hasMarks && (current.marks ?? []).some((mark) => mark.text.trim())) return;
      onChange({ ...current, marks });
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="craft-row" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <TrackPaceChips pace={rel.pace} onChange={(pace) => onChange({ ...rel, pace })} />
      <Field label="Points">
        <input
          type="number"
          min={0}
          max={100}
          aria-label="Bond points"
          value={score}
          onChange={(e) => onChange({ ...rel, score: clampScore(e.target.value) })}
          style={{ width: 88 }}
        />
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Toggle
          on={!!rel.locked}
          label="Keep kind and note"
          onClick={() => onChange({ ...rel, locked: rel.locked ? undefined : true })}
        />
        <span style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>Keep the written kind and note</span>
      </div>
      <MeaningEditor
        marks={rel.marks}
        score={score}
        fallback={FALLBACK_BOND_MARKS}
        onChange={(marks) => onChange({ ...rel, marks })}
      />
      {canDraft && (
        <button
          type="button"
          className="btn-ghost"
          style={{ alignSelf: 'flex-start', fontSize: 12 }}
          disabled={busy}
          onClick={() => void draft()}
        >{busy ? 'Drafting meanings…' : hasMarks ? 'Draft meanings again' : 'Draft meanings'}</button>
      )}
      {error && <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>{error}</div>}
    </div>
  );
}

export function PlayerGoalsEditor({
  goals, onChange, canDraft, onDraftGoals, onDraftMeanings
}: {
  goals: PlayerGoal[] | undefined;
  onChange: (goals: PlayerGoal[]) => void;
  canDraft?: boolean;
  onDraftGoals?: () => Promise<PlayerGoal[]>;
  onDraftMeanings?: (goal: PlayerGoal, replace: boolean) => Promise<ScoreMark[]>;
}) {
  const list = (goals ?? []).slice(0, PLAYER_GOAL_CAP);
  const goalsRef = useRef(list);
  goalsRef.current = list;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const written = list.some((goal) => goal.text.trim());

  const replace = (next: PlayerGoal[]) => onChange(next.slice(0, PLAYER_GOAL_CAP));
  const update = (id: string, patch: Partial<PlayerGoal>) => {
    replace(list.map((goal) => (goal.id === id ? { ...goal, ...patch } : goal)));
  };

  const draftGoals = async () => {
    if (!onDraftGoals) return;
    setBusy('goals');
    setError('');
    try {
      if ((goalsRef.current ?? []).some((goal) => goal.text.trim())) return;
      const next = await onDraftGoals();
      if ((goalsRef.current ?? []).some((goal) => goal.text.trim())) return;
      replace(next);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  const draftMeanings = async (goal: PlayerGoal) => {
    if (!onDraftMeanings) return;
    const replaceMarks = (goal.marks ?? []).some((mark) => mark.text.trim());
    setBusy(goal.id);
    setError('');
    try {
      const marks = await onDraftMeanings(goal, replaceMarks);
      const currentList = goalsRef.current;
      const current = currentList.find((row) => row.id === goal.id);
      if (!current) return;
      if (!replaceMarks && (current.marks ?? []).some((mark) => mark.text.trim())) return;
      replace(currentList.map((row) => (row.id === goal.id ? { ...row, marks } : row)));
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-heading)' }}>Longer aims</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)', marginTop: 4 }}>
          Each one has its own points. The chapter page does not show the number. The scene goal is only what they want right now.
        </div>
      </div>
      {list.map((goal) => {
        const score = clampScore(goal.score);
        const hasMarks = (goal.marks ?? []).some((mark) => mark.text.trim());
        return (
          <div key={goal.id} className="craft-row" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              aria-label="Player goal"
              value={goal.text}
              onChange={(e) => update(goal.id, { text: e.target.value })}
              placeholder="What they are working toward"
            />
            <TrackPaceChips pace={goal.pace} onChange={(pace) => update(goal.id, { pace })} />
            <Field label="Points">
              <input
                type="number"
                min={0}
                max={100}
                aria-label="Goal points"
                value={score}
                onChange={(e) => update(goal.id, { score: clampScore(e.target.value) })}
                style={{ width: 88 }}
              />
            </Field>
            <MeaningEditor
              marks={goal.marks}
              score={score}
              fallback={FALLBACK_GOAL_MARKS}
              onChange={(marks) => update(goal.id, { marks })}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {canDraft && goal.text.trim() && (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  disabled={busy === goal.id}
                  onClick={() => void draftMeanings(goal)}
                >{busy === goal.id ? 'Drafting meanings…' : hasMarks ? 'Draft meanings again' : 'Draft meanings'}</button>
              )}
              <button
                type="button"
                className="btn-quiet"
                style={{ fontSize: 12 }}
                onClick={() => replace(list.filter((row) => row.id !== goal.id))}
              >Remove</button>
            </div>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {list.length < PLAYER_GOAL_CAP && (
          <button
            type="button"
            className="btn-ghost"
            style={{ fontSize: 12 }}
            onClick={() => replace([...list, emptyPlayerGoal(uid())])}
          >Add a goal</button>
        )}
        {canDraft && !written && (
          <button
            type="button"
            className="btn-ghost"
            style={{ fontSize: 12 }}
            disabled={busy === 'goals'}
            onClick={() => void draftGoals()}
          >{busy === 'goals' ? 'Drafting goals…' : 'Draft goals'}</button>
        )}
      </div>
      {error && <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>{error}</div>}
    </div>
  );
}

function ScorePeek({
  name, score, marks, fallback, onScore
}: {
  name: string;
  score: number;
  marks: ScoreMark[] | undefined;
  fallback: ScoreMark[];
  onScore: (n: number) => void;
}) {
  const [text, setText] = useState(String(clampScore(score)));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(clampScore(score)));
  }, [score, focused]);
  const pair = meaningAt(clampScore(text), activeMarks(marks, fallback));
  return (
    <div className="craft-row" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, color: 'var(--ink-heading)', minWidth: 0 }}>{name}</div>
        <input
          type="number"
          min={0}
          max={100}
          aria-label={`${name} points`}
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            const next = clampScore(text);
            setText(String(next));
            if (next !== clampScore(score)) onScore(next);
          }}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() === '') return;
            const next = clampScore(e.target.value);
            if (next !== clampScore(score)) onScore(next);
          }}
          style={{ width: 72 }}
        />
      </div>
      {pair.current && (
        <div style={{ fontSize: 13, color: 'var(--ink-heading)' }}>{pair.current.text}</div>
      )}
      {pair.next && (
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>Next: {pair.next.text}</div>
      )}
    </div>
  );
}

/** Edit-world peek. Nothing here when this chapter has no tracked bond and no player goal. */
export function TrackedScoreSection({
  characters, castIds, onPatch
}: {
  characters: Character[];
  castIds: string[];
  onPatch: (id: string, patch: Partial<Character>) => void;
}) {
  const player = characters.find((person) => person.isPlayer);
  const here = new Set(castIds);
  const bonds = characters.flatMap((person) => {
    if (!player || person.isPlayer || !here.has(person.id)) return [];
    return person.relationships
      .filter((rel) => rel.track && rel.targetId === player.id)
      .map((rel) => ({ person, rel }));
  });
  const goals = (player?.goals ?? []).filter((goal) => goal.text.trim());
  if (bonds.length === 0 && goals.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Mono style={{ fontSize: 9 }}>bonds and goals</Mono>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
        The chapter page does not show these numbers.
      </div>
      {bonds.map(({ person, rel }) => (
        <ScorePeek
          key={`${person.id}:${rel.targetId}`}
          name={person.name || 'unnamed'}
          score={rel.score ?? 0}
          marks={rel.marks}
          fallback={FALLBACK_BOND_MARKS}
          onScore={(score) => onPatch(person.id, {
            relationships: person.relationships.map((row) => (
              row.targetId === rel.targetId ? { ...row, score } : row
            ))
          })}
        />
      ))}
      {player && goals.map((goal) => (
        <ScorePeek
          key={goal.id}
          name={goal.text}
          score={goal.score}
          marks={goal.marks}
          fallback={FALLBACK_GOAL_MARKS}
          onScore={(score) => onPatch(player.id, {
            goals: (player.goals ?? []).map((row) => (row.id === goal.id ? { ...row, score } : row))
          })}
        />
      ))}
    </div>
  );
}
