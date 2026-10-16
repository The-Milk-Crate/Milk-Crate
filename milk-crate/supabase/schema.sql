-- Milk Crate database setup.
-- Run once: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Then run 002_artist_pages.sql the same way.
-- Safe to run again; it skips anything that already exists.

-- ============ Tables ============

-- One artist profile per account.
create table if not exists public.artists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  scene_id    text not null default 'rdu',
  place       text not null default '',
  genres      text[] not null default '{}',
  bio         text not null default '' check (char_length(bio) <= 2000),
  accent      text not null default '#cfb1f8' check (accent ~ '^#[0-9a-fA-F]{6}$'),
  since       int  not null default extract(year from now())::int,
  created_at  timestamptz not null default now()
);

create table if not exists public.releases (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid not null references public.artists(id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 200),
  kind            text not null check (kind in ('Single', 'EP', 'LP')),
  year            int  not null,
  catalog_number  text,
  art_url         text,
  created_at      timestamptz not null default now()
);

create table if not exists public.tracks (
  id          uuid primary key default gen_random_uuid(),
  release_id  uuid not null references public.releases(id) on delete cascade,
  artist_id   uuid not null references public.artists(id) on delete cascade,
  position    int  not null,
  title       text not null check (char_length(title) between 1 and 200),
  duration    int  not null default 0,
  audio_url   text not null,
  created_at  timestamptz not null default now()
);

create index if not exists releases_artist_idx on public.releases(artist_id);
create index if not exists tracks_release_idx  on public.tracks(release_id);

-- ============ Who can do what (row level security) ============
-- Everyone (signed in or not) can read the catalog.
-- Only the account that owns an artist profile can change it or its releases.

alter table public.artists  enable row level security;
alter table public.releases enable row level security;
alter table public.tracks   enable row level security;

drop policy if exists "catalog is public"        on public.artists;
drop policy if exists "owner manages artist"     on public.artists;
drop policy if exists "catalog is public"        on public.releases;
drop policy if exists "owner manages releases"   on public.releases;
drop policy if exists "catalog is public"        on public.tracks;
drop policy if exists "owner manages tracks"     on public.tracks;

create policy "catalog is public" on public.artists  for select using (true);
create policy "catalog is public" on public.releases for select using (true);
create policy "catalog is public" on public.tracks   for select using (true);

create policy "owner manages artist" on public.artists
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "owner manages releases" on public.releases
  for all to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));

create policy "owner manages tracks" on public.tracks
  for all to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));

-- ============ File storage ============
-- covers: album art. audio: the music. Both readable by anyone so the app can stream.
-- Each account can only write inside a folder named after its own user id.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('covers', 'covers', true, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('audio',  'audio',  true, 52428800, array['audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/opus'])
on conflict (id) do nothing;

drop policy if exists "artists list own files"      on storage.objects;
drop policy if exists "artists upload to own folder" on storage.objects;
drop policy if exists "artists update own files"     on storage.objects;
drop policy if exists "artists delete own files"     on storage.objects;

create policy "artists list own files" on storage.objects
  for select to authenticated
  using (bucket_id in ('covers', 'audio') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('covers', 'audio') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists update own files" on storage.objects
  for update to authenticated
  using (bucket_id in ('covers', 'audio') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists delete own files" on storage.objects
  for delete to authenticated
  using (bucket_id in ('covers', 'audio') and (storage.foldername(name))[1] = auth.uid()::text);
