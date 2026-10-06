import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sw-op',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  return null;
}

export const MAX_CHAT_BODY = 2 * 1024 * 1024;
export const MAX_IMAGE_BODY = 8 * 1024 * 1024;

/** Read JSON only after the body is within maxBytes. */
export async function readLimitedJson(
  req: Request,
  maxBytes: number
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = req.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    return { ok: false, response: json(413, { error: { message: 'request too large' } }) };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, response: json(413, { error: { message: 'request too large' } }) };
  }
  try {
    return { ok: true, value: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, response: json(400, { error: { message: 'invalid json' } }) };
  }
}

export function json(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra }
  });
}

export interface AuthedUser {
  id: string;
  token: string;
  email: string | null;
}

/** Rejects the anon key. A signed-in user JWT is required. */
export async function requireUser(req: Request): Promise<AuthedUser | Response> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return json(401, { error: { message: 'Sign in required.' } });

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return json(500, { error: { message: 'Auth is not configured.' } });

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anon }
  });
  if (!res.ok) return json(401, { error: { message: 'Sign in required.' } });

  const user = await res.json() as { id?: string; email?: string | null };
  if (!user?.id) return json(401, { error: { message: 'Sign in required.' } });
  return { id: user.id, token, email: user.email ?? null };
}

export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Service role is not configured.');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
