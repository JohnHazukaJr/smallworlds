/** Grants the one-time starter credit pack. Idempotent per user. */
import { STARTER_CREDITS } from '../_shared/billing.ts';
import { adminClient, handleOptions, json, requireUser } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const admin = adminClient();
  const { error } = await admin.rpc('grant_starter', { p_user: user.id, p_amount: STARTER_CREDITS });
  if (error) return json(500, { error: { message: error.message } });
  return json(200, { ok: true });
});
