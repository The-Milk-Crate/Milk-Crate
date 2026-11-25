-- 0014: at most 2 running processing jobs per artist (session J1, finding M2 of
-- docs/security/review-phase0.md; decided by K Marcus, 21 November 2026).
--
-- api_job_started keeps its arguments and result. It now also returns false (the job stays
-- queued) when the release's artist (its owner) already has c_max_running jobs running. The
-- worker does nothing on false, and the hourly sweep runs the job later, so a third job can
-- wait up to an hour.
--
-- A job that has been running longer than c_running_window (the 4-hour job limit) does not
-- count: its worker is gone, and the sweep fails it. Decided by K Marcus with session J1.
--
-- Existing rows: none change.
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
  -- One start at a time per artist, so two workers cannot both take the second place.
  perform pg_advisory_xact_lock(hashtext('api_job_started'), hashtext(v_owner::text));
  select count(*) into v_running
    from public.api_jobs j join public.api_releases r on r.id = j.release_id
   where r.owner_id = v_owner and j.state = 'running'
     and j.started_at > now() - c_running_window;
  if v_running >= c_max_running then
    return false;
  end if;
  update public.api_jobs j set state = 'running', started_at = now()
    where j.id = p_job_id and j.state = 'queued';
  return found;
end
$$;
