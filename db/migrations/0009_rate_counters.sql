-- 0009: rate counters (session J1, findings M1 and M2 of docs/security/review-phase0.md).
--
-- One small table of counters, one row per (bucket, subject, window). A bucket is one limit:
-- what it counts, over which window, and its cap (api_rate_limit). The subject is whose count
-- it is: a user id, a release id, or the SHA-256 of an email address (never the address).
--
-- api_rate_hit adds to a counter and says whether that stays within the cap, in one
-- statement (insert, or update only while under the cap, returning the count), so two
-- requests at the same moment cannot both pass. A hit over the cap adds nothing.
--
-- Old rows: each hit deletes its own subject's rows from earlier windows, in the same
-- statement. So a subject keeps at most one row per bucket; a subject that never comes back
-- leaves one small row. The all-time bucket (invites_release) has one row per release.

create table if not exists public.api_rate_counters (
  bucket text not null check (bucket in (
    'play_batches_minute', 'play_events_day', 'releases_day',
    'invites_release', 'invites_artist_day', 'invites_address_day')),
  subject text not null check (length(subject) between 1 and 128),
  -- The start of the window: a UTC minute, a UTC day, or 'epoch' for all time.
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  primary key (bucket, subject, window_start)
);

-- The caps, in one place. Decided by K Marcus (21 November 2026).
create or replace function public.api_rate_limit(p_bucket text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_bucket
    -- recordPlays: batches per user per minute.
    when 'play_batches_minute' then 60
    -- recordPlays: stored events per user per UTC day. A starting value.
    when 'play_events_day' then 10000
    -- createRelease: releases per artist per UTC day.
    when 'releases_day' then 20
    -- Invitations: parties invited per release, all time (each party counts once).
    when 'invites_release' then 20
    -- Invitations: emails per artist (the release owner) per UTC day.
    when 'invites_artist_day' then 50
    -- Invitations: emails per recipient address per UTC day.
    when 'invites_address_day' then 3
  end
$$;

-- Adds p_amount to a counter at p_now (null: the database's clock). allowed is false, and
-- nothing is added, when that would pass the cap. hits is the count after the call (or the
-- current count when refused). retry_after_seconds is the time to the next window (null for
-- the all-time bucket).
create or replace function public.api_rate_hit(p_bucket text, p_subject text, p_amount integer, p_now timestamptz)
returns table (allowed boolean, hits integer, cap integer, retry_after_seconds integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_now, now());
  v_cap integer := public.api_rate_limit(p_bucket);
  v_window timestamptz;
  v_next timestamptz;
  v_hits integer;
begin
  if v_cap is null then
    raise exception using errcode = 'MC422', message = 'bad_bucket: no such rate limit';
  end if;
  if p_subject is null or length(p_subject) not between 1 and 128 then
    raise exception using errcode = 'MC422', message = 'bad_subject: a rate limit needs a subject';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception using errcode = 'MC422', message = 'bad_amount: add 1 or more';
  end if;

  if p_bucket like '%\_minute' then
    v_window := date_trunc('minute', v_now at time zone 'UTC') at time zone 'UTC';
    v_next := v_window + interval '1 minute';
  elsif p_bucket like '%\_day' then
    v_window := date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';
    v_next := v_window + interval '1 day';
  else
    v_window := timestamptz 'epoch';
    v_next := null;
  end if;

  with old_windows as (
    delete from public.api_rate_counters c
     where c.bucket = p_bucket and c.subject = p_subject and c.window_start < v_window
  )
  insert into public.api_rate_counters as c (bucket, subject, window_start, hits)
    select p_bucket, p_subject, v_window, p_amount
     where p_amount <= v_cap
    on conflict (bucket, subject, window_start) do update
      set hits = c.hits + excluded.hits
      where c.hits + excluded.hits <= v_cap
    returning c.hits into v_hits;

  if v_hits is null then
    select c.hits into v_hits from public.api_rate_counters c
     where c.bucket = p_bucket and c.subject = p_subject and c.window_start = v_window;
    return query select false, coalesce(v_hits, 0), v_cap,
      case when v_next is null then null else greatest(1, ceil(extract(epoch from (v_next - v_now))))::integer end;
    return;
  end if;
  return query select true, v_hits, v_cap,
    case when v_next is null then null else greatest(1, ceil(extract(epoch from (v_next - v_now))))::integer end;
end
$$;
