const TOLERANCE_SEC = 300;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Stripe-Signature: t=unix,v1=hex */
export async function verifyStripeSignature(raw: string, header: string, secret: string): Promise<boolean> {
  const t = header.match(/(?:^|,)t=(\d+)/)?.[1];
  const sigs = [...header.matchAll(/(?:^|,)v1=([a-f0-9]+)/g)].map((m) => m[1]);
  if (!t || sigs.length === 0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SEC) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
  const expected = hex(mac);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function stripeForm(
  path: string,
  params: Record<string, string>,
  method = 'POST'
): Promise<Record<string, unknown>> {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Stripe is not configured.');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: method === 'GET' ? undefined : new URLSearchParams(params)
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `Stripe error ${res.status}`);
  }
  return data;
}

export function appOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Missing return origin.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid return origin.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid return origin.');
  if (url.username || url.password) throw new Error('Invalid return origin.');
  return url.origin;
}
