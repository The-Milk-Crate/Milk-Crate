-- 0001: shared helpers and the account source (api_accounts).
--
-- Every file in db/migrations runs on Supabase Postgres, Aurora PostgreSQL and plain
-- PostgreSQL 16. No app tables, no auth schema, no extensions. Safe to run twice.
-- Names start with api_ because the app already has public.releases, public.tracks and
-- public.plays. Errors raised on purpose use SQLSTATE MC403, MC404, MC409 or MC422 and a
-- message that starts with a short code word (see db/README.md).

-- Keeps updated_at current on every table that has one.
create or replace function public.api_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Staff account types. third_party is not staff (it may reply to a split invitation).
create or replace function public.api_is_staff_type(p_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('administrator', 'internal', 'internal_accounting')
$$;

-- One row per account, so one role per account. No row means end_user.
-- user_id is the identity's user id: the Supabase user id or the Cognito sub.
create table if not exists public.api_accounts (
  user_id uuid primary key,
  account_type text not null
    constraint api_accounts_type_check
    check (account_type in ('artist', 'third_party', 'administrator', 'internal', 'internal_accounting')),
  email text,
  artist_id uuid unique,
  artist_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- artist_id and artist_name are set, and required, only for artist.
  constraint api_accounts_artist_fields check (
    (account_type = 'artist' and artist_id is not null and artist_name is not null
      and length(btrim(artist_name)) between 1 and 200)
    or (account_type <> 'artist' and artist_id is null and artist_name is null)
  )
);

comment on table public.api_accounts is
  'The account source for the account_type claim. One row per account; no row means end_user.';

-- A row cannot change between artist and a staff type, and user_id never changes.
-- A staff member who makes music uses a second account.
create or replace function public.api_accounts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id <> old.user_id then
    raise exception using errcode = 'MC422', message = 'fixed_field: user_id cannot change';
  end if;
  if (old.account_type = 'artist' and public.api_is_staff_type(new.account_type))
     or (public.api_is_staff_type(old.account_type) and new.account_type = 'artist') then
    raise exception using errcode = 'MC403',
      message = format('one_role: an account cannot change from %s to %s; use a second account',
                       old.account_type, new.account_type);
  end if;
  return new;
end
$$;

drop trigger if exists api_accounts_guard on public.api_accounts;
create trigger api_accounts_guard
  before update on public.api_accounts
  for each row execute function public.api_accounts_guard();

drop trigger if exists api_accounts_touch on public.api_accounts;
create trigger api_accounts_touch
  before update on public.api_accounts
  for each row execute function public.api_touch_updated_at();
