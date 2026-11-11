-- 0004: jobs. A job id is a row here, so a job result finds its release.

create table if not exists public.api_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Creation order, so the newest job of a release is clear even within one transaction.
  seq bigint generated always as identity unique,
  release_id uuid not null references public.api_releases (id) on delete cascade,
  kind text not null check (kind in ('process_release')),
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed')),
  -- Plain words for the artist. Set only when the job failed.
  failure_message text check (failure_message is null or length(failure_message) between 1 and 2000),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint api_jobs_finished check ((state in ('succeeded', 'failed')) = (finished_at is not null)),
  constraint api_jobs_failure check ((state = 'failed') = (failure_message is not null))
);

create index if not exists api_jobs_release on public.api_jobs (release_id, seq desc);

-- A new job row for Jobs.enqueue. The release must be processing.
create or replace function public.api_create_job(p_release_id uuid, p_kind text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
  v_id uuid;
begin
  select r.state into v_state from public.api_releases r where r.id = p_release_id for update;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such release';
  end if;
  if p_kind is distinct from 'process_release' then
    raise exception using errcode = 'MC422', message = 'bad_kind: the only job kind is process_release';
  end if;
  if v_state <> 'processing' then
    raise exception using errcode = 'MC409', message = format('wrong_state: no processing job while %s', v_state);
  end if;
  insert into public.api_jobs (release_id, kind) values (p_release_id, p_kind) returning id into v_id;
  return v_id;
end
$$;

-- The worker picked the job up. Returns false if the job was not queued.
create or replace function public.api_job_started(p_job_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.api_jobs j set state = 'running', started_at = now()
    where j.id = p_job_id and j.state = 'queued';
  return found;
end
$$;

-- Apply a worker's result. Safe to call twice: a finished job is left alone.
-- The release moves (processing to awaiting_splits, or to failed with the message) only when
-- it is still processing and this is its newest job, so a stale result changes nothing.
-- Returns finished (this call finished the job), moved (the release state changed) and the
-- release state after the call.
create or replace function public.api_apply_job_result(p_job_id uuid, p_ok boolean, p_message text)
returns table (finished boolean, moved boolean, release_id uuid, release_state text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release_id uuid;
  v_job_state text;
  v_release_state text;
  v_newest uuid;
  v_moved boolean := false;
begin
  select j.release_id into v_release_id from public.api_jobs j where j.id = p_job_id;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such job';
  end if;
  if p_ok is null or (not p_ok and (p_message is null or length(btrim(p_message)) = 0)) then
    raise exception using errcode = 'MC422', message = 'no_message: a failed job needs a plain-words message';
  end if;

  -- Lock the release first, then the job, the same order as everything else.
  select r.state into v_release_state from public.api_releases r where r.id = v_release_id for update;
  select j.state into v_job_state from public.api_jobs j where j.id = p_job_id for update;

  if v_job_state in ('succeeded', 'failed') then
    return query select false, false, v_release_id, v_release_state;
    return;
  end if;

  update public.api_jobs j
    set state = case when p_ok then 'succeeded' else 'failed' end,
        failure_message = case when p_ok then null else left(btrim(p_message), 2000) end,
        started_at = coalesce(j.started_at, now()),
        finished_at = now()
    where j.id = p_job_id;

  select j.id into v_newest from public.api_jobs j
    where j.release_id = v_release_id order by j.seq desc limit 1;

  if v_release_state = 'processing' and v_newest = p_job_id then
    update public.api_releases r
      set state = case when p_ok then 'awaiting_splits' else 'failed' end,
          failure_reason = case when p_ok then null else left(btrim(p_message), 2000) end
      where r.id = v_release_id
      returning r.state into v_release_state;
    v_moved := true;
  end if;

  return query select true, v_moved, v_release_id, v_release_state;
end
$$;
