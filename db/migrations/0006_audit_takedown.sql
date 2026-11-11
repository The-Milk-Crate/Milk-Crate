-- 0006: audit rows and takedown.

create table if not exists public.api_audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('takedown')),
  -- No cascade: a release with audit rows cannot be deleted.
  release_id uuid not null references public.api_releases (id),
  actor_id uuid not null references public.api_accounts (user_id),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  -- What was removed: {"prefixes": [...], "keys": [...]}.
  removed jsonb not null,
  created_at timestamptz not null default now(),
  -- Set once storage confirms the prefixes are deleted.
  files_deleted_at timestamptz
);

create index if not exists api_audit_log_release on public.api_audit_log (release_id, created_at desc);

-- takedownRelease, database part. Only an administrator. Moves the release to taken_down from
-- any other state, writes the audit row listing the release's prefixes and the keys it knew,
-- clears the streaming keys and the cover row so nothing signs a deleted file, and cancels open
-- uploads. Returns the audit id and the prefixes the caller then deletes from storage, then
-- the caller calls api_takedown_files_deleted.
create or replace function public.api_takedown_release(p_release_id uuid, p_actor_id uuid, p_reason text)
returns table (audit_id uuid, prefixes jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release public.api_releases%rowtype;
  v_type text;
  v_prefixes jsonb;
  v_keys jsonb;
  v_audit uuid;
begin
  select r.* into v_release from public.api_releases r where r.id = p_release_id for update;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such release';
  end if;
  select a.account_type into v_type from public.api_accounts a
    where a.user_id = p_actor_id and not a.suspended;
  if v_type is distinct from 'administrator' then
    raise exception using errcode = 'MC403', message = 'not_allowed: only an administrator can take a release down';
  end if;
  if v_release.state = 'taken_down' then
    raise exception using errcode = 'MC409', message = 'wrong_state: the release is already taken down';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 2000 then
    raise exception using errcode = 'MC422', message = 'no_reason: a takedown needs a reason of 1 to 2000 characters';
  end if;

  v_prefixes := jsonb_build_array(
    format('masters/%s/%s/', v_release.artist_id, v_release.id),
    format('streams/%s/%s/', v_release.artist_id, v_release.id),
    format('art/%s/%s/', v_release.artist_id, v_release.id));

  select coalesce(jsonb_agg(k.key order by k.key), '[]'::jsonb) into v_keys
  from (
    select t.master_key as key from public.api_tracks t where t.release_id = p_release_id and t.master_key is not null
    union
    select t.stream_key from public.api_tracks t where t.release_id = p_release_id and t.stream_key is not null
    union
    select u.object_key from public.api_uploads u where u.release_id = p_release_id
    union
    select c.object_key from public.api_covers c where c.release_id = p_release_id
  ) k;

  insert into public.api_audit_log (action, release_id, actor_id, reason, removed)
    values ('takedown', p_release_id, p_actor_id, btrim(p_reason),
            jsonb_build_object('prefixes', v_prefixes, 'keys', v_keys))
    returning id into v_audit;

  update public.api_tracks t set stream_key = null, duration_ms = null, sample_rate_hz = null
    where t.release_id = p_release_id;
  delete from public.api_covers c where c.release_id = p_release_id;
  update public.api_uploads u set state = 'cancelled' where u.release_id = p_release_id and u.state = 'open';
  update public.api_releases r set state = 'taken_down' where r.id = p_release_id;

  return query select v_audit, v_prefixes;
end
$$;

-- Storage confirmed the takedown's prefixes are deleted.
create or replace function public.api_takedown_files_deleted(p_audit_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.api_audit_log l set files_deleted_at = now()
    where l.id = p_audit_id and l.action = 'takedown' and l.files_deleted_at is null;
  return found;
end
$$;
