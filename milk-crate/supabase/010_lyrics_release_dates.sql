-- Milk Crate: lyrics and credits for songs, and release dates (schedule a release ahead of time).
-- Run once after 009_listening_history.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again. (If you ever run 003_accounts_and_places.sql again, run this one again after it.)

-- ============ Lyrics and credits ============
alter table public.tracks add column if not exists lyrics text;
alter table public.tracks add column if not exists credits text;
alter table public.tracks drop constraint if exists tracks_lyrics_size;
alter table public.tracks add constraint tracks_lyrics_size check (lyrics is null or char_length(lyrics) <= 20000);
alter table public.tracks drop constraint if exists tracks_credits_size;
alter table public.tracks add constraint tracks_credits_size check (credits is null or char_length(credits) <= 4000);

-- ============ Release dates ============
-- Empty = out now. A date in the future: the release shows as "coming" (title, cover, date) but its
-- songs stay hidden from everyone except the artist and reviewers until then.
alter table public.releases add column if not exists release_at timestamptz;
alter table public.releases drop constraint if exists releases_release_at_range;
alter table public.releases add constraint releases_release_at_range
  check (release_at is null or release_at <= now() + interval '2 years') not valid;

drop policy if exists "tracks of approved artists are public" on public.tracks;
create policy "tracks of approved artists are public" on public.tracks for select
  using (exists (
    select 1 from public.artists a join public.releases r on r.id = release_id
    where a.id = artist_id and (
      a.owner_id = auth.uid() or public.is_admin()
      or (a.status = 'approved' and (r.release_at is null or r.release_at <= now()))
    )
  ));
