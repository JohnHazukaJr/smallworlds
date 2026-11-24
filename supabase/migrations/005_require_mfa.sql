-- An account with a verified authenticator must finish the TOTP step (aal2)
-- before it can read or write its rows. Accounts without one are unaffected.
-- Restrictive policies are ANDed with the existing per-user policies.

create or replace function public.mfa_satisfied() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors
      where user_id = auth.uid() and status = 'verified'
    );
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'worlds', 'seasons', 'episodes', 'turns', 'characters', 'locations',
    'continuity', 'threads', 'wraps', 'calendar_events', 'encrypted_secrets'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_mfa', t);
      execute format(
        'create policy %I on public.%I as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied())',
        t || '_mfa', t
      );
    end if;
  end loop;
end $$;
