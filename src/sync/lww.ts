/**
 * Per-row last-write-wins for cloud sync.
 * Null means that side has no row. Equal timestamps are left alone.
 */
export type SyncSide = 'pull' | 'push' | 'skip';

export function syncSide(localMs: number | null, remoteMs: number | null): SyncSide {
  if (remoteMs == null) return localMs == null ? 'skip' : 'push';
  if (localMs == null || remoteMs > localMs) return 'pull';
  if (localMs > remoteMs) return 'push';
  return 'skip';
}
