import type { Screen } from '../store/app';

export const NOTICE_ADD_MODEL = 'Add a writing model in Settings first.';

/** Copy after Stop. One reply: what landed stays, and nothing is queued behind it. */
export function abortWriteNotice(beatsCompleted: number, remaining = 0): string {
  if (beatsCompleted <= 0) {
    return remaining < 0
      ? 'Stopped before any reply — your line was not applied.'
      : 'Stopped before any reply — your line was not applied.';
  }
  return 'Stopped. What was written stays.';
}

/** Copy after a provider error that ended the reply. There is no leftover queue. */
export function unfinishedWriteNotice(beatsCompleted: number, remaining: number): string {
  if (remaining <= 0 && beatsCompleted <= 0) return '';
  if (beatsCompleted <= 0) return 'Stopped before any reply — your line was not applied.';
  return 'Stopped. What was written stays.';
}

/** Only attach a nav chip when the notice is about that destination. */
export function noticeNavAction(notice: string): { label: string; screen: Screen } | null {
  if (notice === NOTICE_ADD_MODEL) return { label: 'Settings', screen: 'settings' };
  return null;
}
