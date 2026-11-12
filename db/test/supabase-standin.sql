-- Test only. Never a migration, never run on a real Supabase project.
--
-- The smallest stand-in for what Supabase provides, so the app's SQL (milk-crate/supabase/),
-- db/migrations and db/supabase load on a plain PostgreSQL 16 cluster:
--   * the roles anon, authenticated, service_role and supabase_auth_admin
--   * auth.users, auth.uid() and auth.jwt(), read from the request.jwt.claims setting the
--     way PostgREST sets it
--   * storage.buckets, storage.objects and storage.foldername()
--   * Supabase's default grants on public to anon and authenticated, so the tests see the
--     same starting point B's tables get on Supabase.
-- "Signing in" in the tests is: set role authenticated, and set request.jwt.claims to the
-- claims the access token hook returned.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role, supabase_auth_admin;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

grant execute on function auth.jwt(), auth.uid() to public;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

-- Supabase's defaults: new tables, sequences and functions in public are granted to anon and
-- authenticated. db/supabase must take these back from B's api_ objects.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
