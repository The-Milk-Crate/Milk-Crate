-- 0012: caps on sending invitations, and the wrong-code lock only slows down wrong codes
-- (session J1, findings M1 and L1 of docs/security/review-phase0.md; decided by K Marcus,
-- 21 November 2026).
--
-- api_issue_invite keeps its arguments and result, and adds three caps (counters from 0009)
-- on top of the per-party daily limit:
--   - invites_release: at most 20 parties invited per release, all time. A party counts once,
--     at its first invitation; a resend or a new code after a change does not count again,
--     and a party that was removed still counts;
--   - invites_artist_day: at most 50 invitations per artist (the release owner) per UTC day;
--   - invites_address_day: at most 3 invitations per recipient address per UTC day. The
--     address is compared lowercased and trimmed, and only its SHA-256 is stored.
-- Over a cap, nothing is counted or changed and the status names the cap: release_limited,
-- artist_limited or address_limited. The caller emails the code only when status is issued.
-- The release row is locked first, as everywhere else, so the per-release count holds.
--
-- api_get_invitation and api_respond_to_invite now check the code before the lock: a right,
-- unexpired, unused code works even after 10 wrong codes in an hour. A wrong code is still
-- counted, and once a party has 10 in an hour wrong codes are refused with rate_limited
-- (and, as before, not counted while locked).
--
-- Existing rows: none change. Sends before this migration are not in the new counters.

create or replace function public.api_issue_invite(p_party_id uuid, p_code_hash text, p_daily_limit integer)
returns table (status text, sends_today integer, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release_id uuid;
  v_owner uuid;
  v_party_state text;
  v_email text;
  v_release_state text;
  v_day date := (now() at time zone 'UTC')::date;
  v_sends integer;
  v_first boolean;
  v_cap text;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'MC422', message = 'bad_hash: the code hash must be 64 lowercase hex characters';
  end if;
  if p_daily_limit is null or p_daily_limit < 1 then
    raise exception using errcode = 'MC422', message = 'bad_limit: the daily limit must be 1 or more';
  end if;

  select p.release_id into v_release_id from public.api_parties p where p.id = p_party_id;
  if not found then
    return query select 'not_found'::text, 0, null::timestamptz;
    return;
  end if;
  select r.state, r.owner_id into v_release_state, v_owner
    from public.api_releases r where r.id = v_release_id for update;
  select p.state, p.email into v_party_state, v_email
    from public.api_parties p where p.id = p_party_id for update;
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

  -- The caps. All three or none are counted: a refusal rolls this block back.
  v_first := not exists (select 1 from public.api_invite_sends s where s.party_id = p_party_id);
  begin
    if v_first and not (select h.allowed from public.api_rate_hit('invites_release', v_release_id::text, 1, null) h) then
      raise exception using errcode = 'MC429', message = 'release_limited';
    end if;
    if not (select h.allowed from public.api_rate_hit('invites_artist_day', v_owner::text, 1, null) h) then
      raise exception using errcode = 'MC429', message = 'artist_limited';
    end if;
    if v_email is not null and not (select h.allowed from public.api_rate_hit('invites_address_day',
         encode(sha256(convert_to(lower(btrim(v_email)), 'UTF8')), 'hex'), 1, null) h) then
      raise exception using errcode = 'MC429', message = 'address_limited';
    end if;
  exception
    when sqlstate 'MC429' then
      get stacked diagnostics v_cap = message_text;
      return query select v_cap, v_sends, null::timestamptz;
      return;
  end;

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

-- The invitation read for getInvitation. The invitee has no access to the tables; this is
-- their only way in. It checks the code's hash and expiry without using up the code, and
-- returns only the release basics and this one party's own share: never other parties,
-- emails or owner_id. A wrong code is counted, so commit even when status is wrong_code.
-- status: ok, not_found, rate_limited (a wrong code after 10 wrong codes in the last hour),
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

  -- The code first: only wrong codes meet the lock.
  if v_party.invite_code_hash is null or p_code_hash is null or v_party.invite_code_hash <> p_code_hash then
    if public.api_invite_locked(p_party_id) then
      return query select 'rate_limited'::text, null::text, null::text, null::date, null::jsonb,
                          null::text, null::text, null::numeric, null::text;
      return;
    end if;
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

  -- The code first: only wrong codes meet the lock.
  if v_party.invite_code_hash is null or p_code_hash is null or v_party.invite_code_hash <> p_code_hash then
    if public.api_invite_locked(p_party_id) then
      return query select 'rate_limited'::text, null::text;
      return;
    end if;
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
