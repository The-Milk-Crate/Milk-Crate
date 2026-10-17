-- Milk Crate: more countries. Artists and listeners can now be in the United States, Canada or Australia.
-- Run once after 005_accounts_reports_stats.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again. Everyone already on the server stays in the United States.

-- ============ A country for every place ============
alter table public.artists   add column if not exists country text not null default 'US';
alter table public.listeners add column if not exists country text not null default 'US';
alter table public.plays     add column if not exists country text;

do $$ begin
  alter table public.artists add constraint artists_country_check check (country in ('US', 'CA', 'AU'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.listeners add constraint listeners_country_check check (country in ('US', 'CA', 'AU'));
exception when duplicate_object then null; end $$;

-- State and province codes: two letters (NC, ON) or three (NSW, VIC, QLD in Australia).
alter table public.artists drop constraint if exists artists_state_check;
alter table public.artists add constraint artists_state_check check (state is null or state ~ '^[A-Z]{2,3}$');
alter table public.listeners drop constraint if exists listeners_state_check;
alter table public.listeners add constraint listeners_state_check check (state ~ '^[A-Z]{2,3}$');

-- ============ Plays: remember the country of the listener's town ============
create or replace function public.plays_fill_town() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.city := null;
  new.state := null;
  new.country := null;
  new.played_at := now();
  if new.listener_id is not null then
    select l.city, l.state, l.country into new.city, new.state, new.country from public.listeners l where l.user_id = new.listener_id;
    if new.city is null then
      select a.city, a.state, a.country into new.city, new.state, new.country from public.artists a where a.owner_id = new.listener_id;
    end if;
  end if;
  return new;
end $$;
update public.plays set country = 'US' where country is null and city is not null;

-- Where people listen from, now with the country (Perth, WA is in Australia; Washington is WA too).
-- Same rule as before: a town only shows once 3 or more different listeners there have played the artist.
drop function if exists public.my_artist_towns();
create function public.my_artist_towns()
returns table (city text, state text, country text, plays bigint, listeners bigint)
language sql stable security definer set search_path = public as $$
  with mine as (
    select p.city, p.state, coalesce(p.country, 'US') as country, p.listener_id
    from public.plays p
    join public.tracks t on t.id = p.track_id
    join public.artists a on a.id = t.artist_id and a.owner_id = auth.uid()
  ), towns as (
    select city, state, country, count(*) as plays, count(distinct listener_id) as listeners
    from mine where city is not null group by city, state, country
  )
  select city, state, country, plays, listeners from towns where listeners >= 3
  union all
  select null, null, null, coalesce(sum(plays), 0)::bigint, coalesce(sum(listeners), 0)::bigint from towns where listeners < 3
  order by 4 desc
$$;
revoke all on function public.my_artist_towns() from public, anon;
grant execute on function public.my_artist_towns() to authenticated;
