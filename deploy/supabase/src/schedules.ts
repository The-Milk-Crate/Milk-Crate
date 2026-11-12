import type { Database, Schedules } from "./core.ts";

const NAME = /^[A-Za-z0-9_.:-]{1,100}$/;
const FN = /^api_[a-z0-9_]{1,59}$/;
const ARG = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * `Schedules` on pg_cron. `api_schedule_set` (deploy/supabase/sql) records the run and
 * schedules a pg_cron job for that minute (UTC); the job calls the function once with named
 * arguments, then removes itself. The same name again replaces the earlier run.
 */
export function supabaseSchedules(database: Database): Schedules {
  return {
    async runSqlFunctionAt(input): Promise<void> {
      if (!NAME.test(input.name)) throw new Error(`bad schedule name: ${input.name}`);
      if (!FN.test(input.fn)) throw new Error(`schedules run only public api_ functions, not ${input.fn}`);
      const args = input.args ?? {};
      for (const key of Object.keys(args)) {
        if (!ARG.test(key)) throw new Error(`bad argument name: ${key}`);
      }
      if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) throw new Error("bad time");
      await database.query("select public.api_schedule_set($1::text, $2::text, $3::jsonb, $4::timestamptz)", [
        input.name,
        input.fn,
        args,
        input.at,
      ]);
    },
  };
}
