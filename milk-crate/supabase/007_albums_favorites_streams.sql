-- Milk Crate: album ratings, favorite songs and stream counts.
--   - Albums are rated out of 5 stars (your rating is private; the average is public).
--   - Songs aren't rated any more: you favorite them instead (private to you).
--     Songs you had rated 5 stars become favorites.
--   - Each song's stream count is public. It ranks the songs on an artist's page and
--     sizes the artists' dots on the scene maps. Who listened, and from where, stays private.
-- Run once after 006_countries.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

-- ============ Album ratings (yours are private; averages are public) ============
create table if not exists public.album_ratings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  release_id uuid not null references public.releases(id) on delete cascade,
  stars      smallint not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, release_id)
);
alter table public.album_ratings enable row level security;
drop policy if exists "your own album ratings" on public.album_ratings;
create policy "your own album ratings" on public.album_ratings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.album_ratings to authenticated;

-- Average stars per album, from everyone. Only averages are shared, never who rated what.
-- Runs with the view owner's rights so it can count every rating while the table stays private.
create or replace view public.album_rating_stats as
  select r.release_id, round(avg(r.stars)::numeric, 2)::float8 as average, count(*)::int as ratings
  from public.album_ratings r
  join public.releases rel on rel.id = r.release_id
  join public.artists a on a.id = rel.artist_id and a.status = 'approved'
  group by r.release_id;
grant select on public.album_rating_stats to anon, authenticated;

-- ============ Favorite songs (private) ============
create table if not exists public.favorites (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  track_id   uuid not null references public.tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);
create index if not exists favorites_user_idx on public.favorites(user_id, created_at desc);
alter table public.favorites enable row level security;
drop policy if exists "your own favorites" on public.favorites;
create policy "your own favorites" on public.favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, delete on public.favorites to authenticated;

-- Songs you rated 5 stars become favorites (the old song ratings are left as they were, unused).
do $$ begin
  insert into public.favorites (user_id, track_id, created_at)
  select user_id, track_id, updated_at from public.ratings where stars = 5
  on conflict do nothing;
exception when undefined_table then null;
end $$;

-- ============ Stream counts (public totals) ============
-- A stream is a play of 30 seconds or more (the plays table, which nobody can read directly).
-- Only each song's total is shared.
create or replace view public.track_stream_counts as
  select p.track_id, count(*)::bigint as streams
  from public.plays p
  join public.tracks t on t.id = p.track_id
  join public.artists a on a.id = t.artist_id and a.status = 'approved'
  group by p.track_id;
grant select on public.track_stream_counts to anon, authenticated;
