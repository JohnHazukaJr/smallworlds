import type { Screen } from '../store/app';

export const NOTICE_ADD_MODEL = 'Add a writing model in Settings first.';
export const NOTICE_ADD_CAST = 'Add someone to this scene on Cast, or open Direct.';

/** Copy after Stop. Leftover beats always point at Continue plan, even if none saved yet. */
export function abortWriteNotice(beatsCompleted: number, remaining: number): string {
  if (remaining > 0) {
    if (beatsCompleted === 0) {
      return (
        `Stopped before a reply landed — ${remaining} line${remaining === 1 ? '' : 's'} ` +
        `left in the plan. Use Continue plan to finish.`
      );
    }
    return (
      `Stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'} — ` +
      `${remaining} left in the plan. Use Continue plan to finish.`
    );
  }
  if (beatsCompleted === 0) {
    return 'Stopped before any reply — your line was not applied.';
  }
  return `Stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}; incomplete line discarded.`;
}

/** Only attach a nav chip when the notice is about that destination. */
export function noticeNavAction(notice: string): { label: string; screen: Screen } | null {
  if (notice === NOTICE_ADD_CAST) return { label: 'Open Cast', screen: 'cast' };
  if (notice === NOTICE_ADD_MODEL) return { label: 'Settings', screen: 'settings' };
  return null;
}
