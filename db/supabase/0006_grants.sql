-- 0006 (Supabase only): what clients may reach. Runs last.
--
-- First the lock-down again (0001), so every api_ table, view, sequence and function made by
-- db/migrations or the files before this one starts with no client grants and row level
-- security on. Then only this list is granted back. anon gets nothing: every operation needs a
-- signed-in account. Clients get SELECT only, and only these columns.

do $$ begin perform public.api_supabase_lock_down(); end $$;

-- Owner and staff view (0004's policies pick the rows).
grant select on public.api_releases to authenticated;
grant select (id, release_id, position, title, master_confirmed_at, created_at, updated_at)
  on public.api_tracks to authenticated;
grant select (id, release_id, side, role, name, email, percent, is_owner, state, created_at, updated_at)
  on public.api_parties to authenticated;
grant select (release_id, confirmed_at) on public.api_covers to authenticated;
grant select (id, release_id, track_id, kind, method, object_key, format, size_bytes, state,
              expires_at, created_at, confirmed_at, updated_at)
  on public.api_uploads to authenticated;

-- Public view: every signed-in account.
grant select on public.api_public_releases, public.api_public_tracks to authenticated;

-- Read rule helpers. Policies call the first two as the caller. Each answers only about the
-- caller.
grant execute on function
  public.api_caller_type(),
  public.api_release_visible(uuid),
  public.api_can_play_track(uuid),
  public.api_can_read_cover(uuid)
  to authenticated;

-- The invitee path: only the wrappers, never B's functions.
grant execute on function
  public.api_client_get_invitation(uuid, uuid, text),
  public.api_client_respond_to_invite(uuid, uuid, text, text)
  to authenticated;

-- The access token hook: only Supabase Auth calls it.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.api_access_token_hook(jsonb), public.api_account_claim(uuid)
  to supabase_auth_admin;

notify pgrst, 'reload schema';
