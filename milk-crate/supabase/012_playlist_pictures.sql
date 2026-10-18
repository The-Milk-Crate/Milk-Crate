-- Milk Crate: playlist pictures that follow you to every computer.
-- A picture you choose for a playlist is saved with your account (a private file only you can read),
-- so the playlist shows it on any computer you sign in on.
-- Run once after 011_crate_songs.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

-- Where the playlist's picture is kept ("<your user id>/<playlist id>.jpg"), or null for none
-- (then the app makes one from the playlist's album covers).
alter table public.playlists add column if not exists cover_path text;
alter table public.playlists drop constraint if exists playlists_cover_path_owner;
alter table public.playlists add constraint playlists_cover_path_owner
  check (cover_path is null or cover_path like (user_id::text || '/%'));

-- playlist-pictures: private (like playlists themselves). JPEG or PNG, up to 2 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('playlist-pictures', 'playlist-pictures', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Only you can read or change the pictures in your own folder.
drop policy if exists "your own playlist pictures" on storage.objects;
create policy "your own playlist pictures" on storage.objects
  for all to authenticated
  using (bucket_id = 'playlist-pictures' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'playlist-pictures' and (storage.foldername(name))[1] = auth.uid()::text);

-- Tell the API about the new column right away.
notify pgrst, 'reload schema';
