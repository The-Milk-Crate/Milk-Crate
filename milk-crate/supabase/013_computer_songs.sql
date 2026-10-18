-- Milk Crate: playlists and favorites with songs from your ripped CDs, on every computer you sign in on.
-- The music never leaves your computers. Only a short description of each song is saved with your
-- account (artist, album, disc, track number and title), so another computer of yours that has the
-- same CD can find its own copy. Private: only you can read or change it.
-- Run once after 012_playlist_pictures.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

-- A playlist's full order when it has songs from your computers: Milk Crate songs by id, your own
-- songs as "song:<artist>|<album>|<disc>|<track>|<title>". Null when it has none (then track_ids is the order).
alter table public.playlists add column if not exists song_order text[];

-- Favorite songs from your computers (ripped CDs and your own files), described the same way.
create table if not exists public.computer_favorites (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  song_key   text not null check (song_key like 'song:%' and length(song_key) <= 600),
  created_at timestamptz not null default now(),
  primary key (user_id, song_key)
);
create index if not exists computer_favorites_user_idx on public.computer_favorites(user_id, created_at desc);
alter table public.computer_favorites enable row level security;
drop policy if exists "your own computer favorites" on public.computer_favorites;
create policy "your own computer favorites" on public.computer_favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, delete on public.computer_favorites to authenticated;

-- Tell the API about the changes right away.
notify pgrst, 'reload schema';
