-- 0002 (Supabase only): the account_type claim.
--
-- One claim, account_type, with the values in the contract's AccountType. The source is
-- session B's api_accounts: one row per account; no row means end_user. A suspended account
-- gets end_user (settled by K Marcus). AWS uses Cognito groups with the same names and
-- the same rule; see db/account-claim.json.
--
-- The claim is read when Supabase Auth issues a token. A role change shows only after the
-- token refreshes. The read rules (0004_read_rules.sql) also check the claim against
-- api_accounts, so a role that is removed or suspended stops at once for direct reads, while a
-- new role waits for the refresh.

-- The claim an account gets now. Used by the hook and by the read rules.
create or replace function public.api_account_claim(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.account_type from public.api_accounts a
     where a.user_id = p_user_id and not a.suspended),
    'end_user')
$$;

-- Supabase custom access token hook. Supabase Auth calls it (as supabase_auth_admin) each time
-- it issues or refreshes a token, and puts account_type at the top level of the claims.
-- Wiring it into a project (Authentication > Hooks, or [auth.hook.custom_access_token] in
-- config.toml with uri "pg-functions://postgres/public/api_access_token_hook") is session E's.
-- It replaces any account_type already in the claims; it never reads user_metadata, which the
-- user can change.
create or replace function public.api_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_user uuid;
begin
  begin
    v_user := (event ->> 'user_id')::uuid;
  exception when invalid_text_representation then
    v_user := null;
  end;
  v_claims := jsonb_set(v_claims, '{account_type}',
                        to_jsonb(case when v_user is null then 'end_user'
                                      else public.api_account_claim(v_user) end));
  return jsonb_set(event, '{claims}', v_claims);
end
$$;
-- Grants are in 0006_grants.sql: the hook only to supabase_auth_admin.
