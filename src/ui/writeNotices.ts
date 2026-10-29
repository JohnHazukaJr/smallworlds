import type { Screen } from '../store/app';

export const NOTICE_ADD_MODEL = 'Add a writing model in Settings first.';

/** Copy after Stop. Leftover beats stay saved so Continue can finish them. */
export function abortWriteNotice(beatsCompleted: number, remaining: number): string {
  if (remaining > 0) {
    const kept = beatsCompleted === 0
      ? 'Stopped before any reply. Nothing new was kept.'
      : `Stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}. Those lines were kept.`;
    return `${kept} Continue finishes the rest of that reply. A new line starts fresh.`;
  }
  if (beatsCompleted === 0) {
    return 'Stopped before any reply — your line was not applied.';
  }
  return `Stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}; incomplete line discarded.`;
}

/** Copy after a provider error. Leftover beats stay saved so Continue can finish them. */
export function unfinishedWriteNotice(beatsCompleted: number, remaining: number): string {
  if (remaining <= 0) return '';
  const kept = beatsCompleted === 0
    ? 'Stopped before any reply. Nothing new was kept.'
    : `Stopped after ${beatsCompleted} line${beatsCompleted === 1 ? '' : 's'}. Those lines were kept.`;
  return `${kept} Continue finishes the rest of that reply. A new line starts fresh.`;
}

/** Only attach a nav chip when the notice is about that destination. */
export function noticeNavAction(notice: string): { label: string; screen: Screen } | null {
  if (notice === NOTICE_ADD_MODEL) return { label: 'Settings', screen: 'settings' };
  return null;
}
