-- Milk Crate: artist page designs (banners, name lettering, logo).
-- Run once after schema.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again, but if you've run 003_accounts_and_places.sql, run 003 again afterwards (it tightens the file rules below).

-- The page design, as JSON (see ArtistPage in src/lib/types.ts). Kept small.
alter table public.artists add column if not exists page jsonb not null default '{}'::jsonb;
alter table public.artists drop constraint if exists artists_page_size;
alter table public.artists add constraint artists_page_size check (octet_length(page::text) <= 8192);

-- profiles: banners, logos and uploaded name fonts. Readable by anyone.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profiles', 'profiles', true, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'font/ttf', 'font/otf', 'font/woff', 'font/woff2'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Artists can only write inside a folder named after their own user id, in any Milk Crate bucket.
drop policy if exists "artists list own files"      on storage.objects;
drop policy if exists "artists upload to own folder" on storage.objects;
drop policy if exists "artists update own files"     on storage.objects;
drop policy if exists "artists delete own files"     on storage.objects;

create policy "artists list own files" on storage.objects
  for select to authenticated
  using (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists update own files" on storage.objects
  for update to authenticated
  using (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists delete own files" on storage.objects
  for delete to authenticated
  using (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

-- Tell the API about the new column right away.
notify pgrst, 'reload schema';
