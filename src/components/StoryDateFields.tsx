import { useState } from 'react';
import { safeWrite } from '../db';
import type { Episode, Season, World } from '../types';
import { Chip, ErrorNote } from '../ui/bits';
import {
  advanceMonths, commitStoryDay, dayFromParts, formatStoryDateShort, partsForDay, worldCalendar
} from '../worldOps';

const MONO_INPUT = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 } as const;

/**
 * Day, month, and year for the scene. Saving moves the world clock and the
 * active chapter's story day together.
 */
export function StoryDateFields({
  world, season, episode, narrow
}: {
  world: World;
  season: Season;
  episode: Episode;
  narrow: boolean;
}) {
  const [error, setError] = useState('');
  const cal = worldCalendar(world);
  const today = partsForDay(cal, cal.currentDay);
  const monthLen = cal.monthLengths[today.monthIndex] ?? 30;
  const setDay = (day: number) => {
    setError('');
    void safeWrite(
      () => commitStoryDay({ world, seasonId: season.id, episode, day }),
      setError
    );
  };
  const setParts = (year: number, monthIndex: number, dayOfMonth: number) =>
    setDay(dayFromParts(cal, year, monthIndex, dayOfMonth));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--ink-heading)' }}>
        {formatStoryDateShort(cal, cal.currentDay)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Chip onClick={() => setDay(cal.currentDay - 1)}>−1</Chip>
        <Chip onClick={() => setDay(cal.currentDay + 1)}>+1 day</Chip>
        <Chip onClick={() => setDay(cal.currentDay + 7)}>+7 days</Chip>
        <Chip onClick={() => setDay(advanceMonths(cal, cal.currentDay, 1))}>+1 month</Chip>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1.4fr 0.9fr', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
          Day
          <input
            type="number"
            min={1}
            max={monthLen}
            value={today.dayOfMonth}
            onChange={(e) => setParts(today.year, today.monthIndex, Number(e.target.value) || 1)}
            style={{ ...MONO_INPUT, width: '100%' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
          Month
          <select
            value={today.monthIndex}
            onChange={(e) => setParts(today.year, Number(e.target.value), today.dayOfMonth)}
            style={{ fontSize: 13, padding: '8px 10px' }}
          >
            {cal.months.map((name, i) => (
              <option key={name + i} value={i}>{name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 }}>
          Year
          <input
            type="number"
            value={today.year}
            onChange={(e) => setParts(Number(e.target.value) || cal.yearOne, today.monthIndex, today.dayOfMonth)}
            style={{ ...MONO_INPUT, width: '100%' }}
          />
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.75 }}>
        Absolute day
        <input
          type="number"
          min={1}
          value={cal.currentDay}
          onChange={(e) => setDay(Math.max(1, Number(e.target.value) || 1))}
          style={{ width: 72, ...MONO_INPUT }}
        />
      </label>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
    </div>
  );
}
