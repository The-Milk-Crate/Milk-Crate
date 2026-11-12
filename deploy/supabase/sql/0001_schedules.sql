-- 0001 (session E, Supabase only): one-time runs of a SQL function on pg_cron.
--
-- Schedules.runSqlFunctionAt calls api_schedule_set. It records the run in api_schedules and
-- schedules a pg_cron job named 'mc_schedule:<name>' for that minute (UTC). The job calls
-- api_schedule_fire, which runs the function once with named arguments, deletes the row and
-- removes the pg_cron job. The same name again replaces the earlier run (pg_cron replaces a
-- job of the same name). A daily sweep (mc_schedule_sweep, 00:30 UTC) runs any due run whose
-- own minute was missed.
--
-- The release date: session G schedules api_release_go_live with p_release_id. It moves only
-- scheduled to live and does nothing otherwise, so a run after a takedown is harmless.
--
-- Applied by the stand-up after db/migrations and db/supabase, in the same transaction.
-- Server only: nothing here is granted to anon or authenticated. Safe to run twice.

-- pg_cron. On Supabase it lives in pg_catalog; the tests use a stand-in cron schema instead.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
end
$$;

create table if not exists public.api_schedules (
  name text primary key check (name ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  fn text not null check (fn ~ '^api_[a-z0-9_]{1,59}$'),
  args jsonb not null default '{}'::jsonb check (jsonb_typeof(args) = 'object'),
  run_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Set when the run raised an error. The row stays so the failure can be seen.
  fired_at timestamptz,
  last_error text
);

-- The SQL that calls public.<fn> with the named arguments taken from $1 (a jsonb object),
-- each cast to the type of that argument. Names and types come from the catalog, never from
-- the caller's text; the values travel as $1.
create or replace function public.api_schedule_call_sql(p_fn text, p_args jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_proc record;
  v_key text;
  v_parts text[] := '{}';
  v_type text;
  v_count int;
begin
  if p_fn !~ '^api_[a-z0-9_]{1,59}$' then
    raise exception using errcode = 'MC422', message = format('bad_function: schedules run only public api_ functions, not %s', p_fn);
  end if;
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = p_fn and p.prokind = 'f';
  if v_count <> 1 then
    raise exception using errcode = 'MC422', message = format('bad_function: need exactly one public.%s, found %s', p_fn, v_count);
  end if;
  -- proargtypes is an oidvector, which counts from 0; through text it counts from 1 like the rest.
  select coalesce(p.proallargtypes, string_to_array(nullif(p.proargtypes::text, ''), ' ')::oid[], '{}'::oid[]) as types,
         coalesce(p.proargnames, '{}'::text[]) as names,
         coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs::int])) as modes
    into v_proc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = p_fn and p.prokind = 'f';

  for v_key in select jsonb_object_keys(coalesce(p_args, '{}'::jsonb)) order by 1 loop
    v_type := null;
    for i in 1 .. coalesce(cardinality(v_proc.types), 0) loop
      if v_proc.names[i] = v_key and v_proc.modes[i] in ('i', 'b') then
        v_type := format_type(v_proc.types[i], null);
      end if;
    end loop;
    if v_type is null then
      raise exception using errcode = 'MC422', message = format('bad_argument: public.%s has no argument %s', p_fn, v_key);
    end if;
    v_parts := v_parts || format('%I => ($1 ->> %L)::%s', v_key, v_key, v_type);
  end loop;
  return format('select public.%I(%s)', p_fn, array_to_string(v_parts, ', '));
end
$$;

