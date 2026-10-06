/**
 * Stripe → credit ledger. Signature-checked. Idempotent on the Stripe event id.
 * Subscription refills come from invoice.paid. Packs come from Checkout payment mode.
 */
import { MONTHLY_CREDITS, PACK_CREDITS } from '../_shared/billing.ts';
import { adminClient, json } from '../_shared/http.ts';
import { verifyStripeSignature } from '../_shared/stripe.ts';

type Row = Record<string, unknown>;

function asRow(v: unknown): Row {
  return v && typeof v === 'object' ? v as Row : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function subscriptionPrice(sub: Row): string | null {
  const data = asRow(sub.items).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  return str(asRow(asRow(data[0]).price).id);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: { message: 'method not allowed' } });

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) return json(503, { error: { message: 'Webhook secret is not configured.' } });

  const raw = await req.text();
  const header = req.headers.get('Stripe-Signature') ?? '';
  const ok = await verifyStripeSignature(raw, header, secret);
  if (!ok) return json(400, { error: { message: 'Invalid Stripe signature.' } });

  let event: Row;
  try {
    event = JSON.parse(raw) as Row;
  } catch {
    return json(400, { error: { message: 'Invalid JSON.' } });
  }

  const eventId = str(event.id);
  const eventType = str(event.type);
  if (!eventId || !eventType) return json(400, { error: { message: 'Missing event id.' } });

  const admin = adminClient();
  const inserted = await admin.from('stripe_events').insert({ id: eventId });
  if (inserted.error) {
    if (inserted.error.code === '23505') return json(200, { duplicate: true });
    return json(500, { error: { message: inserted.error.message } });
  }

  try {
    await handleEvent(admin, eventType, asRow(asRow(event.data).object));
  } catch (e) {
    await admin.from('stripe_events').delete().eq('id', eventId);
    const message = e instanceof Error ? e.message : 'Webhook handler failed.';
    return json(500, { error: { message } });
  }

  return json(200, { ok: true });
});

async function handleEvent(
  admin: ReturnType<typeof adminClient>,
  type: string,
  object: Row
): Promise<void> {
  if (type === 'checkout.session.completed') {
    await onCheckout(admin, object);
    return;
  }
  if (type === 'invoice.paid') {
    await onInvoice(admin, object);
    return;
  }
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    await onSubscription(admin, object, type === 'customer.subscription.deleted');
  }
}

async function userForCustomer(admin: ReturnType<typeof adminClient>, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { data, error } = await admin
    .from('billing_accounts')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.user_id as string | undefined) ?? null;
}

async function onCheckout(admin: ReturnType<typeof adminClient>, session: Row): Promise<void> {
  const meta = asRow(session.metadata);
  const userId = str(meta.user_id) ?? str(session.client_reference_id);
  const customerId = str(session.customer);
  if (!userId) throw new Error('Checkout session has no user id.');

  if (str(session.mode) === 'payment' && str(session.payment_status) === 'paid') {
    const { error } = await admin.rpc('apply_credit', {
      p_user: userId,
      p_amount: PACK_CREDITS,
      p_reason: 'pack',
      p_key: `pack:${str(session.id) ?? userId}`
    });
    if (error) throw new Error(error.message);
  }

  if (str(session.mode) === 'subscription' && customerId) {
    const { error } = await admin.rpc('set_billing_subscription', {
      p_user: userId,
      p_customer: customerId,
      p_status: 'active',
      p_price: null,
      p_period_end: null
    });
    if (error) throw new Error(error.message);
  }
}

async function onInvoice(admin: ReturnType<typeof adminClient>, invoice: Row): Promise<void> {
  const reason = str(invoice.billing_reason);
  if (reason !== 'subscription_create' && reason !== 'subscription_cycle' && reason !== 'subscription_update') {
    return;
  }
  const details = asRow(invoice.subscription_details);
  const parent = asRow(asRow(invoice.parent).subscription_details);
  const meta = asRow(details.metadata);
  const parentMeta = asRow(parent.metadata);
  const customerId = str(invoice.customer);
  const userId = str(meta.user_id) ?? str(parentMeta.user_id) ?? await userForCustomer(admin, customerId);
  if (!userId) throw new Error('Invoice has no Small Worlds user.');

  const invoiceId = str(invoice.id);
  if (!invoiceId) throw new Error('Invoice has no id.');

  const { error } = await admin.rpc('apply_credit', {
    p_user: userId,
    p_amount: MONTHLY_CREDITS,
    p_reason: 'subscription',
    p_key: `invoice:${invoiceId}`
  });
  if (error) throw new Error(error.message);

  const lines = asRow(invoice.lines);
  const first = Array.isArray(lines.data) ? asRow(lines.data[0]) : {};
  const period = asRow(first.period);
  const endUnix = typeof period.end === 'number' ? period.end : null;
  const { error: subErr } = await admin.rpc('set_billing_subscription', {
    p_user: userId,
    p_customer: customerId,
    p_status: 'active',
    p_price: str(asRow(first.price).id),
    p_period_end: endUnix ? new Date(endUnix * 1000).toISOString() : null
  });
  if (subErr) throw new Error(subErr.message);
}

async function onSubscription(
  admin: ReturnType<typeof adminClient>,
  sub: Row,
  deleted: boolean
): Promise<void> {
  const meta = asRow(sub.metadata);
  const customerId = str(sub.customer);
  const userId = str(meta.user_id) ?? await userForCustomer(admin, customerId);
  if (!userId) throw new Error('Subscription has no Small Worlds user.');

  const endUnix = typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
  const price = subscriptionPrice(sub);

  const { error } = await admin.rpc('set_billing_subscription', {
    p_user: userId,
    p_customer: customerId,
    p_status: deleted ? 'canceled' : (str(sub.status) ?? 'none'),
    p_price: price,
    p_period_end: endUnix ? new Date(endUnix * 1000).toISOString() : null
  });
  if (error) throw new Error(error.message);
}
