-- Milk Crate: listener and artist accounts, artist approval, and real locations.
-- Run once after 002_artist_pages.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.
--
-- After running it, make yourself the reviewer (replace the email with the one you sign in with):
--   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';

-- ============ Account kinds ============
-- Every login is either a listener account or an artist account, chosen at sign-up and never changed.
create table if not exists public.accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('listener', 'artist')),
  created_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
drop policy if exists "see own account" on public.accounts;
create policy "see own account" on public.accounts for select to authenticated using (user_id = auth.uid());

-- The kind comes from the sign-up form (user metadata) when the login is created.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (user_id, kind)
  values (new.id, case when new.raw_user_meta_data->>'kind' = 'artist' then 'artist' else 'listener' end)
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Logins made before this script: artist if they already have an artist profile.
insert into public.accounts (user_id, kind)
select u.id, case when exists (select 1 from public.artists a where a.owner_id = u.id)
                    or u.raw_user_meta_data->>'kind' = 'artist' then 'artist' else 'listener' end
from auth.users u
on conflict (user_id) do nothing;

-- ============ Reviewers ============
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
drop policy if exists "see own admin row" on public.admins;
create policy "see own admin row" on public.admins for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;
create or replace function public.account_kind() returns text
language sql stable security definer set search_path = public as $$
  select kind from public.accounts where user_id = auth.uid()
$$;

-- ============ Listeners: where they live ============
-- Private: only the listener can see their own location.
create table if not exists public.listeners (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  city       text not null check (char_length(city) between 1 and 120),
  state      text not null check (state ~ '^[A-Z]{2}$'),
  lat        double precision not null check (lat between -90 and 90),
  lng        double precision not null check (lng between -180 and 180),
  updated_at timestamptz not null default now()
);
alter table public.listeners enable row level security;
drop policy if exists "listener manages own location" on public.listeners;
create policy "listener manages own location" on public.listeners
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.account_kind() = 'listener');

-- ============ Artists: location and approval ============
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artists' and column_name = 'status') then
    alter table public.artists add column status text not null default 'pending' check (status in ('pending', 'approved', 'declined'));
    -- Artists already on Milk Crate before approval existed stay visible.
    update public.artists set status = 'approved';
  end if;
end $$;
alter table public.artists add column if not exists reviewed_at timestamptz;
alter table public.artists add column if not exists city  text;
alter table public.artists add column if not exists state text check (state is null or state ~ '^[A-Z]{2}$');
alter table public.artists add column if not exists lat   double precision check (lat is null or lat between -90 and 90);
alter table public.artists add column if not exists lng   double precision check (lng is null or lng between -180 and 180);

create or replace function public.is_approved_artist() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.artists where owner_id = auth.uid() and status = 'approved')
$$;

-- Only reviewers can change an artist's status; everyone else's changes to it are ignored.
create or replace function public.guard_artist_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    if tg_op = 'UPDATE' and new.status is distinct from old.status then new.reviewed_at := now(); end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.reviewed_at := null;
  else
    new.status := old.status;
    new.reviewed_at := old.reviewed_at;
  end if;
  return new;
end $$;
drop trigger if exists guard_artist_status on public.artists;
create trigger guard_artist_status before insert or update on public.artists for each row execute function public.guard_artist_status();

-- Who sees what: approved artists are public; pending ones only to themselves and reviewers.
drop policy if exists "catalog is public" on public.artists;
drop policy if exists "owner manages artist" on public.artists;
drop policy if exists "approved artists are public" on public.artists;
drop policy if exists "artist account creates own profile" on public.artists;
drop policy if exists "owner or reviewer updates artist" on public.artists;
drop policy if exists "owner deletes artist" on public.artists;
create policy "approved artists are public" on public.artists for select
  using (status = 'approved' or owner_id = auth.uid() or public.is_admin());
create policy "artist account creates own profile" on public.artists for insert to authenticated
  with check (owner_id = auth.uid() and public.account_kind() = 'artist');
create policy "owner or reviewer updates artist" on public.artists for update to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());
create policy "owner deletes artist" on public.artists for delete to authenticated using (owner_id = auth.uid());

