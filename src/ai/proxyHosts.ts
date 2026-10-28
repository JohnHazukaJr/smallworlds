/** Exact hosts the CORS relay may call. Keep in sync with supabase/functions/ai-proxy. */
export const ZAI_HOSTS = ['api.z.ai', 'open.bigmodel.cn'] as const;

export const AI_PROXY_HOSTS = [...ZAI_HOSTS, 'api.venice.ai'] as const;

function hostIs(url: string, allowed: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowed.includes(host);
  } catch {
    return false;
  }
}

export function exactProxyHost(url: string): boolean {
  return hostIs(url, AI_PROXY_HOSTS);
}

/** Z.ai and BigModel only. Venice is relayed, and it is not a Z.ai host. */
export function isZaiHost(url: string): boolean {
  return hostIs(url, ZAI_HOSTS);
}
