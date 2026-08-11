import { describe, expect, it } from 'vitest';
import {
  dayInEventWindow,
  planCalendarEventStatusUpdates,
  selectCalendarEventsForPrompt,
  windowIntersectsAdvance,
  windowIntersectsInclusive,
  emptyCalendarEvent
} from './calendarEvents';
import type { CalendarEvent } from './types';
import { defaultVisibilityForKind, worldCalendarEventPrefs } from './types';

const ev = (patch: Partial<CalendarEvent>): CalendarEvent => ({
  id: patch.id ?? 'e1',
  worldId: 'w',
  seasonId: 's',
  title: patch.title ?? 'Feast',
  summary: patch.summary ?? 'People gather.',
  kind: patch.kind ?? 'festival',
  scale: patch.scale ?? 'small',
  storyDay: patch.storyDay ?? 10,
  endDay: patch.endDay,
  visibility: patch.visibility ?? 'title',
  promptPolicy: patch.promptPolicy ?? 'soft',
  status: patch.status ?? 'scheduled',
  source: patch.source ?? 'manual',
  createdAt: 1,
  updatedAt: 1
});

describe('calendar event windows', () => {
  it('detects advance intersections', () => {
    expect(windowIntersectsAdvance(10, 10, 9, 10)).toBe(true);
    expect(windowIntersectsAdvance(10, 12, 8, 9)).toBe(false);
    expect(windowIntersectsAdvance(5, 8, 8, 12)).toBe(false);
    expect(windowIntersectsAdvance(9, 11, 8, 12)).toBe(true);
  });

  it('inclusive wrap activates same-day windows', () => {
    expect(windowIntersectsInclusive(10, 10, 10, 10)).toBe(true);
    expect(windowIntersectsInclusive(10, 12, 11, 11)).toBe(true);
    expect(windowIntersectsInclusive(20, 22, 10, 12)).toBe(false);
  });

  it('marks scheduled → due on advance into window', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 10, status: 'scheduled' })],
      9,
      10,
      'advance'
    );
    expect(updates).toEqual([{ id: 'a', status: 'due' }]);
  });

  it('wrap same-day activates scheduled events', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 10, status: 'scheduled' })],
      10,
      10,
      'wrap'
    );
    expect(updates).toEqual([{ id: 'a', status: 'due' }]);
  });

  it('does not auto-miss on advance scrub', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 5, status: 'due' })],
      10,
      20,
      'advance'
    );
    expect(updates).toEqual([]);
  });

  it('misses overdue due events on wrap with grace', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 5, endDay: 6, status: 'due' })],
      1,
      10,
      'wrap'
    );
    expect(updates).toEqual([{ id: 'a', status: 'missed' }]);
  });

  it('misses overdue scheduled on wrap instead of sticky due', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 5, status: 'scheduled' })],
      1,
      20,
      'wrap'
    );
    expect(updates).toEqual([{ id: 'a', status: 'missed' }]);
  });

  it('keeps due within grace on wrap', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 8, status: 'due' })],
      1,
      9,
      'wrap'
    );
    expect(updates).toEqual([]);
  });

  it('excludes played ids from miss planning', () => {
    const updates = planCalendarEventStatusUpdates(
      [ev({ id: 'a', storyDay: 5, status: 'due' })],
      1,
      20,
      'wrap',
      { excludeIds: new Set(['a']) }
    );
    expect(updates).toEqual([]);
  });

  it('selects due and upcoming for prompts', () => {
    const { due, upcoming } = selectCalendarEventsForPrompt(
      [
        ev({ id: 'd', storyDay: 20, status: 'due', title: 'Due now' }),
        ev({ id: 'u', storyDay: 24, status: 'scheduled', title: 'Soon' }),
        ev({ id: 'f', storyDay: 40, status: 'scheduled', title: 'Far' })
      ],
      { sceneDay: 20, upcomingDays: 7 }
    );
    expect(due.map((e) => e.id)).toContain('d');
    expect(upcoming.map((e) => e.id)).toContain('u');
    expect(upcoming.map((e) => e.id)).not.toContain('f');
  });

  it('dayInEventWindow handles multi-day festivals', () => {
    expect(dayInEventWindow(11, ev({ storyDay: 10, endDay: 12 }))).toBe(true);
    expect(dayInEventWindow(13, ev({ storyDay: 10, endDay: 12 }))).toBe(false);
  });

  it('emptyCalendarEvent marks today as due when currentDay provided', () => {
    const created = emptyCalendarEvent('w', 's', { storyDay: 5, title: 'Now' }, { currentDay: 5 });
    expect(created.status).toBe('due');
    const future = emptyCalendarEvent('w', 's', { storyDay: 20, title: 'Later' }, { currentDay: 5 });
    expect(future.status).toBe('scheduled');
  });

  it('emptyCalendarEvent rejects NaN storyDay', () => {
    const created = emptyCalendarEvent('w', 's', { storyDay: Number.NaN });
    expect(created.storyDay).toBe(1);
  });
});

describe('calendar event prefs', () => {
  it('defaults visibility by kind for AI spoilers', () => {
    expect(defaultVisibilityForKind('personal')).toBe('hidden');
    expect(defaultVisibilityForKind('disaster')).toBe('hidden');
    expect(defaultVisibilityForKind('festival')).toBe('title');
  });

  it('resolves world prefs defaults', () => {
    expect(worldCalendarEventPrefs(null)).toMatchObject({
      enabled: true,
      aiSeedOnSeasonStart: false,
      defaultVisibility: 'title'
    });
  });
});
