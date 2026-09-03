/**
 * Shared user-facing error classification for AI, storage, vault, and sync.
 * Keep AIError / WriteAbortedError; wrap them here at UI and soft-fail boundaries.
 */

import { isContextOverflowError, isEmptyModelResponse } from './ai/client';

export type AppErrorCode =
  | 'aborted'
  | 'auth'
  | 'rateLimit'
  | 'network'
  | 'timeout'
  | 'provider'
  | 'parse'
  | 'quota'
  | 'vault'
  | 'sync'
  | 'storage'
  | 'unknown';

export class AppError extends Error {
  readonly name = 'AppError';
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly detail?: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(opts: {
    code: AppErrorCode;
    userMessage: string;
    detail?: string;
    status?: number;
    cause?: unknown;
  }) {
    super(opts.userMessage);
    this.code = opts.code;
    this.userMessage = opts.userMessage;
    this.detail = opts.detail;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

function detailFrom(e: unknown): string {
  if (e instanceof AppError) return e.detail || e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function statusOf(e: unknown): number | undefined {
  if (e instanceof AppError && e.status != null) return e.status;
  if (e && typeof e === 'object' && 'status' in e) {
    const s = (e as { status?: unknown }).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
}

function looksLikeNetwork(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('networkerror') ||
    m.includes('network request failed') ||
    m.includes('load failed') ||
    m.includes('fetch failed')
  );
}

function looksLikeTimeout(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('timed out') || m.includes('timeout');
}

function looksLikeParse(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('malformed json') || m.includes('did not return json') || m.includes('unexpected token');
}

function looksLikeQuota(msg: string, e: unknown): boolean {
  if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'QuotaExceededError') {
    return true;
  }
  const m = msg.toLowerCase();
  return m.includes('quota') || m.includes('storage may be full') || m.includes('exceeded the quota');
}

function looksLikeVault(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('vault') || m.includes('passphrase') || m.includes('decrypt');
}

function looksLikeMissingModel(msg: string): boolean {
  return /no (writing|utility|image) model configured/i.test(msg);
}

/** Write-loop copy that should reach the player unchanged (not “check Settings”). */
function looksLikeWriteLoop(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('no usable narration') ||
    m.includes('no character replied') ||
    m.includes('pin who should answer') ||
    m.includes('re-roll produced') ||
    m.includes('only narrator or character') ||
    m.includes('could not find the speaker')
  );
}

function looksLikeSync(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('supabase') ||
    m.includes('cloud sync') ||
    m.includes('vite_supabase') ||
    m.includes('jwt') ||
    m.includes('refresh token') ||
    (m.includes('sync') && !looksLikeMissingModel(msg))
  );
}

