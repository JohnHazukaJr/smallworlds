-- Calendar-tied season events (Dexie db.version 4 / SyncTableName calendarEvents)

create table if not exists public.calendarEvents (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  season_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists calendarEvents_user_updated on public.calendarEvents (user_id, updated_at);

alter table public.calendarEvents enable row level security;

create policy "calendarEvents_own" on public.calendarEvents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
