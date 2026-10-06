/**
 * Metered OpenAI-compatible relay. The owner key stays in function secrets.
 * Clients send small-worlds/* model ids; this function maps them and charges credits.
 */
import {
  COST_IMAGE,
  HOSTED_IMAGE_MODEL,
  HOSTED_UTILITY_MODEL,
  UTILITY_TOKEN_CEILING,
  chatCredit
} from '../_shared/billing.ts';
import { CORS, MAX_CHAT_BODY, MAX_IMAGE_BODY, adminClient, handleOptions, json, readLimitedJson, requireUser } from '../_shared/http.ts';

const MAX_COMPLETION = 8192;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const op = req.headers.get('x-sw-op') === 'image' ? 'image' : 'chat';
  const limited = await readLimitedJson(req, op === 'image' ? MAX_IMAGE_BODY : MAX_CHAT_BODY);
  if (!limited.ok) return limited.response;
  const body = limited.value as Record<string, unknown>;

  const admin = adminClient();
  const since = new Date(Date.now() - 60_000).toISOString();
  const recent = await admin
    .from('credit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .lt('amount', 0)
    .gte('created_at', since);
  if (recent.error) return json(500, { error: { message: recent.error.message } });
  if ((recent.count ?? 0) >= 20) {
    return json(429, { error: { message: 'Too many hosted calls. Wait a minute and try again.' } });
  }
  const priced = priceCall(op, body);
  if (!priced.ok) return json(priced.status, { error: { message: priced.message } });

  const base = (Deno.env.get(priced.baseEnv) || Deno.env.get('HOSTED_CHAT_BASE_URL') || '').replace(/\/$/, '');
  const apiKey = Deno.env.get('HOSTED_CHAT_API_KEY');
  const upstreamModel = Deno.env.get(priced.modelEnv)
    || (priced.modelEnv === 'HOSTED_UTILITY_MODEL' ? Deno.env.get('HOSTED_PROSE_MODEL') : undefined);
  if (!base || !apiKey || !upstreamModel) {
    return json(503, { error: { message: 'Hosted models are not configured.' } });
  }

  const requestId = crypto.randomUUID();
  const reserved = await admin.rpc('reserve_credits', {
    p_user: user.id,
    p_amount: priced.cost,
    p_reason: priced.reason,
    p_key: `spend:${requestId}`,
    p_request: requestId
  });
  if (reserved.error) return json(500, { error: { message: reserved.error.message } });
  if (reserved.data !== true) {
    return json(402, {
      error: { message: 'Not enough Small Worlds credits. Subscribe or buy a pack in Profile.' }
    });
  }

  const forwarded = { ...body, model: upstreamModel };
  if (op === 'chat') {
    forwarded.stream = true;
    const cap = Math.min(priced.maxTokens || MAX_COMPLETION, MAX_COMPLETION);
    if ('max_completion_tokens' in forwarded) forwarded.max_completion_tokens = cap;
    else forwarded.max_tokens = cap;
  }

  const upstream = await fetch(`${base}${priced.path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(forwarded)
  });

  if (!upstream.ok) {
    await admin.rpc('apply_credit', {
      p_user: user.id,
      p_amount: priced.cost,
      p_reason: 'release',
      p_key: `release:${requestId}`
    });
    let detail = '';
    try {
      const errBody = await upstream.json() as { error?: { message?: string }; message?: string };
      detail = errBody?.error?.message ?? errBody?.message ?? '';
    } catch { /* ignore */ }
    return json(502, {
      error: { message: detail ? `Hosted model failed. ${detail}` : 'Hosted model failed.' }
    });
  }

  const headers = new Headers(CORS);
  const ct = upstream.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  return new Response(upstream.body, { status: upstream.status, headers });
});

function priceCall(op: 'chat' | 'image', body: Record<string, unknown>):
  | { ok: true; cost: number; reason: string; path: string; modelEnv: string; baseEnv: string; maxTokens: number }
  | { ok: false; status: number; message: string } {
  const model = typeof body.model === 'string' ? body.model : '';
  const modalities = Array.isArray(body.modalities) ? body.modalities : [];
  const wantsImage = op === 'image' || model === HOSTED_IMAGE_MODEL || modalities.includes('image');

  if (wantsImage) {
    if (op === 'image' && model && model !== HOSTED_IMAGE_MODEL) {
      return { ok: false, status: 400, message: 'Unknown hosted image model.' };
    }
    return {
      ok: true,
      cost: COST_IMAGE,
      reason: 'image',
      path: op === 'image' ? '/images/generations' : '/chat/completions',
      modelEnv: 'HOSTED_IMAGE_MODEL',
      baseEnv: op === 'image' ? 'HOSTED_IMAGE_BASE_URL' : 'HOSTED_CHAT_BASE_URL',
      maxTokens: 0
    };
  }

  const maxRaw = body.max_tokens ?? body.max_completion_tokens ?? UTILITY_TOKEN_CEILING;
  const maxTokens = typeof maxRaw === 'number' && Number.isFinite(maxRaw) ? maxRaw : UTILITY_TOKEN_CEILING;
  const credit = chatCredit(model, maxTokens);
  if (!credit || credit.reason === 'image') {
    return { ok: false, status: 400, message: 'Unknown hosted model.' };
  }

  const utility = model === HOSTED_UTILITY_MODEL;
  return {
    ok: true,
    cost: credit.cost,
    reason: credit.reason,
    path: '/chat/completions',
    modelEnv: utility ? 'HOSTED_UTILITY_MODEL' : 'HOSTED_PROSE_MODEL',
    baseEnv: 'HOSTED_CHAT_BASE_URL',
    maxTokens
  };
}
