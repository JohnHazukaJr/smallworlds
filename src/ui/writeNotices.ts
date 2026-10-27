import type { Screen } from '../store/app';

export const NOTICE_ADD_MODEL = 'Add a writing model in Settings first.';

/** Copy after Stop. Leftover beats are dropped; the notice says what was kept. */
export function abortWriteNotice(beatsCompleted: number, remaining: number): string {
  if (remaining > 0) {
    if (beatsCompleted === 0) {
      return 'The page stopped before a reply. Nothing new was kept.';
    }
    return (
      `The page stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}. ` +
      `Those lines were kept.`
    );
  }
  if (beatsCompleted === 0) {
    return 'Stopped before any reply — your line was not applied.';
  }
  return `Stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}; incomplete line discarded.`;
}

/** Copy after a provider error. Leftover beats are dropped; the notice says what was kept. */
export function unfinishedWriteNotice(beatsCompleted: number, remaining: number): string {
  if (remaining <= 0) return '';
  if (beatsCompleted === 0) {
    return 'The page stopped before a reply. Nothing new was kept.';
  }
  return (
    `The page stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}. ` +
    `Those lines were kept.`
  );
}

/** Only attach a nav chip when the notice is about that destination. */
export function noticeNavAction(notice: string): { label: string; screen: Screen } | null {
  if (notice === NOTICE_ADD_MODEL) return { label: 'Settings', screen: 'settings' };
  return null;
}
