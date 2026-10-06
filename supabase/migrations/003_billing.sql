-- Hosted AI credits and Stripe billing.
-- Users may read their own balance. Writes happen only through service-role functions.

create table if not exists public.billing_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  subscription_status text not null default 'none',
  price_id text,
  current_period_end timestamptz,
  starter_granted boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount integer not null check (amount <> 0),
  reason text not null,
  idempotency_key text not null unique,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_created on public.credit_ledger (user_id, created_at desc);

create table if not exists public.stripe_events (
  id text primary key,
  received_at timestamptz not null default now()
);

create or replace view public.credit_balances
with (security_invoker = true) as
select user_id, coalesce(sum(amount), 0)::integer as balance
from public.credit_ledger
group by user_id;

alter table public.billing_accounts enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.stripe_events enable row level security;

create policy "billing_accounts_read_own" on public.billing_accounts
  for select using (auth.uid() = user_id);

create policy "credit_ledger_read_own" on public.credit_ledger
  for select using (auth.uid() = user_id);

-- No policies on stripe_events: only the service role can see it.

grant select on public.billing_accounts to authenticated;
grant select on public.credit_ledger to authenticated;
grant select on public.credit_balances to authenticated;

-- ---------- service-role credit functions ----------

create or replace function public.apply_credit(
  p_user uuid,
  p_amount integer,
  p_reason text,
  p_key text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount = 0 then
    raise exception 'amount must be non-zero';
  end if;
  insert into public.billing_accounts (user_id) values (p_user) on conflict do nothing;
  insert into public.credit_ledger (user_id, amount, reason, idempotency_key)
  values (p_user, p_amount, p_reason, p_key)
  on conflict (idempotency_key) do nothing;
end;
$$;

create or replace function public.grant_starter(p_user uuid, p_amount integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  insert into public.billing_accounts (user_id) values (p_user) on conflict do nothing;
  if exists (
    select 1 from public.billing_accounts
    where user_id = p_user and starter_granted
  ) then
    return;
  end if;
  update public.billing_accounts
    set starter_granted = true, updated_at = now()
    where user_id = p_user;
  insert into public.credit_ledger (user_id, amount, reason, idempotency_key)
  values (p_user, p_amount, 'starter', 'starter:' || p_user::text)
  on conflict (idempotency_key) do nothing;
end;
$$;

create or replace function public.reserve_credits(
  p_user uuid,
  p_amount integer,
  p_reason text,
  p_key text,
  p_request text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bal integer;
begin
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  insert into public.billing_accounts (user_id) values (p_user) on conflict do nothing;
  if exists (select 1 from public.credit_ledger where idempotency_key = p_key) then
    return true;
  end if;
  select coalesce(sum(amount), 0) into bal
    from public.credit_ledger
    where user_id = p_user;
  if bal < p_amount then
    return false;
  end if;
  insert into public.credit_ledger (user_id, amount, reason, idempotency_key, request_id)
  values (p_user, -p_amount, p_reason, p_key, p_request);
  return true;
end;
$$;

create or replace function public.set_billing_subscription(
  p_user uuid,
  p_customer text,
  p_status text,
  p_price text,
  p_period_end timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.billing_accounts (
    user_id, stripe_customer_id, subscription_status, price_id, current_period_end, updated_at
  ) values (
    p_user, p_customer, coalesce(p_status, 'none'), p_price, p_period_end, now()
  )
  on conflict (user_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, public.billing_accounts.stripe_customer_id),
    subscription_status = excluded.subscription_status,
    price_id = coalesce(excluded.price_id, public.billing_accounts.price_id),
    current_period_end = coalesce(excluded.current_period_end, public.billing_accounts.current_period_end),
    updated_at = now();
end;
$$;

revoke all on function public.apply_credit(uuid, integer, text, text) from public;
revoke all on function public.grant_starter(uuid, integer) from public;
revoke all on function public.reserve_credits(uuid, integer, text, text, text) from public;
revoke all on function public.set_billing_subscription(uuid, text, text, text, timestamptz) from public;

revoke all on function public.apply_credit(uuid, integer, text, text) from anon, authenticated;
revoke all on function public.grant_starter(uuid, integer) from anon, authenticated;
revoke all on function public.reserve_credits(uuid, integer, text, text, text) from anon, authenticated;
revoke all on function public.set_billing_subscription(uuid, text, text, text, timestamptz) from anon, authenticated;

grant execute on function public.apply_credit(uuid, integer, text, text) to service_role;
grant execute on function public.grant_starter(uuid, integer) to service_role;
grant execute on function public.reserve_credits(uuid, integer, text, text, text) to service_role;
grant execute on function public.set_billing_subscription(uuid, text, text, text, timestamptz) to service_role;
