-- Small Worlds — normalized sync schema + RLS
-- Apply in Supabase SQL editor or via supabase db push.
-- Auth: enable Email, Phone (Twilio), and Google as equal optional providers in the dashboard.
-- Optional TOTP MFA: Authentication → MFA → enable TOTP (free-tier basic MFA).
-- Phone SMS is billed via Twilio; email/Google are not SMS-metered.

-- ---------- helpers ----------
create extension if not exists "pgcrypto";

-- ---------- tables (mirror Dexie entities) ----------

create table if not exists public.worlds (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.seasons (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.episodes (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  season_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.turns (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  episode_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.characters (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.locations (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.continuity (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  season_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.threads (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  season_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.wraps (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  season_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- E2E ciphertext only — server never sees provider API keys in plaintext.
create table if not exists public.encrypted_secrets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  salt text not null,
  iv text not null,
  ct text not null,
  updated_at timestamptz not null default now()
);

-- ---------- indexes ----------
create index if not exists worlds_user_updated on public.worlds (user_id, updated_at);
create index if not exists seasons_user_updated on public.seasons (user_id, updated_at);
create index if not exists episodes_user_updated on public.episodes (user_id, updated_at);
create index if not exists turns_user_updated on public.turns (user_id, updated_at);
create index if not exists characters_user_updated on public.characters (user_id, updated_at);
create index if not exists locations_user_updated on public.locations (user_id, updated_at);
create index if not exists continuity_user_updated on public.continuity (user_id, updated_at);
create index if not exists threads_user_updated on public.threads (user_id, updated_at);
create index if not exists wraps_user_updated on public.wraps (user_id, updated_at);

-- ---------- RLS ----------
alter table public.worlds enable row level security;
alter table public.seasons enable row level security;
alter table public.episodes enable row level security;
alter table public.turns enable row level security;
alter table public.characters enable row level security;
alter table public.locations enable row level security;
alter table public.continuity enable row level security;
alter table public.threads enable row level security;
alter table public.wraps enable row level security;
alter table public.encrypted_secrets enable row level security;

create policy "worlds_own" on public.worlds for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "seasons_own" on public.seasons for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "episodes_own" on public.episodes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "turns_own" on public.turns for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "characters_own" on public.characters for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "locations_own" on public.locations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "continuity_own" on public.continuity for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "threads_own" on public.threads for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "wraps_own" on public.wraps for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "secrets_own" on public.encrypted_secrets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
