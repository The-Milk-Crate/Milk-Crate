-- 0001 (Supabase only): close Supabase's default access to the api_ tables and functions.
--
-- On Supabase, new tables, sequences and functions in public are granted to anon and
-- authenticated, and PostgREST serves them. So B's api_ objects are open until this runs.
-- This turns on row level security on every api_ table and takes every grant back from anon,
-- authenticated and public. 0006_grants.sql runs it again at the end and then grants back only
-- what clients need. service_role and the owner keep their access (the server uses them).
-- Applied after db/migrations, on Supabase only. Safe to run twice.

create or replace function public.api_supabase_lock_down()
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  -- Tables and views: row level security on tables, no grants for clients.
  for r in
    select c.oid::regclass as obj, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'api\_%' and c.relkind in ('r', 'p', 'v', 'm')
  loop
    if r.relkind in ('r', 'p') then
      execute format('alter table %s enable row level security', r.obj);
    end if;
    execute format('revoke all on %s from anon, authenticated, public', r.obj);
  end loop;

  -- Sequences (identity columns).
  for r in
    select c.oid::regclass as obj
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'api\_%' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence %s from anon, authenticated, public', r.obj);
  end loop;

  -- Functions, including B's SECURITY DEFINER invite functions.
  for r in
    select p.oid::regprocedure as obj
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'api\_%' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.obj);
  end loop;
end
$$;

do $$ begin perform public.api_supabase_lock_down(); end $$;
