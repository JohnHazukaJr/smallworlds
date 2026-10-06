import { adminClient, handleOptions, json, requireUser } from '../_shared/http.ts';
import { appOrigin, stripeForm } from '../_shared/stripe.ts';

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: { returnOrigin?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: 'invalid json' } });
  }

  let origin: string;
  try {
    origin = appOrigin(body.returnOrigin);
  } catch (e) {
    return json(400, { error: { message: e instanceof Error ? e.message : 'Invalid return origin.' } });
  }

  if (!Deno.env.get('STRIPE_SECRET_KEY')) {
    return json(503, { error: { message: 'Billing is not configured on this project yet.' } });
  }

  const admin = adminClient();
  const existing = await admin
    .from('billing_accounts')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing.error) return json(500, { error: { message: existing.error.message } });

  const customerId = existing.data?.stripe_customer_id as string | null;
  if (!customerId) {
    return json(400, { error: { message: 'Subscribe or buy a pack before managing billing.' } });
  }

  try {
    const session = await stripeForm('billing_portal/sessions', {
      customer: customerId,
      return_url: `${origin}/`
    });
    const url = session.url;
    if (typeof url !== 'string' || !url) {
      return json(502, { error: { message: 'Stripe did not return a portal URL.' } });
    }
    return json(200, { url });
  } catch (e) {
    return json(502, { error: { message: e instanceof Error ? e.message : 'Could not open billing.' } });
  }
});
