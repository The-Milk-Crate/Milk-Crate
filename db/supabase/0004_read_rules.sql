-- 0004 (Supabase only): read rules for direct table access, kept as a backstop.
--
-- On both deployments session G's handlers enforce access in every query, and clients read
-- the new slice only through them: 0006_grants.sql grants none of these tables, views or
-- helpers to clients. These rules guard direct access (PostgREST) in case a grant comes back by
-- mistake. They match db/test/access-expected.json, which G's handler tests use as well.
--
--   * Releases, tracks, rights and the cover flag: the owner (artist) in any state;
--     administrator and internal for every release. Nobody else reads the tables.
--   * Uploads: the owner only (getUpload is owner only).
--   * Everyone signed in: the public views api_public_releases and api_public_tracks, which
--     show only live releases and hide owner_id, rights and review details.
--   * Playback and covers (api_can_play_track, api_can_read_cover): the owner, administrator
--     and internal in any state but taken_down (its files are gone); everyone else only live.
--   * Nobody reads accounts, jobs, invites, play events, streams, review history or audit rows
--     directly. Keys, hashes and the storage module's upload ids are never granted.
-- If a grant comes back, keep it SELECT only and to these columns: every write goes through
-- the server, and keys, hashes and invite fields stay hidden (the test grants exactly this).
--
-- Who is calling: the token's account_type claim, but only while it matches what the account
-- would get now (api_account_claim). So a new role shows after the token refreshes, and a role
-- that is removed or suspended stops at once. A missing claim counts as end_user.

create or replace function public.api_caller_type()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    when auth.jwt() ->> 'account_type' = public.api_account_claim(auth.uid())
      then auth.jwt() ->> 'account_type'
    else 'end_user'
  end
$$;

-- True when the caller may read this release in any state (getRelease, listReleases).
create or replace function public.api_release_visible(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.api_caller_type() in ('administrator', 'internal')
    or (public.api_caller_type() = 'artist' and p_owner_id = auth.uid()),
    false)
$$;

-- Playback and covers: the owner, administrator and internal in any state; everyone signed in
-- when live. Never for taken_down: its files are deleted.
create or replace function public.api_media_visible(p_release_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select r.state <> 'taken_down'
           and (r.state = 'live' or public.api_release_visible(r.owner_id))
    from public.api_releases r
    where r.id = p_release_id and auth.uid() is not null), false)
$$;

-- getPlayback: may this caller get a grant for this track now? False when the track has no
-- streaming copy, so true means the handler would answer 200.
create or replace function public.api_can_play_track(p_track_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select t.stream_key is not null and public.api_media_visible(t.release_id)
    from public.api_tracks t where t.id = p_track_id), false)
$$;

-- getCover: may this caller get a grant for this release's cover now? False when there is no
-- cover.
create or replace function public.api_can_read_cover(p_release_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.api_covers c where c.release_id = p_release_id)
         and public.api_media_visible(p_release_id)
$$;

-- Policies. Row level security is on for every api_ table (0001). With no policy a table
-- shows nothing to clients.
drop policy if exists api_releases_read on public.api_releases;
create policy api_releases_read on public.api_releases
  for select to authenticated
  using (public.api_release_visible(owner_id));

-- Child rows follow their release (the subquery runs under api_releases_read).
drop policy if exists api_tracks_read on public.api_tracks;
create policy api_tracks_read on public.api_tracks
  for select to authenticated
  using (release_id in (select r.id from public.api_releases r));

drop policy if exists api_parties_read on public.api_parties;
create policy api_parties_read on public.api_parties
  for select to authenticated
  using (release_id in (select r.id from public.api_releases r));

drop policy if exists api_covers_read on public.api_covers;
create policy api_covers_read on public.api_covers
  for select to authenticated
  using (release_id in (select r.id from public.api_releases r));

-- Uploads: the owner only, not staff.
drop policy if exists api_uploads_read on public.api_uploads;
create policy api_uploads_read on public.api_uploads
  for select to authenticated
  using (release_id in (select r.id from public.api_releases r where r.owner_id = auth.uid()));

-- The public view. Live releases only; no owner_id, rights or review details.
-- These views run as their owner, so they read past the policies above; they filter on live
-- themselves. security_barrier keeps a caller's own filters from running first.
create or replace view public.api_public_releases with (security_barrier) as
  select r.id, r.artist_id, r.title, r.release_date,
         exists (select 1 from public.api_covers c where c.release_id = r.id) as has_cover
  from public.api_releases r
  where r.state = 'live';

create or replace view public.api_public_tracks with (security_barrier) as
  select t.id, t.release_id, t.position, t.title
  from public.api_tracks t
  join public.api_releases r on r.id = t.release_id
  where r.state = 'live';
