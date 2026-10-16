-- Milk Crate: your crate (digital saves + physical media), playlists, follows,
-- star ratings (averages are public, your own are private), display names,
-- and sound profiles for "similar sound" recommendations.
-- Run once after 003_accounts_and_places.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

-- ============ Display names (public) ============
create table if not exists public.profiles (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "display names are public" on public.profiles;
drop policy if exists "you manage your display name" on public.profiles;
create policy "display names are public" on public.profiles for select using (true);
create policy "you manage your display name" on public.profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ Your crate: digital saves ============
create table if not exists public.crate_items (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  release_id uuid not null references public.releases(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (user_id, release_id)
);
-- ============ Your crate: physical media ============
-- Linked to a Milk Crate release when it's on Milk Crate; otherwise just artist + title.
create table if not exists public.physical_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  format      text not null check (format in ('LP', '7in', 'Cassette', 'CD')),
  release_id  uuid references public.releases(id) on delete set null,
  artist_name text not null default '' check (char_length(artist_name) <= 200),
  title       text not null default '' check (char_length(title) <= 200),
  note        text not null default '' check (char_length(note) <= 500),
  added_at    timestamptz not null default now(),
  check (release_id is not null or char_length(btrim(title)) > 0)
);
-- Keep the artist and title on the item itself, so it stays in your crate even if the release is removed.
create or replace function public.fill_physical_names() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.release_id is not null and (btrim(new.title) = '' or btrim(new.artist_name) = '') then
    select r.title, a.name into new.title, new.artist_name
    from public.releases r join public.artists a on a.id = r.artist_id where r.id = new.release_id;
  end if;
  return new;
end $$;
drop trigger if exists fill_physical_names on public.physical_items;
create trigger fill_physical_names before insert or update on public.physical_items for each row execute function public.fill_physical_names();

-- ============ Playlists (private for now) ============
create table if not exists public.playlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 100),
  track_ids  uuid[] not null default '{}' check (cardinality(track_ids) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- ============ Follows (private: no follower counts) ============
create table if not exists public.follows (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  artist_id  uuid not null references public.artists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);
-- ============ Ratings (yours are private; averages are public) ============
create table if not exists public.ratings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  track_id   uuid not null references public.tracks(id) on delete cascade,
  stars      smallint not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

-- Everything above belongs to one person: they see and change only their own rows.
do $$
declare t text;
begin
  foreach t in array array['crate_items', 'physical_items', 'playlists', 'follows', 'ratings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "your own %s" on public.%I', t, t);
    execute format('create policy "your own %s" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t, t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant select on public.profiles to anon, authenticated;
grant insert, update, delete on public.profiles to authenticated;

-- Average star rating per track, from everyone. Only averages are shared, never who rated what.
-- Runs with the view owner's rights so it can count every rating while the ratings table stays private.
create or replace view public.track_rating_stats as
  select r.track_id, round(avg(r.stars)::numeric, 2)::float8 as average, count(*)::int as ratings
  from public.ratings r
  join public.tracks t on t.id = r.track_id
  join public.artists a on a.id = t.artist_id and a.status = 'approved'
  group by r.track_id;
grant select on public.track_rating_stats to anon, authenticated;

-- ============ Sound profiles ============
-- Measured in the app when an artist uploads: tempo, energy, brightness, dynamics.
alter table public.tracks add column if not exists sound jsonb;
alter table public.tracks drop constraint if exists tracks_sound_size;
alter table public.tracks add constraint tracks_sound_size check (sound is null or octet_length(sound::text) <= 1024);

notify pgrst, 'reload schema';
