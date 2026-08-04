/** Rough storage health for IndexedDB + localStorage (API keys, vault, worlds). */

export interface StorageReport {
  /** bytes used when the browser reports it */
  usage: number | null;
  /** bytes available (quota) when reported */
  quota: number | null;
  /** usage / quota, 0–1, or null if unknown */
  ratio: number | null;
  /** true when we should nudge the user to back up */
  warn: boolean;
  /** human label */
  label: string;
}

const WARN_RATIO = 0.85;
const WARN_USAGE_BYTES = 40 * 1024 * 1024; // 40 MB without quota info

export async function estimateStorage(): Promise<StorageReport> {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const ratio = quota > 0 ? usage / quota : null;
      const warn = (ratio !== null && ratio >= WARN_RATIO) || (quota === 0 && usage >= WARN_USAGE_BYTES);
      const pct = ratio !== null ? Math.round(ratio * 100) : null;
      return {
        usage,
        quota: quota || null,
        ratio,
        warn,
        label: pct !== null
          ? `${formatBytes(usage)} of ${formatBytes(quota)} (${pct}%)`
          : formatBytes(usage)
      };
    }
  } catch {
    /* private mode / unsupported */
  }
  return {
    usage: null,
    quota: null,
    ratio: null,
    warn: false,
    label: 'unknown'
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Persist a soft flag so we can nudge once after QuotaExceededError. */
export const STORAGE_PRESSURE_KEY = 'small-worlds-storage-pressure';

/** Dispatched on `window` when storage pressure is marked or cleared. */
export const STORAGE_PRESSURE_EVENT = 'sw-storage-pressure';

export function markStoragePressure(): void {
  try {
    localStorage.setItem(STORAGE_PRESSURE_KEY, String(Date.now()));
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new Event(STORAGE_PRESSURE_EVENT));
  } catch { /* ignore */ }
}

export function clearStoragePressure(): void {
  try {
    localStorage.removeItem(STORAGE_PRESSURE_KEY);
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new Event(STORAGE_PRESSURE_EVENT));
  } catch { /* ignore */ }
}

export function hasStoragePressure(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_PRESSURE_KEY);
  } catch {
    return false;
  }
}

export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; message?: string; code?: number };
  return (
    err.name === 'QuotaExceededError' ||
    err.code === 22 ||
    /quota/i.test(err.message ?? '')
  );
}
