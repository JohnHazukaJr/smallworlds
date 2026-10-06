import { getSupabase } from './supabase';

export async function invokeFunction(name: string, body?: unknown): Promise<unknown> {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!base || !anon) throw new Error('Cloud sync is not configured.');

  const sb = getSupabase();
  const token = sb ? (await sb.auth.getSession()).data.session?.access_token : undefined;
  if (!token) throw new Error('Sign in required.');

  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon
    },
    body: JSON.stringify(body ?? {})
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch { /* empty */ }

  if (!res.ok) {
    const message = readError(payload) || `Request failed (${res.status}).`;
    const err = new Error(message);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return payload;
}

function readError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const row = payload as { error?: { message?: string } | string; message?: string };
  if (typeof row.error === 'string') return row.error;
  if (row.error && typeof row.error.message === 'string') return row.error.message;
  if (typeof row.message === 'string') return row.message;
  return '';
}
