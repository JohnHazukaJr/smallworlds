import { useState } from 'react';
import { safeWrite } from '../db';
import type { Episode, Season, World } from '../types';
import { Chip, ErrorNote } from '../ui/bits';
import { db } from '../db';
import {
  advanceMonths, calendarPatch, commitStoryDay, dayFromParts, formatStoryDateShort, isEarthCalendar,
  partsForDay, startDatePatch, worldCalendar
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

/**
 * When the story begins: the date story day 1 falls on. For world creation, before
 * any chapter has been played. On an Earth calendar the weekday is worked out; a
 * custom calendar picks its own.
 */
export function StartDateFields({ world, narrow }: { world: World; narrow: boolean }) {
  const [error, setError] = useState('');
  const cal = worldCalendar(world);
  const start = partsForDay(cal, 1);
  const earth = isEarthCalendar(cal);
  const save = (pick: { year?: number; monthIndex?: number; dayOfMonth?: number; weekdayIndex?: number }) => {
    setError('');
    const patch = startDatePatch(cal, {
      year: pick.year ?? start.year,
      monthIndex: pick.monthIndex ?? start.monthIndex,
      dayOfMonth: pick.dayOfMonth ?? start.dayOfMonth,
      weekdayIndex: pick.weekdayIndex
    });
    void safeWrite(
      () => db.worlds.update(world.id, { calendar: calendarPatch(world, patch), updatedAt: Date.now() }),
      setError
    );
  };
  const monthLen = cal.monthLengths[start.monthIndex] ?? 30;
  const label = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.75 } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="label">When does it begin?</div>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr 1fr' : `0.8fr 1.4fr 1fr${earth ? '' : ' 1.2fr'}`, gap: 8 }}>
        <label style={label}>
          Day
          <select
            aria-label="Start day"
            value={start.dayOfMonth}
            onChange={(e) => save({ dayOfMonth: Number(e.target.value) })}
            style={{ fontSize: 13, padding: '8px 10px' }}
          >
            {Array.from({ length: monthLen }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label style={label}>
          Month
          <select
            aria-label="Start month"
            value={start.monthIndex}
            onChange={(e) => save({ monthIndex: Number(e.target.value) })}
            style={{ fontSize: 13, padding: '8px 10px' }}
          >
            {cal.months.map((name, i) => <option key={name + i} value={i}>{name}</option>)}
          </select>
        </label>
        <label style={label}>
          Year
          <input
            aria-label="Start year"
            type="number"
            value={start.year}
            onChange={(e) => {
              const y = Number(e.target.value);
              if (e.target.value.trim() && Number.isFinite(y)) save({ year: y });
            }}
            style={{ ...MONO_INPUT, width: '100%' }}
          />
        </label>
        {!earth && (
          <label style={label}>
            Weekday
            <select
              aria-label="Start weekday"
              value={cal.dayOneWeekday}
              onChange={(e) => save({ weekdayIndex: Number(e.target.value) })}
              style={{ fontSize: 13, padding: '8px 10px' }}
            >
              {cal.weekdays.map((name, i) => <option key={name + i} value={i}>{name}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="label" style={{ lineHeight: 1.5 }}>
        Chapter 1 opens on {formatStoryDateShort(cal, 1).replace(/ Y(-?\d+)$/, ', Year $1')}. The time of year shapes weather,
        festivals, and what people are doing.
      </div>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
    </div>
  );
}
