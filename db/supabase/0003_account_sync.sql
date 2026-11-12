-- 0003 (Supabase only): keep api_accounts in step with the app's tables.
--
--   * A public.admins row means an administrator row.
--   * An approved artist profile (what is_approved_artist() checks: public.artists with
--     status = 'approved') means an artist row with the profile's id and name.
--   * internal, internal_accounting and third_party rows are written straight into
--     api_accounts. The sync never adds, changes or removes them.
--   * Pending and declined applicants get no row, so they stay end_user.
--   * Every row carries the account's email from auth.users, kept in step.
--
-- One role per account. The sync refuses (MC403 one_role) an artist approval for an account
-- that already has another row or an admins row, and an admins row for an account that has an
-- artist row, an approved profile or another staff row. If the app's tables hold both anyway
-- (rows from before this file, or triggers turned off), the sync takes the higher type in the
-- order administrator, internal, internal_accounting, third_party, artist, end_user.
--
-- Losing a role: the row is deleted when the account has no history, and suspended (kept,
-- claim end_user) when it owns a release, made a review decision or took a release down.
-- Regaining the same role lifts the suspension.
--
-- This only adds triggers beside the app's tables. It changes none of the app's tables,
-- policies or functions. Safe to run twice.

-- Delete the account's row, or suspend it when B refuses the delete (MC409 has_history).
create or replace function public.api_sync_remove_account(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    delete from public.api_accounts a where a.user_id = p_user_id;
    return 'deleted';
  exception when sqlstate 'MC409' then
    update public.api_accounts a set suspended = true where a.user_id = p_user_id and not a.suspended;
    return 'suspended';
  end;
end
$$;

-- Bring one account's api_accounts row in line with the app's tables.
-- Returns what it did: none, added, updated, deleted, suspended, replaced.
create or replace function public.api_sync_account(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_artist_id uuid;
  v_artist_name text;
  v_email text;
  v_cur public.api_accounts%rowtype;
  v_has boolean;
  v_want text;
  v_done text;
begin
  if p_user_id is null then
    return 'none';
  end if;
  -- One sync per account at a time.
  perform pg_advisory_xact_lock(hashtext('api_sync_account'), hashtext(p_user_id::text));

  v_admin := exists (select 1 from public.admins ad where ad.user_id = p_user_id);
  select ar.id, left(btrim(ar.name), 200) into v_artist_id, v_artist_name
    from public.artists ar where ar.owner_id = p_user_id and ar.status = 'approved'
    order by ar.created_at limit 1;
  select u.email into v_email from auth.users u where u.id = p_user_id;
  select a.* into v_cur from public.api_accounts a where a.user_id = p_user_id for update;
  v_has := found;

  -- The type the app's tables give, highest first.
  v_want := case
    when v_admin then 'administrator'
    when v_has and v_cur.account_type in ('internal', 'internal_accounting', 'third_party')
      then v_cur.account_type
    when v_artist_id is not null then 'artist'
  end;

  if v_want is null then
    if v_has and v_cur.account_type in ('administrator', 'artist') then
      return public.api_sync_remove_account(p_user_id);
    end if;
    return 'none';
  end if;

  if not v_has then
    insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name)
      values (p_user_id, v_want, v_email,
              case when v_want = 'artist' then v_artist_id end,
              case when v_want = 'artist' then v_artist_name end);
    return 'added';
  end if;

  -- Rows written straight into api_accounts: only the email is kept in step.
  if v_want = v_cur.account_type and v_want in ('internal', 'internal_accounting', 'third_party') then
    if v_email is not null and v_email is distinct from v_cur.email then
      update public.api_accounts a set email = v_email where a.user_id = p_user_id;
      return 'updated';
    end if;
    return 'none';
  end if;

  if v_want = v_cur.account_type then
    if v_cur.suspended or v_cur.email is distinct from coalesce(v_email, v_cur.email)
       or (v_want = 'artist' and (v_cur.artist_id, v_cur.artist_name) is distinct from (v_artist_id, v_artist_name)) then
      update public.api_accounts a
        set suspended = false,
            email = coalesce(v_email, a.email),
            artist_id = case when v_want = 'artist' then v_artist_id end,
            artist_name = case when v_want = 'artist' then v_artist_name end
        where a.user_id = p_user_id;
      return 'updated';
    end if;
    return 'none';
  end if;

  -- A different type. B allows changes between non-artist types.
  if v_cur.account_type <> 'artist' and v_want <> 'artist' then
    update public.api_accounts a
      set account_type = v_want, suspended = false, email = coalesce(v_email, a.email)
      where a.user_id = p_user_id;
    return 'updated';
  end if;

  -- To or from artist: B refuses changing the row. Replace it when the account has no history;
  -- otherwise suspend it, so the account gets end_user and needs a second account.
  v_done := public.api_sync_remove_account(p_user_id);
  if v_done = 'deleted' then
    insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name)
      values (p_user_id, v_want, coalesce(v_email, v_cur.email),
              case when v_want = 'artist' then v_artist_id end,
              case when v_want = 'artist' then v_artist_name end);
    return 'replaced';
  end if;
  raise warning 'one_role: account % has history as %; suspended instead of becoming %',
    p_user_id, v_cur.account_type, v_want;
  return 'suspended';
