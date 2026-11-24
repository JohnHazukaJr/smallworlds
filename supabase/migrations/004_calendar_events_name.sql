-- 002 created the table unquoted, so Postgres stored it as "calendarevents"
-- while the client asked for "calendarEvents" and sync could never find it.
-- Give it one unambiguous snake_case name that the client now uses.

do $$
begin
  if to_regclass('public.calendarevents') is not null and to_regclass('public.calendar_events') is null then
    alter table public.calendarevents rename to calendar_events;
  end if;
end $$;

create table if not exists public.calendar_events (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  world_id uuid not null,
  season_id uuid not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists calendar_events_user_updated on public.calendar_events (user_id, updated_at);

alter table public.calendar_events enable row level security;

drop policy if exists "calendarEvents_own" on public.calendar_events;
drop policy if exists "calendar_events_own" on public.calendar_events;
create policy "calendar_events_own" on public.calendar_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
