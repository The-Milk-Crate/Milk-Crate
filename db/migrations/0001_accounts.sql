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
  -- A suspended account keeps its row (and its releases and keys) but may not act.
  -- Suspend instead of deleting an account that has history.
  suspended boolean not null default false,
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

-- An artist account stays an artist, and no other account becomes one. user_id never
-- changes. A staff member who makes music uses a second account. An account with history
-- (owns a release, made a review decision, took a release down) is never deleted: suspend it.
create or replace function public.api_accounts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.api_releases r where r.owner_id = old.user_id)
       or exists (select 1 from public.api_review_decisions d where d.reviewer_id = old.user_id)
       or exists (select 1 from public.api_audit_log l where l.actor_id = old.user_id) then
      raise exception using errcode = 'MC409',
        message = 'has_history: this account has releases, reviews or takedowns; suspend it instead';
    end if;
    return old;
  end if;
  if new.user_id <> old.user_id then
    raise exception using errcode = 'MC422', message = 'fixed_field: user_id cannot change';
  end if;
  if (old.account_type = 'artist') <> (new.account_type = 'artist') then
    raise exception using errcode = 'MC403',
      message = format('one_role: an account cannot change from %s to %s; use a second account',
                       old.account_type, new.account_type);
  end if;
  return new;
end
$$;

drop trigger if exists api_accounts_guard on public.api_accounts;
create trigger api_accounts_guard
  before update or delete on public.api_accounts
  for each row execute function public.api_accounts_guard();

drop trigger if exists api_accounts_touch on public.api_accounts;
create trigger api_accounts_touch
  before update on public.api_accounts
  for each row execute function public.api_touch_updated_at();
