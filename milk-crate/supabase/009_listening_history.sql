-- Milk Crate: listening history in your account, so it follows you to any computer.
-- Private: only you can see your own history, and you can clear it any time (Your Crate → History).
-- Run once after 008_fair_streams_feedback.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

create table if not exists public.listening_history (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  track_id   uuid not null references public.tracks(id) on delete cascade,
  played_at  timestamptz not null default now()
);
create index if not exists listening_history_user_idx on public.listening_history(user_id, played_at desc);
alter table public.listening_history enable row level security;
drop policy if exists "your own history" on public.listening_history;
create policy "your own history" on public.listening_history for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, delete on public.listening_history to authenticated;

-- Keeps history tidy: no times in the future, the same song started twice within 30 seconds counts once,
-- and only the newest 2,000 songs are kept per person.
create or replace function public.history_tidy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.played_at := least(coalesce(new.played_at, now()), now());
  if exists (select 1 from public.listening_history h where h.user_id = new.user_id and h.track_id = new.track_id
             and abs(extract(epoch from h.played_at - new.played_at)) < 30) then
    return null;
  end if;
  delete from public.listening_history where id in (
    select id from public.listening_history where user_id = new.user_id order by played_at desc offset 1999
  );
  return new;
end $$;
drop trigger if exists history_tidy on public.listening_history;
create trigger history_tidy before insert on public.listening_history for each row execute function public.history_tidy();
revoke all on function public.history_tidy() from public, anon, authenticated;
