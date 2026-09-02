import { getSupabase, isCloudConfigured } from '../cloud/supabase';
import type { ProviderConfig } from '../types';

/** Hosts that often block browser CORS — relay when cloud is configured. */
export const AI_PROXY_HOSTS = ['api.z.ai', 'open.bigmodel.cn'];

export function isZaiProvider(provider: ProviderConfig): boolean {
  const u = provider.baseUrl.toLowerCase();
  return u.includes('api.z.ai') || u.includes('open.bigmodel.cn');
}

export function hostAllowlisted(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AI_PROXY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
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
