-- 0014: at most 2 running processing jobs per artist (session J1, finding M2 of
-- docs/security/review-phase0.md; decided by K Marcus, 21 November 2026).
--
-- api_job_started keeps its arguments and result. It now also returns false when the release's
-- artist (its owner) already has c_max_running jobs running, and marks the job waiting (a new
-- job state), so the worker's sweep, which runs only queued jobs, goes on to other artists'
-- jobs instead of stopping at this one. When one of that artist's jobs finishes,
-- api_apply_job_result puts their oldest waiting job back to queued, and the hourly sweep runs
-- it. So a third job can wait up to an hour after a place frees up.
--
-- A job that has been running longer than c_running_window (the 4-hour job limit) does not
-- count: its worker is gone, and the sweep fails it, which also frees its place. Decided by
-- K Marcus with session J1.
--
-- Both functions take the same per-artist lock, so a job set waiting is always seen by the next
-- finish.
--
-- Existing rows: none change. The state check gains 'waiting'.

alter table public.api_jobs drop constraint if exists api_jobs_state_check;
alter table public.api_jobs add constraint api_jobs_state_check
  check (state in ('queued', 'waiting', 'running', 'succeeded', 'failed'));

create or replace function public.api_job_started(p_job_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  c_max_running constant integer := 2;
  c_running_window constant interval := interval '4 hours';
  v_owner uuid;
  v_running integer;
begin
  select r.owner_id into v_owner
    from public.api_jobs j join public.api_releases r on r.id = j.release_id
   where j.id = p_job_id;
  if not found then
    return false;
  end if;
  -- One start or finish at a time per artist, so two workers cannot both take the second place.
  perform pg_advisory_xact_lock(hashtext('api_jobs_per_artist'), hashtext(v_owner::text));
  select count(*) into v_running
    from public.api_jobs j join public.api_releases r on r.id = j.release_id
   where r.owner_id = v_owner and j.state = 'running'
     and j.started_at > now() - c_running_window;
  if v_running >= c_max_running then
    -- Set aside until one of this artist's jobs finishes.
    update public.api_jobs j set state = 'waiting' where j.id = p_job_id and j.state = 'queued';
    return false;
  end if;
  update public.api_jobs j set state = 'running', started_at = now()
    where j.id = p_job_id and j.state = 'queued';
  return found;
end
$$;

-- As in 0004, plus: when this call finishes a job, the artist's oldest waiting job goes back to
-- queued.
create or replace function public.api_apply_job_result(p_job_id uuid, p_ok boolean, p_message text)
returns table (finished boolean, moved boolean, release_id uuid, release_state text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release_id uuid;
  v_owner uuid;
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
  select r.state, r.owner_id into v_release_state, v_owner from public.api_releases r where r.id = v_release_id for update;
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

  -- A place is free: the artist's oldest waiting job goes back to the queue.
  perform pg_advisory_xact_lock(hashtext('api_jobs_per_artist'), hashtext(v_owner::text));
  update public.api_jobs j set state = 'queued'
    where j.id = (select w.id from public.api_jobs w join public.api_releases r on r.id = w.release_id
                   where r.owner_id = v_owner and w.state = 'waiting'
                   order by w.seq limit 1);

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
