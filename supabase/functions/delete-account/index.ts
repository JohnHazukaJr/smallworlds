/**
 * Deletes the signed-in auth user. Sync rows, secrets, and billing cascade.
 * Best-effort Stripe customer removal when a customer id is on file.
 */
import { adminClient, handleOptions, json, requireUser } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const admin = adminClient();
  const { data: billing } = await admin
    .from('billing_accounts')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  const customer = billing?.stripe_customer_id as string | undefined;
  if (stripeKey && customer) {
    await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customer)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${stripeKey}` }
    }).catch(() => undefined);
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) return json(500, { error: { message: error.message } });
  return json(200, { ok: true });
});
