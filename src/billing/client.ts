import { getSupabase } from '../cloud/supabase';
import { invokeFunction } from '../cloud/functions';

export interface BillingSnapshot {
  balance: number;
  status: string;
  periodEnd: string | null;
  ready: boolean;
  note: string;
}

export async function ensureBilling(): Promise<void> {
  await invokeFunction('ensure-billing', {});
}

export async function loadBilling(userId: string): Promise<BillingSnapshot> {
  const sb = getSupabase();
  if (!sb) {
    return { balance: 0, status: 'none', periodEnd: null, ready: false, note: 'Cloud sync is not configured.' };
  }

  const [balanceRes, accountRes] = await Promise.all([
    sb.from('credit_balances').select('balance').eq('user_id', userId).maybeSingle(),
    sb.from('billing_accounts').select('subscription_status, current_period_end').eq('user_id', userId).maybeSingle()
  ]);

  const missing = balanceRes.error?.code === 'PGRST205' || accountRes.error?.code === '42P01'
    || /schema cache|does not exist|credit_balances|billing_accounts/i.test(
      `${balanceRes.error?.message ?? ''} ${accountRes.error?.message ?? ''}`
    );
  if (missing) {
    return {
      balance: 0,
      status: 'none',
      periodEnd: null,
      ready: false,
      note: 'Billing is not set up on this project yet. Run supabase/migrations/003_billing.sql.'
    };
  }
  if (balanceRes.error && balanceRes.error.code !== 'PGRST116') {
    throw new Error(balanceRes.error.message);
  }
  if (accountRes.error && accountRes.error.code !== 'PGRST116') {
    throw new Error(accountRes.error.message);
  }

  const balance = typeof balanceRes.data?.balance === 'number' ? balanceRes.data.balance : 0;
  const status = typeof accountRes.data?.subscription_status === 'string'
    ? accountRes.data.subscription_status
    : 'none';
  const periodEnd = typeof accountRes.data?.current_period_end === 'string'
    ? accountRes.data.current_period_end
    : null;
  return { balance, status, periodEnd, ready: true, note: '' };
}

export async function startCheckout(kind: 'monthly' | 'pack'): Promise<void> {
  const payload = await invokeFunction('create-checkout-session', {
    kind,
    returnOrigin: window.location.origin
  });
  const url = payload && typeof payload === 'object' ? (payload as { url?: string }).url : undefined;
  if (!url) throw new Error('Checkout did not return a URL.');
  window.location.assign(url);
}

export async function openBillingPortal(): Promise<void> {
  const payload = await invokeFunction('create-portal-session', {
    returnOrigin: window.location.origin
  });
  const url = payload && typeof payload === 'object' ? (payload as { url?: string }).url : undefined;
  if (!url) throw new Error('Billing portal did not return a URL.');
  window.location.assign(url);
}
