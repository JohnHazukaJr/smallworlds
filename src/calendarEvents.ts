import { db, guardStorage, uid } from './db';
import type {
  CalendarEvent,
  CalendarEventKind,
  CalendarEventScale,
  CalendarEventStatus,
  CalendarEventVisibility,
  World
} from './types';
import {
  CALENDAR_EVENT_CAP,
  defaultVisibilityForKind,
  worldCalendarEventPrefs
} from './types';

/** Inclusive window for an event. */
export function eventWindow(ev: Pick<CalendarEvent, 'storyDay' | 'endDay'>): { start: number; end: number } {
  const start = Math.max(1, Math.floor(ev.storyDay));
  const end = ev.endDay != null && ev.endDay >= start ? Math.floor(ev.endDay) : start;
  return { start, end };
}

/** True if [start, end] overlaps (fromDay, toDay] — half-open on the left (day advance). */
export function windowIntersectsAdvance(
  start: number,
  end: number,
  fromDay: number,
  toDay: number
): boolean {
  if (toDay <= fromDay) return false;
  // Overlap of [start, end] with (fromDay, toDay]
  return start <= toDay && end > fromDay;
}

/** True if [start, end] overlaps inclusive [fromDay, toDay] (episode wrap window). */
export function windowIntersectsInclusive(
  start: number,
  end: number,
  fromDay: number,
  toDay: number
): boolean {
  const a = Math.min(fromDay, toDay);
  const b = Math.max(fromDay, toDay);
  return start <= b && end >= a;
}

/** True if absolute day falls inside the event window (inclusive). */
export function dayInEventWindow(day: number, ev: Pick<CalendarEvent, 'storyDay' | 'endDay'>): boolean {
  const { start, end } = eventWindow(ev);
  return day >= start && day <= end;
}

export function eventOverlapsRange(
  ev: Pick<CalendarEvent, 'storyDay' | 'endDay'>,
  rangeStart: number,
  rangeEnd: number
): boolean {
  const { start, end } = eventWindow(ev);
  const a = Math.min(rangeStart, rangeEnd);
  const b = Math.max(rangeStart, rangeEnd);
  return start <= b && end >= a;
}

export type EvaluateCalendarMode = 'advance' | 'wrap';

/**
 * Mark scheduled → due when the day advance / wrap window hits them.
 * On wrap: overdue scheduled past grace → missed; due past grace → missed.
 * `excludeIds` are skipped (e.g. just marked played).
 */
export function planCalendarEventStatusUpdates(
  events: CalendarEvent[],
  fromDay: number,
  toDay: number,
  mode: EvaluateCalendarMode,
  opts?: { excludeIds?: Set<string> }
): Array<{ id: string; status: CalendarEventStatus }> {
  const exclude = opts?.excludeIds ?? new Set<string>();
  const updates: Array<{ id: string; status: CalendarEventStatus }> = [];
  for (const ev of events) {
    if (exclude.has(ev.id)) continue;
    if (ev.status === 'cancelled' || ev.status === 'played' || ev.status === 'missed') continue;
    const { start, end } = eventWindow(ev);

    if (ev.status === 'scheduled') {
      const enters = mode === 'wrap'
        ? windowIntersectsInclusive(start, end, fromDay, toDay)
        : windowIntersectsAdvance(start, end, fromDay, toDay);
      if (enters) {
        // Wrap: if already past grace, close as missed instead of sticky due.
        if (mode === 'wrap' && toDay > end + 1) {
          updates.push({ id: ev.id, status: 'missed' });
        } else {
          updates.push({ id: ev.id, status: 'due' });
        }
        continue;
      }
      // Scheduled that never entered the window but is overdue on wrap → missed.
      if (mode === 'wrap' && toDay > end + 1) {
        updates.push({ id: ev.id, status: 'missed' });
      }
      continue;
    }

    if (mode === 'wrap' && ev.status === 'due' && toDay > end + 1) {
      updates.push({ id: ev.id, status: 'missed' });
    }
  }
  return updates;
}