end
$$;

-- Refuses a change that would give an account a second role.
create or replace function public.api_sync_refuse_second_role(p_user_id uuid, p_becoming text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  select a.account_type into v_type from public.api_accounts a where a.user_id = p_user_id;
  if p_becoming = 'administrator' then
    if v_type is not null and v_type <> 'administrator' then
      raise exception using errcode = 'MC403',
        message = format('one_role: this account is already %s; an administrator uses a second account', v_type);
    end if;
    if exists (select 1 from public.artists ar where ar.owner_id = p_user_id and ar.status = 'approved') then
      raise exception using errcode = 'MC403',
        message = 'one_role: this account has an approved artist profile; an administrator uses a second account';
    end if;
  elsif p_becoming = 'artist' then
    if v_type is not null and v_type <> 'artist' then
      raise exception using errcode = 'MC403',
        message = format('one_role: this account is %s; an artist uses a second account', v_type);
    end if;
    if exists (select 1 from public.admins ad where ad.user_id = p_user_id) then
      raise exception using errcode = 'MC403',
        message = 'one_role: this account is a reviewer (admins); an artist uses a second account';
    end if;
  end if;
end
$$;

-- public.admins: insert, update or delete.
create or replace function public.api_sync_admins_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    if tg_op = 'INSERT' or new.user_id is distinct from old.user_id then
      perform public.api_sync_refuse_second_role(new.user_id, 'administrator');
    end if;
    perform public.api_sync_account(new.user_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or new.user_id is distinct from old.user_id) then
    perform public.api_sync_account(old.user_id);
  end if;
  return null;
end
$$;

drop trigger if exists api_sync_admins on public.admins;
create trigger api_sync_admins
  after insert or update or delete on public.admins
  for each row execute function public.api_sync_admins_trigger();

-- public.artists: a profile approved, unapproved, renamed, moved or removed.
create or replace function public.api_sync_artists_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.name is not distinct from old.name
     and new.owner_id is not distinct from old.owner_id
     and new.id is not distinct from old.id then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.status = 'approved'
       and (tg_op = 'INSERT' or old.status is distinct from 'approved' or new.owner_id is distinct from old.owner_id) then
      perform public.api_sync_refuse_second_role(new.owner_id, 'artist');
    end if;
    perform public.api_sync_account(new.owner_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or new.owner_id is distinct from old.owner_id) then
    perform public.api_sync_account(old.owner_id);
  end if;
  return null;
end
$$;

drop trigger if exists api_sync_artists on public.artists;
create trigger api_sync_artists
  after insert or update or delete on public.artists
  for each row execute function public.api_sync_artists_trigger();

-- auth.users: keep the email in step on every row the account has.
create or replace function public.api_sync_email_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email and new.email is not null then
    update public.api_accounts a set email = new.email
      where a.user_id = new.id and a.email is distinct from new.email;
  end if;
  return null;
end
$$;

drop trigger if exists api_sync_email on auth.users;
create trigger api_sync_email
  after update of email on auth.users
  for each row execute function public.api_sync_email_trigger();

-- Fill api_accounts from what the app's tables hold now. Safe to run again.
do $$
declare
  v_user uuid;
begin
  for v_user in
    select ad.user_id from public.admins ad
    union
    select ar.owner_id from public.artists ar where ar.status = 'approved'
    union
    select a.user_id from public.api_accounts a where a.account_type in ('administrator', 'artist')
    order by 1
  loop
    perform public.api_sync_account(v_user);
  end loop;
end
$$;
