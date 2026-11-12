-- Test only. Lists the app's own tables, columns, constraints, grants, policies, functions and
-- triggers (everything in public, auth and storage that is not api_). run.sh takes it before and
-- after db/migrations and db/supabase and fails if anything differs: those files may only add
-- alongside the app, never change it.
select kind, item from (
  select 'policy' as kind,
         format('%s.%s %s %s %s using(%s) check(%s)', schemaname, tablename, policyname, cmd,
                array_to_string(roles, ','), qual, with_check) as item
  from pg_policies
  where schemaname in ('public', 'auth', 'storage') and tablename not like 'api\_%'
  union all
  select 'relation', format('%s kind=%s rls=%s acl=%s', c.oid::regclass, c.relkind, c.relrowsecurity, c.relacl)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'auth', 'storage') and c.relname not like 'api\_%' and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'column', format('%s.%s.%s %s null=%s default=%s', table_schema, table_name, column_name, data_type,
                          is_nullable, column_default)
  from information_schema.columns
  where table_schema in ('public', 'auth', 'storage') and table_name not like 'api\_%'
  union all
  select 'column grant', format('%s.%s.%s %s %s', table_schema, table_name, column_name, grantee, privilege_type)
  from information_schema.column_privileges
  where table_schema in ('public', 'auth', 'storage') and table_name not like 'api\_%'
  union all
  select 'constraint', format('%s %s %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid))
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
  where n.nspname in ('public', 'auth', 'storage') and c.conrelid <> 0
    and c.conrelid::regclass::text not like '%api\_%'
  union all
  select 'function', format('%s definer=%s acl=%s src=%s', p.oid::regprocedure, p.prosecdef, p.proacl, md5(p.prosrc))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'auth', 'storage') and p.proname not like 'api\_%'
  union all
  select 'trigger', format('%s %s', t.tgrelid::regclass, pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in ('public', 'auth', 'storage')
    and t.tgname not like 'api\_%' and c.relname not like 'api\_%'
) s
order by kind, item;