export async function evaluateCalendarEvents(opts: {
  worldId: string;
  seasonId: string;
  fromDay: number;
  toDay: number;
  mode: EvaluateCalendarMode;
  world?: Pick<World, 'calendarEventPrefs'> | null;
  excludeIds?: Set<string>;
}): Promise<number> {
  const prefs = worldCalendarEventPrefs(opts.world ?? await db.worlds.get(opts.worldId));
  if (!prefs.enabled) return 0;
  const events = await db.calendarEvents.where('seasonId').equals(opts.seasonId).toArray();
  const updates = planCalendarEventStatusUpdates(events, opts.fromDay, opts.toDay, opts.mode, {
    excludeIds: opts.excludeIds
  });
  if (updates.length === 0) return 0;
  const now = Date.now();
  await guardStorage(async () => {
    for (const u of updates) {
      await db.calendarEvents.update(u.id, { status: u.status, updatedAt: now });
    }
  });
  return updates.length;
}

export function emptyCalendarEvent(
  worldId: string,
  seasonId: string,
  patch: Partial<CalendarEvent> = {},
  opts?: { currentDay?: number }
): CalendarEvent {
  const now = Date.now();
  const kind: CalendarEventKind = patch.kind ?? 'custom';
  const rawDay = Number(patch.storyDay);
  const storyDay = Number.isFinite(rawDay) && rawDay >= 1 ? Math.floor(rawDay) : 1;
  const rawEnd = patch.endDay != null ? Number(patch.endDay) : NaN;
  const endDay = Number.isFinite(rawEnd) && rawEnd >= storyDay ? Math.floor(rawEnd) : undefined;
  const currentDay = opts?.currentDay != null && Number.isFinite(opts.currentDay)
    ? Math.max(1, Math.floor(opts.currentDay))
    : undefined;
  const status = patch.status
    ?? (currentDay != null && storyDay <= currentDay ? 'due' : 'scheduled');
  return {
    id: patch.id ?? uid(),
    worldId,
    seasonId,
    title: patch.title ?? '',
    summary: patch.summary ?? '',
    kind,
    scale: patch.scale ?? 'small',
    storyDay,
    endDay,
    visibility: patch.visibility ?? defaultVisibilityForKind(kind),
    promptPolicy: patch.promptPolicy ?? 'soft',
    status,
    characterIds: patch.characterIds,
    source: patch.source ?? 'manual',
    pinned: patch.pinned,
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now
  };
}

export function activeCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.filter((e) => e.status === 'scheduled' || e.status === 'due');
}

/** Cap for prompt / seed lists — pinned first, then due, then soonest day. */
export function selectCalendarEventsForPrompt(
  events: CalendarEvent[],
  opts: { sceneDay: number; upcomingDays?: number; cap?: number }
): { due: CalendarEvent[]; upcoming: CalendarEvent[] } {
  const upcomingDays = opts.upcomingDays ?? 7;
  const cap = opts.cap ?? CALENDAR_EVENT_CAP;
  const due: CalendarEvent[] = [];
  const upcoming: CalendarEvent[] = [];
  const sorted = [...events]
    .filter((e) => e.status === 'scheduled' || e.status === 'due')
    .sort((a, b) => {
      const pin = Number(!!b.pinned) - Number(!!a.pinned);
      if (pin) return pin;
      const dueRank = Number(b.status === 'due') - Number(a.status === 'due');
      if (dueRank) return dueRank;
      return a.storyDay - b.storyDay;
    });

  for (const ev of sorted) {
    if (dayInEventWindow(opts.sceneDay, ev) || ev.status === 'due') {
      if (due.length + upcoming.length < cap) due.push(ev);
      continue;
    }
    const { start } = eventWindow(ev);
    if (start > opts.sceneDay && start <= opts.sceneDay + upcomingDays) {
      if (due.length + upcoming.length < cap) upcoming.push(ev);
    }
  }
  return { due, upcoming };
}

/** Display title respecting visibility (UI only). */
export function displayEventTitle(ev: CalendarEvent, revealedIds: Set<string>): string {
  if (ev.visibility === 'hidden' && !revealedIds.has(ev.id)) return 'Hidden beat';
  return ev.title.trim() || '(untitled)';
}

export function displayEventSummary(ev: CalendarEvent, revealedIds: Set<string>): string | null {
  if (ev.visibility === 'spoiler' || revealedIds.has(ev.id)) return ev.summary;
  if (ev.visibility === 'title') return null;
  return null;
}

export const CALENDAR_EVENT_KINDS: CalendarEventKind[] = [
  'holiday', 'festival', 'ceremony', 'gathering', 'sport', 'disaster', 'personal', 'mundane', 'custom'
];

export const CALENDAR_EVENT_SCALES: CalendarEventScale[] = ['small', 'medium', 'large'];

export const CALENDAR_EVENT_VISIBILITIES: CalendarEventVisibility[] = ['spoiler', 'title', 'hidden'];
