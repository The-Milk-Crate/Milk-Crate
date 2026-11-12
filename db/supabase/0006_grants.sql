-- 0006 (Supabase only): what clients may reach. Runs last.
--
-- First the lock-down again (0001), so every api_ table, view, sequence and function made by
-- db/migrations or the files before this one starts with no client grants and row level
-- security on. Then only this list is granted back.
--
-- Settled by K Marcus: clients read the new slice only through the API (session G's
-- handlers). No direct reads: no table, view or read-rule helper is granted to anon or
-- authenticated. The policies and views in 0004 stay as a backstop, so a grant added by mistake
-- (for example Supabase's default grants on a new table) still shows each account only what
-- the contract allows. The test grants them for a moment to prove that.

do $$ begin perform public.api_supabase_lock_down(); end $$;

-- The invitee path: only the wrappers, never B's functions. Signed-in accounts only.
grant execute on function
  public.api_client_get_invitation(uuid, uuid, text),
  public.api_client_respond_to_invite(uuid, uuid, text, text)
  to authenticated;

-- The access token hook: only Supabase Auth calls it.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.api_access_token_hook(jsonb), public.api_account_claim(uuid)
  to supabase_auth_admin;

notify pgrst, 'reload schema';
