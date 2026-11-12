-- 0005 (Supabase only): the invitee path for clients that call the database directly.
--
-- An invitee has no rights to the release rows, and the tables stay closed to them. B's
-- api_get_invitation and api_respond_to_invite are SECURITY DEFINER, and the reply links
-- whatever user id it is given, so clients never get them. Clients get these two wrappers
-- instead. They take the invite code (not a user id), hash it the way the server does
-- (SHA-256 of the UTF-8 code, lowercase hex), use auth.uid() as the replying account, and
-- refuse staff accounts (administrator, internal, internal_accounting), as the contract does.
-- B does the rest: expiry, single use, counting wrong codes and the lock after 10 an hour.
-- The status comes back as B gives it (ok, not_found, rate_limited, wrong_code, replied,
-- taken_down, expired); the Invitation fields are set only for ok.

create or replace function public.api_invite_code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
$$;

-- Refuses callers who may not use the invitee path, before anything is counted.
create or replace function public.api_invitee_check(p_code text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = 'MC403', message = 'not_signed_in: sign in to reply to an invitation';
  end if;
  if public.api_caller_type() not in ('end_user', 'artist', 'third_party') then
    raise exception using errcode = 'MC403', message = 'not_allowed: staff accounts cannot use split invitations';
  end if;
  if p_code is null or length(p_code) not between 16 and 256 then
    raise exception using errcode = 'MC422', message = 'bad_code: the invite code must be 16 to 256 characters';
  end if;
end
$$;

-- getInvitation for the signed-in invitee. Does not use up the code.
create or replace function public.api_client_get_invitation(
  p_release_id uuid, p_party_id uuid, p_invite_code text)
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
begin
  perform public.api_invitee_check(p_invite_code);
  return query
    select * from public.api_get_invitation(p_release_id, p_party_id,
                                            public.api_invite_code_hash(p_invite_code));
end
$$;

-- respondToSplit for the signed-in invitee: links auth.uid(), never another account.
create or replace function public.api_client_respond_to_invite(
  p_release_id uuid, p_party_id uuid, p_invite_code text, p_response text)
returns table (status text, party_state text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.api_invitee_check(p_invite_code);
  return query
    select * from public.api_respond_to_invite(p_release_id, p_party_id,
                                               public.api_invite_code_hash(p_invite_code),
                                               auth.uid(), p_response);
end
$$;
