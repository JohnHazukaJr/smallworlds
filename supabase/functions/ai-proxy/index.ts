/**
 * Allowlisted SSE/HTTP relay for AI hosts that block browser CORS (Z.ai, BigModel).
 * Forwards the caller's Authorization. Does not store keys or run inference.
 */
const ALLOWED_HOSTS = ['api.z.ai', 'open.bigmodel.cn'];

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function hostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: CORS });
  }

  let payload: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return new Response('invalid json', { status: 400, headers: CORS });
  }

  const target = payload.url ?? '';
  if (!hostAllowed(target)) {
    return new Response('host not allowlisted', { status: 403, headers: CORS });
  }

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
