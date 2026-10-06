/** Exact hosts the CORS relay may call. Keep in sync with supabase/functions/ai-proxy. */
export const AI_PROXY_HOSTS = ['api.z.ai', 'open.bigmodel.cn'] as const;

export function exactProxyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (AI_PROXY_HOSTS as readonly string[]).includes(host);
  } catch {
    return false;
  }
}
