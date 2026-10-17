-- Milk Crate: deleting your account, reports and takedowns, play counts for artists' stats, error reports,
-- and account-safety rules (emails stay private, limits against spam).
-- Run once after 004_crates_and_ratings.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

-- ============ Deleting your account ============
-- Removes the login and everything tied to it (artist profile, releases, crate, ratings, playlists, follows...),
-- since those tables cascade from auth.users. The app removes your uploaded files first.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  -- Erase the follow-up email from reports this person sent (the reports themselves stay for reviewers).
  begin
    update public.reports set contact_email = null where reporter_id = auth.uid();
  exception when undefined_table then null;
  end;
  -- Uploaded files are removed by the app first; let go of any left so they can't block the delete.
  begin
    update storage.objects set owner = null where owner = auth.uid();
  exception when others then null;
  end;
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ============ Reports ============
-- Anyone signed in can report a release or an artist (stolen music, not theirs, offensive, spam).
-- Reviewers see the reports and can take a release down or hide an artist.
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid default auth.uid() references auth.users(id) on delete set null,
  release_id    uuid references public.releases(id) on delete set null,
  artist_id     uuid references public.artists(id) on delete set null,
  -- What was reported, kept even if the release or artist is later removed.
  subject       text not null default '' check (char_length(subject) <= 300),
  reason        text not null check (reason in ('copyright', 'not_theirs', 'offensive', 'spam', 'other')),
  details       text not null default '' check (char_length(details) <= 2000),
  contact_email text check (contact_email is null or char_length(contact_email) <= 200),
  status        text not null default 'open' check (status in ('open', 'removed', 'dismissed')),
  review_note   text check (review_note is null or char_length(review_note) <= 1000),
  created_at    timestamptz not null default now(),
  check (release_id is not null or artist_id is not null or subject <> '')
);
create index if not exists reports_status_idx on public.reports(status, created_at);
alter table public.reports enable row level security;
drop policy if exists "report something" on public.reports;
drop policy if exists "see own or all reports" on public.reports;
drop policy if exists "reviewers handle reports" on public.reports;
create policy "report something" on public.reports for insert to authenticated
  with check (reporter_id = auth.uid() and status = 'open' and review_note is null);
create policy "see own or all reports" on public.reports for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());
create policy "reviewers handle reports" on public.reports for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Reviewers can take a release down (its files too) and hide an artist.
drop policy if exists "reviewers remove releases" on public.releases;
create policy "reviewers remove releases" on public.releases for delete to authenticated using (public.is_admin());
drop policy if exists "reviewers remove release files" on storage.objects;
create policy "reviewers remove release files" on storage.objects for delete to authenticated
  using (bucket_id in ('covers', 'audio') and public.is_admin());

