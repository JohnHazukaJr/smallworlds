import { useEffect, useRef } from 'react';
import { ambiguousResidentNote, mentionedResidents, type PlaceCastPerson } from '../ai/placeDraft';
import { placeTree, wouldCreateLoop } from '../places';
import type { Location } from '../types';
import { Chip, Field } from '../ui/bits';

export interface PlaceCastChip extends PlaceCastPerson {
  hue: number;
}

/**
 * Where a place sits (inside another place), who belongs there, and what is
 * nearby. Names that appear as the author types light up as residents;
 * turning a chip off stays off for this visit.
 */
export function PlaceSettingFields({
  placeKey,
  placeId,
  cast,
  places,
  parentId,
  nearIds,
  residentIds,
  dismissedIds,
  authorText,
  onParentId,
  onNearIds,
  onResidentIds,
  onDismissedIds
}: {
  placeKey: string;
  /** The place being edited. Missing for a place not saved yet. */
  placeId?: string;
  cast: PlaceCastChip[];
  /** Every place in the world. */
  places: Location[];
  parentId: string | null | undefined;
  nearIds?: string[];
  residentIds: string[];
  dismissedIds?: string[];
  authorText: string;
  onParentId: (id: string | null) => void;
  onNearIds?: (ids: string[]) => void;
  onResidentIds: (ids: string[]) => void;
  onDismissedIds?: (ids: string[]) => void;
}) {
  const dismissed = useRef(new Set(dismissedIds ?? []));
  const residentRef = useRef(residentIds);
  residentRef.current = residentIds;
  const prevText = useRef<string | null>(null);
  const castKey = cast.map((person) => `${person.id}:${person.name}`).join('|');
  const named = cast.filter((person) => person.name.trim());
  const ambiguous = ambiguousResidentNote(authorText, named);
  const others = places.filter((p) => p.id !== placeId);
  const parentOptions = placeTree(others).filter((row) => !placeId || !wouldCreateLoop(placeId, row.place.id, places));
  const near = nearIds ?? [];

  useEffect(() => {
    prevText.current = authorText;
    dismissed.current = new Set(dismissedIds ?? []);
    // Only when the place changes. Typing is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);

  useEffect(() => {
    if (prevText.current === null) {
      prevText.current = authorText;
      return;
    }
    if (prevText.current === authorText) return;
    const before = new Set(mentionedResidents(prevText.current, named).map((person) => person.id));
    prevText.current = authorText;
    const appeared = mentionedResidents(authorText, named)
      .filter((person) => !before.has(person.id) && !dismissed.current.has(person.id));
    if (appeared.length === 0) return;
    const next = [...new Set([...residentRef.current, ...appeared.map((person) => person.id)])];
    onResidentIds(next);
    // named is derived from castKey. onResidentIds is a parent setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorText, castKey]);

  const toggle = (id: string) => {
    const on = residentIds.includes(id);
    if (on) dismissed.current.add(id);
    else dismissed.current.delete(id);
    onDismissedIds?.([...dismissed.current]);
    onResidentIds(on ? residentIds.filter((item) => item !== id) : [...residentIds, id]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Inside" note="the bigger place this one is part of — a room in a building, a shop in a town">
        <select
          value={parentId ?? ''}
          onChange={(e) => onParentId(e.target.value || null)}
          disabled={parentOptions.length === 0}
        >
          <option value="">{parentOptions.length === 0 ? 'No other places yet' : 'Nowhere — top level'}</option>
          {parentOptions.map(({ place, depth }) => (
            <option key={place.id} value={place.id}>
              {`${'  '.repeat(depth)}${place.name.trim() || 'Unnamed place'}`}
            </option>
          ))}
        </select>
      </Field>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-heading)' }}>Belongs to</div>
        {named.length === 0 ? (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
            Add people on Cast first. Whoever you tap here lives or works here.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {named.map((person) => (
              <Chip key={person.id} active={residentIds.includes(person.id)} onClick={() => toggle(person.id)}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: `oklch(0.72 0.08 ${person.hue})`, marginRight: 6
                }} />
                {person.name}
              </Chip>
            ))}
          </div>
        )}
        {ambiguous && (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)' }}>{ambiguous}</div>
        )}
      </div>

      {onNearIds && others.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-heading)' }}>
            Nearby <span style={{ fontWeight: 400, color: 'var(--ink-muted)', fontSize: 12 }}>· a short walk or ride away</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {others.map((p) => {
              const on = near.includes(p.id);
              return (
                <Chip key={p.id} active={on} onClick={() => onNearIds(on ? near.filter((id) => id !== p.id) : [...near, p.id])}>
                  {p.name.trim() || 'Unnamed place'}
                </Chip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** One rule per row, add and remove. Optional: most places need none. */
export function PlaceRulesEditor({ rules, onRules }: { rules: string[]; onRules: (rules: string[]) => void }) {
  const rows = rules.length > 0 ? rules : [];
  const set = (index: number, value: string) => onRules(rows.map((r, i) => (i === index ? value : r)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((rule, index) => (
        <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={rule}
            onChange={(e) => set(index, e.target.value)}
            onBlur={() => { if (!rule.trim()) onRules(rows.filter((_, i) => i !== index)); }}
            placeholder="e.g. The causeway floods at high tide — no crossing after the bell."
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="button" className="btn-quiet" style={{ fontSize: 11 }} onClick={() => onRules(rows.filter((_, i) => i !== index))}>
            remove
          </button>
        </div>
      ))}
      <button type="button" className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }} onClick={() => onRules([...rows, ''])}>
        + add a rule
      </button>
    </div>
  );
}
