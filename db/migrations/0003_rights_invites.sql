-- 0003: rights (parties and shares) and split invitations.
--
-- Invite codes: only a SHA-256 hash of the code is stored (lowercase hex, worked out by the
-- caller). The code itself is never stored or returned. A code expires 14 days after it is
-- sent and works once. A resend replaces the hash and expiry, so the old code stops working.
-- After 10 wrong codes in an hour a party's invitation is locked for the rest of that hour,
-- even if the caller is not counting.
-- The release owner's own party (is_owner) is accepted when it is created and gets no code.
-- Every other reply must use up a valid code.

create table if not exists public.api_parties (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.api_releases (id) on delete cascade,
  side text not null check (side in ('recording', 'composition')),
  role text not null check (length(btrim(role)) between 1 and 100),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- Where the invitation goes. Not needed for the owner.
  email text check (email is null or length(email) between 3 and 320),
  percent numeric(5, 2) not null check (percent >= 0 and percent <= 100),
  -- The release owner's own share. Accepted at once; no invitation.
  is_owner boolean not null default false,
  -- Set by the server only. New parties start as invited (the owner's as accepted).
  state text not null default 'invited' check (state in ('invited', 'accepted', 'declined')),
  -- The account that replied. No foreign key: an end_user has no api_accounts row.
  responder_user_id uuid,
  responded_at timestamptz,
  invite_code_hash text check (invite_code_hash ~ '^[0-9a-f]{64}$'),
  invite_sent_at timestamptz,
  invite_expires_at timestamptz,
  invite_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_parties_reply check ((state = 'invited') = (responded_at is null)),
  constraint api_parties_invite_fields check (
    (invite_code_hash is null) = (invite_sent_at is null)
    and (invite_sent_at is null) = (invite_expires_at is null)
  ),
  constraint api_parties_invite_14_days check (invite_expires_at = invite_sent_at + interval '14 days'),
  constraint api_parties_invite_used check (invite_used_at is null or invite_code_hash is not null),
  constraint api_parties_owner check (not is_owner or (state = 'accepted' and invite_code_hash is null))
);

create index if not exists api_parties_release on public.api_parties (release_id);

-- Invitations sent, per party per day (UTC). For resendInvitation's limit.
create table if not exists public.api_invite_sends (
  party_id uuid not null references public.api_parties (id) on delete cascade,
  day date not null,
  sends integer not null check (sends >= 1),
  primary key (party_id, day)
);

-- Wrong invite codes, per party. getInvitation and respondToSplit count together.
create table if not exists public.api_invite_wrong_codes (
  id bigint generated always as identity primary key,
  party_id uuid not null references public.api_parties (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index if not exists api_invite_wrong_codes_party
  on public.api_invite_wrong_codes (party_id, attempted_at);

-- Parties change only while rights are editable. A party whose details change goes back to
-- invited and its code stops working (the owner's party stays accepted). A reply moves invited
-- to accepted or declined, once, and only by using up a code.
create or replace function public.api_parties_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
  v_owner uuid;
begin
  select r.state, r.owner_id into v_state, v_owner
    from public.api_releases r where r.id = coalesce(new.release_id, old.release_id);

  if tg_op = 'DELETE' then
    if v_state is not null and not public.api_release_rights_editable(v_state) then
      raise exception using errcode = 'MC409', message = format('not_editable: rights cannot change while %s', v_state);
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if not public.api_release_rights_editable(v_state) then
      raise exception using errcode = 'MC409', message = format('not_editable: rights cannot change while %s', v_state);
    end if;
    if new.state <> 'invited' or new.invite_code_hash is not null or new.invite_used_at is not null
       or new.responder_user_id is not null or new.responded_at is not null then
      raise exception using errcode = 'MC422', message = 'server_state: a new party starts invited, with no code yet';
    end if;
    if new.is_owner then
      new.state := 'accepted';
      new.responder_user_id := v_owner;
      new.responded_at := now();
    end if;
    return new;
  end if;

  if new.id <> old.id or new.release_id <> old.release_id or new.is_owner <> old.is_owner then
    raise exception using errcode = 'MC422', message = 'fixed_field: id, release_id and is_owner cannot change';
  end if;

  if (new.side, new.role, new.name, new.email, new.percent)
     is distinct from (old.side, old.role, old.name, old.email, old.percent) then
    if not public.api_release_rights_editable(v_state) then
      raise exception using errcode = 'MC409', message = format('not_editable: rights cannot change while %s', v_state);
    end if;
    if not new.is_owner then
      new.state := 'invited';
      new.responder_user_id := null;
      new.responded_at := null;
      new.invite_code_hash := null;
      new.invite_sent_at := null;
      new.invite_expires_at := null;
      new.invite_used_at := null;
    end if;
  elsif new.state <> old.state then
    if v_state = 'taken_down' then
      raise exception using errcode = 'MC409', message = 'wrong_state: the release is taken down';
    end if;
    if not (old.state = 'invited' and new.state in ('accepted', 'declined')) then
      raise exception using errcode = 'MC409', message = 'already_replied: this party already replied';
    end if;
    if old.invite_used_at is not null or new.invite_used_at is null then
      raise exception using errcode = 'MC409', message = 'no_code: a reply must use up a valid invite code';
    end if;
  end if;
  return new;
end
$$;

-- True while a party has had 10 or more wrong codes in the last hour.
create or replace function public.api_invite_locked(p_party_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select count(*) >= 10 from public.api_invite_wrong_codes w
  where w.party_id = p_party_id and w.attempted_at > now() - interval '1 hour'
$$;

drop trigger if exists api_parties_guard on public.api_parties;
create trigger api_parties_guard
  before insert or update or delete on public.api_parties
  for each row execute function public.api_parties_guard();

drop trigger if exists api_parties_touch on public.api_parties;
create trigger api_parties_touch
  before update on public.api_parties
  for each row execute function public.api_touch_updated_at();

-- Send (or resend) an invitation: store the new code's hash, expiry 14 days from now, and
-- count the send. Returns status:
--   issued, not_found, not_invited (the party already replied), taken_down,
--   rate_limited (p_daily_limit sends already today, UTC).
-- The caller emails the code only when status is issued.
create or replace function public.api_issue_invite(p_party_id uuid, p_code_hash text, p_daily_limit integer)
returns table (status text, sends_today integer, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_party_state text;
  v_release_state text;
  v_day date := (now() at time zone 'UTC')::date;
  v_sends integer;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'MC422', message = 'bad_hash: the code hash must be 64 lowercase hex characters';
  end if;
  if p_daily_limit is null or p_daily_limit < 1 then
    raise exception using errcode = 'MC422', message = 'bad_limit: the daily limit must be 1 or more';
  end if;

  select p.state, r.state into v_party_state, v_release_state
    from public.api_parties p join public.api_releases r on r.id = p.release_id
    where p.id = p_party_id
    for update of p;
  if not found then
    return query select 'not_found'::text, 0, null::timestamptz;
    return;
  end if;
  if v_release_state = 'taken_down' then
    return query select 'taken_down'::text, 0, null::timestamptz;
    return;
  end if;
  if v_party_state <> 'invited' then
    return query select 'not_invited'::text, 0, null::timestamptz;
    return;
  end if;

  select s.sends into v_sends from public.api_invite_sends s where s.party_id = p_party_id and s.day = v_day;
  v_sends := coalesce(v_sends, 0);
  if v_sends >= p_daily_limit then
    return query select 'rate_limited'::text, v_sends, null::timestamptz;
    return;
  end if;

  insert into public.api_invite_sends as s (party_id, day, sends) values (p_party_id, v_day, 1)
    on conflict (party_id, day) do update set sends = s.sends + 1
    returning s.sends into v_sends;

  update public.api_parties p
    set invite_code_hash = p_code_hash,
        invite_sent_at = now(),
        invite_expires_at = now() + interval '14 days',
        invite_used_at = null
    where p.id = p_party_id;

  return query select 'issued'::text, v_sends, now() + interval '14 days';
end
$$;

-- Wrong codes for a party in the last p_window_seconds, if the caller wants a stricter limit
-- than the built-in 10 an hour.
create or replace function public.api_invite_wrong_count(p_party_id uuid, p_window_seconds integer)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.api_invite_wrong_codes w
  where w.party_id = p_party_id
    and w.attempted_at > now() - make_interval(secs => p_window_seconds)
$$;

-- The invitation read for getInvitation. The invitee has no access to the tables; this is
-- their only way in. It checks the code's hash and expiry without using up the code, and
-- returns only the release basics and this one party's own share: never other parties,
-- emails or owner_id. A wrong code is counted, so commit even when status is wrong_code.
-- status: ok, not_found, rate_limited (10 wrong codes in the last hour; nothing is checked),
-- wrong_code, replied, taken_down, expired. Fields are set only for ok.
create or replace function public.api_get_invitation(p_release_id uuid, p_party_id uuid, p_code_hash text)
returns table (
  status text,
  release_title text,
  artist_name text,
  release_date date,
  track_titles jsonb,
  side text,
  role text,
  percent numeric,
  party_state text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_party public.api_parties%rowtype;
  v_release public.api_releases%rowtype;
begin
  select p.* into v_party from public.api_parties p
    where p.id = p_party_id and p.release_id = p_release_id;
  if not found then
    return query select 'not_found'::text, null::text, null::text, null::date, null::jsonb,
                        null::text, null::text, null::numeric, null::text;
    return;
  end if;

  if public.api_invite_locked(p_party_id) then
    return query select 'rate_limited'::text, null::text, null::text, null::date, null::jsonb,
                        null::text, null::text, null::numeric, null::text;
    return;
  end if;

  if v_party.invite_code_hash is null or p_code_hash is null or v_party.invite_code_hash <> p_code_hash then
    insert into public.api_invite_wrong_codes (party_id) values (p_party_id);
    return query select 'wrong_code'::text, null::text, null::text, null::date, null::jsonb,
                        null::text, null::text, null::numeric, null::text;
    return;
  end if;

  select r.* into v_release from public.api_releases r where r.id = p_release_id;
  if v_party.state <> 'invited' or v_party.invite_used_at is not null then
    return query select 'replied'::text, null::text, null::text, null::date, null::jsonb,
                        null::text, null::text, null::numeric, null::text;
    return;
  end if;
  if v_release.state = 'taken_down' then
    return query select 'taken_down'::text, null::text, null::text, null::date, null::jsonb,
                        null::text, null::text, null::numeric, null::text;
    return;
  end if;
  if v_party.invite_expires_at <= now() then
    return query select 'expired'::text, null::text, null::text, null::date, null::jsonb,
                        null::text, null::text, null::numeric, null::text;
    return;
  end if;

  return query
    select 'ok'::text,
           v_release.title,
           a.artist_name,
           v_release.release_date,
           coalesce((select jsonb_agg(t.title order by t.position)
                     from public.api_tracks t where t.release_id = p_release_id), '[]'::jsonb),
           v_party.side,
           v_party.role,
           v_party.percent::numeric,
           v_party.state
    from public.api_accounts a
    where a.user_id = v_release.owner_id;
end
$$;

-- The reply for respondToSplit. Same checks as api_get_invitation; on ok it uses up the code,
-- links p_user_id (the signed-in account) to the party and moves it to accepted or declined.
-- A wrong code is counted, so commit even when status is wrong_code.
-- status: ok, not_found, rate_limited, wrong_code, replied, taken_down, expired.
create or replace function public.api_respond_to_invite(
  p_release_id uuid, p_party_id uuid, p_code_hash text, p_user_id uuid, p_response text)
returns table (status text, party_state text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_party public.api_parties%rowtype;
  v_release_state text;
begin
  if p_response is null or p_response not in ('accept', 'decline') then
    raise exception using errcode = 'MC422', message = 'bad_response: response must be accept or decline';
  end if;
  if p_user_id is null then
    raise exception using errcode = 'MC422', message = 'no_user: the replying account is needed';
  end if;

  select p.* into v_party from public.api_parties p
    where p.id = p_party_id and p.release_id = p_release_id
    for update;
  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if public.api_invite_locked(p_party_id) then
    return query select 'rate_limited'::text, null::text;
    return;
  end if;

  if v_party.invite_code_hash is null or p_code_hash is null or v_party.invite_code_hash <> p_code_hash then
    insert into public.api_invite_wrong_codes (party_id) values (p_party_id);
    return query select 'wrong_code'::text, null::text;
    return;
  end if;

  select r.state into v_release_state from public.api_releases r where r.id = p_release_id;
  if v_party.state <> 'invited' or v_party.invite_used_at is not null then
    return query select 'replied'::text, v_party.state;
    return;
  end if;
  if v_release_state = 'taken_down' then
    return query select 'taken_down'::text, null::text;
    return;
  end if;
  if v_party.invite_expires_at <= now() then
    return query select 'expired'::text, null::text;
    return;
  end if;

  update public.api_parties p
    set state = case p_response when 'accept' then 'accepted' else 'declined' end,
        invite_used_at = now(),
        responder_user_id = p_user_id,
        responded_at = now()
    where p.id = p_party_id;

  return query select 'ok'::text, case p_response when 'accept' then 'accepted' else 'declined' end;
end
$$;
