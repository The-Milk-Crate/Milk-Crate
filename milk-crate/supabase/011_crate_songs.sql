-- Milk Crate: single songs in your crate.
-- Add one song (or a few) from a release without adding the whole thing. In Your Crate, 1–3 songs
-- from a release show as a single, double or triple; 4 or more (or the whole release) show under Albums.
-- Private to you, like the rest of your crate.
-- Run once after 010_lyrics_release_dates.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

create table if not exists public.crate_songs (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, track_id)
);
create index if not exists crate_songs_user_idx on public.crate_songs(user_id, added_at desc);
alter table public.crate_songs enable row level security;
drop policy if exists "your own crate songs" on public.crate_songs;
create policy "your own crate songs" on public.crate_songs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, delete on public.crate_songs to authenticated;
