-- Milk Crate: sending ripped CDs only between computers signed in to the same account.
-- Each account gets a secret link key. Your computers fetch it while signed in and mix it into the
-- transfer's encryption (it's never sent over your network), so a computer signed in to a
-- different account can't connect, even with the 6-digit code. Only you can read your key.
-- Run once after 013_computer_songs.sql: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
-- Safe to run again.

create table if not exists public.link_keys (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  -- 244 random bits, made by the server.
  secret     text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now()
);
alter table public.link_keys enable row level security;
drop policy if exists "your own link key" on public.link_keys;
create policy "your own link key" on public.link_keys for select to authenticated using (user_id = auth.uid());
drop policy if exists "make your link key" on public.link_keys;
create policy "make your link key" on public.link_keys for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "replace your link key" on public.link_keys;
create policy "replace your link key" on public.link_keys for delete to authenticated using (user_id = auth.uid());
revoke all on public.link_keys from anon;
grant select, insert, delete on public.link_keys to authenticated;
-- The key itself can't be chosen or changed by the app: only made by the server.
revoke insert on public.link_keys from authenticated;
grant insert (user_id) on public.link_keys to authenticated;

notify pgrst, 'reload schema';