-- ============ Plays (for artists' own stats) ============
-- A play is counted after about 30 seconds of listening. Nobody can read the raw rows;
-- artists see totals for their own songs through the functions below.
create table if not exists public.plays (
  id          bigint generated always as identity primary key,
  track_id    uuid not null references public.tracks(id) on delete cascade,
  listener_id uuid default auth.uid() references auth.users(id) on delete set null,
  city        text,
  state       text,
  played_at   timestamptz not null default now()
);
create index if not exists plays_track_idx on public.plays(track_id, played_at);
alter table public.plays enable row level security;
drop policy if exists "count a play" on public.plays;
create policy "count a play" on public.plays for insert to anon, authenticated
  with check (listener_id is not distinct from auth.uid());

-- The town comes from the listener's own saved city (whatever the app sends is ignored), filled in here.
create or replace function public.plays_fill_town() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.city := null;
  new.state := null;
  new.played_at := now();
  if new.listener_id is not null then
    select l.city, l.state into new.city, new.state from public.listeners l where l.user_id = new.listener_id;
    if new.city is null then
      select a.city, a.state into new.city, new.state from public.artists a where a.owner_id = new.listener_id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists plays_fill_town on public.plays;
create trigger plays_fill_town before insert on public.plays for each row execute function public.plays_fill_town();

-- Per song: total plays, plays in the last 30 days, and how many different listeners.
create or replace function public.my_artist_stats()
returns table (track_id uuid, plays bigint, plays_30d bigint, listeners bigint)
language sql stable security definer set search_path = public as $$
  select t.id,
         count(p.id),
         count(p.id) filter (where p.played_at > now() - interval '30 days'),
         count(distinct p.listener_id)
  from public.tracks t
  join public.artists a on a.id = t.artist_id and a.owner_id = auth.uid()
  left join public.plays p on p.track_id = t.id
  group by t.id
$$;

-- Where people listen from. A town only shows once 3 or more different listeners there have played
-- the artist, so no one listener can be picked out; the rest are counted together.
create or replace function public.my_artist_towns()
returns table (city text, state text, plays bigint, listeners bigint)
language sql stable security definer set search_path = public as $$
  with mine as (
    select p.city, p.state, p.listener_id
    from public.plays p
    join public.tracks t on t.id = p.track_id
    join public.artists a on a.id = t.artist_id and a.owner_id = auth.uid()
  ), towns as (
    select city, state, count(*) as plays, count(distinct listener_id) as listeners
    from mine where city is not null group by city, state
  )
  select city, state, plays, listeners from towns where listeners >= 3
  union all
  select null, null, coalesce(sum(plays), 0)::bigint, coalesce(sum(listeners), 0)::bigint from towns where listeners < 3
  order by 3 desc
$$;
revoke all on function public.my_artist_stats() from public, anon;
revoke all on function public.my_artist_towns() from public, anon;
grant execute on function public.my_artist_stats() to authenticated;
grant execute on function public.my_artist_towns() to authenticated;

-- ============ Error reports ============
-- When the app hits an error it sends a short report (no audio, no personal files). Only reviewers read them.
create table if not exists public.error_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid default auth.uid() references auth.users(id) on delete set null,
  message     text not null check (char_length(message) <= 2000),
  stack       text check (stack is null or char_length(stack) <= 8000),
  screen      text check (screen is null or char_length(screen) <= 200),
  app_version text check (app_version is null or char_length(app_version) <= 40),
  platform    text check (platform is null or char_length(platform) <= 200),
  created_at  timestamptz not null default now()
);
alter table public.error_reports enable row level security;
drop policy if exists "send an error report" on public.error_reports;
drop policy if exists "reviewers read error reports" on public.error_reports;
drop policy if exists "reviewers clear error reports" on public.error_reports;
create policy "send an error report" on public.error_reports for insert to anon, authenticated
  with check (user_id is not distinct from auth.uid());
create policy "reviewers read error reports" on public.error_reports for select to authenticated using (public.is_admin());
create policy "reviewers clear error reports" on public.error_reports for delete to authenticated using (public.is_admin());

-- ============ Account safety ============
-- Emails are private: the only tables holding one (reports, artist_applications) are readable
-- by the person who wrote the row and reviewers. These rules keep it that way and limit spam.

-- Display names are public, so they can't contain an email address. (Existing names aren't checked.)
do $$ begin
  alter table public.profiles add constraint display_name_not_email
    check (display_name !~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}') not valid;
exception when duplicate_object then null; end $$;

-- Follow-up emails have to look like an email.
do $$ begin
  alter table public.reports add constraint reports_contact_email_shape
    check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.artist_applications add constraint applications_contact_email_shape
    check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') not valid;
exception when duplicate_object then null; end $$;

-- Reports: at most 10 an hour from one account, so the report button can't be used to flood reviewers.
create or replace function public.limit_reports() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.reports where reporter_id = new.reporter_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many reports for now. Try again in an hour.';
  end if;
  return new;
end $$;
drop trigger if exists reports_limit on public.reports;
create trigger reports_limit before insert on public.reports for each row execute function public.limit_reports();

-- Error reports: no email addresses stored (blanked out here too, in case the app missed one),
-- and limits so nobody can fill the table: 30 an hour per account, 300 an hour from signed-out apps.
create or replace function public.clean_error_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  email_re constant text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
begin
  if new.user_id is not null then
    if (select count(*) from public.error_reports where user_id = new.user_id and created_at > now() - interval '1 hour') >= 30 then
      return null; -- dropped quietly; the app doesn't need to know
    end if;
  elsif (select count(*) from public.error_reports where user_id is null and created_at > now() - interval '1 hour') >= 300 then
    return null;
  end if;
  new.message := regexp_replace(new.message, email_re, '[email]', 'g');
  new.stack := regexp_replace(new.stack, email_re, '[email]', 'g');
  new.screen := regexp_replace(new.screen, email_re, '[email]', 'g');
  new.created_at := now();
  return new;
end $$;
drop trigger if exists error_reports_clean on public.error_reports;
create trigger error_reports_clean before insert on public.error_reports for each row execute function public.clean_error_report();

-- Nobody outside reviewers can call the trigger functions directly.
revoke all on function public.limit_reports() from public, anon, authenticated;
revoke all on function public.clean_error_report() from public, anon, authenticated;
