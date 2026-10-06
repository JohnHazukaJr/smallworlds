import { MONTHLY_CREDITS, PACK_CREDITS, STARTER_CREDITS } from '../_shared/billing.ts';
import { adminClient, handleOptions, json, requireUser } from '../_shared/http.ts';
import { appOrigin, stripeForm } from '../_shared/stripe.ts';

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: { kind?: string; returnOrigin?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: 'invalid json' } });
  }

  const kind = body.kind === 'pack' ? 'pack' : body.kind === 'monthly' ? 'monthly' : null;
  if (!kind) return json(400, { error: { message: 'Choose a monthly plan or a credit pack.' } });

  let origin: string;
  try {
    origin = appOrigin(body.returnOrigin);
  } catch (e) {
    return json(400, { error: { message: e instanceof Error ? e.message : 'Invalid return origin.' } });
  }

  const price = Deno.env.get(kind === 'monthly' ? 'STRIPE_PRICE_MONTHLY' : 'STRIPE_PRICE_PACK');
  if (!price || !Deno.env.get('STRIPE_SECRET_KEY')) {
    return json(503, { error: { message: 'Billing is not configured on this project yet.' } });
  }

  const admin = adminClient();
  const granted = await admin.rpc('grant_starter', { p_user: user.id, p_amount: STARTER_CREDITS });
  if (granted.error) return json(500, { error: { message: granted.error.message } });

  const existing = await admin
    .from('billing_accounts')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing.error) return json(500, { error: { message: existing.error.message } });

  let customerId = existing.data?.stripe_customer_id as string | null;
  if (!customerId) {
    try {
      const customer = await stripeForm('customers', {
        'metadata[user_id]': user.id,
        ...(user.email ? { email: user.email } : {})
      });
      customerId = String(customer.id ?? '');
    } catch (e) {
      return json(502, { error: { message: e instanceof Error ? e.message : 'Could not start checkout.' } });
    }
    if (!customerId) return json(502, { error: { message: 'Stripe did not return a customer.' } });
    const saved = await admin
      .from('billing_accounts')
      .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
      .eq('user_id', user.id);
    if (saved.error) return json(500, { error: { message: saved.error.message } });
  }

  const credits = kind === 'monthly' ? MONTHLY_CREDITS : PACK_CREDITS;
  try {
    const session = await stripeForm('checkout/sessions', {
      mode: kind === 'monthly' ? 'subscription' : 'payment',
      customer: customerId,
      client_reference_id: user.id,
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user.id,
      'metadata[kind]': kind,
      'metadata[credits]': String(credits),
      ...(kind === 'monthly' ? { 'subscription_data[metadata][user_id]': user.id } : {})
    });
    const url = session.url;
    if (typeof url !== 'string' || !url) {
      return json(502, { error: { message: 'Stripe did not return a checkout URL.' } });
    }
    return json(200, { url });
  } catch (e) {
    return json(502, { error: { message: e instanceof Error ? e.message : 'Could not start checkout.' } });
  }
});
