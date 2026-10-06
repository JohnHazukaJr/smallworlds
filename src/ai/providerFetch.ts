import { getSupabase, isCloudConfigured } from '../cloud/supabase';
import type { ProviderConfig } from '../types';
import { AI_PROXY_HOSTS, exactProxyHost } from './proxyHosts';

export { AI_PROXY_HOSTS };

/** Supabase function that meters hosted Small Worlds models. */
export const HOSTED_FN_MARK = '/functions/v1/hosted-ai';

export function isHostedFunctionUrl(url: string): boolean {
  return url.includes(HOSTED_FN_MARK);
}

/** Strip /chat/completions or /images/generations so the function root receives the body. */
export function hostedFunctionRoot(url: string): string {
  const u = new URL(url);
  const idx = u.pathname.indexOf(HOSTED_FN_MARK);
  if (idx < 0) return url;
  u.pathname = u.pathname.slice(0, idx + HOSTED_FN_MARK.length);
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function hostedOp(url: string): 'image' | 'chat' {
  return url.includes('/images/') ? 'image' : 'chat';
}

export function isZaiProvider(provider: ProviderConfig): boolean {
  return exactProxyHost(provider.baseUrl);
}

export function hostAllowlisted(url: string): boolean {
  return exactProxyHost(url);
}

function supabaseFnUrl(): string | null {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
  if (!base) return null;
  return `${base}/functions/v1/ai-proxy`;
}

/**
 * fetch() that optionally relays allowlisted hosts through the Supabase Edge Function.
 * Falls back to a direct browser call if cloud is off or the function is missing.
 */
export async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  if (isHostedFunctionUrl(url)) return hostedFetch(url, init);
  if (!isCloudConfigured() || !hostAllowlisted(url)) {
    return fetch(url, init);
  }
  const fn = supabaseFnUrl();
  if (!fn) return fetch(url, init);

  const sb = getSupabase();
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  let bearer = anon ?? '';
  try {
    const session = sb ? (await sb.auth.getSession()).data.session : null;
    if (session?.access_token) bearer = session.access_token;
  } catch { /* use anon */ }

  const rawHeaders = init.headers;
  const headers: Record<string, string> = {};
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((v, k) => { headers[k] = v; });
  } else if (Array.isArray(rawHeaders)) {
    for (const [k, v] of rawHeaders) headers[k] = v;
  } else if (rawHeaders) {
    Object.assign(headers, rawHeaders);
  }

  try {
    const res = await fetch(fn, {
      method: 'POST',
      signal: init.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        apikey: anon ?? ''
      },
      body: JSON.stringify({
        url,
        method: init.method ?? 'POST',
        headers,
        body: typeof init.body === 'string' ? init.body : undefined
      })
    });
    if (res.status === 404 || res.status === 501) return fetch(url, init);
    return res;
  } catch {
    return fetch(url, init);
  }
}

/** Session JWT only. The owner key never reaches the browser. */
async function hostedFetch(url: string, init: RequestInit): Promise<Response> {
  const sb = getSupabase();
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  let token = '';
  try {
    token = sb ? (await sb.auth.getSession()).data.session?.access_token ?? '' : '';
  } catch { /* unsigned */ }
  if (!token) {
    return new Response(JSON.stringify({ error: { message: 'Sign in required.' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return fetch(hostedFunctionRoot(url), {
    method: 'POST',
    signal: init.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon ?? '',
      'x-sw-op': hostedOp(url)
    },
    body: typeof init.body === 'string' ? init.body : undefined
  });
}
