import { useEffect, useRef } from 'react';
import { ambiguousResidentNote, mentionedResidents, reuseArea, type PlaceCastPerson } from '../ai/placeDraft';
import { Chip, Field } from '../ui/bits';

export interface PlaceCastChip extends PlaceCastPerson {
  hue: number;
}

/**
 * Area, who the place is for, and one nearby line.
 * Names that appear as the author types light up. Turning a chip off stays off for this visit.
 */
export function PlaceSettingFields({
  placeKey,
  cast,
  areas,
  area,
  near,
  residentIds,
  dismissedIds,
  authorText,
  onArea,
  onNear,
  onResidentIds,
  onDismissedIds
}: {
  placeKey: string;
  cast: PlaceCastChip[];
  areas: string[];
  area: string;
  near: string;
  residentIds: string[];
  dismissedIds?: string[];
  authorText: string;
  onArea: (area: string) => void;
  onNear: (near: string) => void;
  onResidentIds: (ids: string[]) => void;
  onDismissedIds?: (ids: string[]) => void;
}) {
  const dismissed = useRef(new Set(dismissedIds ?? []));
  const residentRef = useRef(residentIds);
  residentRef.current = residentIds;
  const prevText = useRef<string | null>(null);
  const castKey = cast.map((person) => `${person.id}:${person.name}`).join('|');
  const named = cast.filter((person) => person.name.trim());
  const selected = named.filter((person) => residentIds.includes(person.id));
  const ambiguous = ambiguousResidentNote(authorText, named);
  const listId = `place-areas-${placeKey}`;

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

  const home = selected.map((person) => person.name.trim()).filter(Boolean);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Area" note="the neighborhood or district">
        <input
          list={listId}
          value={area}
          placeholder="Briar Park"
          onChange={(e) => onArea(e.target.value)}
          onBlur={() => {
            const next = reuseArea(area, areas);
            if (next !== area) onArea(next);
          }}
        />
        <datalist id={listId}>
          {areas.map((item) => <option key={item} value={item} />)}
        </datalist>
      </Field>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-heading)' }}>Who it’s for</div>
        {named.length === 0 ? (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
            Add people on Cast first. Fill in will not invent a resident.
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
        {!ambiguous && named.length > 0 && home.length === 0 && (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
            Fill in will not invent a resident.
          </div>
        )}
        {home.length > 0 && (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--paper)' }}>
            Home of {home.length === 1 ? home[0] : home.length === 2 ? `${home[0]} and ${home[1]}` : `${home.slice(0, -1).join(', ')}, and ${home[home.length - 1]}`}.
          </div>
        )}
      </div>

      <Field label="Nearby" note="one line, optional">
        <input
          value={near}
          placeholder="about 15 minutes from the school"
          onChange={(e) => onNear(e.target.value)}
        />
      </Field>
    </div>
  );
}