-- Releases and tracks: public once the artist is approved; only approved artists can publish.
drop policy if exists "catalog is public" on public.releases;
drop policy if exists "catalog is public" on public.tracks;
drop policy if exists "owner manages releases" on public.releases;
drop policy if exists "owner manages tracks" on public.tracks;
drop policy if exists "releases of approved artists are public" on public.releases;
drop policy if exists "tracks of approved artists are public" on public.tracks;
drop policy if exists "approved artist adds releases" on public.releases;
drop policy if exists "approved artist adds tracks" on public.tracks;
drop policy if exists "owner changes releases" on public.releases;
drop policy if exists "owner changes tracks" on public.tracks;
drop policy if exists "owner removes releases" on public.releases;
drop policy if exists "owner removes tracks" on public.tracks;

create policy "releases of approved artists are public" on public.releases for select
  using (exists (select 1 from public.artists a where a.id = artist_id and (a.status = 'approved' or a.owner_id = auth.uid() or public.is_admin())));
create policy "tracks of approved artists are public" on public.tracks for select
  using (exists (select 1 from public.artists a where a.id = artist_id and (a.status = 'approved' or a.owner_id = auth.uid() or public.is_admin())));
create policy "approved artist adds releases" on public.releases for insert to authenticated
  with check (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid() and a.status = 'approved'));
create policy "approved artist adds tracks" on public.tracks for insert to authenticated
  with check (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid() and a.status = 'approved'));
create policy "owner changes releases" on public.releases for update to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));
create policy "owner changes tracks" on public.tracks for update to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));
create policy "owner removes releases" on public.releases for delete to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));
create policy "owner removes tracks" on public.tracks for delete to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));

-- ============ Applications ============
-- What an artist tells the reviewers. Private to the artist and reviewers.
create table if not exists public.artist_applications (
  artist_id     uuid primary key references public.artists(id) on delete cascade,
  links         text not null default '' check (char_length(links) <= 2000),
  note          text not null default '' check (char_length(note) <= 2000),
  contact_email text check (contact_email is null or char_length(contact_email) <= 320),
  review_note   text check (review_note is null or char_length(review_note) <= 2000),
  submitted_at  timestamptz not null default now()
);
alter table public.artist_applications enable row level security;
drop policy if exists "artist and reviewers see application" on public.artist_applications;
drop policy if exists "artist writes own application" on public.artist_applications;
drop policy if exists "artist updates own application" on public.artist_applications;
drop policy if exists "reviewers update applications" on public.artist_applications;
create policy "artist and reviewers see application" on public.artist_applications for select to authenticated
  using (public.is_admin() or exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));
create policy "artist writes own application" on public.artist_applications for insert to authenticated
  with check (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));
create policy "artist updates own application" on public.artist_applications for update to authenticated
  using (exists (select 1 from public.artists a where a.id = artist_id and a.owner_id = auth.uid()));
create policy "reviewers update applications" on public.artist_applications for update to authenticated
  using (public.is_admin());

-- ============ Storage ============
-- Music and covers: approved artists only. Banners, logos and fonts: any artist account (for their application).
drop policy if exists "artists list own files"      on storage.objects;
drop policy if exists "artists upload to own folder" on storage.objects;
drop policy if exists "artists update own files"     on storage.objects;
drop policy if exists "artists delete own files"     on storage.objects;

create policy "artists list own files" on storage.objects
  for select to authenticated
  using (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists upload to own folder" on storage.objects
  for insert to authenticated
  with check (
    (storage.foldername(name))[1] = auth.uid()::text and (
      (bucket_id in ('covers', 'audio') and public.is_approved_artist()) or
      (bucket_id = 'profiles' and public.account_kind() = 'artist')
    )
  );

create policy "artists update own files" on storage.objects
  for update to authenticated
  using (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "artists delete own files" on storage.objects
  for delete to authenticated
  using (bucket_id in ('covers', 'audio', 'profiles') and (storage.foldername(name))[1] = auth.uid()::text);

-- ============ Access for the app ============
grant select on public.accounts to authenticated;
grant select on public.admins to authenticated;
grant select, insert, update, delete on public.listeners to authenticated;
grant select, insert, update on public.artist_applications to authenticated;
grant execute on function public.is_admin(), public.account_kind(), public.is_approved_artist() to anon, authenticated;

notify pgrst, 'reload schema';
