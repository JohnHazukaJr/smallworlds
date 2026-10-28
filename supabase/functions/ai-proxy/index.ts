/**
 * Allowlisted SSE/HTTP relay for AI hosts that block browser CORS (Z.ai, BigModel, Venice).
 * Forwards the caller's upstream Authorization. Does not store keys or run inference.
 * Requires a signed-in Supabase user — the anon key is not enough.
 */
import { CORS, handleOptions, json, MAX_CHAT_BODY, readLimitedJson, requireUser } from '../_shared/http.ts';

const ALLOWED_HOSTS = ['api.z.ai', 'open.bigmodel.cn', 'api.venice.ai'];

function hostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const limited = await readLimitedJson(req, MAX_CHAT_BODY);
  if (!limited.ok) return limited.response;
  const payload = limited.value as {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  const target = payload.url ?? '';
  if (!hostAllowed(target)) return json(403, { error: { message: 'host not allowlisted' } });

  const fwdHeaders = new Headers();
  for (const [k, v] of Object.entries(payload.headers ?? {})) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (key === 'host' || key === 'content-length') continue;
    fwdHeaders.set(k, v);
  }

  const upstream = await fetch(target, {
    method: payload.method ?? 'POST',
    headers: fwdHeaders,
    body: payload.body
  });

  const out = new Headers(CORS);
  const ct = upstream.headers.get('content-type');
  if (ct) out.set('content-type', ct);
  const cache = upstream.headers.get('cache-control');
  if (cache) out.set('cache-control', cache);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out
  });
});
