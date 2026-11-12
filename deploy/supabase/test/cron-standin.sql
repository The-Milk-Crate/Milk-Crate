-- Test only: a stand-in for pg_cron's schedule, unschedule and job table, because the test
-- Postgres has no pg_cron. Same names and arguments as pg_cron 1.6. Nothing runs on a timer:
-- the tests run a job's command themselves, as pg_cron would.
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  jobname text unique,
  username text not null default current_user,
  active boolean not null default true
);
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  if not found then
    raise exception 'could not find valid entry for job ''%''', job_name;
  end if;
  return true;
end
$$;
