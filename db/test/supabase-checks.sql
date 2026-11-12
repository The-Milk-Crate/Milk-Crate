-- Supabase checks (session C). Run by db/test/run.sh on a throwaway cluster, after the test-only
-- stand-in (supabase-standin.sql), the app's SQL (milk-crate/supabase/), db/migrations and
-- db/supabase. psql passes the fixture as :'fixture' and the claim definition as :'claimdef'.
-- Each check prints "ok - ..."; a failure raises and stops the run.
--
-- Signing in works like Supabase: Supabase Auth calls the access token hook (here as
-- supabase_auth_admin) and the claims it returns become the token. A read runs as the role
-- authenticated with request.jwt.claims set to that token, the way PostgREST runs it. The
-- token is kept until the test "refreshes" it, so a role change shows only after a refresh.

set client_min_messages = warning;
drop schema if exists ct cascade;
set client_min_messages = notice;
create schema ct;

create table ct.fixture (name text primary key, doc jsonb not null);
insert into ct.fixture values ('access', :'fixture'::jsonb), ('claim', :'claimdef'::jsonb);

-- Helpers ----------------------------------------------------------------------------

create function ct.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL - %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end
$$;

create function ct.eq(p_got text, p_want text, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL - %: got %, wanted %', p_label, coalesce(p_got, 'null'), coalesce(p_want, 'null');
  end if;
  raise notice 'ok - %', p_label;
end
$$;

-- Runs p_sql as the server (the owner) and expects SQLSTATE p_sqlstate. Changes are rolled back.
create function ct.fails(p_sql text, p_sqlstate text, p_label text) returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = p_sqlstate then
      raise notice 'ok - % (%)', p_label, v_msg;
      return;
    end if;
    raise exception 'FAIL - %: wanted error %, got % (%)', p_label, p_sqlstate, v_state, v_msg;
  end;
  raise exception 'FAIL - %: wanted error %, got none', p_label, p_sqlstate;
end
$$;

create table ct.users (name text primary key, id uuid not null unique);
create table ct.tokens (name text primary key, claims jsonb not null);

create function ct.uid(p_name text) returns uuid language sql stable as $$
  select id from ct.users where name = p_name
$$;

-- A Supabase Auth login.
create function ct.new_user(p_name text) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into auth.users (email) values (p_name || '@example.test') returning id into v_id;
  insert into ct.users values (p_name, v_id);
  return v_id;
end
$$;

-- Supabase Auth issuing (or refreshing) a token: it calls the hook as supabase_auth_admin.
create function ct.issue_token(p_name text) returns jsonb language plpgsql as $$
declare
  v_id uuid := ct.uid(p_name);
  v_claims jsonb;
begin
  perform set_config('role', 'supabase_auth_admin', true);
  v_claims := public.api_access_token_hook(jsonb_build_object(
    'user_id', v_id,
    'authentication_method', 'password',
    'claims', jsonb_build_object('sub', v_id, 'role', 'authenticated', 'aud', 'authenticated',
                                 'email', p_name || '@example.test'))) -> 'claims';
  perform set_config('role', 'none', true);
  insert into ct.tokens values (p_name, v_claims) on conflict (name) do update set claims = excluded.claims;
  return v_claims;
end
$$;

create function ct.claim(p_name text) returns text language sql stable as $$
  select claims ->> 'account_type' from ct.tokens where name = p_name
$$;

-- Runs p_sql as the account p_name with its current token (role authenticated), or as anon when
-- p_name is null. Returns the rows as a JSON array, or {"error": "<SQLSTATE>"}.
create function ct.read_as(p_name text, p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
  v_state text;
begin
  if p_name is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', (select claims::text from ct.tokens where name = p_name), true);
    perform set_config('role', 'authenticated', true);
  end if;
  begin
    execute format('select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (%s) q', p_sql) into v;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    v := jsonb_build_object('error', v_state);
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end
$$;

-- Runs one statement (such as an update) as the account p_name, or as anon when p_name is
-- null. Returns {"rows": n} or {"error": "<SQLSTATE>"}.
create function ct.run_as(p_name text, p_sql text) returns jsonb language plpgsql as $$
declare
  v_rows bigint;
  v jsonb;
  v_state text;
begin
  perform set_config('request.jwt.claims', coalesce((select claims::text from ct.tokens where name = p_name), ''), true);
  perform set_config('role', case when p_name is null then 'anon' else 'authenticated' end, true);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v := jsonb_build_object('rows', v_rows);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    v := jsonb_build_object('error', v_state);
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end
$$;

-- The ids in a read_as result.
create function ct.ids(p_rows jsonb, p_key text default 'id') returns uuid[] language sql immutable as $$
  select coalesce(array_agg((e ->> p_key)::uuid), '{}') from jsonb_array_elements(
    case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end) e
$$;

-- An app reviewer (the given admin) approving or declining an artist profile, through the app's
-- own policies, as the app does it.
create function ct.review_artist(p_admin text, p_artist text, p_status text) returns jsonb language sql as $$
  select ct.run_as(p_admin, format('update public.artists set status = %L where owner_id = %L',
                                    p_status, ct.uid(p_artist)))
$$;

-- The expected outcome from the fixture.
create function ct.expect(p_op text, p_type text, p_rel text, p_state text) returns text language sql stable as $$
  select o.key
  from ct.fixture f,
       jsonb_each(f.doc -> 'operations' -> p_op -> 'byAccountType' -> p_type -> p_rel) o
  where f.name = 'access' and o.value ? p_state
$$;

create function ct.hash(p_code text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
$$;

-- 1. The fixture and the claim definition --------------------------------------------

do $$
declare
  v_doc jsonb := (select doc from ct.fixture where name = 'access');
  v_claim jsonb := (select doc from ct.fixture where name = 'claim');
  v_types jsonb := v_doc -> 'accountTypes';
  v_bad integer;
begin
  perform ct.ok(v_types = v_claim -> 'values', 'the fixture and db/account-claim.json list the same account types');
  perform ct.ok((select array_agg(x order by x) from jsonb_array_elements_text(v_claim -> 'precedence') x)
                = (select array_agg(x order by x) from jsonb_array_elements_text(v_types) x),
                'the precedence list has every account type once');
  perform ct.ok((select array_agg(g ->> 'name' order by (g ->> 'precedence')::int)
                 from jsonb_array_elements(v_claim -> 'cognitoGroups') g)
                = (select array_agg(x) from jsonb_array_elements_text(v_claim -> 'precedence') x where x <> 'end_user'),
                'Cognito groups are every account type but end_user, in precedence order');
  perform ct.eq(v_claim ->> 'suspended', 'end_user', 'a suspended account gets end_user');
  -- Every cell lists every state exactly once.
  select count(*) into v_bad
  from jsonb_each(v_doc -> 'operations') op,
       jsonb_each(op.value -> 'byAccountType') t,
       jsonb_each(t.value) rel
  where (select array_agg(s order by s) from jsonb_each(rel.value) o, jsonb_array_elements_text(o.value) s)
        is distinct from (select array_agg(s order by s) from jsonb_array_elements_text(v_doc -> 'states') s);
  perform ct.eq(v_bad::text, '0', 'every fixture cell lists every release state exactly once');
  select count(*) into v_bad
  from jsonb_each(v_doc -> 'operations') op
  where (select array_agg(k order by k) from jsonb_object_keys(op.value -> 'byAccountType') k)
        is distinct from (select array_agg(s order by s) from jsonb_array_elements_text(v_types) s);
  perform ct.eq(v_bad::text, '0', 'every fixture operation covers every account type');
end
$$;

-- 2. Supabase's default access is closed ---------------------------------------------

do $$
declare
  r record;
  v_bad text[] := '{}';
  v_allowed_fn text[] := array[
    'api_client_get_invitation(uuid,uuid,text)', 'api_client_respond_to_invite(uuid,uuid,text,text)'];
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'api\_%' and c.relkind in ('r', 'p') and not c.relrowsecurity loop
    v_bad := v_bad || r.relname::text;
  end loop;
  perform ct.eq(array_to_string(v_bad, ', '), '', 'row level security is on for every api_ table');

  v_bad := '{}';
  for r in select c.oid, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'api\_%' and c.relkind in ('r', 'p', 'v', 'm', 'S') loop
    if r.relkind = 'S' then
      if has_sequence_privilege('anon', r.oid, 'usage,select,update')
         or has_sequence_privilege('authenticated', r.oid, 'usage,select,update') then
        v_bad := v_bad || r.relname::text;
      end if;
    else
      if has_table_privilege('anon', r.oid, 'select,insert,update,delete,truncate,references,trigger')
         or has_any_column_privilege('anon', r.oid, 'select,insert,update,references') then
        v_bad := v_bad || ('anon:' || r.relname);
      end if;
      if has_table_privilege('authenticated', r.oid, 'insert,update,delete,truncate,references,trigger')
         or has_any_column_privilege('authenticated', r.oid, 'insert,update,references') then
        v_bad := v_bad || ('authenticated writes:' || r.relname);
      end if;
      if has_any_column_privilege('authenticated', r.oid, 'select') then
        v_bad := v_bad || ('authenticated select:' || r.relname);
      end if;
    end if;
  end loop;
  perform ct.eq(array_to_string(v_bad, ', '), '',
    'anon and authenticated reach no api_ table, view or sequence (no direct reads)');

  v_bad := '{}';
  for r in select p.oid, replace(p.oid::regprocedure::text, 'public.', '') as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'api\_%' loop
    if has_function_privilege('anon', r.oid, 'execute') then
      v_bad := v_bad || ('anon:' || r.sig);
    end if;
    if has_function_privilege('authenticated', r.oid, 'execute') <> (r.sig = any (v_allowed_fn)) then
      v_bad := v_bad || ('authenticated:' || r.sig);
    end if;
  end loop;
  perform ct.eq(array_to_string(v_bad, ', '), '',
    'anon runs no api_ function; authenticated runs only the two invitee wrappers');

  perform ct.ok(has_function_privilege('supabase_auth_admin', 'public.api_access_token_hook(jsonb)', 'execute'),
                'supabase_auth_admin can run the access token hook');
  perform ct.ok(not has_function_privilege('authenticated', 'public.api_access_token_hook(jsonb)', 'execute')
                and not has_function_privilege('anon', 'public.api_access_token_hook(jsonb)', 'execute'),
                'clients cannot run the access token hook');
  perform ct.ok(not has_function_privilege('authenticated', 'public.api_account_claim(uuid)', 'execute'),
                'clients cannot look up another account''s claim');
end
$$;

-- 3. Accounts and the claim for each source ------------------------------------------

do $$
declare
  v_row public.api_accounts%rowtype;
begin
  perform ct.new_user('admin1');
  perform ct.new_user('admin2');
  perform ct.new_user('internal1');
  perform ct.new_user('acct1');
  perform ct.new_user('tp1');
  perform ct.new_user('artistA');
  perform ct.new_user('artistB');
  perform ct.new_user('artistC');
  perform ct.new_user('pending1');
  perform ct.new_user('declined1');
  perform ct.new_user('listener1');
  perform ct.new_user('invitee1');

  -- The app's reviewer table: the sync adds administrator rows.
  insert into public.admins (user_id) values (ct.uid('admin1')), (ct.uid('admin2'));
  -- Written straight into api_accounts.
  insert into public.api_accounts (user_id, account_type, email) values
    (ct.uid('internal1'), 'internal', 'internal1@example.test'),
    (ct.uid('acct1'), 'internal_accounting', 'acct1@example.test'),
    (ct.uid('tp1'), 'third_party', 'tp1@example.test');
  -- Artist profiles start pending (the app's guard_artist_status).
  insert into public.artists (owner_id, name) values
    (ct.uid('artistA'), 'Artist A'), (ct.uid('artistB'), 'Artist B'), (ct.uid('artistC'), 'Artist C'),
    (ct.uid('pending1'), 'Pending One'), (ct.uid('declined1'), 'Declined One');
  perform ct.ok(not exists (select 1 from public.api_accounts a
                            where a.user_id in (ct.uid('artistA'), ct.uid('pending1'))),
                'a pending applicant has no api_accounts row');
end
$$;

-- The reviewer approves and declines through the app (as authenticated, with a token).
do $$ begin perform ct.issue_token('admin1'); end $$;
do $$
begin
  perform ct.ok(ct.review_artist('admin1', 'artistA', 'approved') = '{"rows": 1}', 'a reviewer approves Artist A through the app');
  perform ct.review_artist('admin1', 'artistB', 'approved');
  perform ct.review_artist('admin1', 'artistC', 'approved');
  perform ct.ok(ct.review_artist('admin1', 'declined1', 'declined') = '{"rows": 1}', 'a reviewer declines an applicant through the app');
  perform ct.ok((select status from public.artists where owner_id = ct.uid('artistA')) = 'approved',
                'the app''s own approval still works (status approved)');
end
$$;

do $$
declare
  v_row public.api_accounts%rowtype;
  v_name text;
  v_want text;
  v_id uuid;
  v_forged jsonb;
  v_garbled jsonb;
begin
  select * into v_row from public.api_accounts where user_id = ct.uid('artistA');
  perform ct.ok(v_row.account_type = 'artist'
                and v_row.artist_id = (select id from public.artists where owner_id = ct.uid('artistA'))
                and v_row.artist_name = 'Artist A' and v_row.email = 'artistA@example.test' and not v_row.suspended,
                'an approved artist gets an artist row with the profile id, name and email');
  select * into v_row from public.api_accounts where user_id = ct.uid('admin1');
  perform ct.ok(v_row.account_type = 'administrator' and v_row.email = 'admin1@example.test',
                'an admins row gives an administrator row with the email');
  perform ct.ok(not exists (select 1 from public.api_accounts
                            where user_id in (ct.uid('pending1'), ct.uid('declined1'), ct.uid('listener1'))),
                'pending and declined applicants and listeners have no row');

  for v_name, v_want in values
    ('admin1', 'administrator'), ('internal1', 'internal'), ('acct1', 'internal_accounting'),
    ('tp1', 'third_party'), ('artistA', 'artist'), ('pending1', 'end_user'), ('declined1', 'end_user'),
    ('listener1', 'end_user')
  loop
    perform ct.issue_token(v_name);
    perform ct.eq(ct.claim(v_name), v_want, format('claim for %s is %s', v_name, v_want));
  end loop;
  for v_name in select name from ct.users where name not in ('admin1','internal1','acct1','tp1','artistA','pending1','declined1','listener1') loop
    perform ct.issue_token(v_name);
  end loop;

  -- The hook keeps Supabase's own claims and overwrites a forged account_type.
  v_id := ct.uid('listener1');
  perform set_config('role', 'supabase_auth_admin', true);
  v_forged := public.api_access_token_hook(jsonb_build_object('user_id', v_id,
                'claims', jsonb_build_object('sub', v_id, 'role', 'authenticated', 'account_type', 'administrator')));
  v_garbled := public.api_access_token_hook('{"user_id": "not-a-uuid", "claims": {}}'::jsonb);
  perform set_config('role', 'none', true);
  perform ct.ok(v_forged -> 'claims' = jsonb_build_object('sub', v_id, 'role', 'authenticated', 'account_type', 'end_user'),
                'the hook keeps the other claims and replaces a forged account_type');
  perform ct.eq(v_garbled #>> '{claims,account_type}', 'end_user', 'the hook gives end_user when the user id is not readable');

  -- The email follows auth.users.
  update auth.users set email = 'artist.a@example.test' where id = ct.uid('artistA');
  perform ct.eq((select email from public.api_accounts where user_id = ct.uid('artistA')),
                'artist.a@example.test', 'an email change in auth.users reaches api_accounts');
  update auth.users set email = 'artistA@example.test' where id = ct.uid('artistA');

  -- A renamed profile renames the row.
  update public.artists set name = 'Artist A!' where owner_id = ct.uid('artistA');
  perform ct.eq((select artist_name from public.api_accounts where user_id = ct.uid('artistA')),
                'Artist A!', 'renaming an approved profile renames the artist row');
  update public.artists set name = 'Artist A' where owner_id = ct.uid('artistA');
end
$$;

-- 4. One role per account ------------------------------------------------------------

do $$
begin
  perform ct.fails(format('insert into public.admins (user_id) values (%L)', ct.uid('artistA')),
                   'MC403', 'an admins row for an approved artist is refused');
  perform ct.fails(format('insert into public.admins (user_id) values (%L)', ct.uid('tp1')),
                   'MC403', 'an admins row for a third_party account is refused');
  perform ct.fails(format('insert into public.admins (user_id) values (%L)', ct.uid('internal1')),
                   'MC403', 'an admins row for an internal account is refused');
  -- Staff with an artist profile: the approval is refused.
  insert into public.artists (owner_id, name) values
    (ct.uid('internal1'), 'Internal Band'), (ct.uid('admin2'), 'Admin Band'), (ct.uid('tp1'), 'Third Band');
end
$$;
do $$ begin perform ct.issue_token('admin1'); end $$;
do $$
begin
  perform ct.ok(ct.run_as('admin1', format('update public.artists set status = ''approved'' where owner_id = %L',
                ct.uid('internal1'))) ->> 'error' = 'MC403', 'approving an artist profile for an internal account is refused');
  perform ct.ok(ct.run_as('admin1', format('update public.artists set status = ''approved'' where owner_id = %L',
                ct.uid('tp1'))) ->> 'error' = 'MC403', 'approving an artist profile for a third_party account is refused');
  perform ct.ok(ct.run_as('admin1', format('update public.artists set status = ''approved'' where owner_id = %L',
                ct.uid('admin2'))) ->> 'error' = 'MC403', 'approving an artist profile for an administrator is refused');
  perform ct.ok((select status from public.artists where owner_id = ct.uid('internal1')) = 'pending'
                and (select account_type from public.api_accounts where user_id = ct.uid('internal1')) = 'internal',
                'the refused approval left the profile pending and the row unchanged');
  delete from public.artists where owner_id in (ct.uid('internal1'), ct.uid('admin2'), ct.uid('tp1'));
end
$$;

-- Both roles anyway (rows from before the sync, or triggers turned off): the higher type wins.
do $$
declare
  v_type text;
  v_done text;
begin
  perform ct.new_user('both1');
  perform ct.new_user('both2');
  perform ct.new_user('both3');
  perform ct.new_user('both4');
  -- Make the app's tables hold both, with the sync's triggers off (replica skips triggers).
  perform set_config('session_replication_role', 'replica', true);
  insert into public.admins (user_id) values (ct.uid('both1'));
  insert into public.artists (owner_id, name, status) values (ct.uid('both1'), 'Both One', 'approved');
  insert into public.api_accounts (user_id, account_type, email) values (ct.uid('both2'), 'third_party', null);
  insert into public.artists (owner_id, name, status) values (ct.uid('both2'), 'Both Two', 'approved');
  insert into public.artists (owner_id, name, status) values (ct.uid('both3'), 'Both Three', 'approved');
  insert into public.artists (owner_id, name, status) values (ct.uid('both4'), 'Both Four', 'approved');
  perform set_config('session_replication_role', 'origin', true);

  perform public.api_sync_account(ct.uid('both1'));
  perform ct.eq((select account_type from public.api_accounts where user_id = ct.uid('both1')), 'administrator',
                'admins row and approved profile: the sync takes administrator');
  perform public.api_sync_account(ct.uid('both2'));
  perform ct.eq((select account_type from public.api_accounts where user_id = ct.uid('both2')), 'third_party',
                'third_party row and approved profile: the sync keeps third_party');

  -- An artist row with no history, then an admins row: replaced by administrator.
  perform public.api_sync_account(ct.uid('both3'));
  perform set_config('session_replication_role', 'replica', true);
  insert into public.admins (user_id) values (ct.uid('both3'));
  perform set_config('session_replication_role', 'origin', true);
  v_done := public.api_sync_account(ct.uid('both3'));
  perform ct.ok(v_done = 'replaced' and (select account_type from public.api_accounts where user_id = ct.uid('both3')) = 'administrator',
                'an artist row with no history is replaced by administrator');

  -- An artist row with a release, then an admins row: B keeps it an artist, so it is suspended.
  perform public.api_sync_account(ct.uid('both4'));
  insert into public.api_releases (owner_id, title, release_date) values (ct.uid('both4'), 'Both Four LP', date '2026-01-01');
  perform set_config('session_replication_role', 'replica', true);
  insert into public.admins (user_id) values (ct.uid('both4'));
  perform set_config('session_replication_role', 'origin', true);
  set local client_min_messages = error;
  v_done := public.api_sync_account(ct.uid('both4'));
  set local client_min_messages = notice;
  perform ct.ok(v_done = 'suspended' and (select account_type = 'artist' and suspended from public.api_accounts where user_id = ct.uid('both4')),
                'an artist row with history cannot become administrator: it is suspended');

  perform ct.issue_token('both1');
  perform ct.issue_token('both2');
  perform ct.issue_token('both4');
  perform ct.eq(ct.claim('both1'), 'administrator', 'claim for admins row and approved profile is administrator');
  perform ct.eq(ct.claim('both2'), 'third_party', 'claim for third_party row and approved profile is third_party');
  perform ct.eq(ct.claim('both4'), 'end_user', 'claim for the suspended artist is end_user');
  -- The artist endpoints refuse them: their claim is not artist, and B refuses them as owners.
  perform ct.fails(format('insert into public.api_releases (owner_id, title, release_date) values (%L, ''X'', ''2026-01-01'')', ct.uid('both1')),
                   'MC403', 'an account with both roles cannot own a release');
  perform ct.fails(format('insert into public.api_releases (owner_id, title, release_date) values (%L, ''X'', ''2026-01-01'')', ct.uid('both4')),
                   'MC403', 'a suspended artist cannot create a release');
end
$$;

-- 5. Removing a role -----------------------------------------------------------------

do $$
declare
  v_rel uuid;
begin
  perform ct.new_user('gone1');
  perform ct.new_user('gone2');
  insert into public.artists (owner_id, name) values (ct.uid('gone1'), 'Gone One'), (ct.uid('gone2'), 'Gone Two');
end
$$;
do $$ begin perform ct.issue_token('admin1'); end $$;
do $$
begin
  perform ct.review_artist('admin1', 'gone1', 'approved');
  perform ct.review_artist('admin1', 'gone2', 'approved');
  insert into public.api_releases (owner_id, title, release_date) values (ct.uid('gone2'), 'Gone Two EP', date '2026-01-01');

  perform ct.review_artist('admin1', 'gone1', 'declined');
  perform ct.ok(not exists (select 1 from public.api_accounts where user_id = ct.uid('gone1')),
                'an artist with no history who is no longer approved loses the row');
  perform ct.review_artist('admin1', 'gone2', 'pending');
  perform ct.ok((select suspended and account_type = 'artist' from public.api_accounts where user_id = ct.uid('gone2')),
                'an artist with a release who is no longer approved is suspended, not deleted');
  perform ct.issue_token('gone2');
  perform ct.eq(ct.claim('gone2'), 'end_user', 'a suspended artist''s claim is end_user');
  perform ct.review_artist('admin1', 'gone2', 'approved');
  perform ct.ok((select not suspended from public.api_accounts where user_id = ct.uid('gone2')),
                'approving the profile again lifts the suspension');
  perform ct.issue_token('gone2');
  perform ct.eq(ct.claim('gone2'), 'artist', 'and the claim is artist again after a refresh');

  delete from public.artists where owner_id = ct.uid('gone2');
  perform ct.ok((select suspended from public.api_accounts where user_id = ct.uid('gone2')),
                'deleting the profile of an artist with history suspends the row');

  -- An administrator with no history loses the row; one with a review decision is suspended.
  perform ct.new_user('admin3');
  insert into public.admins (user_id) values (ct.uid('admin3'));
  delete from public.admins where user_id = ct.uid('admin3');
  perform ct.ok(not exists (select 1 from public.api_accounts where user_id = ct.uid('admin3')),
                'an administrator with no history loses the row when the admins row goes');
  insert into public.admins (user_id) values (ct.uid('admin3'));
  insert into public.api_review_decisions (release_id, reviewer_id, decision)
    select id, ct.uid('admin3'), 'approved' from public.api_releases where owner_id = ct.uid('gone2') limit 1;
  delete from public.admins where user_id = ct.uid('admin3');
  perform ct.ok((select suspended and account_type = 'administrator' from public.api_accounts where user_id = ct.uid('admin3')),
                'an administrator with a review decision is suspended when the admins row goes');
  insert into public.admins (user_id) values (ct.uid('admin3'));
  perform ct.ok((select not suspended from public.api_accounts where user_id = ct.uid('admin3')),
                'a new admins row lifts the suspension');
end
$$;

-- 6. Releases in every state, for Artist A and Artist B ------------------------------
-- Built with triggers off (replica), so each state can be set directly. Every release has a
-- track with a confirmed master and a streaming copy, a confirmed cover, uploads and the
-- owner's parties, except taken_down, which has no streaming copy and no cover (takedown
-- removed them).

create table ct.rel (owner text, state text, release_id uuid, track_id uuid, primary key (owner, state));

do $$
declare
  v_owner text;
  v_state text;
  v_artist uuid;
  v_rel uuid;
  v_track uuid;
  v_up uuid;
  v_cover_up uuid;
  v_n integer := 0;
  v_sha text := repeat('a', 64);
begin
  perform set_config('session_replication_role', 'replica', true);
  for v_owner in values ('artistA'), ('artistB') loop
    select artist_id into v_artist from public.api_accounts where user_id = ct.uid(v_owner);
    foreach v_state in array (select array_agg(s) from jsonb_array_elements_text(
                               (select doc -> 'states' from ct.fixture where name = 'access')) s) loop
      v_n := v_n + 1;
      v_rel := gen_random_uuid();
      v_track := gen_random_uuid();
      v_up := gen_random_uuid();
      v_cover_up := gen_random_uuid();
      insert into public.api_releases (id, owner_id, artist_id, title, release_date, state, failure_reason,
                                       review_decision, review_reason, review_decided_at, created_at)
      values (v_rel, ct.uid(v_owner), v_artist, format('%s %s', v_owner, v_state), date '2026-01-01', v_state,
              case when v_state = 'failed' then 'The master could not be read.' end,
              case when v_state in ('scheduled', 'live') then 'approved'
                   when v_state = 'needs_changes' then 'needs_changes' else 'none' end,
              case when v_state = 'needs_changes' then 'Fix the cover.' end,
              case when v_state in ('scheduled', 'live', 'needs_changes') then now() end,
              now() - make_interval(mins => v_n));
      insert into public.api_uploads (id, release_id, track_id, kind, method, provider_upload_id, object_key,
                                      format, size_bytes, state, sha256, confirmed_at)
      values (v_up, v_rel, v_track, 'master', 'tus', 'tus-' || v_up, public.api_master_key(v_artist, v_rel, v_track),
              'wav', 1000, 'confirmed', v_sha, now()),
             (v_cover_up, v_rel, null, 'cover', 'tus', 'tus-' || v_cover_up, public.api_cover_key(v_artist, v_rel),
              'png', 1000, 'confirmed', v_sha, now());
      insert into public.api_tracks (id, release_id, position, title, master_upload_id, master_key, master_format,
                                     master_size_bytes, master_sha256, master_confirmed_at, stream_key, duration_ms)
      values (v_track, v_rel, 1, 'Song', v_up, public.api_master_key(v_artist, v_rel, v_track), 'wav', 1000, v_sha, now(),
              case when v_state <> 'taken_down' then public.api_stream_prefix(v_artist, v_rel, v_track) || 'stream.m4a' end,
              case when v_state <> 'taken_down' then 200000 end);
      if v_state <> 'taken_down' then
        insert into public.api_covers (release_id, upload_id, object_key, format, size_bytes, width, height)
        values (v_rel, v_cover_up, public.api_cover_key(v_artist, v_rel), 'png', 1000, 1000, 1000);
      end if;
      insert into public.api_parties (release_id, side, role, name, percent, is_owner, state, responder_user_id, responded_at,
                                      invite_code_hash, invite_sent_at, invite_expires_at)
      values (v_rel, 'recording', 'artist', v_owner, 100, true, 'accepted', ct.uid(v_owner), now(), null, null, null),
             (v_rel, 'composition', 'songwriter', 'Writer', 100, false, 'invited', null, null,
              repeat('b', 64), now(), now() + interval '14 days');
      insert into ct.rel values (v_owner, v_state, v_rel, v_track);
    end loop;
  end loop;
  perform set_config('session_replication_role', 'origin', true);
  perform ct.eq((select count(*)::text from ct.rel), '20', 'built 20 releases: two artists, every state');
end
$$;

-- 7. No direct reads, and the policies as a backstop ---------------------------------
-- Clients read the new slice only through the API. With the real grants every account is
-- refused every table, view and read-rule helper.

do $$
declare
  v_name text;
  v_sql text;
  v_bad text[] := '{}';
  v_rel uuid := (select release_id from ct.rel where owner = 'artistA' and state = 'live');
  v_track uuid := (select track_id from ct.rel where owner = 'artistA' and state = 'live');
begin
  for v_name in values ('listener1'), ('artistA'), ('tp1'), ('admin1'), ('internal1'), ('acct1') loop
    perform ct.issue_token(v_name);
    foreach v_sql in array array[
      'select id from public.api_releases', 'select release_id from public.api_tracks',
      'select release_id from public.api_parties', 'select release_id from public.api_covers',
      'select release_id from public.api_uploads', 'select id from public.api_public_releases',
      'select id from public.api_public_tracks', 'select public.api_caller_type() as t',
      format('select public.api_can_play_track(%L) as ok', v_track),
      format('select public.api_can_read_cover(%L) as ok', v_rel)] loop
      if ct.read_as(v_name, v_sql) ->> 'error' is distinct from '42501' then
        v_bad := v_bad || format('%s: %s', v_name, v_sql);
      end if;
    end loop;
  end loop;
  perform ct.eq(array_to_string(v_bad, '; '), '',
    'no direct reads: every account type is refused the release tables, the public views and the helpers, even for a live release');
end
$$;

-- The backstop. Inside one transaction that is rolled back, grant what a mistaken grant might
-- open (SELECT on the release tables without keys, hashes or invite fields, the public views
-- and the helpers), then check each account type still reads only what the fixture allows.
begin;
grant select on public.api_releases to authenticated;
grant select (id, release_id, position, title, master_confirmed_at, created_at, updated_at)
  on public.api_tracks to authenticated;
grant select (id, release_id, side, role, name, email, percent, is_owner, state, created_at, updated_at)
  on public.api_parties to authenticated;
grant select (release_id, confirmed_at) on public.api_covers to authenticated;
grant select (id, release_id, track_id, kind, method, object_key, format, size_bytes, state,
              expires_at, created_at, confirmed_at, updated_at)
  on public.api_uploads to authenticated;
grant select on public.api_public_releases, public.api_public_tracks to authenticated;
grant execute on function public.api_caller_type(), public.api_release_visible(uuid),
  public.api_can_play_track(uuid), public.api_can_read_cover(uuid) to authenticated;

create function ct.check_reads(p_type text, p_user text) returns void language plpgsql as $$
declare
  r record;
  v_rel text;
  v_releases uuid[];
  v_tracks uuid[];
  v_parties uuid[];
  v_covers uuid[];
  v_uploads uuid[];
  v_public uuid[];
  v_public_tracks uuid[];
  v_listed uuid[];
  v_play boolean;
  v_cover boolean;
  v_bad text[] := '{}';
  v_exp text;
begin
  perform ct.issue_token(p_user);
  v_releases := ct.ids(ct.read_as(p_user, 'select id from public.api_releases'));
  v_tracks := ct.ids(ct.read_as(p_user, 'select release_id from public.api_tracks'), 'release_id');
  v_parties := ct.ids(ct.read_as(p_user, 'select distinct release_id from public.api_parties'), 'release_id');
  v_covers := ct.ids(ct.read_as(p_user, 'select release_id from public.api_covers'), 'release_id');
  v_uploads := ct.ids(ct.read_as(p_user, 'select distinct release_id from public.api_uploads'), 'release_id');
  v_public := ct.ids(ct.read_as(p_user, 'select id from public.api_public_releases'));
  v_public_tracks := ct.ids(ct.read_as(p_user, 'select release_id from public.api_public_tracks'), 'release_id');
  -- listReleases as the server calls it, passing the caller.
  select coalesce(array_agg(l.id), '{}') into v_listed
    from public.api_list_releases(ct.uid(p_user), null, 101, null, null) l;

  for r in select * from ct.rel order by owner, state loop
    v_rel := case when p_type = 'artist' and r.owner = p_user then 'own' else 'other' end;
    if p_type = 'artist' and v_rel = 'other' and r.owner = 'artistA' then
      continue;
    end if;
    v_exp := ct.expect('getRelease', p_type, v_rel, r.state);
    if (v_exp = '200') <> (r.release_id = any (v_releases)) then v_bad := v_bad || format('getRelease %s/%s', v_rel, r.state); end if;
    if (v_exp = '200') <> (r.release_id = any (v_tracks)) then v_bad := v_bad || format('tracks %s/%s', v_rel, r.state); end if;
    if (v_exp = '200') <> (r.release_id = any (v_parties)) then v_bad := v_bad || format('rights %s/%s', v_rel, r.state); end if;
    if (v_exp = '200' and r.state <> 'taken_down') <> (r.release_id = any (v_covers)) then v_bad := v_bad || format('cover flag %s/%s', v_rel, r.state); end if;

    v_exp := ct.expect('listReleases', p_type, v_rel, r.state);
    if (v_exp = 'listed') <> (r.release_id = any (v_listed)) then v_bad := v_bad || format('listReleases %s/%s', v_rel, r.state); end if;

    v_exp := ct.expect('getPublicRelease', p_type, v_rel, r.state);
    if (v_exp = '200') <> (r.release_id = any (v_public)) then v_bad := v_bad || format('getPublicRelease %s/%s', v_rel, r.state); end if;
    if (v_exp = '200') <> (r.release_id = any (v_public_tracks)) then v_bad := v_bad || format('public tracks %s/%s', v_rel, r.state); end if;

    v_exp := ct.expect('getUpload', p_type, v_rel, r.state);
    if (v_exp = '200') <> (r.release_id = any (v_uploads)) then v_bad := v_bad || format('getUpload %s/%s', v_rel, r.state); end if;

    v_play := (ct.read_as(p_user, format('select public.api_can_play_track(%L) as ok', r.track_id)) -> 0 ->> 'ok')::boolean;
    if (ct.expect('getPlayback', p_type, v_rel, r.state) = '200') <> v_play then v_bad := v_bad || format('getPlayback %s/%s', v_rel, r.state); end if;
    v_cover := (ct.read_as(p_user, format('select public.api_can_read_cover(%L) as ok', r.release_id)) -> 0 ->> 'ok')::boolean;
    if (ct.expect('getCover', p_type, v_rel, r.state) = '200') <> v_cover then v_bad := v_bad || format('getCover %s/%s', v_rel, r.state); end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'FAIL - % (%) reads differ from the fixture: %', p_type, p_user, array_to_string(v_bad, ', ');
  end if;
  raise notice 'ok - backstop: % reads match the fixture: releases, tracks, rights, cover flag, list, public view, uploads, playback, cover', p_type;
end
$$;

do $$
begin
  perform ct.check_reads('end_user', 'listener1');
  perform ct.check_reads('artist', 'artistA');
  perform ct.check_reads('artist', 'artistB');
  perform ct.check_reads('third_party', 'tp1');
  perform ct.check_reads('administrator', 'admin1');
  perform ct.check_reads('internal', 'internal1');
  perform ct.check_reads('internal_accounting', 'acct1');
  -- Pending and declined applicants and suspended accounts read as end_user.
  perform ct.check_reads('end_user', 'pending1');
  perform ct.check_reads('end_user', 'declined1');
end
$$;

-- A suspended artist reads as end_user, own releases included.
do $$
declare
  v_rel uuid;
  v_track uuid;
begin
  select release_id, track_id into v_rel, v_track from ct.rel where owner = 'artistB' and state = 'draft';
  update public.api_accounts set suspended = true where user_id = ct.uid('artistB');
  perform ct.issue_token('artistB');
  perform ct.eq(ct.claim('artistB'), 'end_user', 'a suspended artist''s token says end_user');
  perform ct.ok(not (v_rel = any (ct.ids(ct.read_as('artistB', 'select id from public.api_releases')))),
                'a suspended artist cannot read their own draft');
  perform ct.ok(not (ct.read_as('artistB', format('select public.api_can_play_track(%L) as ok', v_track)) -> 0 ->> 'ok')::boolean,
                'a suspended artist cannot play their own draft');
  perform ct.ok(not exists (select 1 from public.api_list_releases(ct.uid('artistB'), null, 101, null, null)),
                'a suspended artist lists nothing');
  update public.api_accounts set suspended = false where user_id = ct.uid('artistB');
  perform ct.issue_token('artistB');
end
$$;

-- The public view hides owner_id, rights and review details.
do $$
declare
  v_cols text;
begin
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'api_public_releases';
  perform ct.eq(v_cols, 'id,artist_id,title,release_date,has_cover', 'the public release view has only the PublicRelease fields');
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'api_public_tracks';
  perform ct.eq(v_cols, 'id,release_id,position,title', 'the public track view has only id, release, position and title');
end
$$;

-- Hidden columns and closed tables, for every account type.
do $$
declare
  v_name text;
  v_sql text;
  v_bad text[] := '{}';
  v_got jsonb;
begin
  for v_name in values ('listener1'), ('artistA'), ('tp1'), ('admin1'), ('internal1'), ('acct1') loop
    foreach v_sql in array array[
      'select stream_key from public.api_tracks', 'select master_key from public.api_tracks',
      'select master_sha256 from public.api_tracks', 'select invite_code_hash from public.api_parties',
      'select responder_user_id from public.api_parties', 'select object_key from public.api_covers',
      'select provider_upload_id from public.api_uploads', 'select sha256 from public.api_uploads',
      'select * from public.api_accounts', 'select * from public.api_review_decisions',
      'select * from public.api_invite_sends', 'select * from public.api_invite_wrong_codes',
      'select * from public.api_jobs', 'select * from public.api_play_batches', 'select * from public.api_play_events',
      'select * from public.api_qualified_streams', 'select * from public.api_audit_log'] loop
      v_got := ct.read_as(v_name, v_sql);
      if v_got ->> 'error' is distinct from '42501' then
        v_bad := v_bad || format('%s: %s', v_name, v_sql);
      end if;
    end loop;
  end loop;
  perform ct.eq(array_to_string(v_bad, '; '), '',
    'no account reads keys, hashes, upload ids, accounts, jobs, invites, plays, streams, review history or audit rows');

  -- anon reads nothing at all.
  v_bad := '{}';
  foreach v_sql in array array['select id from public.api_releases', 'select id from public.api_public_releases',
                               'select id from public.api_public_tracks', 'select release_id from public.api_tracks'] loop
    if ct.read_as(null, v_sql) ->> 'error' is distinct from '42501' then v_bad := v_bad || v_sql; end if;
  end loop;
  perform ct.eq(array_to_string(v_bad, '; '), '', 'anon reads no release, track or public view');
end
$$;

-- Clients cannot write, and cannot call B's functions.
do $$
declare
  v_rel uuid := (select release_id from ct.rel where owner = 'artistA' and state = 'awaiting_review');
  v_sql text;
  v_bad text[] := '{}';
begin
  foreach v_sql in array array[
    format('update public.api_releases set state = ''live'' where id = %L', v_rel),
    format('insert into public.api_releases (owner_id, title, release_date) values (%L, ''x'', ''2026-01-01'')', ct.uid('artistA')),
    format('delete from public.api_tracks where release_id = %L', v_rel),
    format('update public.api_parties set state = ''accepted'' where release_id = %L', v_rel),
    format('select * from public.api_takedown_release(%L, %L, ''x'')', v_rel, ct.uid('admin1')),
    format('select * from public.api_record_review(%L, %L, ''approve'', null)', v_rel, ct.uid('admin1')),
    format('select * from public.api_publish_release(%L)', v_rel),
    format('select * from public.api_list_releases(%L, null, 10, null, null)', ct.uid('admin1')),
    format('select public.api_release_go_live(%L) as s', v_rel),
    format('select * from public.api_get_invitation(%L, %L, %L)', v_rel, v_rel, repeat('b', 64)),
    format('select * from public.api_respond_to_invite(%L, %L, %L, %L, ''accept'')', v_rel, v_rel, repeat('b', 64), ct.uid('artistA')),
    format('select * from public.api_record_play_batch(%L, ''key-00000001'', ''[]''::jsonb)', ct.uid('artistA')),
    format('select public.api_account_claim(%L) as c', ct.uid('admin1')),
    'select public.api_access_token_hook(''{}''::jsonb) as h',
    format('select public.api_sync_account(%L) as s', ct.uid('artistA'))] loop
    if ct.run_as('admin1', v_sql) ->> 'error' is distinct from '42501'
       or ct.run_as('artistA', v_sql) ->> 'error' is distinct from '42501'
       or ct.run_as(null, v_sql) ->> 'error' is distinct from '42501' then
      v_bad := v_bad || v_sql;
    end if;
  end loop;
  perform ct.eq(array_to_string(v_bad, '; '), '',
    'clients cannot write api_ tables or call takedown, review, publish, list, go-live, the invite functions, plays, the claim lookup, the hook or the sync');
  perform ct.eq((select state from public.api_releases where id = v_rel), 'awaiting_review', 'and the release is unchanged');
end
$$;

-- recordPlays: every account may send events; only a live release counts a stream.
do $$
declare
  r record;
  v_type text;
  v_user text;
  v_rel text;
  v_play uuid;
  v_got integer;
  v_bad text[] := '{}';
  v_t0 timestamptz := now() - interval '1 hour';
begin
  for v_type, v_user in values ('end_user', 'listener1'), ('artist', 'artistA'), ('third_party', 'tp1'),
                               ('administrator', 'admin1'), ('internal', 'internal1'), ('internal_accounting', 'acct1') loop
    for r in select * from ct.rel loop
      v_rel := case when v_type = 'artist' and r.owner = v_user then 'own' else 'other' end;
      v_play := gen_random_uuid();
      select qualified_new into v_got from public.api_record_play_batch(ct.uid(v_user), 'k-' || v_play,
        jsonb_build_array(
          jsonb_build_object('type', 'start', 'trackId', r.track_id, 'playId', v_play, 'positionMs', 0, 'occurredAt', v_t0),
          jsonb_build_object('type', 'end', 'trackId', r.track_id, 'playId', v_play, 'positionMs', 31000,
                             'occurredAt', v_t0 + interval '31 seconds')));
      if (ct.expect('recordPlays', v_type, v_rel, r.state) = 'qualifies') <> (v_got = 1) then
        v_bad := v_bad || format('%s %s/%s', v_type, v_rel, r.state);
      end if;
    end loop;
  end loop;
  perform ct.eq(array_to_string(v_bad, ', '), '', 'recordPlays: a 31-second play qualifies only on a live release, for every account type');
end
$$;

-- 8. A role change shows only after the token refreshes ------------------------------
-- Still inside the backstop transaction, so the direct reads show the effect.

do $$
declare
  v_rel uuid;
begin
  perform ct.new_user('late1');
  insert into public.artists (owner_id, name) values (ct.uid('late1'), 'Late One');
  perform ct.issue_token('late1');
  perform ct.eq(ct.claim('late1'), 'end_user', 'refresh: an applicant signs in as end_user');
end
$$;
do $$ begin perform ct.issue_token('admin1'); end $$;
do $$
declare
  v_rel uuid;
begin
  perform ct.review_artist('admin1', 'late1', 'approved');
  insert into public.api_releases (owner_id, title, release_date) values (ct.uid('late1'), 'Late LP', date '2026-01-01')
    returning id into v_rel;
  perform ct.eq(ct.claim('late1'), 'end_user', 'refresh: after approval the old token still says end_user');
  perform ct.ok(not (v_rel = any (ct.ids(ct.read_as('late1', 'select id from public.api_releases')))),
                'refresh: with the old token the new artist cannot read their draft yet');
  perform ct.issue_token('late1');
  perform ct.eq(ct.claim('late1'), 'artist', 'refresh: the refreshed token says artist');
  perform ct.ok(v_rel = any (ct.ids(ct.read_as('late1', 'select id from public.api_releases'))),
                'refresh: with the refreshed token the artist reads their draft');

  -- Removing a role: the old token still says administrator until it refreshes, but the read
  -- rules check the token against api_accounts, so direct reads stop at once.
  perform ct.issue_token('admin2');
  perform ct.ok(cardinality(ct.ids(ct.read_as('admin2', 'select id from public.api_releases'))) > 0,
                'refresh: an administrator reads every release');
  delete from public.admins where user_id = ct.uid('admin2');
  perform ct.eq(ct.claim('admin2'), 'administrator', 'refresh: after removal the old token still says administrator');
  perform ct.eq(ct.read_as('admin2', 'select public.api_caller_type() as t') -> 0 ->> 't', 'end_user',
                'refresh: the read rules treat the stale administrator token as end_user');
  perform ct.eq(cardinality(ct.ids(ct.read_as('admin2', 'select id from public.api_releases')))::text, '0',
                'refresh: a removed administrator reads no release at once');
  perform ct.issue_token('admin2');
  perform ct.eq(ct.claim('admin2'), 'end_user', 'refresh: the refreshed token says end_user');
end
$$;

rollback;

-- 9. The invitee path ---------------------------------------------------------------
-- A release of Artist B awaiting splits, with parties invited by code. The invitee has no
-- rights to the release rows.

do $$
declare
  v_rel uuid := gen_random_uuid();
  v_track uuid := gen_random_uuid();
  v_artist uuid := (select artist_id from public.api_accounts where user_id = ct.uid('artistB'));
  v_party uuid;
  v_name text;
  v_code text;
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.api_releases (id, owner_id, artist_id, title, release_date, state)
    values (v_rel, ct.uid('artistB'), v_artist, 'Invite LP', date '2026-03-01', 'awaiting_splits');
  insert into public.api_tracks (id, release_id, position, title) values
    (v_track, v_rel, 1, 'First'), (gen_random_uuid(), v_rel, 2, 'Second');
  perform set_config('session_replication_role', 'origin', true);
  insert into ct.rel values ('invite', 'awaiting_splits', v_rel, v_track);
  insert into public.api_parties (release_id, side, role, name, email, percent, is_owner)
    values (v_rel, 'recording', 'artist', 'Artist B', null, 60, true);
  -- One party per test, each with its own code.
  for v_name in values ('valid'), ('wrong'), ('expired'), ('artist'), ('third_party'), ('staff'), ('other') loop
    insert into public.api_parties (release_id, side, role, name, email, percent)
      values (v_rel, 'recording', 'producer', 'Party ' || v_name, v_name || '@example.test', 40.0 / 7)
      returning id into v_party;
    v_code := 'invite-code-' || v_name || '-0000000000';
    perform ct.eq((select status from public.api_issue_invite(v_party, ct.hash(v_code), 5)), 'issued',
                  'issued an invitation for party ' || v_name);
    insert into ct.users values ('party_' || v_name, v_party);
  end loop;
  insert into public.api_parties (release_id, side, role, name, percent) values (v_rel, 'composition', 'songwriter', 'Writer', 100);
  -- The expired party: sent 15 days ago.
  update public.api_parties set invite_sent_at = now() - interval '15 days', invite_expires_at = now() - interval '1 day'
    where id = ct.uid('party_expired');
end
$$;

create function ct.invite(p_who text, p_party text, p_code text) returns jsonb language sql as $$
  select ct.read_as(p_who, format('select * from public.api_client_get_invitation(%L, %L, %L)',
    (select release_id from ct.rel where owner = 'invite'), ct.uid('party_' || p_party), p_code))
$$;

create function ct.reply(p_who text, p_party text, p_code text, p_response text) returns jsonb language sql as $$
  select ct.read_as(p_who, format('select * from public.api_client_respond_to_invite(%L, %L, %L, %L)',
    (select release_id from ct.rel where owner = 'invite'), ct.uid('party_' || p_party), p_code, p_response))
$$;

do $$ begin perform ct.issue_token('invitee1'); end $$;
do $$
declare
  v_rel uuid := (select release_id from ct.rel where owner = 'invite');
  v_got jsonb;
  v_row jsonb;
  v_fields text;
  v_wrong integer;
  v_name text;
begin
  -- A valid code: only the Invitation fields.
  v_got := ct.invite('invitee1', 'valid', 'invite-code-valid-0000000000');
  v_row := v_got -> 0;
  perform ct.eq(jsonb_array_length(v_got)::text, '1', 'invitee, valid code: one row');
  select string_agg(k, ',' order by k) into v_fields from jsonb_object_keys(v_row) k;
  perform ct.eq(v_fields, 'artist_name,party_state,percent,release_date,release_title,role,side,status,track_titles',
                'invitee, valid code: only status and the Invitation fields');
  perform ct.ok(v_row ->> 'status' = 'ok' and v_row ->> 'release_title' = 'Invite LP' and v_row ->> 'artist_name' = 'Artist B'
                and v_row -> 'track_titles' = '["First", "Second"]'::jsonb and v_row ->> 'side' = 'recording'
                and v_row ->> 'role' = 'producer' and v_row ->> 'party_state' = 'invited',
                'invitee, valid code: the release basics and their own share');
  perform ct.ok(position(lower('Party wrong') in lower(v_got::text)) = 0 and position('@' in v_got::text) = 0
                and position((select owner_id::text from public.api_releases where id = v_rel) in v_got::text) = 0,
                'invitee, valid code: no other party, no email, no owner_id');
  perform ct.eq((select invite_used_at::text from public.api_parties where id = ct.uid('party_valid')), null,
                'invitee, valid code: reading does not use up the code');

  -- The tables stay closed to the invitee.
  perform ct.ok(not (v_rel = any (ct.ids(ct.read_as('invitee1', 'select id from public.api_releases'))))
                and not (v_rel = any (ct.ids(ct.read_as('invitee1', 'select release_id from public.api_parties'), 'release_id')))
                and not (v_rel = any (ct.ids(ct.read_as('invitee1', 'select release_id from public.api_tracks'), 'release_id')))
                and not (v_rel = any (ct.ids(ct.read_as('invitee1', 'select id from public.api_public_releases')))),
                'invitee: the release, rights and tracks stay hidden');

  -- A wrong code: nothing, and it is counted.
  v_got := ct.invite('invitee1', 'wrong', 'invite-code-not-the-right-one');
  perform ct.ok(v_got -> 0 ->> 'status' = 'wrong_code'
                and (select bool_and(value = 'null'::jsonb) from jsonb_each(v_got -> 0) where key <> 'status'),
                'invitee, wrong code: status wrong_code and no fields');
  perform ct.eq((select count(*)::text from public.api_invite_wrong_codes where party_id = ct.uid('party_wrong')), '1',
                'invitee, wrong code: the wrong code is counted');
  v_got := ct.invite('invitee1', 'wrong', 'invite-code-valid-0000000000');
  perform ct.eq(v_got -> 0 ->> 'status', 'wrong_code', 'invitee: another party''s code does not open this party');

  -- An expired code: nothing.
  v_got := ct.invite('invitee1', 'expired', 'invite-code-expired-0000000000');
  perform ct.ok(v_got -> 0 ->> 'status' = 'expired'
                and (select bool_and(value = 'null'::jsonb) from jsonb_each(v_got -> 0) where key <> 'status'),
                'invitee, expired code: status expired and no fields');
  v_got := ct.reply('invitee1', 'expired', 'invite-code-expired-0000000000', 'accept');
  perform ct.eq(v_got -> 0 ->> 'status', 'expired', 'invitee, expired code: the reply is refused');

  -- Staff cannot use it; anon cannot call it.
  for v_name in values ('admin1'), ('internal1'), ('acct1') loop
    perform ct.eq(ct.invite(v_name, 'staff', 'invite-code-staff-0000000000') ->> 'error', 'MC403',
                  format('%s (staff) cannot read an invitation', ct.claim(v_name)));
    perform ct.eq(ct.reply(v_name, 'staff', 'invite-code-staff-0000000000', 'accept') ->> 'error', 'MC403',
                  format('%s (staff) cannot reply to an invitation', ct.claim(v_name)));
  end loop;
  perform ct.eq(ct.invite(null, 'staff', 'invite-code-staff-0000000000') ->> 'error', '42501', 'anon cannot read an invitation');
  perform ct.eq(ct.reply(null, 'staff', 'invite-code-staff-0000000000', 'accept') ->> 'error', '42501', 'anon cannot reply');
  perform ct.eq(ct.invite('invitee1', 'staff', 'short') ->> 'error', 'MC422', 'a code under 16 characters is refused before it is counted');

  -- artist and third_party accounts may be invitees.
  perform ct.eq(ct.invite('artistA', 'artist', 'invite-code-artist-0000000000') -> 0 ->> 'status', 'ok', 'an artist account can read its invitation');
  perform ct.eq(ct.reply('artistA', 'artist', 'invite-code-artist-0000000000', 'decline') -> 0 ->> 'status', 'ok', 'an artist account can reply');
  perform ct.eq(ct.invite('tp1', 'third_party', 'invite-code-third_party-0000000000') -> 0 ->> 'status', 'ok', 'a third_party account can read its invitation');

  -- The reply links the signed-in account, never another one.
  v_got := ct.reply('invitee1', 'valid', 'invite-code-valid-0000000000', 'accept');
  perform ct.ok(v_got -> 0 ->> 'status' = 'ok' and v_got -> 0 ->> 'party_state' = 'accepted', 'invitee, valid code: the reply is recorded');
  perform ct.eq((select responder_user_id::text from public.api_parties where id = ct.uid('party_valid')),
                ct.uid('invitee1')::text, 'the reply links the signed-in account');
  perform ct.eq((select responder_user_id::text from public.api_parties where id = ct.uid('party_artist')),
                ct.uid('artistA')::text, 'the artist''s reply links the artist''s account');
  perform ct.eq((select string_agg(format_type(t, null), ',') from pg_proc p, unnest(p.proargtypes::oid[]) t
                 where p.oid = 'public.api_client_respond_to_invite(uuid,uuid,text,text)'::regprocedure),
                'uuid,uuid,text,text', 'the reply wrapper takes no user id (release, party, code, response)');
  perform ct.eq(ct.read_as('listener1', format('select * from public.api_respond_to_invite(%L, %L, %L, %L, ''accept'')',
                  v_rel, ct.uid('party_other'), ct.hash('invite-code-other-0000000000'), ct.uid('invitee1'))) ->> 'error',
                '42501', 'a client cannot call B''s reply with another account''s user id');
  perform ct.eq((select state from public.api_parties where id = ct.uid('party_other')), 'invited', 'and that party is still invited');

  -- After the reply the code is used up.
  perform ct.eq(ct.invite('invitee1', 'valid', 'invite-code-valid-0000000000') -> 0 ->> 'status', 'replied',
                'invitee: after replying, the invitation reads as replied');
  perform ct.eq(ct.reply('invitee1', 'valid', 'invite-code-valid-0000000000', 'decline') -> 0 ->> 'status', 'replied',
                'invitee: a second reply is refused');
  perform ct.eq((select state from public.api_parties where id = ct.uid('party_valid')), 'accepted', 'and the first reply stands');

  -- The fixture's cases match B's statuses.
  perform ct.ok((select bool_and(c.value ->> 'status' in ('ok','wrong_code','expired','replied','taken_down','rate_limited','not_found'))
                 from ct.fixture f, jsonb_each(f.doc -> 'invitation' -> 'cases') c where f.name = 'access'),
                'the fixture''s invitation cases use B''s statuses');
end
$$;

-- 10. The app's own access still works ----------------------------------------------

do $$
begin
  perform ct.eq(ct.read_as('admin1', 'select public.is_admin() as a') -> 0 ->> 'a', 'true', 'the app''s is_admin() still works');
  perform ct.eq(ct.read_as('artistA', 'select public.is_approved_artist() as a') -> 0 ->> 'a', 'true',
                'the app''s is_approved_artist() still works');
  perform ct.eq(ct.read_as('pending1', 'select public.is_approved_artist() as a') -> 0 ->> 'a', 'false',
                'a pending applicant is still not an approved artist in the app');
  perform ct.ok(jsonb_array_length(ct.read_as('listener1', 'select id from public.artists where status = ''approved''')) >= 3,
                'a listener still reads approved artist profiles through the app''s policy');
end
$$;

set client_min_messages = warning;
drop schema ct cascade;
