-- Milk Crate: fair stream counts, and feedback from people using the app.
-- Run once after 007_albums_favorites_streams.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

-- ============ Fair stream counts ============
-- Stream counts are public (they rank songs and size dots on the maps), so they can't be pumped up.
-- A play that breaks one of these rules is quietly not counted (the app isn't told, so there's nothing to work around):
--   - The same listener and song: one stream every 4 hours. Looping a song doesn't add up.
--   - One listener: at most 300 streams a day (about 15 hours of music).
--   - Artists don't add streams to their own songs.
--   - Listeners who aren't signed in: at most 20 streams of one song an hour, and 500 an hour in all.
create index if not exists plays_listener_track_idx on public.plays(listener_id, track_id, played_at desc);
create index if not exists plays_listener_time_idx on public.plays(listener_id, played_at desc);
create index if not exists plays_anon_idx on public.plays(track_id, played_at desc) where listener_id is null;

create or replace function public.plays_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.listener_id is not null then
    -- Your own songs.
    if exists (select 1 from public.tracks t join public.artists a on a.id = t.artist_id
               where t.id = new.track_id and a.owner_id = new.listener_id) then
      return null;
    end if;
    -- The same song again within 4 hours.
    if exists (select 1 from public.plays p where p.listener_id = new.listener_id and p.track_id = new.track_id
               and p.played_at > now() - interval '4 hours') then
      return null;
    end if;
    -- More than a day's worth of listening.
    if (select count(*) from public.plays p where p.listener_id = new.listener_id and p.played_at > now() - interval '24 hours') >= 300 then
      return null;
    end if;
  else
    if (select count(*) from public.plays p where p.listener_id is null and p.track_id = new.track_id
        and p.played_at > now() - interval '1 hour') >= 20 then
      return null;
    end if;
    if (select count(*) from public.plays p where p.listener_id is null and p.played_at > now() - interval '1 hour') >= 500 then
      return null;
    end if;
  end if;
  return new;
end $$;
-- Runs after plays_fill_town (triggers run in name order), so played_at is already the server's clock.
drop trigger if exists plays_limit on public.plays;
create trigger plays_limit before insert on public.plays for each row execute function public.plays_limit();
revoke all on function public.plays_limit() from public, anon, authenticated;

-- ============ Feedback ============
-- "Send feedback" in the app. Anyone can send it; only reviewers read it (Review → Feedback).
create table if not exists public.feedback (
  id            bigint generated always as identity primary key,
  user_id       uuid default auth.uid() references auth.users(id) on delete set null,
  kind          text not null default 'idea' check (kind in ('idea', 'problem', 'other')),
  message       text not null check (char_length(btrim(message)) between 1 and 4000),
  contact_email text check (contact_email is null or (char_length(contact_email) <= 200 and contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  screen        text check (screen is null or char_length(screen) <= 200),
  app_version   text check (app_version is null or char_length(app_version) <= 40),
  platform      text check (platform is null or char_length(platform) <= 200),
  status        text not null default 'new' check (status in ('new', 'done')),
  created_at    timestamptz not null default now()
);
create index if not exists feedback_status_idx on public.feedback(status, created_at desc);
alter table public.feedback enable row level security;
drop policy if exists "send feedback" on public.feedback;
drop policy if exists "reviewers read feedback" on public.feedback;
drop policy if exists "reviewers handle feedback" on public.feedback;
drop policy if exists "reviewers clear feedback" on public.feedback;
create policy "send feedback" on public.feedback for insert to anon, authenticated
  with check (user_id is not distinct from auth.uid() and status = 'new');
create policy "reviewers read feedback" on public.feedback for select to authenticated using (public.is_admin());
create policy "reviewers handle feedback" on public.feedback for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "reviewers clear feedback" on public.feedback for delete to authenticated using (public.is_admin());
grant insert on public.feedback to anon, authenticated;
grant select, update, delete on public.feedback to authenticated;

-- At most 10 an hour from one account, and 100 an hour from people who aren't signed in.
create or replace function public.limit_feedback() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null then
    if (select count(*) from public.feedback where user_id = new.user_id and created_at > now() - interval '1 hour') >= 10 then
      raise exception 'You''ve sent a lot of feedback this hour. Thanks! Try again a bit later.';
    end if;
  elsif (select count(*) from public.feedback where user_id is null and created_at > now() - interval '1 hour') >= 100 then
    raise exception 'Too much feedback right now. Try again a bit later.';
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists feedback_limit on public.feedback;
create trigger feedback_limit before insert on public.feedback for each row execute function public.limit_feedback();
revoke all on function public.limit_feedback() from public, anon, authenticated;

-- When an account is deleted (from the app or the dashboard), erase the reply email on its feedback.
create or replace function public.forget_feedback_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.feedback set contact_email = null where user_id = old.id;
  return old;
end $$;
drop trigger if exists forget_feedback_email on auth.users;
create trigger forget_feedback_email before delete on auth.users for each row execute function public.forget_feedback_email();
revoke all on function public.forget_feedback_email() from public, anon, authenticated;