/** Map any thrown value into a stable AppError with actionable user copy. */
export function classifyError(e: unknown): AppError {
  if (e instanceof AppError) return e;

  const name = e instanceof Error ? e.name : '';
  const msg = detailFrom(e);
  const status = statusOf(e);

  if (name === 'AbortError' || name === 'WriteAbortedError' || msg === 'Aborted') {
    return new AppError({
      code: 'aborted',
      userMessage: 'Stopped.',
      detail: msg,
      cause: e
    });
  }

  if (
    name === 'VaultCorruptError' ||
    (msg.toLowerCase().includes('vault') && msg.toLowerCase().includes('unreadable'))
  ) {
    return new AppError({
      code: 'vault',
      userMessage: 'Vault unreadable — restore a backup or reset the vault (stories are kept).',
      detail: msg,
      cause: e
    });
  }

  if (status === 401 || status === 403) {
    return new AppError({
      code: 'auth',
      userMessage: 'Provider rejected the key. Check API key in Settings.',
      detail: msg,
      status,
      cause: e
    });
  }

  if (status === 429) {
    return new AppError({
      code: 'rateLimit',
      userMessage: 'Rate limited by the provider. Wait a moment and try again.',
      detail: msg,
      status,
      cause: e
    });
  }

  if (status != null && status >= 500) {
    return new AppError({
      code: 'provider',
      userMessage: 'The model provider had a server error. Try again shortly.',
      detail: msg,
      status,
      cause: e
    });
  }

  const empty = isEmptyModelResponse(e) || msg.toLowerCase().includes('empty response');
  if (empty) {
    return new AppError({
      code: 'provider',
      userMessage: 'The model returned an empty reply. Try again or pick a different model in Settings.',
      detail: msg,
      status,
      cause: e
    });
  }

  if (isContextOverflowError(e)) {
    return new AppError({
      code: 'provider',
      userMessage: 'The prompt is too large for this model. Wrap the episode or try a larger-context model.',
      detail: msg,
      status,
      cause: e
    });
  }

  if (status != null && status >= 400) {
    return new AppError({
      code: 'provider',
      userMessage: 'The model provider rejected the request. Check model and Settings.',
      detail: msg,
      status,
      cause: e
    });
  }

  if (looksLikeTimeout(msg)) {
    return new AppError({
      code: 'timeout',
      userMessage: 'That took too long. Try a shorter stretch, or check your connection.',
      detail: msg,
      cause: e
    });
  }

  if (looksLikeParse(msg)) {
    return new AppError({
      code: 'parse',
      userMessage: 'The model returned something we could not read. Try again.',
      detail: msg,
      cause: e
    });
  }

  if (e instanceof TypeError || looksLikeNetwork(msg)) {
    return new AppError({
      code: 'network',
      userMessage: 'Network error. Check your connection and try again.',
      detail: msg,
      cause: e
    });
  }

  if (looksLikeQuota(msg, e)) {
    return new AppError({
      code: 'quota',
      userMessage: 'This browser is low on storage. Back up in Profile, then free space.',
      detail: msg,
      cause: e
    });
  }

  if (looksLikeVault(msg)) {
    return new AppError({
      code: 'vault',
      userMessage: 'Vault error. Check your passphrase, or restore a backup.',
      detail: msg,
      cause: e
    });
  }

  if (looksLikeMissingModel(msg)) {
    return new AppError({
      code: 'provider',
      userMessage: 'No model picked. Add a provider and choose a writing model in Settings.',
      detail: msg,
      cause: e
    });
  }

  if (msg.toLowerCase().includes('cloud sync is not configured')) {
    return new AppError({
      code: 'sync',
      userMessage: 'Cloud sync is not configured on this build.',
      detail: msg,
      cause: e
    });
  }

  if (looksLikeSync(msg)) {
    return new AppError({
      code: 'sync',
      userMessage: 'Cloud sync failed. Open Profile to retry or reconnect.',
      detail: msg,
      cause: e
    });
  }

  if (msg.toLowerCase().includes('did not draft a world')) {
    return new AppError({
      code: 'provider',
      userMessage: 'The model did not draft a world. Try again or switch models.',
      detail: msg,
      status,
      cause: e
    });
  }

  if (looksLikeWriteLoop(msg)) {
    return new AppError({
      code: 'provider',
      userMessage: msg.trim(),
      detail: msg,
      status,
      cause: e
    });
  }

  if (name === 'AIError') {
    return new AppError({
      code: 'provider',
      userMessage: 'The model request failed. Check Settings and try again.',
      detail: msg,
      status,
      cause: e
    });
  }

  return new AppError({
    code: 'unknown',
    userMessage: msg.trim() || 'Something went wrong.',
    detail: msg,
    cause: e
  });
}

/** Short string for simple setError(string) call sites. */
export function formatUserError(e: unknown): string {
  return classifyError(e).userMessage;
}

/** Dev-only breadcrumb; no analytics. */
export function logAppError(e: unknown, context?: string): void {
  if (!import.meta.env.DEV) return;
  const err = classifyError(e);
  console.warn(`[${err.code}]${context ? ` ${context}` : ''}`, err.userMessage, err.detail ?? '');
}

/** Run a task; on failure call setError with classified copy and return undefined. */
export async function withUserError<T>(
  task: () => Promise<T>,
  setError: (msg: string) => void
): Promise<T | undefined> {
  try {
    return await task();
  } catch (e) {
    const err = classifyError(e);
    logAppError(err);
    setError(err.userMessage);
    return undefined;
  }
}