-- Record a run and schedule it. Replaces a run of the same name.
create or replace function public.api_schedule_set(p_name text, p_fn text, p_args jsonb, p_at timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_minute timestamptz;
  v_utc timestamp;
  v_cron text;
begin
  if p_name is null or p_name !~ '^[A-Za-z0-9_.:-]{1,100}$' then
    raise exception using errcode = 'MC422', message = 'bad_name: a schedule name is 1 to 100 of A-Z a-z 0-9 _ . : -';
  end if;
  if p_at is null then
    raise exception using errcode = 'MC422', message = 'bad_time: a schedule needs a time';
  end if;
  perform public.api_schedule_call_sql(p_fn, coalesce(p_args, '{}'::jsonb)); -- checks fn and args now

  insert into public.api_schedules as s (name, fn, args, run_at)
    values (p_name, p_fn, coalesce(p_args, '{}'::jsonb), p_at)
    on conflict (name) do update
      set fn = excluded.fn, args = excluded.args, run_at = excluded.run_at,
          created_at = now(), fired_at = null, last_error = null;

  -- pg_cron has minutes and no years. Round up to the minute; a time in the past or this
  -- minute runs at the next minute. A time more than a year out may fire early in an earlier
  -- year: api_schedule_fire then sees it is not due and leaves it for the right year.
  v_minute := date_trunc('minute', p_at);
  if v_minute < p_at then v_minute := v_minute + interval '1 minute'; end if;
  if v_minute <= now() + interval '1 minute' then
    v_cron := '* * * * *';
  else
    v_utc := v_minute at time zone 'UTC';
    v_cron := format('%s %s %s %s *', extract(minute from v_utc)::int, extract(hour from v_utc)::int,
                     extract(day from v_utc)::int, extract(month from v_utc)::int);
  end if;
  -- The name is checked above to hold no quote; %L quotes it anyway.
  perform cron.schedule('mc_schedule:' || p_name, v_cron, format('select public.api_schedule_fire(%L)', p_name));
end
$$;

-- What the pg_cron job runs. Returns ran, failed, not_due or none.
create or replace function public.api_schedule_fire(p_name text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_row public.api_schedules%rowtype;
  v_error text;
  v_job text := 'mc_schedule:' || p_name;
begin
  select s.* into v_row from public.api_schedules s where s.name = p_name for update skip locked;
  if not found then
    if not exists (select 1 from public.api_schedules s where s.name = p_name) then
      if exists (select 1 from cron.job j where j.jobname = v_job) then perform cron.unschedule(v_job); end if;
      return 'none';
    end if;
    return 'not_due'; -- another run of this name holds the row
  end if;
  if v_row.fired_at is not null then
    if exists (select 1 from cron.job j where j.jobname = v_job) then perform cron.unschedule(v_job); end if;
    return 'none';
  end if;
  if v_row.run_at > now() then
    return 'not_due';
  end if;

  begin
    execute public.api_schedule_call_sql(v_row.fn, v_row.args) using v_row.args;
  exception when others then
    v_error := format('%s: %s', sqlstate, sqlerrm);
  end;

  if v_error is null then
    delete from public.api_schedules s where s.name = p_name;
  else
    update public.api_schedules s set fired_at = now(), last_error = left(v_error, 2000) where s.name = p_name;
    raise warning 'schedule % failed: %', p_name, v_error;
  end if;
  if exists (select 1 from cron.job j where j.jobname = v_job) then perform cron.unschedule(v_job); end if;
  return case when v_error is null then 'ran' else 'failed' end;
end
$$;

-- The daily sweep: runs every run that is due and was never fired, for when its own minute was
-- missed (the database was down then, say). Without it, a missed minute waits a year, because
-- pg_cron has no year. A run that failed (fired_at set) is not tried again. Returns how many it
-- ran or tried.
create or replace function public.api_schedule_sweep()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_name text;
  v_count integer := 0;
begin
  for v_name in
    select s.name from public.api_schedules s
    where s.fired_at is null and s.run_at <= now() order by s.run_at, s.name
  loop
    if public.api_schedule_fire(v_name) in ('ran', 'failed') then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end
$$;

-- Every day at 00:30 UTC, half an hour after release dates begin. Scheduling the same name
-- again replaces it, so this is safe to run twice.
do $$ begin perform cron.schedule('mc_schedule_sweep', '30 0 * * *', 'select public.api_schedule_sweep()'); end $$;

-- Server only. Supabase's default grants on new objects in public are taken back here, because
-- this file runs after db/supabase/0006 (which locks down api_ objects and grants back only
-- the invitee wrappers). Running db/supabase again later also covers these, as they are api_.
alter table public.api_schedules enable row level security;
revoke all on public.api_schedules from anon, authenticated, public;
revoke all on function public.api_schedule_call_sql(text, jsonb) from anon, authenticated, public;
revoke all on function public.api_schedule_set(text, text, jsonb, timestamptz) from anon, authenticated, public;
revoke all on function public.api_schedule_fire(text) from anon, authenticated, public;
revoke all on function public.api_schedule_sweep() from anon, authenticated, public;
